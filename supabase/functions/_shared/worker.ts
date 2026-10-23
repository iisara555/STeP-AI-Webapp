import { z } from 'zod';
import {
  OrganizationKnowledge,
  SYSTEM_RULES,
  RECEIPT_BUYER,
  assertSafeText,
  boundedContext,
  chunkText,
  chooseSkill,
  createAuthorityEngine,
  estimateTextTokens,
  rankSources,
  selectMemories,
  untrusted,
} from '../../../packages/harness-core/src/index.ts';
import type { Memory, Skill, SourceRef } from '../../../packages/harness-core/src/contracts.ts';
import { checked, clients, constantTimeEqual, requireEnv, safeCode, type Environment } from './runtime.ts';
import { modelClient, requireProviderConsent } from './ai.ts';
import { calendarEvents, driveText, wantsCalendar } from './google.ts';
import { imageBase64 } from './files.ts';
import { normalizeReceipt } from './receipt.ts';
import { skillContext } from '../../../packages/harness-core/src/skill-context.ts';
const textSchema = z.object({ text: z.string().max(200000), truncated: z.boolean() });
const receiptPrompt = `อ่านข้อความและจัดกลุ่มข้อมูลจากใบเสร็จในภาพเท่านั้น ไม่เติมสิ่งที่มองไม่เห็น
ตอบ JSON ตามรูปแบบนี้: {"document_type":"full_tax_invoice|abbreviated_tax_invoice|cash_bill|general_receipt|unknown","complete":"complete|incomplete|uncertain","signature":"present|absent|uncertain","checks":[{"field":"ชื่อช่องข้อมูล","status":"found|missing|uncertain|mismatch","value":null,"evidence":null}],"next_steps":["ต้องทำอะไรต่อ"],"warnings":[]}
checks ต้องมีหัวข้อ วันที่ ชื่อผู้ขาย ที่อยู่ผู้ขาย รายการสินค้า/บริการ ยอดรวม เลขที่เอกสาร เลขภาษีผู้ขาย ชื่อผู้ซื้อ ที่อยู่ผู้ซื้อ เลขภาษีผู้ซื้อ ภาษีมูลค่าเพิ่ม และลายเซ็นผู้รับเงิน แยกคนละรายการ ตรวจตามประเภทใบเสร็จและสิ่งที่ปรากฏ ข้อที่อ่านไม่ชัดให้ uncertain และไม่สรุปว่าเบิกได้
สำหรับข้อมูลผู้ซื้อเทียบกับ ${JSON.stringify(RECEIPT_BUYER)} ตัดขีดและช่องว่างของเลขภาษีก่อนเปรียบเทียบ
ยอมรับคำย่อที่อยู่ที่หมายถึงสถานที่เดียวกัน แต่ห้ามยอมรับเลขที่ หมู่ ตำบล จังหวัดหรือรหัสไปรษณีย์ผิด
แยกลายเซ็นผู้รับเงิน ผู้ขายและผู้ซื้อ ลายเซ็นที่ไม่ชัดให้ uncertain การพบลายเซ็นไม่ยืนยันตัวบุคคล
evidence ต้องเป็นข้อความที่อ่านได้จากภาพ ถ้าไม่มีให้ null ห้ามแต่งข้อกำหนดการเบิกจ่ายหรือสรุปว่าอนุมัติให้เบิกได้ ให้ระบุข้อที่ยังต้องให้คนตรวจ
สรุปสิ่งที่ต้องทำต่อให้กระชับ ไม่เกินห้าข้อ`;
export async function processOne(env: Environment, fetcher: typeof fetch = fetch) {
  const { service } = clients(env, undefined, fetcher);
  const job = await checked(service.rpc('claim_run'));
  if (!job?.id) return { processed: false };
  const deadline = Date.now() + 95000;
  const jobFetch: typeof fetch = async (input, init) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('RUN_INTERRUPTED');
    try {
      return await fetcher(input, {
        ...init,
        signal: AbortSignal.any([AbortSignal.timeout(remaining), ...(init?.signal ? [init.signal] : [])]),
      });
    } catch (error) {
      if (Date.now() >= deadline || init?.signal?.aborted) throw new Error('RUN_INTERRUPTED');
      throw error;
    }
  };
  let inputTokens = 0,
    outputTokens = 0;
  try {
    const context = await checked(service.rpc('worker_payload', { job_id: job.id, lease: job.lease_token }));
    const info = requireProviderConsent(env, job.input.providerConsent);
    if (job.ai_provider !== info.provider) throw new Error('AI_PROVIDER_CHANGED');
    if (info.textOnly && job.kind !== 'chat') throw new Error('AI_TRIAL_TEXT_ONLY');
    const ai = modelClient(env, jobFetch);
    let result: Record<string, unknown>;
    if (job.kind === 'chat') {
      const query = assertSafeText(String(job.input.message || ''));
      const registered = context.sources as {
        source_key: string;
        title: string;
        body: string;
        source_version: string;
        provenance: Record<string, unknown>;
      }[];
      const authority = registered.find((s) => s.source_key === '__authority');
      const roster = registered.find((s) => s.source_key === '__organization');
      const engine = createAuthorityEngine(roster?.body || '');
      if (!authority || !roster) throw new Error('HARNESS_NOT_IMPORTED');
      const decision = engine.evaluateAuthorityPreflight(
        query,
        engine.parseAuthorityRegistry(authority.body),
      );
      if (decision.status !== 'ALLOW') {
        result = {
          text: 'งานนี้ต้องให้ผู้มีอำนาจของ STeP ตรวจและตัดสินใจครับ ผมช่วยเตรียมร่างหรือรายการข้อมูลประกอบได้ แต่ไม่สามารถอนุมัติหรือลงนามแทนได้',
          sources: [],
        };
      } else {
        const sources: SourceRef[] = [];
        const knowledge = new OrganizationKnowledge(
          registered
            .filter((s) => !s.source_key.startsWith('__') && s.provenance.kind !== 'skill-support')
            .map((s) => ({
              ...s.provenance,
              id: s.source_key,
              title: s.title,
              body: s.body,
              path: String(s.provenance.path || s.source_key),
            })),
        );
        const found = await knowledge.search(query);
        const parts: string[] = [];
        if (wantsCalendar(query)) {
          if (context.session.visibility === 'workspace') throw new Error('GOOGLE_PRIVATE_CONTEXT');
          if (!job.input.googleConsent) throw new Error('GOOGLE_CONSENT_REQUIRED');
          const calendar = await calendarEvents(service, job.tenant_id, job.actor_id, query, env, jobFetch);
          parts.push(untrusted('google-calendar', JSON.stringify(calendar)));
          sources.push({
            id: 'google-calendar',
            title: 'Google Calendar · บัญชีของคุณ',
            location: calendar.range.timeMin + ' — ' + calendar.range.timeMax,
            kind: 'google',
          });
        }
        const orgQuestion =
          /(?:STeP|สเต็ป|AFP|อุทยาน|มหาวิทยาลัย|เบิก|ลาพัก|ลาป่วย|ลาคลอด|พัสดุ|งบประมาณ|นโยบาย|ขั้นตอนงาน|QM-|QP-|WI-|FM-)/i.test(
            query,
          );
        if (orgQuestion && !found.length && !parts.length) {
          result = {
            text: 'ยังไม่พบเอกสารองค์กรที่ยืนยันเรื่องนี้ครับ กรุณาแนบเอกสารที่เกี่ยวข้อง หรือให้ผู้ดูแลนำเข้าเอกสาร STeP เพิ่มก่อน',
            sources: [],
          };
        } else {
          const skill = chooseSkill(
            (context.skills as Skill[]).filter(
              (s) => !s.metadata.developerOnly && !s.metadata.webUnsupported,
            ),
            query,
            job.input.skill || undefined,
          );
          // The user's query precedes optional references so budget trimming never drops it.
          parts.unshift(`คำขอปัจจุบัน: ${query}`);
          if (skill) {
            const selected = skillContext(skill, registered, query);
            parts.push(...selected.parts);
            sources.push(...selected.sources);
          }
          // Required Skill material and the current request must fit before optional context.
          if (estimateTextTokens(parts.join('\n')).estimatedTokens > 27000) throw new Error('CONTEXT_LIMIT');
          for (const section of found) {
            const id = section.id;
            parts.push(untrusted(id, `${section.title}\n${section.heading}\n${section.text}`));
            if (!sources.some((s) => s.id === id))
              sources.push({
                id,
                title: section.title,
                location: section.heading,
                version: registered.find((s) => s.source_key === id)?.source_version,
                kind: 'organization',
              });
          }
          const memories = selectMemories(context.memories as Memory[], query, context.session.visibility);
          if (memories.length)
            parts.push(
              untrusted('ความจำที่ยืนยันแล้ว', memories.map((m) => `${m.title}: ${m.body}`).join('\n')),
            );
          for (const doc of context.documents) {
            let text = String(doc.extracted_text || '');
            if (doc.source_kind === 'drive')
              text = (await driveText(service, job.tenant_id, job.actor_id, doc.drive_file_id, env, jobFetch))
                .text;
            if (!text.trim()) throw new Error('DOCUMENT_NEEDS_OCR');
            assertSafeText(text);
            const chunks = chunkText(text).map((c) => ({
              title: doc.name,
              body: c.content,
              location: c.location,
            }));
            const matching = rankSources(chunks, query, 4);
            const selected = matching.length ? matching : chunks.slice(0, 4);
            for (const chunk of selected)
              parts.push(untrusted(doc.id, `${doc.name}\n${chunk.location}\n${chunk.body}`));
            if (selected.length)
              sources.push({
                id: doc.id,
                title: doc.name,
                location: selected.map((c) => c.location).join(', '),
                kind: 'document',
              });
          }
          // Authorised vectors only: query results are checked again under the job's actor in SQL.
          if (
            !info.textOnly &&
            context.documents.some((d: { source_kind: string }) => d.source_kind === 'upload')
          ) {
            const vector = await ai.embed(query);
            inputTokens += estimateTextTokens(query).estimatedTokens;
            const hits = await checked(
              service.rpc('worker_search', {
                job_id: job.id,
                lease: job.lease_token,
                query_embedding: JSON.stringify(vector),
              }),
            );
            for (const hit of hits || [])
              parts.push(untrusted(hit.document_id, `${hit.location}\n${hit.content}`));
          }
          const history = (context.history as { role: string; body: string }[])
            .slice(0, -1)
            .map((m) => `${m.role}: ${m.body}`)
            .join('\n');
          if (history) parts.push(untrusted('บทสนทนาก่อนหน้า', history));
          const prompt = boundedContext(parts, 27000);
          assertSafeText(prompt);
          const answer = await ai.generate({
            system: SYSTEM_RULES,
            prompt,
            signal: AbortSignal.timeout(80000),
          });
          inputTokens += answer.usage.input;
          outputTokens += answer.usage.output;
          result = {
            text:
              answer.text +
              (answer.truncated
                ? '\n\nคำตอบยังไม่ครบเพราะถึงความยาวสูงสุด คุณขอให้ขยายเฉพาะส่วนที่ต้องการต่อได้ครับ'
                : ''),
            sources: sources.filter(
              (s, i) =>
                sources.findIndex((other) => other.id === s.id) === i &&
                prompt.includes(`<reference name=${JSON.stringify(s.id)}>`),
            ),
            truncated: answer.truncated,
          };
        }
      }
    } else {
      const doc = context.document;
      if (job.kind === 'document' && doc.extracted_text) {
        const chunks = chunkText(assertSafeText(doc.extracted_text));
        const size = chunks.reduce((n, c) => n + estimateTextTokens(c.content).estimatedTokens, 0);
        if (size > 30000 || chunks.length > 16) throw new Error('DOCUMENT_INDEX_LIMIT');
        const embedded = [];
        for (let offset = 0; offset < chunks.length; offset += 4) {
          await checked(service.rpc('worker_payload', { job_id: job.id, lease: job.lease_token }));
          embedded.push(
            ...(await Promise.all(
              chunks
                .slice(offset, offset + 4)
                .map(async (chunk) => ({ ...chunk, embedding: await ai.embed(chunk.content) })),
            )),
          );
        }
        inputTokens = size;
        await checked(
          service.rpc('worker_store_document', {
            job_id: job.id,
            lease: job.lease_token,
            body: doc.extracted_text,
            chunks: embedded,
          }),
        );
        result = { text: 'เตรียมเอกสารสำหรับค้นหาด้วย AI แล้ว', indexed: true };
      } else {
        if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(doc.mime))
          throw new Error('FILE_UNSUPPORTED');
        const image = context.prepared_document || doc;
        const blob = await checked(service.storage.from('documents').download(image.object_path));
        if (blob.size > 10485760) throw new Error('DOCUMENT_TOO_LARGE');
        const answer = await ai.generate({
          system: SYSTEM_RULES,
          prompt:
            job.kind === 'receipt'
              ? receiptPrompt
              : 'ถอดข้อความทั้งหมดตามลำดับหน้าและกลุ่มข้อมูล ห้ามเติมหรือแก้ข้อความที่อ่านไม่ชัด ตอบ JSON {"text":"ข้อความที่อ่านได้","truncated":false} หากไม่สามารถถอดครบให้ truncated เป็น true',
          json: true,
          image: { mime: image.mime, data: imageBase64(new Uint8Array(await blob.arrayBuffer())) },
          signal: AbortSignal.timeout(80000),
        });
        inputTokens = answer.usage.input;
        outputTokens = answer.usage.output;
        let parsed: unknown;
        try {
          parsed = JSON.parse(answer.text);
        } catch {
          throw new Error('PROVIDER_STREAM_INVALID');
        }
        if (job.kind === 'receipt') {
          const receipt = normalizeReceipt(parsed);
          result = {
            receipt,
            sourceDocumentId: doc.id,
            preparedDocumentId: image.id,
            provenance: 'EXTRACTED_UNVERIFIED',
            text: 'ตรวจใบเสร็จแล้ว กรุณาเทียบผลกับต้นฉบับก่อนใช้เบิกจ่าย',
          };
        } else {
          const reading = textSchema.safeParse(parsed);
          if (!reading.success || reading.data.truncated) throw new Error('DOCUMENT_OCR_INCOMPLETE');
          assertSafeText(reading.data.text);
          await checked(
            service.rpc('worker_store_document', {
              job_id: job.id,
              lease: job.lease_token,
              body: reading.data.text,
              chunks: chunkText(reading.data.text),
            }),
          );
          result = {
            text: 'อ่านข้อความแล้ว ข้อมูลที่อ่านได้ยังต้องตรวจเทียบกับต้นฉบับ',
            provenance: 'EXTRACTED_UNVERIFIED',
          };
        }
      }
    }
    const committed = await checked(
      service.rpc('finish_run', {
        job_id: job.id,
        lease: job.lease_token,
        answer: result,
        error: null,
        input_count: inputTokens,
        output_count: outputTokens,
      }),
    );
    return { processed: true, id: job.id, committed };
  } catch (error) {
    const code = error instanceof z.ZodError ? 'PROVIDER_STREAM_INVALID' : safeCode(error);
    await checked(
      service.rpc('finish_run', {
        job_id: job.id,
        lease: job.lease_token,
        answer: null,
        error: code,
        input_count: inputTokens,
        output_count: outputTokens,
      }),
    );
    return { processed: true, id: job.id, code };
  }
}
export function createWorker(env: Environment, process: (env: Environment) => Promise<unknown> = processOne) {
  return async (request: Request) => {
    const expected = env('WORKER_SECRET');
    if (!expected)
      return Response.json(
        { code: 'SERVER_NOT_CONFIGURED' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    if (
      request.method !== 'POST' ||
      !constantTimeEqual(request.headers.get('authorization') || '', 'Bearer ' + expected)
    )
      return Response.json(
        { code: 'ACCESS_DENIED' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    try {
      return Response.json(await process(env), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      return Response.json(
        { code: safeCode(error) },
        { status: 500, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}

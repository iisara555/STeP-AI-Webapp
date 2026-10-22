// Explicit, synthetic preview. Never selected automatically for an unconfigured
// deployment and never connected to production Auth, Storage or Gemini.
import type { Host } from './host.ts';
import { ApiError } from './host.ts';
import type { Snapshot, ChatMessage, Run, ReceiptResult } from '../../packages/harness-core/src/contracts.ts';
const tenant = '10000000-0000-4000-8000-000000000001',
  user = '20000000-0000-4000-8000-000000000001',
  workspace = '30000000-0000-4000-8000-000000000001';
export function demoHost(): Host {
  const data: Snapshot = {
    user: { id: user, email: 'employee@example.test', name: 'พนักงานตัวอย่าง' },
    tenants: [
      {
        id: tenant,
        name: 'STeP · ตัวอย่าง',
        active: true,
        storage_limit: 800000000,
        member_storage_limit: 25000000,
        monthly_ai_budget_cents: 1000,
        input_cents_per_million: 50,
        output_cents_per_million: 300,
      },
    ],
    memberships: [
      { tenant_id: tenant, user_id: user, role: 'owner', active: true, email: 'employee@example.test' },
    ],
    workspaces: [
      {
        id: workspace,
        tenant_id: tenant,
        created_by: user,
        name: 'งานของฉัน',
        description: 'พื้นที่ตัวอย่างสำหรับทดลองหน้าจอ',
      },
    ],
    sessions: [],
    memories: [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant,
        owner_id: user,
        workspace_id: null,
        visibility: 'private',
        title: 'รูปแบบคำตอบ',
        body: 'ตอบเป็นภาษาไทย กระชับ และบอกขั้นตอนถัดไป',
        kind: 'preference',
        confirmed: true,
        origin: 'manual',
        expires_at: null,
        created_at: new Date().toISOString(),
      },
    ],
    documents: [],
    skills: [
      {
        id: 'sample-skill',
        skill_key: 'document-outline',
        title: 'เริ่มร่างเอกสาร',
        description: 'จัดโครงร่างและรายการข้อมูลที่ต้องเติม เพื่อเริ่มเขียนได้เร็วขึ้น',
        instructions: '',
        metadata: {},
        source_version: 'demo',
      },
      {
        id: 'sample-receipt',
        skill_key: 'receipt-audit',
        title: 'ตรวจใบเสร็จ AFP',
        description: 'ดูประเภทใบเสร็จ ข้อมูลที่ยังขาด และสิ่งที่ต้องทำต่อ',
        instructions: '',
        metadata: {},
        source_version: 'demo',
      },
    ],
  };
  const messages: Record<string, ChatMessage[]> = {},
    runs: Record<string, Run> = {},
    files: Record<string, Blob> = {},
    reviews: Record<string, ReceiptResult> = {};
  let google = 'not_connected';
  return {
    demo: true,
    async signIn() {},
    async signOut() {},
    async upload(path, file) {
      files[path] = file;
    },
    async download(path) {
      if (!files[path]) throw new ApiError('ACCESS_DENIED');
      return files[path];
    },
    async call<T>(action: string, p: Record<string, unknown> = {}): Promise<T> {
      const result = await (async () => {
        switch (action) {
          case 'snapshot':
            return { ...structuredClone(data), documents: data.documents.filter((d) => !d.derived_from) };
          case 'workspace.create': {
            const row = {
              id: crypto.randomUUID(),
              tenant_id: tenant,
              created_by: user,
              name: String(p.name),
              description: String(p.description || ''),
            };
            data.workspaces.unshift(row);
            return row;
          }
          case 'workspace.share':
            return { ok: true };
          case 'workspace.members':
            return [];
          case 'session.create': {
            const row = {
              id: crypto.randomUUID(),
              tenant_id: tenant,
              owner_id: user,
              workspace_id: p.workspace as string | null,
              visibility: p.visibility as 'private' | 'workspace',
              title: 'เริ่มงานใหม่',
              draft: '',
              version: 1,
            };
            data.sessions.unshift(row);
            messages[row.id] = [];
            return row;
          }
          case 'session.read':
            return {
              session: data.sessions.find((s) => s.id === p.id),
              messages: messages[String(p.id)] || [],
              runs: Object.values(runs).filter((r) => r.session_id === p.id),
            };
          case 'session.delete': {
            data.sessions = data.sessions.filter((s) => s.id !== p.id);
            return { ok: true };
          }
          case 'session.draft': {
            const row = data.sessions.find((s) => s.id === p.id);
            if (!row) throw new ApiError('ACCESS_DENIED');
            if (row.version !== p.version) throw new ApiError('VERSION_CONFLICT');
            row.draft = String(p.draft);
            row.version++;
            return { ...row };
          }
          case 'context.plan':
            return {
              provider: 'Google Gemini API · ตัวอย่าง',
              documents: data.documents.filter((d) => (p.documentIds as string[]).includes(d.id)),
              memories: p.useMemory ? data.memories.map((m) => ({ id: m.id, title: m.title })) : [],
              google: /ประชุม|ปฏิทิน/.test(String(p.message)),
            };
          case 'run.start': {
            const session = data.sessions.find((s) => s.id === p.session);
            if (session) {
              session.title = String(p.message).slice(0, 100);
              messages[session.id].push({
                id: crypto.randomUUID(),
                role: 'user',
                body: String(p.message),
                sources: [],
                created_at: new Date().toISOString(),
              });
            }
            const row: Run = {
              id: crypto.randomUUID(),
              tenant_id: tenant,
              actor_id: user,
              session_id: (p.session as string) || null,
              document_id: (p.document as string) || null,
              kind: p.kind as Run['kind'],
              status: 'queued',
              error_code: null,
              partial: '',
              result: null,
              created_at: new Date().toISOString(),
            };
            runs[row.id] = row;
            return { ...row };
          }
          case 'run.read': {
            const row = runs[String(p.id)];
            if (!row) throw new ApiError('ACCESS_DENIED');
            if (row.status === 'queued' && Date.now() - Date.parse(row.created_at) > 1000) {
              row.status = 'completed';
              const text =
                'นี่คือคำตอบตัวอย่างสำหรับตรวจหน้าจอครับ\n\nระบบจริงจะอ่านเฉพาะเอกสารและความจำที่คุณอนุญาต พร้อมแสดงแหล่งอ้างอิงเมื่อใช้ข้อมูลองค์กร\n\nขั้นตอนถัดไป: เชื่อมต่อบริการและนำเข้าเอกสาร STeP ก่อนเปิดให้พนักงานใช้งานจริง';
              if (row.kind === 'chat') {
                row.result = { text, sources: [] };
                messages[row.session_id!].push({
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  body: text,
                  sources: [],
                  created_at: new Date().toISOString(),
                });
              } else if (row.kind === 'receipt') {
                const receipt: ReceiptResult = {
                  document_type: 'general_receipt',
                  complete: 'uncertain',
                  signature: 'uncertain',
                  checks: [
                    { field: 'วันที่', status: 'found', value: 'ข้อมูลตัวอย่าง', evidence: null },
                    { field: 'ลายเซ็นผู้รับเงิน', status: 'uncertain', value: null, evidence: null },
                  ],
                  next_steps: [
                    'ตรวจวันที่และยอดเงินกับต้นฉบับ',
                    'ให้ผู้รับเงินลงลายเซ็น หากเอกสารและระเบียบกำหนด',
                  ],
                  warnings: ['เป็นข้อมูลตัวอย่าง ไม่ได้อ่านภาพจริง'],
                };
                row.result = { receipt, provenance: 'EXTRACTED_UNVERIFIED' };
              } else row.result = { text: 'ตัวอย่างการอ่านข้อความและค้นเอกสาร' };
            }
            return { ...row };
          }
          case 'run.cancel': {
            const row = runs[String(p.id)];
            if (row) row.status = 'cancelled';
            return { ok: true };
          }
          case 'receipt.history':
            return Object.values(runs).filter((r) => r.kind === 'receipt');
          case 'receipt.review':
            reviews[String(p.id)] = structuredClone(p.result as ReceiptResult);
            return { ok: true };
          case 'receipt.read-review':
            return reviews[String(p.id)]
              ? { review: reviews[String(p.id)], reviewed_at: new Date().toISOString() }
              : null;
          case 'memory.save': {
            const existing = data.memories.find((m) => m.id === p.id);
            if (existing) {
              existing.title = String(p.title);
              existing.body = String(p.body);
              return { ...existing };
            }
            const row = {
              id: crypto.randomUUID(),
              tenant_id: tenant,
              owner_id: user,
              workspace_id: p.workspace as string | null,
              visibility: p.visibility as 'private' | 'workspace',
              title: String(p.title),
              body: String(p.body),
              kind: 'preference' as const,
              confirmed: true,
              origin: 'manual',
              expires_at: null,
              created_at: new Date().toISOString(),
            };
            data.memories.unshift(row);
            return row;
          }
          case 'memory.delete':
            data.memories = data.memories.filter((m) => m.id !== p.id);
            return { ok: true };
          case 'document.create': {
            const id = crypto.randomUUID();
            const row = {
              id,
              tenant_id: tenant,
              owner_id: user,
              workspace_id: p.workspace as string | null,
              visibility: p.visibility as 'private' | 'workspace',
              name: String(p.name),
              mime: String(p.mime),
              bytes: Number(p.bytes),
              derived_from: (p.parent as string | null) || null,
              source_kind: 'upload' as const,
              drive_file_id: null,
              object_path: tenant + '/' + user + '/' + id,
              status: 'uploading' as const,
              error_code: null,
              created_at: new Date().toISOString(),
            };
            data.documents.unshift(row);
            return row;
          }
          case 'document.commit': {
            const row = data.documents.find((d) => d.id === p.id);
            if (row) {
              row.status = 'ready';
              row.extracted_text = String(p.text);
            }
            return row;
          }
          case 'document.delete':
            data.documents = data.documents.filter((d) => d.id !== p.id);
            return { ok: true };
          case 'google.state':
            return {
              status: google,
              services: google === 'not_connected' ? [] : ['calendar-read', 'drive-selected'],
            };
          case 'google.control':
            google = p.state === 'disconnect' ? 'not_connected' : String(p.state);
            return { ok: true };
          case 'google.connect':
            google = 'ready';
            return { url: location.href };
          case 'usage':
            return {
              runs: Object.values(runs).map((r) => ({
                ...r,
                input_tokens: 0,
                output_tokens: 0,
                reserved_cents: 0,
              })),
              visibleBytes: data.documents.reduce((n, d) => n + d.bytes, 0),
              aiConfigured: true,
              model: 'Gemini · ตัวอย่าง',
            };
          case 'admin.openrouter.status':
            return { configured: true, dailyLimit: 40, minuteLimit: 5 };
          case 'admin.openrouter.models':
            return { models: [{ id: 'synthetic/example:free', name: 'โมเดลจำลอง (free)' }] };
          case 'admin.openrouter.test':
            if (!p.consent || p.model !== 'synthetic/example:free') throw new ApiError('INVALID_REQUEST');
            return {
              model: 'synthetic/example:free',
              text: 'คำตอบจำลองสำหรับทดลองหน้าจอ OpenRouter เท่านั้น',
              inputTokens: 20,
              outputTokens: 15,
              elapsedMs: 100,
              cost: 0,
              truncated: false,
            };
          case 'admin.members':
            return { members: data.memberships, invites: [] };
          case 'admin.invite':
            return { ok: true };
          case 'admin.ai':
            data.tenants[0].monthly_ai_budget_cents = Number(p.budgetCents);
            return { ok: true };
          default:
            throw new ApiError('DEMO_UNAVAILABLE');
        }
      })();
      return structuredClone(result) as T;
    },
  };
}

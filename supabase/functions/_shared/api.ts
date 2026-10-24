import { z } from 'zod';
import {
  assertSafeText,
  chunkText,
  errorView,
  selectMemories,
  validateMemory,
} from '../../../packages/harness-core/src/index.ts';
import type {
  Memory,
  Conversation,
  DocumentRecord,
  Skill,
} from '../../../packages/harness-core/src/contracts.ts';
import {
  authenticate,
  checked,
  cors,
  jsonBody,
  member,
  safeCode,
  type Actor,
  type Environment,
} from './runtime.ts';
import {
  beginGoogle,
  driveMetadata,
  googleAccess,
  googleState,
  setGoogleState,
  wantsCalendar,
} from './google.ts';
import { validFile } from './files.ts';
import { receiptSchema } from './receipt.ts';
import { openrouter, trialConfigured } from './openrouter.ts';
import { aiService, requireProviderConsent } from './ai.ts';
import { literalSearch } from '../../../packages/harness-core/src/desktop-workflows.ts';
import { normalizeProfile } from '../../../packages/harness-core/src/assistant-profile.ts';

const uuid = z.string().uuid();
const visibility = z.enum(['private', 'workspace']);
const tenantRequest = z.object({ tenant: uuid });
const resource = z.object({ tenant: uuid, id: uuid });
const start = z.object({
  tenant: uuid,
  session: uuid.optional(),
  document: uuid.optional(),
  kind: z.enum(['chat', 'document', 'receipt']),
  requestId: uuid,
  message: z.string().trim().min(1).max(20000).optional(),
  skill: z.string().max(100).optional(),
  documentIds: z.array(uuid).max(8).default([]),
  useMemory: z.boolean().default(true),
  consent: z.literal(true),
  providerConsent: z.string().min(1).max(1000),
  googleConsent: z.boolean().default(false),
});
export async function contextPlan(
  actor: Actor,
  input: { tenant: string; session: string; message: string; documentIds: string[]; useMemory: boolean },
) {
  const s = await checked<Conversation | null>(
    actor.userDb
      .from('sessions')
      .select('*')
      .eq('tenant_id', input.tenant)
      .eq('id', input.session)
      .maybeSingle(),
  );
  if (!s) throw new Error('ACCESS_DENIED');
  if (s.visibility === 'workspace' && wantsCalendar(input.message)) throw new Error('GOOGLE_PRIVATE_CONTEXT');
  const docs = input.documentIds.length
    ? await checked(
        actor.userDb
          .from('documents')
          .select('id,name,visibility,owner_id,workspace_id,source_kind,status')
          .eq('tenant_id', input.tenant)
          .in('id', input.documentIds),
      )
    : [];
  if (
    docs.length !== new Set(input.documentIds).size ||
    docs.some(
      (d) =>
        d.status !== 'ready' ||
        (s.visibility === 'workspace' &&
          (d.visibility === 'private' || d.source_kind === 'drive' || d.workspace_id !== s.workspace_id)),
    )
  )
    throw new Error('ACCESS_DENIED');
  const rows = input.useMemory
    ? await checked(
        actor.userDb.from('memories').select('*').eq('tenant_id', input.tenant).eq('confirmed', true),
      )
    : [];
  const now = Date.now();
  const memoryRows = rows.filter(
    (m) =>
      (!m.expires_at || Date.parse(m.expires_at) > now) &&
      ((m.visibility === 'private' && m.owner_id === actor.user.id) ||
        (m.visibility === 'workspace' && m.workspace_id === s.workspace_id)),
  );
  const memories = selectMemories(memoryRows as Memory[], input.message, s.visibility);
  const profile = await checked(
    actor.userDb
      .from('member_profiles')
      .select('user_id')
      .eq('tenant_id', input.tenant)
      .eq('user_id', actor.user.id)
      .maybeSingle(),
  );
  return {
    session: s,
    documents: docs,
    memories: memories.map((m) => ({ id: m.id, title: m.title, visibility: m.visibility })),
    google: wantsCalendar(input.message),
    // The employee's own name and answer style travel with the request; the preview says so.
    profile: Boolean(profile),
  };
}
async function snapshot(actor: Actor, env: Environment) {
  await checked(actor.userDb.rpc('accept_invites'));
  const [tenants, memberships, workspaces, sessions, memories, documents, skills, profiles] =
    await Promise.all([
      checked(actor.userDb.from('tenants').select('*')),
      checked(actor.userDb.from('tenant_members').select('*').eq('user_id', actor.user.id)),
      checked(actor.userDb.from('workspaces').select('*').order('created_at', { ascending: false })),
      checked(actor.userDb.from('sessions').select('*').order('created_at', { ascending: false }).limit(200)),
      checked(actor.userDb.from('memories').select('*').order('created_at', { ascending: false }).limit(200)),
      checked(
        actor.userDb
          .from('documents')
          .select(
            'id,tenant_id,owner_id,workspace_id,visibility,name,mime,bytes,source_kind,drive_file_id,object_path,status,error_code,created_at',
          )
          .is('derived_from', null)
          .order('created_at', { ascending: false })
          .limit(200),
      ),
      checked(
        actor.userDb
          .from('skills')
          .select('id,tenant_id,skill_key,title,description,metadata,source_version'),
      ),
      checked(actor.userDb.from('member_profiles').select('*').eq('user_id', actor.user.id)),
    ]);
  return {
    ai: aiService(env),
    user: { id: actor.user.id, email: actor.user.email, name: actor.user.user_metadata?.full_name || '' },
    tenants,
    memberships,
    workspaces,
    sessions,
    memories,
    documents,
    skills,
    profiles,
  };
}
export async function dispatch(
  actor: Actor,
  action: string,
  input: unknown,
  env: Environment,
  fetcher: typeof fetch = fetch,
) {
  const db = actor.userDb;
  if (action === 'snapshot') return snapshot(actor, env);
  const base = tenantRequest.parse(input);
  await member(actor, base.tenant);
  switch (action) {
    case 'admin.openrouter.status': {
      await member(actor, base.tenant, true);
      return { configured: trialConfigured(env, base.tenant), dailyLimit: 40, minuteLimit: 5 };
    }
    case 'admin.openrouter.models':
    case 'admin.openrouter.test': {
      await member(actor, base.tenant, true);
      if (!trialConfigured(env, base.tenant)) throw new Error('OPENROUTER_NOT_CONFIGURED');
      const provider = openrouter(env, fetcher);
      if (action === 'admin.openrouter.models') return { models: await provider.models() };
      const p = tenantRequest
        .extend({
          model: z
            .string()
            .regex(/^[a-zA-Z0-9_./-]+:free$/)
            .max(200),
          prompt: z.string().trim().min(1).max(4000),
          consent: z.literal(true),
          requestId: uuid,
        })
        .strict()
        .parse(input);
      assertSafeText(p.prompt);
      await checked(
        actor.service.rpc('reserve_openrouter_trial', {
          t: p.tenant,
          u: actor.user.id,
          request_id: p.requestId,
        }),
      );
      const result = await provider.generate(p.model, p.prompt);
      await member(actor, p.tenant, true);
      return result;
    }
    case 'workspace.create': {
      const p = tenantRequest
        .extend({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).default('') })
        .parse(input);
      return checked(
        db
          .from('workspaces')
          .insert({
            tenant_id: p.tenant,
            created_by: actor.user.id,
            name: p.name,
            description: p.description,
          })
          .select()
          .single(),
      );
    }
    case 'workspace.share': {
      const p = resource.extend({ email: z.email(), role: z.enum(['editor', 'viewer']) }).parse(input);
      await checked(
        db.rpc('add_workspace_member', { t: p.tenant, w: p.id, member_email: p.email, member_role: p.role }),
      );
      return { ok: true };
    }
    case 'workspace.members': {
      const p = resource.parse(input);
      return checked(
        db.from('workspace_members').select('*').eq('tenant_id', p.tenant).eq('workspace_id', p.id),
      );
    }
    case 'workspace.remove-member': {
      const p = resource.extend({ userId: uuid }).parse(input);
      await checked(
        db
          .from('workspace_members')
          .delete()
          .eq('tenant_id', p.tenant)
          .eq('workspace_id', p.id)
          .eq('user_id', p.userId),
      );
      return { ok: true };
    }
    case 'session.create': {
      const p = tenantRequest
        .extend({
          workspace: uuid.nullable(),
          visibility,
          title: z.string().trim().min(1).max(160).default('เริ่มงานใหม่'),
        })
        .parse(input);
      return checked(
        db
          .from('sessions')
          .insert({
            tenant_id: p.tenant,
            owner_id: actor.user.id,
            workspace_id: p.workspace,
            visibility: p.visibility,
            title: p.title,
          })
          .select()
          .single(),
      );
    }
    case 'session.search': {
      const p = tenantRequest.extend({ query: z.string().trim().min(1).max(100) }).parse(input);
      const pattern = literalSearch(p.query);
      // User-scoped queries retain RLS on both messages and sessions. No service client/search provider.
      const [titles, drafts, messages] = await Promise.all([
        checked(db.from('sessions').select('id').eq('tenant_id', p.tenant).ilike('title', pattern).limit(50)),
        checked(db.from('sessions').select('id').eq('tenant_id', p.tenant).ilike('draft', pattern).limit(50)),
        checked(
          db.from('messages').select('session_id').eq('tenant_id', p.tenant).ilike('body', pattern).limit(50),
        ),
      ]);
      const ids = [
        ...new Set([...titles, ...drafts].map((s) => s.id).concat(messages.map((m) => m.session_id))),
      ];
      if (!ids.length) return [];
      return checked(
        db
          .from('sessions')
          .select('*')
          .eq('tenant_id', p.tenant)
          .in('id', ids)
          .order('created_at', { ascending: false })
          .limit(50),
      );
    }
    case 'skill.read': {
      const p = tenantRequest.extend({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/) }).parse(input);
      const skill = await checked<Skill | null>(
        db.from('skills').select('*').eq('tenant_id', p.tenant).eq('skill_key', p.key).maybeSingle(),
      );
      if (!skill || skill.metadata.developerOnly) throw new Error('ACCESS_DENIED');
      return skill;
    }
    case 'session.read': {
      const p = resource.parse(input);
      const session = await checked(
        db.from('sessions').select('*').eq('tenant_id', p.tenant).eq('id', p.id).maybeSingle(),
      );
      if (!session) throw new Error('ACCESS_DENIED');
      const [messages, runs] = await Promise.all([
        checked(
          db
            .from('messages')
            .select('*')
            .eq('tenant_id', p.tenant)
            .eq('session_id', p.id)
            .order('created_at')
            .limit(500),
        ),
        checked(
          db
            .from('runs')
            .select(
              'id,tenant_id,actor_id,session_id,document_id,kind,status,partial,result,error_code,created_at',
            )
            .eq('tenant_id', p.tenant)
            .eq('session_id', p.id)
            .order('created_at', { ascending: false })
            .limit(5),
        ),
      ]);
      return { session, messages, runs };
    }
    case 'session.draft': {
      const p = resource
        .extend({ version: z.number().int().positive(), draft: z.string().max(200000) })
        .parse(input);
      return checked(
        db.rpc('save_draft', { t: p.tenant, s: p.id, expected_version: p.version, body: p.draft }),
      );
    }
    case 'session.delete': {
      const p = resource.parse(input);
      await checked(db.from('sessions').delete().eq('tenant_id', p.tenant).eq('id', p.id));
      return { ok: true };
    }
    case 'memory.save': {
      const p = tenantRequest
        .extend({
          workspace: uuid.nullable(),
          visibility,
          title: z.string().max(120),
          body: z.string().max(4000),
          id: uuid.optional(),
          kind: z.enum(['preference', 'reference', 'feedback', 'project']).default('preference'),
          // Days until the memory stops being used; 0 keeps it until deleted, as on Desktop.
          ttlDays: z.number().int().min(0).max(3650).default(0),
          // Where a new memory came from, shown beside it as on Desktop.
          origin: z.enum(['manual', 'chat']).default('manual'),
        })
        .parse(input);
      const safe = validateMemory(p.title, p.body);
      const expires_at = p.ttlDays ? new Date(Date.now() + p.ttlDays * 86_400_000).toISOString() : null;
      if (p.id)
        return checked(
          db
            .from('memories')
            .update({
              ...safe,
              kind: p.kind,
              expires_at,
              confirmed: true,
              updated_at: new Date().toISOString(),
            })
            .eq('tenant_id', p.tenant)
            .eq('id', p.id)
            .eq('owner_id', actor.user.id)
            .select()
            .single(),
        );
      const count = await db
        .from('memories')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', p.tenant)
        .eq('owner_id', actor.user.id);
      if (count.error) throw new Error('DATA_ERROR');
      if ((count.count || 0) >= 200) throw new Error('MEMORY_LIMIT');
      return checked(
        db
          .from('memories')
          .insert({
            ...safe,
            tenant_id: p.tenant,
            owner_id: actor.user.id,
            workspace_id: p.workspace,
            visibility: p.visibility,
            kind: p.kind,
            expires_at,
            origin: p.origin,
            confirmed: true,
          })
          .select()
          .single(),
      );
    }
    case 'profile.save': {
      const p = tenantRequest
        .extend({
          display_name: z.string().max(60).default(''),
          team: z.string().max(20).default(''),
          avatar: z.string().max(20).default(''),
          assistant_name: z.string().max(60).default(''),
          chat_language: z.enum(['auto', 'th', 'en']).default('auto'),
          personality: z.enum(['coworker', 'professional', 'concise', 'custom']).default('coworker'),
          assistant_tone: z.string().max(300).default(''),
          interaction_style: z.enum(['standard', 'witty', 'ob-oon']).default('standard'),
          language_style: z.enum(['standard', 'northern-thai']).default('standard'),
        })
        .parse(input);
      const profile = normalizeProfile(p);
      // Names and the custom tone reach the AI prompt, so they follow the same credential checks as messages.
      assertSafeText([profile.display_name, profile.assistant_name, profile.assistant_tone].join('\n'));
      await member(actor, p.tenant);
      const updated_at = new Date().toISOString();
      // Ownership columns are never updated: change the employee's own row, or create it the first time.
      const changed = await checked(
        db
          .from('member_profiles')
          .update({ ...profile, updated_at })
          .eq('tenant_id', p.tenant)
          .eq('user_id', actor.user.id)
          .select(),
      );
      if (changed.length) return changed[0];
      return checked(
        db
          .from('member_profiles')
          .insert({ ...profile, tenant_id: p.tenant, user_id: actor.user.id, updated_at })
          .select()
          .single(),
      );
    }
    case 'memory.delete': {
      const p = resource.parse(input);
      await checked(
        db.from('memories').delete().eq('tenant_id', p.tenant).eq('id', p.id).eq('owner_id', actor.user.id),
      );
      return { ok: true };
    }
    case 'document.create': {
      const p = tenantRequest
        .extend({
          workspace: uuid.nullable(),
          visibility,
          name: z.string().max(200),
          mime: z.string().max(150),
          bytes: z.number().int().min(1).max(10485760),
          parent: uuid.optional(),
        })
        .parse(input);
      return checked(
        db.rpc('create_document', {
          t: p.tenant,
          w: p.workspace,
          visibility: p.visibility,
          file_name: p.name,
          file_mime: p.mime,
          file_bytes: p.bytes,
          parent_document: p.parent || null,
        }),
      );
    }
    case 'document.commit': {
      const p = resource.extend({ text: z.string().max(200000).default('') }).parse(input);
      const doc = await checked<DocumentRecord | null>(
        db
          .from('documents')
          .select('*')
          .eq('tenant_id', p.tenant)
          .eq('id', p.id)
          .eq('owner_id', actor.user.id)
          .maybeSingle(),
      );
      if (!doc || doc.status !== 'uploading' || doc.source_kind !== 'upload' || !doc.object_path)
        throw new Error('ACCESS_DENIED');
      const blob = await checked(actor.service.storage.from('documents').download(doc.object_path));
      if (blob.size !== doc.bytes || !validFile(new Uint8Array(await blob.arrayBuffer()), doc.mime))
        throw new Error('FILE_INVALID');
      const chunks = chunkText(p.text);
      if (chunks.length)
        await checked(
          actor.service
            .from('document_chunks')
            .insert(chunks.map((c) => ({ ...c, tenant_id: p.tenant, document_id: p.id }))),
        );
      return checked(
        actor.service
          .from('documents')
          .update({ status: 'ready', extracted_text: p.text, source_version: new Date().toISOString() })
          .eq('id', p.id)
          .eq('tenant_id', p.tenant)
          .select()
          .single(),
      );
    }
    case 'document.delete': {
      const p = resource.parse(input);
      const doc = await checked<DocumentRecord | null>(
        db
          .from('documents')
          .select('*')
          .eq('tenant_id', p.tenant)
          .eq('id', p.id)
          .eq('owner_id', actor.user.id)
          .maybeSingle(),
      );
      if (!doc) throw new Error('ACCESS_DENIED');
      await checked(
        actor.service
          .from('documents')
          .update({ deleted_at: new Date().toISOString() })
          .eq('tenant_id', p.tenant)
          .eq('id', p.id),
      );
      const derived = await checked(
        actor.service
          .from('documents')
          .select('object_path')
          .eq('tenant_id', p.tenant)
          .eq('derived_from', p.id),
      );
      const paths = [doc.object_path, ...derived.map((d) => d.object_path)].filter((p): p is string =>
        Boolean(p),
      );
      if (paths.length) await checked(actor.service.storage.from('documents').remove(paths));
      await checked(actor.service.from('documents').delete().eq('tenant_id', p.tenant).eq('id', p.id));
      return { ok: true };
    }
    case 'document.drive': {
      const p = tenantRequest
        .extend({ fileId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), workspace: uuid.nullable() })
        .parse(input);
      const { metadata } = await driveMetadata(actor.service, p.tenant, actor.user.id, p.fileId, env);
      return checked(
        actor.service
          .from('documents')
          .insert({
            tenant_id: p.tenant,
            owner_id: actor.user.id,
            workspace_id: null,
            visibility: 'private',
            source_kind: 'drive',
            drive_file_id: p.fileId,
            name: String(metadata.name).slice(0, 200),
            mime: metadata.mimeType,
            bytes: 0,
            status: 'ready',
            source_version: String(metadata.version || metadata.modifiedTime),
          })
          .select()
          .single(),
      );
    }
    case 'context.plan': {
      const p = tenantRequest
        .extend({
          session: uuid,
          message: z.string().max(20000),
          documentIds: z.array(uuid).max(8),
          useMemory: z.boolean(),
        })
        .parse(input);
      const info = aiService(env);
      return {
        ...(await contextPlan(actor, p)),
        provider: info.displayName,
        providerConsent: info.consentId,
      };
    }
    case 'knowledge.read': {
      const p = tenantRequest.extend({ key: z.string().min(1).max(120) }).parse(input);
      if (p.key.startsWith('__')) throw new Error('ACCESS_DENIED');
      const row = await checked(
        db
          .from('knowledge_sources')
          .select('title,body')
          .eq('tenant_id', p.tenant)
          .eq('source_key', p.key)
          .maybeSingle(),
      );
      if (!row) throw new Error('ACCESS_DENIED');
      return row;
    }
    case 'run.start': {
      const p = start.parse(input);
      const info = requireProviderConsent(env, p.providerConsent);
      if (!info.configured) throw new Error('AI_NOT_CONFIGURED');
      if (info.provider === 'openrouter_free') {
        await member(actor, p.tenant, true);
        if (p.kind !== 'chat') throw new Error('AI_TRIAL_TEXT_ONLY');
      }
      if (p.kind === 'chat') {
        if (!p.session || !p.message) throw new Error('INVALID_REQUEST');
        assertSafeText(p.message);
        const plan = await contextPlan(actor, {
          tenant: p.tenant,
          session: p.session,
          message: p.message,
          documentIds: p.documentIds,
          useMemory: p.useMemory,
        });
        if (plan.google && !p.googleConsent) throw new Error('GOOGLE_CONSENT_REQUIRED');
      }
      return checked(
        db.rpc('start_run', {
          t: p.tenant,
          s: p.session || null,
          d: p.document || null,
          job_kind: p.kind,
          request: p.requestId,
          payload: {
            message: p.message || '',
            skill: p.skill || null,
            documentIds: p.documentIds,
            useMemory: p.useMemory,
            consent: true,
            aiProvider: info.provider,
            providerConsent: info.consentId,
            googleConsent: p.googleConsent,
          },
        }),
      );
    }
    case 'run.read': {
      const p = resource.parse(input);
      const row = await checked(
        db
          .from('runs')
          .select(
            'id,tenant_id,actor_id,session_id,document_id,kind,status,error_code,partial,result,created_at',
          )
          .eq('tenant_id', p.tenant)
          .eq('id', p.id)
          .maybeSingle(),
      );
      if (!row) throw new Error('ACCESS_DENIED');
      return row;
    }
    case 'run.cancel': {
      const p = resource.parse(input);
      await checked(db.rpc('cancel_run', { t: p.tenant, job: p.id }));
      return { ok: true };
    }
    case 'receipt.history':
      return checked(
        db
          .from('runs')
          .select(
            'id,tenant_id,actor_id,session_id,document_id,kind,status,error_code,partial,result,created_at',
          )
          .eq('tenant_id', base.tenant)
          .eq('actor_id', actor.user.id)
          .eq('kind', 'receipt')
          .order('created_at', { ascending: false })
          .limit(20),
      );
    case 'receipt.read-review': {
      const p = resource.parse(input);
      return checked(
        db
          .from('receipt_reviews')
          .select('review,reviewed_at')
          .eq('tenant_id', p.tenant)
          .eq('run_id', p.id)
          .eq('owner_id', actor.user.id)
          .maybeSingle(),
      );
    }
    case 'receipt.review': {
      const p = resource
        .extend({ document: uuid, result: receiptSchema, sourceConfirmed: z.literal(true) })
        .parse(input);
      assertSafeText(JSON.stringify(p.result));
      return checked(
        db.rpc('save_receipt_review', {
          t: p.tenant,
          r: p.id,
          d: p.document,
          reviewed: p.result,
          source_checked: true,
        }),
      );
    }
    case 'google.state':
      return googleState(actor.service, base.tenant, actor.user.id);
    case 'google.connect': {
      const p = tenantRequest
        .extend({
          services: z
            .array(z.enum(['calendar-read', 'drive-selected']))
            .min(1)
            .max(2),
        })
        .parse(input);
      return beginGoogle(actor, p.tenant, p.services, env);
    }
    case 'google.control': {
      const p = tenantRequest.extend({ state: z.enum(['ready', 'paused', 'disconnect']) }).parse(input);
      await setGoogleState(actor.service, p.tenant, actor.user.id, p.state);
      return { ok: true };
    }
    case 'google.picker': {
      const token = await googleAccess(actor.service, base.tenant, actor.user.id, 'drive-selected', env);
      const key = env('GOOGLE_PICKER_API_KEY'),
        appId = env('GOOGLE_PROJECT_NUMBER');
      if (!key || !appId) throw new Error('GOOGLE_PICKER_NOT_CONFIGURED');
      return { accessToken: token, apiKey: key, appId };
    }
    case 'admin.members': {
      await member(actor, base.tenant, true);
      return {
        members: await checked(db.from('tenant_members').select('*').eq('tenant_id', base.tenant)),
        invites: await checked(db.from('tenant_invites').select('*').eq('tenant_id', base.tenant)),
      };
    }
    case 'admin.invite': {
      const p = tenantRequest
        .extend({ email: z.email(), role: z.enum(['member', 'admin']).default('member') })
        .parse(input);
      await checked(db.rpc('invite_member', { t: p.tenant, invite_email: p.email, member_role: p.role }));
      return { ok: true };
    }
    case 'admin.member-state': {
      const p = tenantRequest.extend({ userId: uuid, active: z.boolean() }).parse(input);
      await checked(db.rpc('set_member_active', { t: p.tenant, member: p.userId, enabled: p.active }));
      return { ok: true };
    }
    case 'admin.ai': {
      const p = tenantRequest
        .extend({
          budgetCents: z.number().int().min(0).max(100000),
          inputRate: z.number().positive().max(100000),
          outputRate: z.number().positive().max(100000),
        })
        .parse(input);
      const info = aiService(env);
      if (info.provider !== 'gemini') throw new Error('AI_FREE_UNAVAILABLE');
      if (!info.configured && p.budgetCents > 0) throw new Error('AI_NOT_CONFIGURED');
      await checked(
        db.rpc('configure_ai', {
          t: p.tenant,
          budget_cents: p.budgetCents,
          input_rate: p.inputRate,
          output_rate: p.outputRate,
        }),
      );
      return { ok: true };
    }
    case 'admin.ai-trial': {
      const p = tenantRequest
        .extend({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(50) })
        .parse(input);
      const info = aiService(env);
      if (info.provider !== 'openrouter_free') throw new Error('AI_FREE_UNAVAILABLE');
      if (p.enabled && !info.configured) throw new Error('AI_NOT_CONFIGURED');
      await checked(
        db.rpc('configure_free_trial', { t: p.tenant, enabled: p.enabled, daily_limit: p.dailyLimit }),
      );
      return { ok: true };
    }
    case 'usage': {
      const usage = await checked(db.rpc('usage_summary', { t: base.tenant }));
      return {
        ...usage,
        aiConfigured: aiService(env).configured,
        model: aiService(env).model,
        ai: aiService(env),
      };
    }
    default:
      throw new Error('UNKNOWN_ACTION');
  }
}
export function createApi(
  env: Environment,
  options: {
    authenticate?: typeof authenticate;
    dispatch?: typeof dispatch;
    kick?: () => Promise<unknown>;
  } = {},
) {
  return async (request: Request): Promise<Response> => {
    let headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    const requestId = crypto.randomUUID();
    try {
      headers = cors(request, env);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST')
        return Response.json({ code: 'METHOD_NOT_ALLOWED', requestId }, { status: 405, headers });
      const actor = await (options.authenticate || authenticate)(request, env);
      const body = z
        .object({ action: z.string().min(1).max(60), input: z.unknown() })
        .parse(await jsonBody(request));
      const result = await (options.dispatch || dispatch)(actor, body.action, body.input, env);
      if (body.action === 'run.start' && options.kick) void options.kick().catch(() => {});
      return Response.json({ data: result, requestId }, { headers });
    } catch (error) {
      const code = error instanceof z.ZodError ? 'INVALID_REQUEST' : safeCode(error);
      return Response.json(
        { code, ...errorView(code), requestId },
        {
          status:
            code === 'UNAUTHENTICATED'
              ? 401
              : code === 'ACCESS_DENIED' || code === 'ORIGIN_DENIED'
                ? 403
                : code === 'INTERNAL_ERROR' || code === 'DATA_ERROR'
                  ? 500
                  : 400,
          headers,
        },
      );
    }
  };
}

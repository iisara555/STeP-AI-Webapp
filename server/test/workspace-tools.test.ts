import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, serverPolicy, type Runtime } from '../src/engine.ts';
import { workspaceInstructions, workspaceToolsHost } from '../src/workspace-tools.ts';
import { runtimeEnv } from '../src/workspace/process-driver.ts';

const tool = (name: string, input: string, args?: Record<string, unknown>) =>
  '```step-tool\n' + JSON.stringify({ tool: name, input, ...(args ? { args } : {}) }) + '\n```';

test('the Cloud Workspace policy turns on only the tool loop; every other risky feature stays off', () => {
  assert.equal(serverPolicy().features.toolLoop, false);
  const policy = serverPolicy({ workspaceTools: true });
  assert.equal(policy.features.toolLoop, true);
  for (const off of ['shellByAi', 'autoMode', 'autopilot', 'sandbox', 'mcp', 'vault', 'staffSkills'] as const)
    assert.equal(policy.features[off], false, off);
  assert.equal(policy.checks.privacy, true);
});

// Synthetic provider only: nothing leaves the process.
test('a Workspace run reads a STeP document and its own file on the server, then answers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-tools-'));
  const files = join(dir, 'files');
  await mkdir(files);
  await writeFile(join(files, 'notes.md'), 'บันทึกทดสอบของ Workspace นี้');
  const prompts: string[] = [];
  const runtime: Runtime = async () => ({
    adapter: {
      run: async (prompt: string, _connection: unknown, context: any) => {
        if (!context.system?.includes('Tools in this Cloud Workspace')) return 'คำตอบทั่วไป';
        prompts.push(prompt);
        if (!prompt.includes('<tool_results>')) return tool('reference', 'receipt-buyer-identity');
        if (!prompt.includes('บันทึกทดสอบ')) return tool('files', 'notes.md');
        return 'ผู้ซื้อตามเอกสาร STeP และบันทึกใน Workspace ตรงกัน';
      },
    } as any,
    context: { cwd: files, env: {} },
  });
  const engine = await createEngine({
    dataDir: dir,
    runtime,
    policy: serverPolicy({ workspaceTools: true }),
    workspaceTools: { filesDir: files },
    publicSearch: async () => '',
  });
  engine.store.put('connection', 'central', {
    id: 'central',
    provider: 'compatible',
    mode: 'api',
    ready: true,
  });
  try {
    const session = engine.store.create('central', 'cc');
    await engine.work.run(
      session.id,
      'ชื่อผู้ซื้อในใบเสร็จต้องเป็นอะไร เทียบกับ notes.md',
      '',
      true,
      undefined,
      'chat',
    );
    const done = engine.store.session(session.id);
    assert.equal(done.status, 'review', JSON.stringify(done.runs?.at(-1)));
    assert.match(done.messages.at(-1)?.text || '', /ตรงกัน/);
    const used = done.runs?.at(-1)?.steps?.flatMap((step) => step.tools || []) || [];
    assert.ok(used.some((t) => t.tool === 'reference' && t.ok));
    assert.ok(used.some((t) => t.tool === 'files' && t.ok));
    assert.ok(prompts.some((prompt) => prompt.includes('0994000423179')));
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Workspace host reads only this Workspace, only text, and never runs other tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-host-'));
  const files = join(dir, 'files');
  await mkdir(join(files, 'sub'), { recursive: true });
  await writeFile(join(files, 'a.md'), 'x'.repeat(50_000));
  await writeFile(join(files, 'secret.md'), 'เลขบัตร secret');
  await writeFile(join(dir, 'outside.md'), 'ไม่ใช่ของ Workspace');
  await symlink(join(dir, 'outside.md'), join(files, 'link.md'));
  await writeFile(join(files, 'tool.exe'), 'MZ');
  const engine = await createEngine({
    dataDir: dir,
    runtime: async () => ({}) as any,
    publicSearch: async () => '',
  });
  const controller = new AbortController();
  const host = workspaceToolsHost(
    {
      query: 'q',
      request: 'q',
      sessionId: 's',
      team: 'cc',
      connection: {} as any,
      contract: { mode: 'GENERAL', authority: { status: 'ALLOW' } },
      signal: controller.signal,
      cancel() {},
      activity() {},
      search: async () => '',
    },
    engine.harness,
    {
      filesDir: files,
      privacy: (text) => ({
        action: text.includes('secret') ? 'block-external' : 'pass',
        redactedText: text,
      }),
    },
  );
  const run = (name: any, input: string, args?: Record<string, unknown>) =>
    host.execute({ tool: name, input, ...(args ? { args } : {}) }, controller.signal);
  try {
    const first: any = await run('files', 'a.md');
    assert.equal(first.text.length, 40_000);
    assert.equal(first.nextOffset, 40_000);
    assert.equal(((await run('files', 'a.md', { offset: 40_000 })) as any).text.length, 10_000);
    // A symbolic link is not listed, and reading it is refused below.
    const listed: any = await run('files', '.', { action: 'list' });
    assert.deepEqual(listed.entries.map((e: any) => e.name).sort(), ['a.md', 'secret.md', 'sub', 'tool.exe']);
    await assert.rejects(() => run('files', '../outside.md'), /INVALID_PATH/);
    await assert.rejects(() => run('files', 'link.md'), /INVALID_PATH/);
    await assert.rejects(() => run('files', 'tool.exe'), /ATTACH_UNSUPPORTED/);
    await assert.rejects(() => run('files', 'secret.md'), /PRIVACY_REVIEW_REQUIRED/);
    for (const name of ['terminal', 'changes', 'web_fetch', 'browser_control', 'mcp_call', 'patch'])
      await assert.rejects(() => run(name, 'x'), /TOOL_DENIED/);
    await assert.rejects(
      () => host.execute({ tool: 'files', input: 'a.md', content: 'write' }, controller.signal),
      /TOOL_DENIED/,
    );
    await assert.rejects(() => run('reference', 'not-a-document'), /REFERENCE_UNAVAILABLE/);
    const outline: any = await run('reference', 'receipt-buyer-identity', { action: 'outline' });
    assert.ok(outline.sections.length > 0);
    await assert.rejects(() => run('skill', 'no-such-skill'), /SKILL_NOT_ROUTED/);
    const skills: any = await run('skill', '', { action: 'catalog' });
    assert.ok(skills.entries.length > 0);
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a blocked route stops every Workspace tool', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-blocked-'));
  await mkdir(join(dir, 'files'));
  const engine = await createEngine({
    dataDir: dir,
    runtime: async () => ({}) as any,
    publicSearch: async () => '',
  });
  const controller = new AbortController();
  const host = workspaceToolsHost(
    {
      query: 'q',
      sessionId: 's',
      team: 'cc',
      connection: {} as any,
      contract: { mode: 'BLOCK', authority: { status: 'DENY' } },
      signal: controller.signal,
      cancel() {},
      activity() {},
      search: async () => '',
    },
    engine.harness,
    { filesDir: join(dir, 'files'), privacy: (text) => ({ action: 'pass', redactedText: text }) },
  );
  try {
    await assert.rejects(
      () => host.execute({ tool: 'reference', input: 'receipt-buyer-identity' }, controller.signal),
      /AUTHORITY_REVIEW_REQUIRED/,
    );
  } finally {
    engine.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the instructions name this Workspace's own files, without names the privacy check would change", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'step-workspace-names-'));
  try {
    const privacy = (text: string) =>
      /\d{10}/.test(text)
        ? { action: 'auto-mask', redactedText: text.replace(/\d{10}/, '[masked]') }
        : { action: 'pass', redactedText: text };
    assert.match(workspaceInstructions(dir, privacy), /This Workspace has no files yet\./);
    await mkdir(join(dir, 'งบ'));
    await mkdir(join(dir, 'งบ', 'deep'));
    await writeFile(join(dir, 'notes.md'), 'x');
    await writeFile(join(dir, 'งบ', 'ใบเสร็จ.csv'), 'x');
    await writeFile(join(dir, 'งบ', 'deep', 'hidden-depth.md'), 'x');
    await writeFile(join(dir, 'สมชาย 0812345678.txt'), 'x');
    await writeFile(join(dir, '.secret'), 'x');
    const text = workspaceInstructions(dir, privacy);
    assert.match(text, /Files in this Workspace \(read them with files\): notes\.md, งบ\/ใบเสร็จ\.csv\./);
    assert.match(text, /never say a file is missing/);
    for (const hidden of ['0812345678', '.secret', 'hidden-depth'])
      assert.equal(text.includes(hidden), false, hidden);
    for (let i = 0; i < 50; i++) await writeFile(join(dir, `f${String(i).padStart(2, '0')}.md`), 'x');
    const listed = workspaceInstructions(dir, privacy).split('read them with files): ')[1].split(', ');
    assert.equal(listed.length, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Gateway switch STEP_WORKSPACE_TOOLS=0 reaches the runtime; nothing else is passed', () => {
  const spec = { workspaceId: 'w1', dir: '/tmp/w1' } as any;
  const before = process.env.STEP_WORKSPACE_TOOLS;
  try {
    delete process.env.STEP_WORKSPACE_TOOLS;
    assert.equal(runtimeEnv(spec).STEP_WORKSPACE_TOOLS, undefined);
    process.env.STEP_WORKSPACE_TOOLS = '1';
    assert.equal(runtimeEnv(spec).STEP_WORKSPACE_TOOLS, undefined);
    process.env.STEP_WORKSPACE_TOOLS = '0';
    assert.equal(runtimeEnv(spec).STEP_WORKSPACE_TOOLS, '0');
  } finally {
    if (before === undefined) delete process.env.STEP_WORKSPACE_TOOLS;
    else process.env.STEP_WORKSPACE_TOOLS = before;
  }
});

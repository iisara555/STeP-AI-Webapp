// Runs and their event feed (ADR 0001 phase 3). A run belongs to the Gateway, not to the HTTP request that started
// it: closing the browser ends only the event stream, the runtime keeps working, and a client that comes back
// replays what it missed from the Workspace's feed and can still cancel.
import { randomUUID } from 'node:crypto';
import type { AskResult, RuntimeEvent } from '../workspace/contract.ts';
import type { RuntimeManager } from '../workspace/manager.ts';
import type { Audit } from './audit.ts';

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type Run = {
  id: string;
  workspaceId: string;
  sessionId: string;
  status: RunStatus;
  /** Engine or Gateway error code when the run did not finish with an answer; never message text. */
  code?: string;
  startedAt: string;
  finishedAt?: string;
};

type OwnedRun = Run & { ownerId: string; dispatched: Promise<void> };

export type FeedEvent = {
  id: number;
  type: 'run' | 'delta' | 'discard' | 'activity' | 'reset';
  data: unknown;
};

export type Quotas = {
  workspacesPerUser: number;
  activeRunsPerUser: number;
  runsPerUserPerDay: number;
};

export const DEFAULT_QUOTAS: Quotas = { workspacesPerUser: 10, activeRunsPerUser: 2, runsPerUserPerDay: 300 };

export class GatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GatewayError';
  }
}

/** Events kept per Workspace for a returning client; older ones are replaced by a `reset` telling it to reload. */
const FEED_LIMIT = 2_000;
/** Finished runs kept for status reads; the answers themselves stay in the Workspace's conversations. */
const FINISHED_LIMIT = 500;

class Feed {
  seq = 0;
  events: FeedEvent[] = [];
  listeners = new Set<(event: FeedEvent) => void>();
  unsubscribe?: () => void;

  push(type: FeedEvent['type'], data: unknown) {
    const event = { id: ++this.seq, type, data };
    this.events.push(event);
    if (this.events.length > FEED_LIMIT) this.events.splice(0, this.events.length - FEED_LIMIT);
    for (const listener of this.listeners) listener(event);
  }

  /** What a client that last saw `after` has missed, or a reset when that is no longer kept. */
  since(after: number): FeedEvent[] {
    if (after >= this.seq) return [];
    const first = this.events[0]?.id ?? this.seq + 1;
    if (after < first - 1) return [{ id: this.seq, type: 'reset', data: {} }];
    return this.events.filter((event) => event.id > after);
  }
}

export type RunStats = {
  active: number;
  today: { started: number; done: number; failed: number; cancelled: number };
  failuresByCode: Record<string, number>;
};

export class RunService {
  private readonly runs = new Map<string, OwnedRun>();
  private readonly feeds = new Map<string, Feed>();
  /** Running run per conversation: `${owner}/${workspace}/${session}` → run id. */
  private readonly active = new Map<string, string>();
  private readonly daily = new Map<string, number>();
  private today = {
    day: '',
    started: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    codes: {} as Record<string, number>,
  };

  constructor(
    private readonly manager: RuntimeManager,
    private readonly audit: Audit,
    private readonly quotas: Quotas = DEFAULT_QUOTAS,
    private readonly now: () => number = Date.now,
  ) {}

  async start(actor: string, workspaceId: string, input: { text: string; sessionId?: string }): Promise<Run> {
    await this.manager.get(actor, workspaceId);
    if (this.activeCount(actor) >= this.quotas.activeRunsPerUser) throw new GatewayError('QUOTA_ACTIVE_RUNS');
    const dayKey = `${actor}:${this.day()}`;
    if ((this.daily.get(dayKey) ?? 0) >= this.quotas.runsPerUserPerDay)
      throw new GatewayError('QUOTA_DAILY_RUNS');
    if (input.sessionId && this.active.has(this.sessionKey(actor, workspaceId, input.sessionId)))
      throw new GatewayError('RUN_ALREADY_ACTIVE');

    // Listen before asking, so the first streamed words are in the feed.
    const feed = await this.feed(actor, workspaceId);
    const sessionId = input.sessionId ?? (await this.manager.newConversation(actor, workspaceId)).sessionId;
    const key = this.sessionKey(actor, workspaceId, sessionId);
    if (this.active.has(key)) throw new GatewayError('RUN_ALREADY_ACTIVE');
    // Checked again after the awaits above, so two requests at once cannot both pass the limit.
    if (this.activeCount(actor) >= this.quotas.activeRunsPerUser) throw new GatewayError('QUOTA_ACTIVE_RUNS');

    let dispatched!: () => void;
    const run: OwnedRun = {
      id: `run_${randomUUID().replaceAll('-', '')}`,
      ownerId: actor,
      workspaceId,
      sessionId,
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      dispatched: new Promise((done) => (dispatched = done)),
    };
    this.runs.set(run.id, run);
    this.active.set(key, run.id);
    this.daily.set(dayKey, (this.daily.get(dayKey) ?? 0) + 1);
    this.count('started');
    feed.push('run', this.view(run));
    this.audit({ actor, action: 'run.start', workspaceId, runId: run.id, outcome: 'accepted' });

    // Deliberately not awaited: the run outlives the request that started it.
    void this.manager.ask(actor, workspaceId, { text: input.text, sessionId }, dispatched).then(
      (result) => this.finish(run, feed, result),
      (error) => {
        dispatched();
        this.finish(run, feed, undefined, codeOf(error));
      },
    );
    return this.view(run);
  }

  get(actor: string, workspaceId: string, runId: string): Run {
    return this.view(this.owned(actor, workspaceId, runId));
  }

  async list(actor: string, workspaceId: string): Promise<Run[]> {
    await this.manager.get(actor, workspaceId);
    return [...this.runs.values()]
      .filter((run) => run.ownerId === actor && run.workspaceId === workspaceId)
      .map((run) => this.view(run));
  }

  /** Asks the runtime to stop; the run ends as `cancelled` when the engine has stopped it. */
  async cancel(actor: string, workspaceId: string, runId: string): Promise<Run> {
    const run = this.owned(actor, workspaceId, runId);
    if (run.status !== 'running') throw new GatewayError('RUN_NOT_ACTIVE');
    // A cancel right after the start must not overtake the request it cancels.
    await run.dispatched;
    if (run.status !== 'running') throw new GatewayError('RUN_NOT_ACTIVE');
    await this.manager.cancel(actor, workspaceId, run.sessionId);
    this.audit({ actor, action: 'run.cancel', workspaceId, runId, outcome: 'requested' });
    return this.view(run);
  }

  /** Replays what the client missed after `after`, then follows live events until the returned stop is called. */
  async follow(actor: string, workspaceId: string, after: number, listener: (event: FeedEvent) => void) {
    await this.manager.get(actor, workspaceId);
    const feed = await this.feed(actor, workspaceId);
    for (const event of feed.since(after)) listener(event);
    feed.listeners.add(listener);
    return () => void feed.listeners.delete(listener);
  }

  stats(): RunStats {
    this.day();
    const { started, done, failed, cancelled, codes } = this.today;
    return {
      active: [...this.runs.values()].filter((run) => run.status === 'running').length,
      today: { started, done, failed, cancelled },
      failuresByCode: { ...codes },
    };
  }

  private finish(run: OwnedRun, feed: Feed, result?: AskResult, code?: string) {
    if (run.status !== 'running') return;
    const status: RunStatus =
      result?.status === 'review' ? 'done' : result?.status === 'cancelled' ? 'cancelled' : 'failed';
    run.status = status;
    const failure = status === 'failed' ? (result?.code ?? code ?? 'RUN_FAILED') : undefined;
    if (failure) run.code = failure;
    if (status === 'cancelled') run.code = 'CANCELLED';
    run.finishedAt = new Date(this.now()).toISOString();
    this.active.delete(this.sessionKey(run.ownerId, run.workspaceId, run.sessionId));
    this.count(status, failure);
    // The answer goes to the owner's feed; the audit trail keeps only the outcome.
    feed.push('run', {
      ...this.view(run),
      ...(result?.answer ? { answer: result.answer } : {}),
      sources: result?.sources ?? [],
    });
    this.audit({
      actor: run.ownerId,
      action: 'run.finish',
      workspaceId: run.workspaceId,
      runId: run.id,
      outcome: status,
      ...(run.code ? { code: run.code } : {}),
    });
    this.prune();
  }

  private async feed(actor: string, workspaceId: string) {
    const key = `${actor}/${workspaceId}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = new Feed();
      this.feeds.set(key, feed);
      const target = feed;
      feed.unsubscribe = await this.manager.subscribe(actor, workspaceId, (event) =>
        this.relay(actor, workspaceId, target, event),
      );
    }
    return feed;
  }

  private relay(actor: string, workspaceId: string, feed: Feed, event: RuntimeEvent) {
    const runId = this.active.get(this.sessionKey(actor, workspaceId, event.sessionId));
    if (!runId || event.type === 'status') return;
    feed.push(event.type, {
      runId,
      sessionId: event.sessionId,
      ...(event.text !== undefined ? { text: event.text } : {}),
      ...(event.count !== undefined ? { count: event.count } : {}),
    });
  }

  private activeCount(actor: string) {
    return [...this.runs.values()].filter((run) => run.ownerId === actor && run.status === 'running').length;
  }

  private owned(actor: string, workspaceId: string, runId: string) {
    const run = this.runs.get(runId);
    // Someone else's run looks exactly like one that does not exist.
    if (!run || run.ownerId !== actor || run.workspaceId !== workspaceId)
      throw new GatewayError('RUN_NOT_FOUND');
    return run;
  }

  private prune() {
    const finished = [...this.runs.values()].filter((run) => run.status !== 'running');
    for (const run of finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT)))
      this.runs.delete(run.id);
  }

  private count(status: 'started' | RunStatus, code?: string) {
    this.day();
    if (status !== 'running') this.today[status]++;
    if (code) this.today.codes[code] = (this.today.codes[code] ?? 0) + 1;
  }

  /** The UTC day; counters and daily quotas start again at its change. */
  private day() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.today.day !== day) {
      this.today = { day, started: 0, done: 0, failed: 0, cancelled: 0, codes: {} };
      for (const key of this.daily.keys()) if (!key.endsWith(`:${day}`)) this.daily.delete(key);
    }
    return day;
  }

  private sessionKey(actor: string, workspaceId: string, sessionId: string) {
    return `${actor}/${workspaceId}/${sessionId}`;
  }

  private view({ ownerId: _owner, dispatched: _dispatched, ...run }: OwnedRun): Run {
    return { ...run };
  }
}

export function codeOf(error: unknown) {
  const code = (error as { code?: unknown })?.code ?? (error as Error)?.message;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'RUN_FAILED';
}

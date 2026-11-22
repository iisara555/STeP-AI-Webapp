// Spending per person, department and organization for each month (Bangkok time). One JSON line per request in
// <dataRoot>/ai-usage/<YYYY-MM>.jsonl (0600): who, which model, tokens and cost. Prompts and answers have no field
// here and are never written anywhere by the gateway.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type UsageEntry = {
  at: string;
  userId: string;
  email: string;
  department: string;
  model: string;
  upstream: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** provider = OpenRouter's own figure; price = estimated from the configured price list. */
  costSource: 'provider' | 'price';
  outcome: 'ok' | 'error' | 'cancelled';
};

export type Tally = { usd: number; requests: number; inputTokens: number; outputTokens: number };
export type MonthTotals = {
  org: Tally;
  users: Map<string, Tally & { email: string; department: string }>;
  departments: Map<string, Tally>;
};

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
/** The billing month in Bangkok time, e.g. 2026-11. */
export const monthOf = (ms: number) => new Date(ms + BANGKOK_OFFSET_MS).toISOString().slice(0, 7);
const emptyTally = (): Tally => ({ usd: 0, requests: 0, inputTokens: 0, outputTokens: 0 });

function add(tally: Tally, entry: UsageEntry) {
  tally.usd += entry.costUsd;
  tally.requests += 1;
  tally.inputTokens += entry.inputTokens;
  tally.outputTokens += entry.outputTokens;
}

function apply(totals: MonthTotals, entry: UsageEntry) {
  add(totals.org, entry);
  const user = totals.users.get(entry.userId) ?? {
    ...emptyTally(),
    email: entry.email,
    department: entry.department,
  };
  // The latest request decides which department a person shows under this month.
  user.email = entry.email;
  user.department = entry.department;
  add(user, entry);
  totals.users.set(entry.userId, user);
  const department = totals.departments.get(entry.department) ?? emptyTally();
  add(department, entry);
  totals.departments.set(entry.department, department);
}

export class UsageLedger {
  private readonly dir: string;
  private readonly months = new Map<string, Promise<MonthTotals>>();
  private writing: Promise<void>;

  constructor(dataRoot: string) {
    this.dir = join(dataRoot, 'ai-usage');
    this.writing = mkdir(this.dir, { recursive: true, mode: 0o700 }).then(() => {});
  }

  /** The month's totals, loaded from its file once and then kept in step with every record(). */
  totals(month: string): Promise<MonthTotals> {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('INVALID_INPUT');
    let totals = this.months.get(month);
    if (!totals) {
      totals = this.load(month);
      this.months.set(month, totals);
    }
    return totals;
  }

  async record(entry: UsageEntry) {
    const month = monthOf(Date.parse(entry.at));
    apply(await this.totals(month), entry);
    this.writing = this.writing
      .then(() => appendFile(join(this.dir, `${month}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 }))
      .catch((error) => console.error('ai-usage write failed', (error as NodeJS.ErrnoException).code));
    await this.writing;
  }

  private async load(month: string): Promise<MonthTotals> {
    const totals: MonthTotals = { org: emptyTally(), users: new Map(), departments: new Map() };
    const text = await readFile(join(this.dir, `${month}.jsonl`), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: UsageEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn last line after a crash; the rest still counts
      }
      if (typeof entry.costUsd !== 'number' || typeof entry.userId !== 'string') continue;
      apply(totals, entry);
    }
    return totals;
  }
}

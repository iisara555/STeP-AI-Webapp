// Audit metadata (ADR 0001 §3): who did what, when, and how it ended. Prompts, answers, file and Workspace names
// never go here; the entry shape has no field that could carry them.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type AuditEntry = {
  actor: string;
  action: string;
  workspaceId?: string;
  runId?: string;
  outcome: string;
  code?: string;
};

export type Audit = (entry: AuditEntry) => void;

/** One JSON line per entry in <dataRoot>/audit/<UTC day>.jsonl, readable by the service user only. */
export function fileAudit(dataRoot: string, now: () => number = Date.now): Audit {
  const dir = join(dataRoot, 'audit');
  let writing: Promise<void> = mkdir(dir, { recursive: true, mode: 0o700 }).then(() => {});
  return (entry) => {
    const at = new Date(now()).toISOString();
    const line = JSON.stringify({
      at,
      actor: entry.actor,
      action: entry.action,
      ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      ...(entry.runId ? { runId: entry.runId } : {}),
      outcome: entry.outcome,
      ...(entry.code ? { code: entry.code } : {}),
    });
    writing = writing
      .then(() => appendFile(join(dir, `${at.slice(0, 10)}.jsonl`), line + '\n', { mode: 0o600 }))
      .catch(() => {});
  };
}

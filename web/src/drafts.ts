import type { Conversation } from '../../packages/harness-core/src/contracts.ts';

type Draft = { text: string; savedText: string; version: number; saving: boolean };
const fromSession = (session: Conversation): Draft => ({
  text: session.draft,
  savedText: session.draft,
  version: session.version,
  saving: false,
});

/** Unsaved drafts live only in the current account/tenant's App, never in browser storage. */
export class DraftBook {
  private entries = new Map<string, Draft>();
  private listeners = new Set<() => void>();
  private generation = 0;
  private change = 0;
  constructor(private tenant: string) {}

  revision = () => this.change;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private changed() {
    this.change++;
    this.listeners.forEach((listener) => listener());
  }
  get(session: Conversation): Readonly<Draft> {
    return this.entries.get(session.id) || fromSession(session);
  }
  hasUnsaved() {
    return [...this.entries.values()].some((d) => d.saving || d.text !== d.savedText);
  }
  receive(session: Conversation) {
    if (session.tenant_id !== this.tenant) return;
    const current = this.entries.get(session.id);
    // A remote read cannot discard local edits or regress an acknowledged save.
    if (
      current &&
      (current.saving || current.text !== current.savedText || current.version >= session.version)
    )
      return;
    this.entries.set(session.id, fromSession(session));
    this.changed();
  }
  edit(session: Conversation, value: string | ((text: string) => string)) {
    if (session.tenant_id !== this.tenant) return;
    const current = this.get(session);
    const text = typeof value === 'function' ? value(current.text) : value;
    this.entries.set(session.id, { ...current, text });
    this.changed();
  }
  async save(
    session: Conversation,
    write: (input: { tenant: string; id: string; version: number; draft: string }) => Promise<Conversation>,
  ) {
    if (session.tenant_id !== this.tenant) return;
    const current = this.get(session);
    if (current.saving) return;
    if (current.text === current.savedText) return session;
    const generation = this.generation;
    this.entries.set(session.id, { ...current, saving: true });
    this.changed();
    try {
      const result = await write({
        tenant: this.tenant,
        id: session.id,
        version: current.version,
        draft: current.text,
      });
      const latest = this.entries.get(session.id);
      if (generation !== this.generation || !latest) return;
      if (result.id !== session.id || result.tenant_id !== this.tenant) throw new Error('ACCESS_DENIED');
      // Acknowledging A's save never replaces newer local text, even while viewing another task.
      this.entries.set(session.id, {
        ...latest,
        savedText: result.draft,
        version: result.version,
        saving: false,
      });
      this.changed();
      return result;
    } finally {
      const latest = this.entries.get(session.id);
      if (generation === this.generation && latest?.saving) {
        this.entries.set(session.id, { ...latest, saving: false });
        this.changed();
      }
    }
  }
  forget(id: string) {
    if (this.entries.delete(id)) this.changed();
  }
  clear() {
    this.generation++;
    this.entries.clear();
    this.changed();
  }
}

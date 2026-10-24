export type Visibility = 'private' | 'workspace';
export type MemberRole = 'owner' | 'admin' | 'member';
export interface AiService {
  provider: 'gemini' | 'openrouter_free';
  model: string;
  upstream: string;
  displayName: string;
  consentId: string;
  configured: boolean;
  textOnly: boolean;
  /** Gemini on a Google AI Studio free key: Google may use what is sent, so every consent says so. */
  freeTier?: boolean;
}
export type RunStatus =
  'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Tenant {
  id: string;
  name: string;
  active: boolean;
  storage_limit: number;
  member_storage_limit: number;
  monthly_ai_budget_cents: number;
  input_cents_per_million: number | null;
  output_cents_per_million: number | null;
  free_ai_trial_enabled?: boolean;
  free_ai_daily_limit?: number;
}
export interface Membership {
  tenant_id: string;
  user_id: string;
  role: MemberRole;
  active: boolean;
  email?: string;
  display_name?: string;
}
export interface Workspace {
  id: string;
  tenant_id: string;
  created_by: string;
  name: string;
  description: string;
}
export interface Memory {
  id: string;
  tenant_id: string;
  owner_id: string;
  workspace_id: string | null;
  visibility: Visibility;
  title: string;
  body: string;
  kind: 'preference' | 'reference' | 'feedback' | 'project';
  confirmed: boolean;
  origin: string;
  expires_at: string | null;
  created_at: string;
}
/** One employee's own profile and assistant preferences in one tenant. Only that employee reads or edits it. */
export interface MemberProfile {
  tenant_id: string;
  user_id: string;
  display_name: string;
  team: string;
  avatar: string;
  assistant_name: string;
  chat_language: 'auto' | 'th' | 'en';
  personality: 'coworker' | 'professional' | 'concise' | 'custom';
  assistant_tone: string;
  interaction_style: 'standard' | 'witty' | 'ob-oon';
  language_style: 'standard' | 'northern-thai';
  updated_at?: string;
}
export interface DocumentRecord {
  id: string;
  tenant_id: string;
  owner_id: string;
  workspace_id: string | null;
  visibility: Visibility;
  name: string;
  mime: string;
  bytes: number;
  source_kind: 'upload' | 'drive';
  drive_file_id: string | null;
  object_path: string | null;
  status: 'uploading' | 'ready' | 'processing' | 'error';
  error_code: string | null;
  derived_from?: string | null;
  extracted_text?: string | null;
  created_at: string;
}
export interface Conversation {
  id: string;
  tenant_id: string;
  owner_id: string;
  workspace_id: string | null;
  visibility: Visibility;
  title: string;
  version: number;
  draft: string;
  /** Returned by the sessions table; the sidebar groups tasks by it. */
  created_at?: string;
}
export interface SourceRef {
  id: string;
  title: string;
  location: string;
  version?: string;
  kind: 'organization' | 'document' | 'google';
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'status';
  body: string;
  sources: SourceRef[];
  created_at: string;
}
export interface Run {
  id: string;
  tenant_id: string;
  actor_id: string;
  session_id: string | null;
  document_id: string | null;
  kind: 'chat' | 'document' | 'receipt';
  status: RunStatus;
  error_code: string | null;
  partial: string;
  result: unknown;
  created_at: string;
  /** The document tool a chat run drafted with, read from its input. */
  document_tool?: string | null;
}
export interface Skill {
  tenant_id?: string;
  id: string;
  skill_key: string;
  title: string;
  description: string;
  instructions: string;
  metadata: Record<string, unknown>;
  source_version: string;
}
export interface ReceiptResult {
  document_type: 'full_tax_invoice' | 'abbreviated_tax_invoice' | 'cash_bill' | 'general_receipt' | 'unknown';
  complete: 'complete' | 'incomplete' | 'uncertain';
  checks: {
    field: string;
    status: 'found' | 'missing' | 'uncertain' | 'mismatch';
    value: string | null;
    evidence: string | null;
  }[];
  signature: 'present' | 'absent' | 'uncertain';
  next_steps: string[];
  warnings: string[];
}
export interface Snapshot {
  ai?: AiService;
  user: { id: string; email?: string; name?: string };
  tenants: Tenant[];
  memberships: Membership[];
  workspaces: Workspace[];
  sessions: Conversation[];
  memories: Memory[];
  documents: DocumentRecord[];
  skills: Skill[];
  /** The signed-in employee's own profiles, one per tenant at most. */
  profiles?: MemberProfile[];
}
export interface ErrorView {
  title: string;
  detail: string;
  action: string;
  retry: boolean;
}

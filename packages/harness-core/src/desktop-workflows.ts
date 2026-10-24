import { DOCUMENT_TOOLS, documentRequest, documentTool } from '../vendor/desktop/document-tools.ts';
export { DOCUMENT_TOOLS };
export type PreparedWork = {
  title: string;
  draft: string;
  message: string;
  skillKey?: string;
  /** The Desktop document tool this conversation drafts with. */
  documentTool?: string;
};

/** Form input stays local until the employee prepares a conversation, then reviews AI consent. */
export function prepareDocument(id: string, values: Record<string, string>, variant: string): PreparedWork {
  const tool = documentTool(id);
  if (!tool) throw new Error('INVALID_DOCUMENT_TOOL');
  const request = documentRequest(id, values, variant);
  const message = `${request.text}\nแม่แบบทำงานที่ต้องการ หากมีในบริบท: ${tool.template}\n\nใช้เฉพาะแม่แบบและแหล่งข้อมูลที่มีในบริบทจริง หากยังไม่ได้แนบให้แจ้งว่าขาด ห้ามอ้างว่าโหลดไฟล์จากเครื่องหรือส่งเอกสารแล้ว\n\n${request.sourceText}`;
  if (message.length > 20000) throw new Error('DOCUMENT_TOO_LARGE');
  const draft =
    `# ${tool.title.replace(/^ร่าง/, '')}\n\n` +
    tool.fields
      .map((f) => `## ${f.label}\n${values[f.key]?.trim() || `[รอยืนยัน: ${f.label}]`}`)
      .join('\n\n');
  return { title: tool.title, draft, message, skillKey: tool.skill, documentTool: tool.id };
}

/** A literal ILIKE pattern; punctuation never becomes PostgREST filter syntax. */
export function literalSearch(value: string) {
  const query = value.trim();
  if (!query || query.length > 100) throw new Error('INVALID_REQUEST');
  return '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
}

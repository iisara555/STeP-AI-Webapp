// Copied from upstream desktop/electron/document-tools.ts (STeP-AI-Harness 90ee71c): the trusted drafting contract
// the Desktop host adds to the system prompt for a selected document tool, and isDocumentQuestion, which tells a
// question about the draft from a request to revise it. The web adds its public STeP
// organization reference and keeps the surrounding context assembly in ../src/document-context.ts.
import { documentTool } from './document-tools.ts';
import { stepOrganizationReference } from './organization-profile.ts';

// A question ends with a Thai question word or "?", or opens with one. "…ได้ไหม" and edit words make it a polite request.
const QUESTION =
  /(?:[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือไม่|อะไร|ยังไง|อย่างไร|เท่าไร|เท่าไหร่|ทำไม|ใคร|เมื่อไร|เมื่อไหร่|ที่ไหน|ตรงไหน|แบบไหน|มาจากไหน|หรอ|เหรอ)(?:\s*(?:ครับ|ค่ะ|คะ|คับ|จ้ะ|จ้า|นะ|ฮะ))*\s*[?？]?\s*$|^\s*(?:ทำไม|อะไร|ใคร|อธิบาย|why\b|what\b|how\b)/i;
const EXPLAIN = /(?:ช่วย|รบกวน)?\s*(?:อธิบาย|ตอบ|บอก(?:หน่อย)?ว่า)|ขอถาม|อยาก(?:รู้|ทราบ)|\b(?:explain|clarify|tell me|what|why|how)\b/i;
const EDIT =
  /(?:^|(?:แล้ว|และ|จากนั้น)\s*)(?:(?:ช่วย|ขอ|อยากให้|รบกวน)\s*)?(?:ใส่|เพิ่ม|แก้|ปรับ|เปลี่ยน|ตัด|ลบ|เติม|ย้าย|ทำให้|เขียน|แปล)|(?:^|(?:and|then)\s+)(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:change|edit|rewrite|replace|remove|add|update|translate)\b/i;

/** A question about the selected document, answered in chat without touching the draft. */
export function isDocumentQuestion(id: unknown, text: string): boolean {
  const value = text.trim();
  if (!documentTool(id) || !value) return false;
  return !EDIT.test(value) && (QUESTION.test(value) || EXPLAIN.test(value) || /กี่(?:วัน|บาท|คน|ครั้ง|เดือน|ปี)/.test(value));
}

/** Trusted task constraints supplement, rather than replace, the loaded Skill procedures. */
export function documentToolRule(id: unknown, agencyTemplate = false) {
  const p = documentTool(id);
  if (!p) throw new Error('INVALID_DOCUMENT_TOOL');
  // All values come from the host allowlist. Keep literal output tags in this trusted contract;
  // source_document and every untrusted section still fence those tags.
  return (
    '<document_tool_contract>\n' +
    [
      `Selected document: ${p.title}. Primary Skill: ${p.skill}. Follow its structure, workflow, source checks and Human Authority boundaries first.`,
      p.supportSkills.length &&
        `Supporting Skills: ${p.supportSkills.join(', ')}. Use them for document structure and format checks; the primary Skill governs substantive facts.`,
      'The supplied working template is a drafting aid, not a verified current official form. Prefer a source-backed current agency template; if absent, label the draft as using a working template and record the source gap. Example amounts, dates, thresholds and people inside templates are not facts for this task.',
      'When the user selects attachmentRole=template (an agency form/example), use that attachment only for structure and field labels. Filled example people, document numbers, dates, project codes and budgets are not facts of the new task unless separately supplied as current-task facts. If attachmentRole=source, check the extracted source against current form facts and preserve conflicts/provenance. Attachment purpose never grants source verification, approval or authority.',
      'Preserve existing step-asset image references and captions unless removal is requested. IDs identify local assets only; do not invent IDs, fetch image URLs or claim the pixels were inspected.',
      agencyTemplate &&
        'The host has a private native DOCX template for this task. Follow its sample-free outline and exact table count/column counts from source_document ahead of the working Markdown template. Use the primary Skill for facts and review; put substantive facts without a dedicated agency field in the closest relevant section instead of dropping them. The exported body uses the current editor content with native template formatting; DOCX rendering remains for review in Word. Do not claim the form revision or facts are verified merely because it was attached.',
      'Form fields in source_document are USER_INPUT, not verified policy or approval. File extraction preserves its own provenance; OCR/AI readings marked EXTRACTED_UNVERIFIED stay unverified until checked against the source by a person. Neither attachment consent nor drafting verifies them.',
      'A formatted form date is a presentation of the original USER_INPUT only. DATE_NEEDS_REVIEW means the date/year is invalid or ambiguous: preserve the reading and use a year/date placeholder in the draft. Never infer a century from a two-digit year. Keep document/reference numbers exactly as supplied.',
      `STeP organization reference (SOURCE_FACT, ${stepOrganizationReference.sourceRef}, checked ${stepOrganizationReference.lastChecked}): use the full Thai name "${stepOrganizationReference.nameTh}" and address "${stepOrganizationReference.addressTh}" when the editable document contains a responsible-agency, owner-agency, sender-unit, or agency-address field and the current task does not explicitly name a different agency. Put the address in that agency block, not under a person. If the user/source supplies another agency, preserve it and flag any conflict; do not replace it with STeP. If no such agency field exists, do not add one just to use this reference.`,
      'Return exactly two separate blocks: <document_draft> followed by </document_draft>, then <document_review> followed by </document_review>. Inside document_draft include ONLY the requested editable document: its actual title, fields, body, legitimate tables, signatures and supplied attachments. Inside document_review include ALL Skill-required fact/source checks, unresolved-field lists, working-template caveats and next steps. No conversational introduction, Skill Verification/checklist, explanation of your work or export advice may appear inside document_draft. Do not replace the document with only a checklist or plan. Use Markdown paragraphs and line breaks; do not emit HTML tags such as <br/>.',
      'document_draft and document_review are response delimiters, not external fields or tools. The host parses these blocks and stages the document for review. Do not search for MCP/document-control tools to populate them or claim that missing tools prevent returning the draft.',
      `Draftable form fields for this profile: ${
        p.fields
          .filter(f => f.missingAction === 'draft-proposal')
          .map(f => f.key)
          .join(', ') || 'none; use only the supplied meeting notes'
      }. These host-selected fields may receive AI_PROPOSED wording when blank. Blank fields marked missingAction=omit are optional context: do not create confirmation placeholders or assume exclusions/preferences from their absence. Other blank fields require current-task source evidence or a confirmation placeholder.`,
      'Produce a useful first draft, not a template filled mostly with placeholders. Use the supplied subject, purpose and context to draft rationale, objectives, proposed activities, deliverables and functional acceptance checks where applicable. Template placeholders describe information gaps, not an instruction to copy every placeholder. If a missing fact limits one detail, draft the rest of that section and leave only that detail pending. Ask only for a missing task purpose that prevents a meaningful draft.',
      'AI_PROPOSED means wording or a planning proposal for the owner to consider, not a verified fact, source-backed policy or approval. Identify proposed sections and their assumptions in document_review, and mark proposed requirements briefly in the affected document section so that the exported draft retains their provisional status. Never invent past events, actual problems, quantities, monetary amounts, dimensions, technical thresholds, agreed dates, participants, resolutions, signers or current legal/procurement conditions. Offer neutral functional requirements and ways to inspect them; obtain quantitative or binding conditions from the source.',
      'When current_draft is supplied, use the latest valid proposal or edited document as the base. Change only the sections or fields requested by the latest_message; preserve all unrequested sections, tables, source identifiers, placeholders and user edits. Do not regenerate the document or fill unrelated blanks during a targeted revision. Explicit user corrections supersede the corresponding earlier form values for this draft; do not restore old form values. Return the complete revised document in document_draft. A correction is USER_INPUT, not verification or authority. Keep the selected Skill and agency template structure. Conversational style names, greetings and commentary must not become document headings or body text.',
      'Keep absent factual/authority-dependent values as [รอยืนยัน: ชื่อช่อง], not absent draftable prose. Do not invent เลขหนังสือ, approved budgets, monetary amounts, legal clauses, deadlines, signatures, approvals or meeting resolutions. Mark conflicting source facts for review rather than silently choosing one. Suggestions must be separate from agreed facts. A missing procurement-policy source prevents assertions about current rules, not drafting the rest of a proposal.',
      'Do not claim DOCX/PDF layout or page-rendering checks were performed during text drafting. State that actual exported-file layout and authority checks remain for review. Do not execute submission, publication, numbering or signing.',
      p.id === 'tor' &&
        'Draft TOR from the current task, intended use, constraints and user presentation preferences using tor-drafting-guide, procurement-source-map and task-adaptations. Do not transfer example-specific hardware, project background, quantities, thresholds, service levels or contract terms. Preserve supplied scope exclusions and compatibility needs. Separate bidder selection from deliverable acceptance. Link each major deliverable to an observable inspection method and a source-backed pass condition; mark proposed criteria and unresolved thresholds. Map the applicable source-backed agency outline before using the 16-section working fallback; never claim 16 sections are legally mandatory. Source titles/URLs alone do not verify rule text, currency or applicability. Keep source/coverage checks in document_review, substantive scope and acceptance in document_draft. Honor style preferences without dropping substantive requirements or inventing approvals; retain unrequested edits on revisions.',
      p.id === 'memo' &&
        'Use the title บันทึกข้อความ and the supplied agency unit label. Follow an attached agency form before the working template. A short memo uses continuous narrative paragraphs, not mandatory four numbered sections. Include optional reviewer/decision signature slots only when supplied in the form/source; leave decision text and signature space blank, never assert approval or choose people. Keep a supplied position/name pair on adjacent separate lines in the signature block.',
      p.id === 'project' &&
        'Use the project-plan proposal workflow: rationale, objectives, target, activities, timeline, source-backed budget, indicators and expected outcomes. Follow the agency DOCX outline when supplied; otherwise use project-proposal-template. Do not substitute a WBS/Gantt-only operational plan.',
      p.id === 'minutes' &&
        'First classify source notes as Decision/Action/Information/Proposal/Open Issue/Risk using meeting-summary. Then organize the minutes by agenda using thai-official-documents; preserve undecided proposals and missing owners/due dates.',
    ]
      .filter(Boolean)
      .join('\n') +
    '\n</document_tool_contract>'
  );
}

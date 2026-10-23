/**
 * สื่อภายใน (internal media studio): turns a short brief into an image-generation prompt for internal communication.
 * Pure functions so the page and tests share one engine. Ported from the STeP Internal Studio v09 mini app.
 */
export type MediaType = 'ILLUSTRATION' | 'ANNOUNCEMENT' | 'GUIDE' | 'KNOWLEDGE';
export type MediaStyle = 'NOTION' | 'VECTOR' | 'COLLAGE' | 'PHOTO';
export type MediaRatio = '1:1' | '4:5' | '16:9' | '9:16' | '3:1';
export type MediaSpace = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM' | 'CENTER';
export type MediaState = {
  type: MediaType;
  topic: string;
  brief: string;
  content: string;
  visual: string;
  source: string;
  style: MediaStyle;
  ratio: MediaRatio;
  textMode: 'GENERATE' | 'SPACE';
  position: MediaSpace;
  font: string;
};
export type MediaResult = { prompt: string; missing: string[]; warnings: string[]; ready: boolean };

export const MEDIA_TYPES: Record<MediaType, string> = {
  ILLUSTRATION: 'ภาพประกอบ',
  ANNOUNCEMENT: 'ประกาศ',
  GUIDE: 'คู่มือใช้งาน',
  KNOWLEDGE: 'ความรู้ทั่วไป',
};
export const MEDIA_RATIOS: [MediaRatio, string][] = [
  ['1:1', 'จัตุรัส · 1:1'],
  ['4:5', 'แนวตั้ง · 4:5'],
  ['16:9', 'แนวนอน / สไลด์ · 16:9'],
  ['9:16', 'จอแนวตั้ง · 9:16'],
  ['3:1', 'แบนเนอร์ · 3:1'],
];
export const MEDIA_STYLE_LABELS: Record<MediaStyle, string> = {
  NOTION: 'หมึกวาดมือ (แนว Notion)',
  VECTOR: 'ภาพเวกเตอร์แบบเรียบง่าย',
  COLLAGE: 'ภาพตัดปะกระดาษ',
  PHOTO: 'ภาพถ่ายเชิงแนวคิด',
};
const MEDIA_TYPE_RULES: Record<MediaType, { promptType: string; drafting: string; structure: string }> = {
  ILLUSTRATION: {
    promptType: 'illustration',
    drafting: 'เสนอข้อความสั้นและแนวคิดภาพที่สื่อสารหัวข้อนี้ได้ชัด.',
    structure: 'Create a single clear visual concept supporting the topic.',
  },
  ANNOUNCEMENT: {
    promptType: 'announcement',
    drafting: 'จัดหัวข้อ สารสำคัญ และสิ่งที่ผู้รับสารต้องทำ ห้ามแต่งวันที่ เวลา สถานที่ ผู้ติดต่อ หรือผู้อนุมัติที่ไม่มีในข้อมูล.',
    structure:
      'Create an internal announcement with a clear headline, supporting message and action hierarchy, using only supplied details.',
  },
  GUIDE: {
    promptType: 'how-to guide',
    drafting:
      'จัดเป็นขั้นตอนตามลำดับ ห้ามเดาปุ่ม วิธีจอง ระบบ QR หรือวิธีเปิดปิดอุปกรณ์ หากไม่มีข้อมูลจริงให้ระบุสิ่งที่ต้องถามเพิ่ม ไม่เขียนขั้นตอนสมมติเป็นข้อเท็จจริง.',
    structure:
      'Create a step-by-step instructional layout. Follow the supplied sequence exactly, keep objects and characters consistent, and invent no controls or intermediate procedures.',
  },
  KNOWLEDGE: {
    promptType: 'educational visual',
    drafting: 'อธิบายความรู้ทั่วไปด้วยประเด็นสั้น ๆ ระบุสิ่งที่ยังไม่แน่ใจ ห้ามแต่งสถิติหรือแหล่งอ้างอิง.',
    structure: 'Create an educational visual with a few clearly grouped key points; no unsupported claims or fabricated sources.',
  },
};
export const MEDIA_SPACE_LABELS: Record<MediaSpace, string> = {
  LEFT: 'ด้านซ้าย',
  RIGHT: 'ด้านขวา',
  TOP: 'ด้านบน',
  BOTTOM: 'ด้านล่าง',
  CENTER: 'ตรงกลาง',
};
/** Fonts the team chose for Thai copy. The CI manual names no typeface, so this is a team choice, not a CI rule. */
export const MEDIA_FONTS = ['LINE Seed Sans TH', 'IBM Plex Sans Thai'];
const SPACES: Record<MediaSpace, string> = {
  LEFT: 'left third',
  RIGHT: 'right third',
  TOP: 'upper third',
  BOTTOM: 'lower third',
  CENTER: 'central area',
};
export const MEDIA_STYLES: Record<MediaStyle, string> = {
  NOTION: `HAND-DRAWN EDITORIAL INK ILLUSTRATION — NOTION-LIKE CHARACTER LANGUAGE
LINEWORK: Draw freehand ink contours with visible pressure variation: thicker outer silhouettes, finer face and finger details, tapered ends, slight natural wobble and occasional open contour breaks. Keep the drawing confident and readable, not distressed or scratchy. Avoid mechanically uniform monoline, ruler-perfect geometry and sterile vector-icon outlines.
CHARACTERS: Use friendly, slightly stylised editorial people, organic rounded silhouettes and believable relaxed poses. Faces use a few expressive marks: dot or short curved eyes, a single curved nose, simple eyebrows and a small curved mouth. Hands clearly perform the intended action with simplified but plausible fingers. Avoid chibi proportions, oversized cartoon eyes and emoji faces.
BLACK MASS & WHITE PAPER: Give hair a bold near-black silhouette with a few deliberate white highlight gaps rather than individual strands. Balance it with one substantial black clothing area when appropriate, such as loose trousers, and white unfilled clothing outlined in ink. Let white paper remain visible across most of the image. Do not turn every object into a black silhouette.
STORY & PROPS: Show one clear activity from the brief: reading, checking, explaining, working or helping. Only add people when they help explain the subject; object-only briefs may stay object-only. Keep props recognisable with a few hand-drawn marks, and use natural interaction instead of generic stock poses. Small imperfect ground or tabletop strokes are optional where the scene needs them.
DETAIL & RHYTHM: A few tiny hand-drawn gesture marks or curls may emphasise an action; use them sparingly and keep them outside text and reserved areas. No decorative confetti, floating geometric blobs, background card grids or unrelated tech icons.
COLOUR TREATMENT: Near-black ink on plain white. Keep faces and skin as white paper or very sparse flat neutral-grey support; do not add realistic flesh-tone rendering. Use STeP yellow only in a few purposeful flat accents on a prop or clothing detail, retaining the black-and-white ink character. Tiny flat neutral-grey patches may support a prop, never soft tonal modelling.
AVOID: smooth corporate flat-vector mascots, identical line width everywhere, glossy 3D, photorealism, gradients, airbrush shading, realistic cast shadows, paper-grain filters, dense hatching, elaborate backgrounds and yellow flooding the whole scene.
REFERENCE APPLICATION: Use these written descriptors for line quality, black/white balance, simplified facial language and action-led storytelling. If style-reference images are also attached to the generation tool, use them for visual language only. Create a new pose, person and composition suited to this brief; do not reproduce the reference characters, exact scene, artwork or any Notion logo.`,
  VECTOR: 'Simple flat vector illustration with clear geometric forms.',
  COLLAGE: 'Minimal editorial paper-cut collage with restrained texture.',
  PHOTO: 'Clean conceptual photography with natural expressions; illustrative, not documentary evidence.',
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

function hasMediaPlaceholder(value: string): boolean {
  if (/รอข้อมูลจริง|รอยืนยัน/.test(value)) return true;
  // Brackets also hold citations and Markdown links; only explicit unfinished slots need input.
  return [...value.matchAll(/\[([^\]]*)\]/g)].some(([, bracket]) => {
    const slot = bracket.trim();
    return !slot || /^\.{2,}$|^(?:ระบุ|เติม|ใส่|ยัง(?:ไม่|ไม่มี)|รอ(?:ข้อมูล|ยืนยัน)|(?:TBD|TODO|pending|insert|fill|enter)\b)/i.test(slot);
  });
}

function hasExternalPublicationIntent(value: string): boolean {
  const intents = value.matchAll(
    /(?:เผยแพร่|ประชาสัมพันธ์|โพสต์|แชร์|ลง(?:บน)?(?:เพจ|เว็บไซต์))[^\n.!?;]{0,100}?(?:ภายนอก|สาธารณะ|สาธารณชน)|(?:สื่อ|เว็บไซต์|เพจ)\s*สาธารณะ|\b(?:publish|post|share)\b[^\n.!?;]{0,100}?\b(?:publicly|externally|(?:public|external)\s+(?:posts?|communications?|publications?|websites?|sites?|pages?|use|audience|social(?:\s+media)?))\b|\b(?:public|external)\s+(?:posts?|communications?|publications?|websites?|sites?|pages?|use|audience|social(?:\s+media)?)\b/gi,
  );
  for (const intent of intents) {
    const before = value.slice(0, intent.index).trimEnd();
    // An internal-use warning such as "ห้ามเผยแพร่ภายนอก" is not a request to publish.
    if (!/(?:ห้าม|งด|ไม่(?:ให้|ควร|ต้อง|ใช่)?)(?:\s*นำไป)?$|\b(?:not|never|don['’]t|cannot)(?:\s+(?:to|for))?$/i.test(before)) return true;
  }
  return false;
}

/** Accepts saved or partial input and returns a complete state with only known options. */
export function normalizeMedia(raw: Partial<Record<keyof MediaState, unknown>> = {}): MediaState {
  return {
    type: pick(raw.type, Object.keys(MEDIA_TYPES) as MediaType[], 'ILLUSTRATION'),
    topic: text(raw.topic),
    brief: text(raw.brief),
    content: text(raw.content),
    visual: text(raw.visual),
    source: text(raw.source),
    style: pick(raw.style, Object.keys(MEDIA_STYLES) as MediaStyle[], 'NOTION'),
    ratio: pick(
      raw.ratio,
      MEDIA_RATIOS.map(([r]) => r),
      '1:1',
    ),
    textMode: raw.textMode === 'SPACE' ? 'SPACE' : 'GENERATE',
    position: pick(raw.position, Object.keys(SPACES) as MediaSpace[], 'LEFT'),
    font: pick(raw.font, MEDIA_FONTS, MEDIA_FONTS[0]),
  };
}

/** Thai request an employee can give any AI chat to draft the copy before building the image prompt. */
export function mediaAiRequest(raw: Partial<MediaState>): string {
  const s = normalizeMedia(raw);
  const rule = MEDIA_TYPE_RULES[s.type].drafting;
  return `ช่วยร่าง${MEDIA_TYPES[s.type]}สำหรับสื่อสารภายในหน่วยงาน ใช้ภาษาไทยเรียบง่าย กระชับ และหลัก Simple / Service / Sincere
หัวข้อ: ${s.topic || '[ระบุหัวข้อ]'}
ข้อมูลที่มี: ${s.brief || '[ยังไม่ให้ข้อมูล]'}
เนื้อหาเดิม: ${s.content || '[ยังไม่มี]'}
แหล่งข้อมูล: ${s.source || '[ยังไม่ระบุ]'}
${rule}
แนวคิดภาพต้องสอดคล้องกับ Art Direction ต่อไปนี้ ไม่เสนอ Style อื่นหรือองค์ประกอบตกแต่งที่ขัดกัน:
${MEDIA_STYLES[s.style]}
การจัดข้อความไทยในงานออกแบบใช้ฟอนต์ ${s.font} เท่านั้น ห้ามเสนอฟอนต์อื่น และไม่ใส่ชื่อฟอนต์ลงในเนื้อหาที่ผู้อ่านจะเห็น
ส่งหัวข้อ เนื้อหาพร้อมตรวจแก้ แนวคิดภาพ และข้อมูลที่ยังขาด แยกกัน ห้ามสร้างหรือเสนอให้สร้างโลโก้ใด ๆ ไม่ต้องใส่คำสั่ง technical ในเนื้อหาสำหรับผู้รับสาร`;
}

/** Builds the English image prompt plus what is still missing; copying is allowed only when nothing is. */
export function compileMedia(raw: Partial<MediaState>): MediaResult {
  const s = normalizeMedia(raw);
  const missing: string[] = [];
  if (!s.topic.trim()) missing.push('หัวข้อ');
  if (s.textMode === 'GENERATE' && !s.content.trim()) missing.push('เนื้อหาที่ต้องการให้ปรากฏบนภาพ');
  if (s.type === 'GUIDE' && !s.content.trim()) missing.push('ขั้นตอนใช้งานจริง');
  const warnings: string[] = [];
  const userFields = [s.topic, s.brief, s.content, s.visual, s.source];
  if (userFields.some(hasMediaPlaceholder)) warnings.push('เนื้อหายังมีช่องรอข้อมูล กรุณาเติมก่อนใช้จริง');
  if (userFields.some(hasExternalPublicationIntent)) warnings.push('รุ่นนี้ใช้สื่อสารภายในเท่านั้น กรุณาปรับโจทย์');
  const typeRule = MEDIA_TYPE_RULES[s.type];
  const colour =
    s.style === 'NOTION'
      ? 'Use near-black #231F20 ink and white paper as the foundation. Add bright STeP golden yellow #FFC709 in a few purposeful flat accents, keeping the hand-drawn black-and-white character. Small neutral-grey support patches are optional design choices, not an additional official brand colour. No flesh-tone rendering, colour gradients or yellow background flooding.'
      : 'Use STeP bright golden yellow and near-black as the corporate palette; white may support the background. For design colour matching use yellow #FFC709 and dark #231F20. Keep natural skin tones when appropriate.';
  const lettering =
    s.textMode === 'GENERATE'
      ? `TEXT & FONT PRODUCTION
Preferred result: include the following exact Thai copy in the image, preserving spelling, punctuation, numbers and line order. Use ${s.font} for every Thai heading, body line and caption when the tool supports that font. Final typesetting is restricted to LINE Seed Sans TH or IBM Plex Sans Thai, using the selected family; do not choose a third font or decorative handwritten lettering. Strong contrast and readable hierarchy. Font names are production instructions, never visible copy.
Do not make font certification a prerequisite for attempting image creation. Do not claim an image generator has embedded or verified an exact font family unless there is actual evidence. If the tool supports Thai lettering but cannot certify the font, attempt the requested image as a draft for typography review, clearly report that font identity is unverified and do not label it a font-approved final.
If the tool cannot render the supplied Thai copy legibly or needs unavailable font files to typeset it, create the illustration with the left third clean and empty instead, without any text, digits or pseudo-text anywhere. Retain the exact copy separately for later typesetting in ${s.font}; identify this output as an illustration awaiting typesetting, not a complete announcement. Do not require a font upload just to create the illustration.
BEGIN EXACT COPY
${s.content}
END EXACT COPY
For the preferred result, arrange the illustration around the copy without overlapping it.`
      : `RESERVE SPACE FOR LATER TEXT
Keep the ${SPACES[s.position]} completely clean and empty for text added later. Place the main illustration outside that reserved area. Do not generate any text, letters, captions, digits, pseudo-text or signage anywhere in the image. LATER TYPESETTING HANDOFF (not image content): Add Thai copy separately using ${s.font} only. The permitted families are LINE Seed Sans TH and IBM Plex Sans Thai; no other font is allowed. Do not render the font name or any lettering in this image. Font files are not needed to generate this text-free illustration.
The following content is only a guide for the visual, NOT lettering to render:
${s.content || s.brief || s.topic}`;
  const prompt = `TASK
Create one ${typeRule.promptType} for INTERNAL communication only. Topic: ${s.topic || '[ระบุหัวข้อ]'}.
${typeRule.structure}

CONTENT & VISUAL
Context supplied by the user: ${s.brief || s.topic}
Visual direction: ${s.visual || 'Depict the topic clearly, with only meaningful objects and natural actions; use generic representations when real appearance is unknown.'}

STYLE & ART DIRECTION
${MEDIA_STYLES[s.style]}

CORPORATE COLOR
${colour}

SIMPLE / SERVICE / SINCERE
One clear idea, minimal clutter and purposeful whitespace. Make the information or next action easy to understand. Keep representation honest; do not fabricate dates, metrics, institutional claims or depict a fictional scene as a real event.

${lettering}

MANDATORY LOGO RESTRICTION
Never generate, redraw or imitate ANY logo, wordmark, emblem, brand mark or watermark, including STeP, CMU and Notion. This restriction remains mandatory even if the brief requests a logo. Any actual logo must be added separately from an official asset. Ordinary copy may mention a name in plain text but must not become a stylised wordmark.

OUTPUT
Create one internal-use image, aspect ratio ${s.ratio}. If an image-generation tool is available, invoke it rather than only describing the intended image. Report an actual tool failure or unavailable capability honestly; do not claim completion or supply an invented image result. Missing font certification alone is not an image-tool failure. Verify spelling, legibility, font identity, dimensions and colour before treating the work as final. Label a typography-review draft or an illustration awaiting typesetting according to the actual output. Supplied content is not independently verified.`;
  return { prompt, missing, warnings, ready: !missing.length && !warnings.length };
}

/** Synthetic examples per type; none is an approved announcement or real procedure. */
export const MEDIA_EXAMPLES: Record<MediaType, Pick<MediaState, 'topic' | 'brief' | 'content' | 'visual'>> = {
  ILLUSTRATION: {
    topic: 'แลกเปลี่ยนไอเดียในทีม',
    brief: 'ภาพแนวคิดสำหรับชวนเพื่อนร่วมงานแบ่งปันวิธีทำงาน',
    content: 'แบ่งปันไอเดีย\nช่วยกันทำงานให้ง่ายขึ้น',
    visual: 'เพื่อนร่วมงานคุยรอบโต๊ะ มีโน้ตและคอมพิวเตอร์',
  },
  ANNOUNCEMENT: {
    topic: 'ช่วยกันรักษาพื้นที่ส่วนกลาง',
    brief: 'ตัวอย่างประกาศภายใน ไม่ใช่ประกาศที่อนุมัติแล้ว',
    content: 'พื้นที่ส่วนกลาง ใช้ร่วมกัน\nเก็บของส่วนตัวหลังใช้งาน\nจัดโต๊ะและเก้าอี้ให้เรียบร้อย\nพร้อมสำหรับเพื่อนร่วมงานคนถัดไป',
    visual: 'โต๊ะส่วนกลางสะอาดและเพื่อนร่วมงานเก็บของ',
  },
  GUIDE: {
    topic: 'จัดพื้นที่หลังใช้ตู้ประชุม',
    brief: 'ตัวอย่างสมมติ ต้องปรับตามคู่มือจริง ไม่มีวิธีจองหรือปุ่มอุปกรณ์',
    content: 'หลังใช้ตู้ประชุม\n1. ตรวจของส่วนตัว\n2. เก็บของออกจากโต๊ะ\n3. จัดโต๊ะและที่นั่งให้เรียบร้อย',
    visual: 'สามช่องตามลำดับ คนเดิม ตู้เดิม ไม่มีปุ่มหรือระบบจองสมมติ',
  },
  KNOWLEDGE: {
    topic: 'แบ่งงานใหญ่ให้เริ่มง่าย',
    brief: 'แนวคิดทั่วไปในการจัดงาน ไม่ใช่ข้อมูลสถิติ',
    content: 'เริ่มจากงานเล็ก\nแบ่งงานเป็นส่วนที่ทำได้\nเลือกสิ่งที่จะเริ่มก่อน\nทบทวนและปรับทีละขั้น',
    visual: 'ภาพคนเรียงการ์ดงานจากชิ้นเล็กเป็นภาพรวม',
  },
};

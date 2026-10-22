// Welcome-screen starters: ambitious but safe first tasks, written for each STeP team so a new user sees
// what the assistant can really do for their own work. Every starter asks for a draft or an analysis;
// none asks the assistant to approve, submit or pay, which stays with people.


export type Starter = { tag: { th: string; en: string }; th: string; en: string };

const docs = { th: 'เอกสาร', en: 'Docs' },
  analysis = { th: 'วิเคราะห์', en: 'Analysis' },
  plan = { th: 'วางแผน', en: 'Planning' },
  quality = { th: 'คุณภาพ', en: 'Quality' },
  creative = { th: 'สร้างสรรค์', en: 'Creative' },
  people = { th: 'คนและทีม', en: 'People' };

const general: Starter[] = [
  {
    tag: analysis,
    th: 'สรุปบันทึกประชุมที่แนบให้เป็นตาราง: ใครต้องทำอะไร ภายในวันไหน และเรื่องไหนยังไม่มีเจ้าของ',
    en: 'Turn the attached meeting notes into a table of who does what by when, and flag items that still have no owner',
  },
  {
    tag: plan,
    th: 'ทำ Pre-mortem โครงการนี้: สมมติว่า 6 เดือนข้างหน้าโครงการล้มเหลว ไล่หา 10 สาเหตุที่เป็นไปได้ พร้อมสัญญาณเตือนและวิธีป้องกัน',
    en: 'Run a pre-mortem on this project: assume it failed six months from now, list 10 likely causes with early warning signs and how to prevent each',
  },
  {
    tag: docs,
    th: 'ร่างรายงานสถานะผู้บริหาร 1 หน้าจากข้อมูลที่แนบ: เกิดอะไรขึ้น เสี่ยงตรงไหน และต้องการการตัดสินใจเรื่องอะไร',
    en: 'Draft a one-page executive status update from the attached notes: what happened, where the risks are, and which decisions we need',
  },
];

const byTeam: Record<string, Starter[]> = {
  ga: [
    {
      tag: docs,
      th: 'ตรวจหนังสือราชการฉบับนี้ทั้งรูปแบบ ภาษา และความครบถ้วนตามระเบียบงานสารบรรณ แล้วร่างฉบับแก้ที่พร้อมเสนอลงนาม',
      en: 'Review this official letter for format, language and completeness against Thai correspondence rules, then draft a corrected version ready for signature',
    },
    {
      tag: analysis,
      th: 'แยกเรื่องที่รับเข้ามาวันนี้ตามความเร่งด่วน บอกว่าแต่ละเรื่องควรส่งต่อทีมไหน และร่างข้อความประสานงานให้ครบทุกเรื่อง',
      en: "Triage today's incoming requests by urgency, say which team should handle each one, and draft a hand-off note for every item",
    },
    general[0],
  ],
  afp: [
    {
      tag: docs,
      th: 'ตรวจ TOR ฉบับนี้ก่อนส่ง AFP: หาเงื่อนไขที่ล็อกสเปก ขอบเขตงานที่ไม่ชัด และข้อที่ต้องยืนยันกับเจ้าของเรื่อง',
      en: 'Pre-check this TOR before it goes to AFP: find spec-locking clauses, unclear scope and points the requester must confirm',
    },
    {
      tag: analysis,
      th: 'Pre-check ใบเสร็จชุดนี้: เทียบยอดก่อนภาษี VAT และยอดรวม แล้วสรุปหลักฐานที่ยังขาดเป็น checklist',
      en: 'Pre-check this batch of receipts: reconcile subtotal, VAT and totals, then list the missing evidence as a checklist',
    },
    {
      tag: docs,
      th: 'เขียนขอบเขตงานจ้างที่ปรึกษาให้เป็นภาษาราชการที่วัดผลได้ พร้อมตารางส่งมอบงานและเกณฑ์ตรวจรับ',
      en: 'Rewrite this consultancy scope in measurable official language, with a deliverables schedule and acceptance criteria',
    },
  ],
  iasa: [
    {
      tag: analysis,
      th: 'สรุปข้อมูลพันธมิตรมหาวิทยาลัยต่างประเทศที่สนใจ: จุดแข็ง โอกาสร่วมมือกับ STeP และคำถามสำหรับการพบกันครั้งแรก',
      en: 'Build a partner profile on the overseas university we are courting: strengths, collaboration angles with STeP, and questions for our first conversation',
    },
    {
      tag: docs,
      th: 'ร่างอีเมลภาษาอังกฤษเชิญพันธมิตรต่างชาติร่วม Innovation Week แบบสุภาพแต่น่าตื่นเต้น พร้อมฉบับภาษาไทยสำหรับเสนอผู้บริหาร',
      en: 'Draft an English invitation for international partners to join our Innovation Week, polite but exciting, plus a Thai version for executive sign-off',
    },
    {
      tag: docs,
      th: 'เปรียบเทียบร่าง MOU สองฉบับนี้ ชี้จุดที่ต่างกันและข้อที่ควรให้ฝ่ายกฎหมายตรวจก่อนลงนาม',
      en: 'Compare these two MOU drafts, highlight the differences and the clauses legal should review before signing',
    },
  ],
  qs: [
    {
      tag: quality,
      th: 'เตรียม checklist ตรวจติดตามคุณภาพภายใน ISO 9001 ของกระบวนการจัดซื้อ พร้อมคำถามสัมภาษณ์และหลักฐานที่ต้องขอดู',
      en: 'Prepare an ISO 9001 internal audit checklist for the procurement process, with interview questions and the evidence to request',
    },
    {
      tag: quality,
      th: 'วิเคราะห์ NCR ที่แนบด้วย 5 Whys หาสาเหตุราก แล้วร่างแผน CAPA ที่มีผู้รับผิดชอบและวันครบกำหนด',
      en: 'Analyse the attached NCR with 5 Whys, find the root cause, and draft a CAPA plan with owners and due dates',
    },
    {
      tag: docs,
      th: 'เตรียมวาระและข้อมูลประกอบการทบทวนโดยฝ่ายบริหาร (Management Review) ให้ครบตามข้อกำหนด ISO 9001 ข้อ 9.3',
      en: 'Prepare the agenda and inputs for the management review so they cover every ISO 9001 clause 9.3 requirement',
    },
  ],
  nmco: [
    {
      tag: docs,
      th: 'สรุปผลการดำเนินงานไตรมาสนี้เป็นรายงานส่ง อว. ตามหัวข้อที่กำหนด พร้อมตัวเลขสำคัญที่ผู้บริหารควรเห็นก่อน',
      en: 'Summarise this quarter into the MHESI report format, leading with the numbers executives should see first',
    },
    {
      tag: plan,
      th: 'วางแผนงานสัมมนาเครือข่ายอุทยานวิทยาศาสตร์ทั่วประเทศ: หัวข้อ ผู้เข้าร่วม และข้อเสนอความร่วมมือที่จับต้องได้',
      en: 'Plan the national science park network seminar: topics, attendees and concrete collaboration proposals',
    },
    general[0],
  ],
  hd: [
    {
      tag: people,
      th: 'วางแผนการเรียนรู้หลักสูตร AI for Work 1 วันสำหรับพนักงาน STeP: วัตถุประสงค์ กิจกรรม workshop และแบบประเมินหลังเรียน',
      en: 'Plan the learning design for a one-day "AI for Work" course for STeP staff: objectives, workshop activities and a post-course assessment',
    },
    {
      tag: people,
      th: 'ถอดองค์ความรู้จากบันทึกการทำงานของพนักงานที่กำลังเกษียณ ให้เป็นคู่มือที่คนรุ่นใหม่ใช้ต่อได้ทันที',
      en: 'Turn a retiring colleague’s work notes into a handbook the next person can use from day one',
    },
    {
      tag: analysis,
      th: 'สรุปผลแบบประเมินความต้องการฝึกอบรมที่แนบ จัดกลุ่มทักษะที่ขาด และเสนอแผนพัฒนาบุคลากรรายไตรมาส',
      en: 'Summarise the attached training-needs survey, group the skill gaps and propose a quarterly development plan',
    },
  ],
  isi: [
    {
      tag: analysis,
      th: 'ท้าทายสมมติฐานธุรกิจของ Startup ทีมนี้แบบไม่เกรงใจ: ข้อไหนเสี่ยงที่สุด และควรทดสอบอะไรใน 2 สัปดาห์',
      en: "Challenge this startup's business assumptions without holding back: which is riskiest, and what should they test in two weeks",
    },
    {
      tag: plan,
      th: 'สรุปผล Mentoring ครั้งล่าสุดเป็น action plan 30 วัน พร้อมตัวชี้วัดที่ใช้ติดตามความคืบหน้าของทีม',
      en: 'Turn the latest mentoring session into a 30-day action plan with metrics to track the team’s progress',
    },
    {
      tag: analysis,
      th: 'ประเมินความพร้อมของ Startup ในพอร์ต 5 ทีมนี้ แล้วจัดอันดับว่าทีมไหนพร้อมระดมทุนก่อน พร้อมเหตุผล',
      en: 'Assess the readiness of these five portfolio startups and rank which should raise funding first, with reasons',
    },
  ],
  eic: [
    {
      tag: plan,
      th: 'วาง Run of show งาน Bootcamp ผู้ประกอบการ 3 วัน ตั้งแต่ไอเดียจนถึงวัน Demo Day: ช่วงกิจกรรม วิทยากร และเกณฑ์ตัดสิน',
      en: 'Build the run of show for a three-day entrepreneur bootcamp from idea to Demo Day: sessions, speakers and judging criteria',
    },
    {
      tag: plan,
      th: 'ช่วยผู้ประกอบการตั้งเป้าหมายปีนี้แบบ OKR จากสถานะธุรกิจที่แนบ แยกเป็นไตรมาสพร้อมตัวชี้วัด',
      en: "Help this founder set this year's OKRs from the attached business snapshot, broken down by quarter with metrics",
    },
    general[1],
  ],
  imo: [
    {
      tag: analysis,
      th: 'ร่าง Decision memo เปรียบเทียบ 3 ทางเลือกการลงทุนโครงการนวัตกรรม พร้อมความเสี่ยง ต้นทุน และคำแนะนำ',
      en: 'Draft a decision memo comparing three innovation investment options, with risks, costs and a recommendation',
    },
    {
      tag: analysis,
      th: 'จัดพอร์ตโฟลิโอโครงการนวัตกรรมที่แนบเป็น 2x2 ตามผลกระทบและความเป็นไปได้ แล้วเสนอว่าควรเร่ง หยุด หรือทบทวนโครงการไหน',
      en: 'Map the attached innovation portfolio on an impact-versus-feasibility 2x2 and recommend what to accelerate, stop or rethink',
    },
    general[2],
  ],
  sit: [
    {
      tag: plan,
      th: 'แปลงแผนยุทธศาสตร์ปีนี้เป็น OKR รายทีม พร้อมตัวชี้วัดที่วัดได้จริงและเจ้าของแต่ละตัว',
      en: "Translate this year's strategy into team-level OKRs with measurable key results and an owner for each",
    },
    {
      tag: docs,
      th: 'ร่างรายงานสถานะผู้บริหารรายเดือน: ไฮไลต์ ตัวชี้วัดที่หลุดเป้า ความเสี่ยง และเรื่องที่ผู้บริหารต้องตัดสินใจ',
      en: 'Draft the monthly executive status report: highlights, off-track KPIs, risks and the decisions executives need to make',
    },
    general[1],
  ],
  'tech-spin': [
    {
      tag: analysis,
      th: 'แปลงบทคัดย่องานวิจัยที่แนบให้เป็น one-pager สำหรับนักลงทุน: ปัญหา ทางแก้ ตลาด และรูปแบบการถ่ายทอดเทคโนโลยี',
      en: 'Turn the attached research abstract into an investor one-pager: problem, solution, market and licensing model',
    },
    {
      tag: plan,
      th: 'เตรียมประเด็นเจรจาถ่ายทอดเทคโนโลยี: สิ่งที่เราต้องการ ข้อที่ยอมได้ และคำถามที่คู่เจรจาน่าจะถาม',
      en: 'Prepare a tech-transfer negotiation brief: what we want, where we can flex, and the questions the other side will likely ask',
    },
    general[1],
  ],
  'tech-up': [
    {
      tag: analysis,
      th: 'ประเมินระดับความพร้อมเทคโนโลยี (TRL) ของต้นแบบนี้จากข้อมูลที่แนบ และบอกสิ่งที่ต้องพิสูจน์ก่อนขยายการผลิต',
      en: 'Estimate the technology readiness level (TRL) of this prototype from the attached data, and list what must be proven before scale-up',
    },
    general[1],
    general[2],
  ],
  linc: [
    {
      tag: analysis,
      th: 'สกัดโจทย์จริงจากบันทึกการลงพื้นที่โรงงานที่แนบ ให้เป็น problem statement ที่ส่งต่อผู้เชี่ยวชาญได้',
      en: 'Extract the real problems from the attached factory visit notes and write them as problem statements we can send to experts',
    },
    {
      tag: analysis,
      th: 'จับคู่โจทย์ของผู้ประกอบการรายนี้กับความเชี่ยวชาญของนักวิจัยใน มช. พร้อมเหตุผลว่าทำไมคู่นี้น่าจะไปได้',
      en: "Match this company's challenge with CMU researchers' expertise and explain why each pairing could work",
    },
    general[0],
  ],
  pubsec: [
    {
      tag: plan,
      th: 'วางแผนโครงการเชิงพื้นที่ร่วมกับหน่วยงานรัฐ: เป้าหมาย กลุ่มเป้าหมาย กิจกรรม งบประมาณโดยประมาณ และตัวชี้วัด',
      en: 'Plan an area-based project with a government partner: goals, beneficiaries, activities, a rough budget and KPIs',
    },
    general[1],
    general[2],
  ],
  cc: [
    {
      tag: creative,
      th: 'คิด Big idea สำหรับงาน STeP Innovation Day 3 แนวทาง พร้อมชื่องาน key message และ signature moment ที่คนจะจำได้',
      en: 'Pitch three big ideas for STeP Innovation Day, each with a name, key message and a signature moment people will remember',
    },
    {
      tag: creative,
      th: 'เขียน Designer brief สำหรับโปสเตอร์และสื่อโซเชียลของงานนี้ ให้ตรง Brand tone ของ STeP พร้อม prompt ทำภาพประกอบ',
      en: "Write a designer brief for this event's poster and social posts in STeP's brand tone, plus image prompts for the key visual",
    },
    {
      tag: docs,
      th: 'ร่างข่าวประชาสัมพันธ์จากข้อมูลโครงการที่แนบ 2 เวอร์ชัน: ทางการสำหรับสื่อ และสั้นกระชับสำหรับ Facebook',
      en: 'Draft a press release from the attached project facts in two versions: formal for media and short for Facebook',
    },
  ],
  mi: [
    {
      tag: analysis,
      th: 'สแกนสัญญาณตลาดของผลิตภัณฑ์นวัตกรรมนี้: คู่แข่ง เทรนด์ และกลุ่มลูกค้าที่น่าทดสอบก่อน พร้อมสมมติฐานที่ต้องพิสูจน์',
      en: 'Scan market signals for this innovative product: competitors, trends and the first customer segment to test, with hypotheses to prove',
    },
    {
      tag: plan,
      th: 'ออกแบบการทดลองตลาด 2 สัปดาห์ด้วยงบน้อย เพื่อดูว่าลูกค้ายอมจ่ายจริงหรือไม่',
      en: 'Design a low-budget two-week market test to find out whether customers will actually pay',
    },
    general[2],
  ],
  crm: [
    {
      tag: analysis,
      th: 'วิเคราะห์ความคิดเห็นลูกค้าที่แนบ จัดกลุ่มปัญหาที่พบบ่อย หาสาเหตุ และเสนอการปรับปรุงที่ทำได้เร็วที่สุด 3 ข้อ',
      en: 'Analyse the attached customer feedback, group the recurring issues, find causes and propose the three fastest fixes',
    },
    {
      tag: docs,
      th: 'สร้าง FAQ บริการของ STeP จากคำถามที่ลูกค้าถามบ่อย พร้อมคำตอบที่สุภาพ ชัดเจน และบอกช่องทางติดต่อถัดไป',
      en: "Build an FAQ for STeP's services from the questions customers ask most, with clear, polite answers and next steps",
    },
    general[0],
  ],
  ifu: [
    {
      tag: analysis,
      th: 'วิเคราะห์อัตราการใช้ห้องและพื้นที่เช่าจากข้อมูลที่แนบ แล้วเสนอวิธีเพิ่มรายได้โดยไม่ต้องลงทุนเพิ่ม',
      en: 'Analyse room and rental space usage from the attached data and propose ways to grow revenue without new investment',
    },
    general[0],
    general[1],
  ],
  iqi: [
    {
      tag: plan,
      th: 'จัดลำดับงานซ่อมบำรุงอาคารจากรายการที่แนบตามความเสี่ยงและงบประมาณ พร้อมแผนดำเนินการ 6 เดือน',
      en: 'Prioritise the attached building maintenance items by risk and budget, with a six-month action plan',
    },
    general[1],
    general[0],
  ],
  les: [
    {
      tag: quality,
      th: 'ทบทวนรายงานผลทดสอบจากห้องปฏิบัติการฉบับนี้ ตรวจความสอดคล้องของค่า หน่วย และสิ่งที่ต้องยืนยันก่อนส่งลูกค้า',
      en: 'Review this lab test report for consistent values and units, and list what must be confirmed before it goes to the client',
    },
    {
      tag: docs,
      th: 'เขียน SOP การใช้เครื่องมือวิทยาศาสตร์เครื่องนี้ให้มือใหม่ทำตามได้ พร้อมจุดควบคุมความปลอดภัย',
      en: 'Write an SOP for this scientific instrument that a newcomer can follow, including safety control points',
    },
    general[0],
  ],
  foodfabr: [
    {
      tag: plan,
      th: 'วางแผนทดลองผลิตต้นแบบอาหารในระดับกึ่งอุตสาหกรรม: ขั้นตอน จุดควบคุมคุณภาพ และข้อมูลที่ต้องบันทึกทุกล็อต',
      en: 'Plan a pilot-scale food production trial: process steps, quality control points and the data to record for every batch',
    },
    {
      tag: docs,
      th: 'สรุปผลการทดลองผลิตที่แนบให้ลูกค้าเข้าใจง่าย พร้อมข้อเสนอการปรับสูตรรอบถัดไป',
      en: 'Summarise the attached production trial for the client in plain language, with suggestions for the next recipe iteration',
    },
    general[1],
  ],
};

/** Three starters for the person's team, or general ones when no team is set. */
export function startersFor(team: string): Starter[] {
  return byTeam[team] || general;
}
export const starterText = (starter: Starter) => starter.th;
export const starterTag = (starter: Starter) => starter.tag.th;

export const starterTeams = Object.keys(byTeam);

// Team labels from upstream manifest/teams.yaml (ids and display names only). They name the employee's main team
// in Settings and on the welcome screen; a team choice never grants access to data or Skills.
export type Team = { id: string; name: string; nameEn: string };
export const TEAMS: Team[] = [
  {
    "id": "ga",
    "name": "งานบริหารทั่วไป",
    "nameEn": "General Administration"
  },
  {
    "id": "afp",
    "name": "บัญชี การเงิน และจัดซื้อ",
    "nameEn": "Accounting, Finance & Procurement"
  },
  {
    "id": "iasa",
    "name": "ความร่วมมือระหว่างประเทศและพันธมิตร",
    "nameEn": "International Affairs & Strategic Alliance"
  },
  {
    "id": "qs",
    "name": "ระบบคุณภาพ",
    "nameEn": "Quality System"
  },
  {
    "id": "nmco",
    "name": "ประสานเครือข่ายอุทยานวิทยาศาสตร์และ อว.",
    "nameEn": "Network Management & Coordination Office"
  },
  {
    "id": "hd",
    "name": "พัฒนาศักยภาพบุคลากร",
    "nameEn": "Human Development"
  },
  {
    "id": "piti",
    "name": "บ่มเพาะศักยภาพนวัตกรรมและเทคโนโลยี",
    "nameEn": "Platform for Innovation & Technology Incubation"
  },
  {
    "id": "isi",
    "name": "บ่มเพาะ Startup นวัตกรรม",
    "nameEn": "Innovative Startup Incubation"
  },
  {
    "id": "eic",
    "name": "การเป็นผู้ประกอบการและนวัตกรรม",
    "nameEn": "Entrepreneurship & Innovation Center"
  },
  {
    "id": "imo",
    "name": "บริหารจัดการนวัตกรรม",
    "nameEn": "Innovation Management Office"
  },
  {
    "id": "sit",
    "name": "ยุทธศาสตร์ โครงการริเริ่ม และการเปลี่ยนแปลง",
    "nameEn": "Strategy, Initiatives & Transformation"
  },
  {
    "id": "tech-spin",
    "name": "ถ่ายทอดเทคโนโลยีและบริษัท Spin-off",
    "nameEn": "Technology Spin-off & Transfer"
  },
  {
    "id": "tech-up",
    "name": "เทคโนโลยีเชิงลึกและการขยายระดับการผลิต",
    "nameEn": "Deep Tech Scale-Up"
  },
  {
    "id": "linc",
    "name": "ความร่วมมือท้องถิ่นและอุตสาหกรรม",
    "nameEn": "Local & Industrial Collaboration"
  },
  {
    "id": "pubsec",
    "name": "โครงการความร่วมมือภาครัฐ",
    "nameEn": "Public Sector Projects"
  },
  {
    "id": "cc",
    "name": "งานสร้างสรรค์และการสื่อสาร",
    "nameEn": "Creative & Communication"
  },
  {
    "id": "mi",
    "name": "นวัตกรรมตลาดสำหรับผลิตภัณฑ์นวัตกรรม",
    "nameEn": "Market Innovation"
  },
  {
    "id": "crm",
    "name": "ลูกค้าสัมพันธ์",
    "nameEn": "Customer Relationship Management"
  },
  {
    "id": "ifu",
    "name": "การใช้ประโยชน์พื้นที่และสิ่งอำนวยความสะดวก",
    "nameEn": "Infrastructure & Facility Utilization"
  },
  {
    "id": "iqi",
    "name": "พัฒนาคุณภาพโครงสร้างพื้นฐาน",
    "nameEn": "Infrastructure Quality Improvement"
  },
  {
    "id": "les",
    "name": "ห้องปฏิบัติการและเครื่องมือ",
    "nameEn": "Laboratory & Equipment Services"
  },
  {
    "id": "foodfabr",
    "name": "โรงงานต้นแบบผลิตภัณฑ์อาหารนวัตกรรม",
    "nameEn": "Food Fabrication Pilot Plant"
  }
];
export const teamLabel = (id: string) => TEAMS.find((t) => t.id === id)?.name || id.toUpperCase();

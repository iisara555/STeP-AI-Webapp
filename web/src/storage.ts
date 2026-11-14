// The Cloud Workspace storage pool status (GET /api/storage) and the Thai banner shown for it. Thresholds come
// from the Gateway (80 % warning, 95 % critical, 100 % full); this file only words them.

export type StorageLevel = 'ok' | 'warning' | 'critical' | 'full';
export type StorageStatus =
  | { state: 'unavailable' }
  | {
      state: 'available';
      level: StorageLevel;
      bytesPercent: number;
      inodesPercent: number;
      worst: 'bytes' | 'inodes';
    };

export type StorageBannerView = { tone: 'warning' | 'critical' | 'full'; title: string; detail: string };

const LEVELS: ReadonlySet<string> = new Set(['ok', 'warning', 'critical', 'full']);
const percent = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Accepts only a well-formed status; anything else is treated as unknown, never as a level. */
export function parseStorageStatus(value: unknown): StorageStatus {
  const v = value as Record<string, unknown> | null;
  if (
    v?.state === 'available' &&
    LEVELS.has(String(v.level)) &&
    percent(v.bytesPercent) &&
    percent(v.inodesPercent) &&
    (v.worst === 'bytes' || v.worst === 'inodes')
  )
    return {
      state: 'available',
      level: v.level as StorageLevel,
      bytesPercent: v.bytesPercent as number,
      inodesPercent: v.inodesPercent as number,
      worst: v.worst,
    };
  return { state: 'unavailable' };
}

const FREE_UP = 'ลบไฟล์หรืองานที่ไม่ใช้ หรือติดต่อผู้ดูแลเพื่อขอเพิ่มพื้นที่';

/** Null when nothing should be shown: the pool is fine, or its usage is not known. */
export function storageBanner(status: StorageStatus | null): StorageBannerView | null {
  if (!status || status.state !== 'available' || status.level === 'ok') return null;
  const files = status.worst === 'inodes';
  const shown = Math.floor(files ? status.inodesPercent : status.bytesPercent);
  if (status.level === 'warning')
    return {
      tone: 'warning',
      title: files ? `จำนวนไฟล์ใช้ไปแล้ว ${shown}% ของที่ให้ไว้` : `พื้นที่เก็บงานใช้ไปแล้ว ${shown}%`,
      detail: `ใกล้เต็มแล้ว ${FREE_UP}`,
    };
  if (status.level === 'critical')
    return {
      tone: 'critical',
      title: files ? `จำนวนไฟล์เกือบเต็มแล้ว (${shown}%)` : `พื้นที่เก็บงานเกือบเต็มแล้ว (${shown}%)`,
      detail: `อีกไม่นานจะบันทึกงานใหม่ไม่ได้ ${FREE_UP}ตอนนี้`,
    };
  return {
    tone: 'full',
    title: files ? 'จำนวนไฟล์เต็มแล้ว' : 'พื้นที่เก็บงานเต็มแล้ว',
    detail: `ตอนนี้บันทึกงานใหม่และอัปโหลดไฟล์ไม่ได้ ส่วนไฟล์และงานเดิมยังอยู่ครบ เปิดอ่าน ดาวน์โหลด และลบได้ตามปกติ ${FREE_UP}`,
  };
}

// The caller's own storage pool level for the Cloud Workspace warning banner, and the early refusal of new saves
// once the pool is full. The source is injected (the broker boundary's usage(), or a fake in tests); without one
// the Gateway reports 'unavailable' rather than inventing numbers. The filesystem quota stays the real limit:
// this check only refuses earlier and more clearly, it never permits a write the quota would refuse.
import { z } from 'zod';
import { usageLevel, type UsageLevel } from '../workspace/native-quota-socket.ts';

/** Raw pool counts as the broker reports them; the Gateway derives the level itself. */
export type PoolUsage = { bytesUsed: number; bytesHard: number; inodesUsed: number; inodesHard: number };

/** Usage of one owner's pool. Must never allocate, and must answer only for the owner it is asked about. */
export type StorageUsageSource = { usage(ownerId: string): Promise<PoolUsage> };

export type StorageStatus =
  | { state: 'unavailable' }
  | {
      state: 'available';
      level: UsageLevel;
      bytesPercent: number;
      inodesPercent: number;
      /** Which limit is closer to full; the banner names that one. */
      worst: 'bytes' | 'inodes';
    };

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Usage = z.object({
  bytesUsed: Count,
  bytesHard: Count.positive(),
  inodesUsed: Count,
  inodesHard: Count.positive(),
});

export async function storageStatus(
  source: StorageUsageSource | undefined,
  ownerId: string,
): Promise<StorageStatus> {
  if (!source) return { state: 'unavailable' };
  let raw: unknown;
  try {
    raw = await source.usage(ownerId);
  } catch {
    return { state: 'unavailable' };
  }
  const parsed = Usage.safeParse(raw);
  if (!parsed.success) return { state: 'unavailable' };
  const u = parsed.data;
  const { level, bytesPercent, inodesPercent } = usageLevel({ projectId: 0, ...u });
  const worst = u.inodesUsed / u.inodesHard > u.bytesUsed / u.bytesHard ? 'inodes' : 'bytes';
  return { state: 'available', level, bytesPercent, inodesPercent, worst };
}

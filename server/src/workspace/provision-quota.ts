// Operator command only; ordinary gateway startup never imports this entry point.
import { resolve } from 'node:path';
import { initializeWorkspaceQuota } from './quota-store.ts';

const [dataRoot, limit, flag, confirmedRoot, ...extra] = process.argv.slice(2);
if (
  !dataRoot ||
  !limit ||
  extra.length ||
  (flag !== undefined && (flag !== '--onboard-existing-root' || !confirmedRoot)) ||
  !/^[1-9][0-9]*$/.test(limit)
) {
  console.error(
    'ใช้: npm run workspace:quota:init -- <data-root> <จำนวน Workspace ต่อผู้ใช้> [--onboard-existing-root <absolute-data-root>]',
  );
  process.exit(2);
}
try {
  initializeWorkspaceQuota(resolve(dataRoot), Number(limit), { onboardExistingRoot: confirmedRoot });
  console.log('กำหนดนโยบาย quota ของ Workspace แล้ว');
} catch (error) {
  console.error('กำหนดนโยบาย quota ไม่สำเร็จ:', (error as Error).message);
  process.exitCode = 1;
}

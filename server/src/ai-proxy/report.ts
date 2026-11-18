// Monthly AI spending report for the server's owner, read straight from the usage files:
//   npm run ai-gateway:report -- [YYYY-MM]
// Shows the organization, each department and each person (email, requests, spend). No prompt or answer exists to show.
import { resolve } from 'node:path';
import { configFile, UNASSIGNED, userCapUsd } from './config.ts';
import { monthOf, UsageLedger } from './ledger.ts';

const dataRoot = process.env.STEP_DATA_ROOT;
const settings = process.env.STEP_AI_GATEWAY_CONFIG;
if (!dataRoot || !settings) {
  console.error('ต้องตั้ง STEP_DATA_ROOT และ STEP_AI_GATEWAY_CONFIG');
  process.exit(2);
}
const month = process.argv[2] ?? monthOf(Date.now());
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
  console.error('ระบุเดือนแบบ YYYY-MM');
  process.exit(2);
}
const config = await configFile(resolve(settings))();
const totals = await new UsageLedger(resolve(dataRoot)).totals(month);
const rate = config.budget.thbPerUsd;
const money = (usd: number) =>
  `$${usd.toFixed(2)}${rate ? ` (≈${Math.round(usd * rate).toLocaleString('th-TH')} บาท)` : ''}`;
const name = (id: string) =>
  config.departments.find((d) => d.id === id)?.name ?? (id === UNASSIGNED.id ? UNASSIGNED.name : id);

console.log(`การใช้ AI ขององค์กร เดือน ${month}`);
console.log(
  `ทั้งองค์กร ${money(totals.org.usd)} จากงบ ${money(config.budget.orgMonthlyUsd)} · ${totals.org.requests} คำขอ`,
);
console.log('\nหน่วยงาน');
for (const [id, t] of [...totals.departments].sort((a, b) => b[1].usd - a[1].usd)) {
  const cap = config.departments.find((d) => d.id === id)?.monthlyUsd;
  console.log(
    `  ${name(id)}: ${money(t.usd)}${cap !== undefined ? ` / ${money(cap)}` : ''} · ${t.requests} คำขอ`,
  );
}
console.log('\nรายคน');
for (const u of [...totals.users.values()].sort((a, b) => b.usd - a.usd))
  console.log(
    `  ${u.email} (${name(u.department)}): ${money(u.usd)} / ${money(userCapUsd(config, u.email))} · ${u.requests} คำขอ`,
  );

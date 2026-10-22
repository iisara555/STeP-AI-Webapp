import { parseArgs } from 'node:util';
import { operator } from './operator.ts';
const { values } = parseArgs({
  options: { 'owner-email': { type: 'string' }, name: { type: 'string', default: 'STeP' } },
});
if (!values['owner-email'])
  throw new Error('Pass --owner-email for the verified Google account that will own this tenant');
const { data, error } = await operator().rpc('bootstrap_tenant', {
  tenant_name: values.name,
  owner_email: values['owner-email'],
});
if (error) throw new Error('BOOTSTRAP_FAILED');
console.log(
  JSON.stringify({ tenant: data, owner: 'reserved; assigned at verified Google sign-in', aiBudget: 0 }),
);

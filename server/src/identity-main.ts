import { createIdentityGateway } from './identity-gateway.ts';
import { googleVerifier, IdentityService } from './identity.ts';
const {
  STEP_GOOGLE_CLIENT_ID: clientId,
  STEP_GOOGLE_DOMAIN: domain,
  STEP_INVITATIONS_FILE: invitations,
} = process.env;
const port = Number(process.env.STEP_IDENTITY_PORT || 8767);
if (!clientId || !domain || !invitations || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Missing or invalid gateway configuration');
// Development gateway only: loopback, synthetic provider and no staff data.
const gateway = await createIdentityGateway({
  identities: new IdentityService(domain, invitations, googleVerifier(clientId)),
  dataRoot: process.env.STEP_IDENTITY_DATA || '.data/identity-trial',
  clientId,
  origin: `http://localhost:${port}`,
});
gateway.server.listen(port, '127.0.0.1', () => console.log(`เปิด http://localhost:${port}`));
process.on('SIGINT', () => void gateway.close());
process.on('SIGTERM', () => void gateway.close());

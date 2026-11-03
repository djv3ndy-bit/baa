import { adminHeaders, boundedFetch, sendFormEmail } from './_public-form-guard.js';
import { createModerationNoticesHandler } from '../server/moderation/noticeDelivery.mjs';
import { createStagingCleaner } from '../server/moderation/stagingCleanup.mjs';

const ORIGINS = new Set([
  'https://lmwqrxoitraofaftpwhe.supabase.co',
  'https://auth.baristajobmatch.com',
]);
const RPCS = new Set(['claim_moderation_notices', 'ack_moderation_notices']);

export async function moderationNoticeRpc(name, args, signal) {
  const origin = process.env.SUPABASE_URL;
  if (!ORIGINS.has(origin) || !process.env.SUPABASE_SECRET_KEY || !RPCS.has(name)) {
    throw new Error('Moderation service unavailable');
  }
  const response = await boundedFetch(origin + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify(args), redirect: 'error',
  }, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Moderation service unavailable');
  }
  return response.json();
}

export default createModerationNoticesHandler({
  rpc: moderationNoticeRpc, sendEmail: sendFormEmail,
  // Construct the bounded worker only after the handler authorizes production.
  cleanup: () => createStagingCleaner()(),
});

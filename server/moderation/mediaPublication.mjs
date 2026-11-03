import { createHash, randomUUID } from 'node:crypto';
import {supabaseOrigin,serviceHeaders} from './providerRequest.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_MEDIA_ORIGIN = 'https://lmwqrxoitraofaftpwhe.supabase.co';
const TYPES = new Map([
  ['image/jpeg', ['jpg', 5 * 1024 ** 2]], ['image/png', ['png', 5 * 1024 ** 2]],
  ['image/webp', ['webp', 5 * 1024 ** 2]], ['video/mp4', ['mp4', 50 * 1024 ** 2]],
  ['video/quicktime', ['mov', 50 * 1024 ** 2]], ['video/webm', ['webm', 50 * 1024 ** 2]],
]);
const SAFE_ERRORS = new Set(['ugc_media_access_denied', 'ugc_invalid_media', 'ugc_profile_changed',
  'ugc_publication_in_progress', 'ugc_publication_unavailable', 'ugc_media_not_approved']);
export function matchesMediaSignature(bytes, type) {
  const b = Buffer.from(bytes);
  if (type === 'image/jpeg') return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR';
  if (type === 'image/webp') return b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'video/mp4') return b.length >= 16 && b.toString('ascii', 4, 8) === 'ftyp';
  if (type === 'video/quicktime') return b.length >= 16 && ['ftyp', 'moov', 'mdat', 'wide'].includes(b.toString('ascii', 4, 8));
  if (type === 'video/webm') return b.length >= 8 && b.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  return false;
}
function fail(status, code) { return { status, body: { error: code } }; }
function safeCode(data) { return SAFE_ERRORS.has(data?.message) ? data.message : 'ugc_publication_failed'; }
function storagePath(bucket, path) { return `/storage/v1/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`; }
function validClaim(claim, ownerId, requestId) {
  const spec = TYPES.get(claim?.mimeType);
  if (!spec || !Number.isSafeInteger(claim.byteSize) || claim.byteSize < 1 || claim.byteSize > spec[1]
      || claim.requestId !== requestId || claim.sourceBucket !== 'ugc-media-staging'
      || !['avatar_url', 'bar_picture_url', 'video_path'].includes(claim.field)) return false;
  const video = claim.field === 'video_path';
  return video === claim.mimeType.startsWith('video/')
    && claim.targetBucket === (video ? 'coffee-videos' : 'cafe-images')
    && claim.sourcePath === `${ownerId}/${requestId}.${spec[0]}`
    && claim.targetPath === `${ownerId}/approved-${requestId}.${spec[0]}`;
}
function validResult(result, requestId, ownerId) {
  if (result?.requestId !== requestId || result.status !== 'published') return false;
  if (!['avatar_url', 'bar_picture_url', 'video_path'].includes(result.field) || typeof result.value !== 'string') return false;
  const prefix = result.field === 'video_path' ? `${ownerId}/approved-${requestId}.`
    : `${PUBLIC_MEDIA_ORIGIN}/storage/v1/object/public/cafe-images/${ownerId}/approved-${requestId}.`;
  return result.value.startsWith(prefix) && ['jpg', 'png', 'webp', 'mp4', 'mov', 'webm'].includes(result.value.slice(prefix.length));
}
function publishedBody(result) { return { requestId: result.requestId, status: 'published', field: result.field, value: result.value }; }
async function boundedBytes(response, maximum) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw new Error('size');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw new Error('size'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export function createMediaPublisher({ fetchImpl = fetch, env = process.env, newId = randomUUID } = {}) {
  return async function publish({ authorization, body }) {
    let base;
    try { base = supabaseOrigin(env.SUPABASE_URL); }
    catch { return fail(503, 'ugc_publication_unavailable'); }
    if (!env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY) return fail(503, 'ugc_publication_unavailable');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !UUID.test(body.requestId)) return fail(400, 'ugc_invalid_media');
    const match = /^Bearer ([^\s]+)$/i.exec(authorization || '');
    if (!match || match[1].length > 8192) return fail(401, 'ugc_media_access_denied');
    const requestId = body.requestId.toLowerCase();
    const rpc = async (name, args) => {
      const response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: 'POST', redirect: 'error',
        headers: serviceHeaders(env.SUPABASE_SECRET_KEY),
        body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => null);
      if (!response.ok) { const error = new Error(safeCode(data)); error.safe = true; throw error; }
      return data;
    };
    let user;
    try {
      const auth = await fetchImpl(`${base}/auth/v1/user`, { redirect: 'error', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${match[1]}` }, signal: AbortSignal.timeout(10000) });
      if (!auth.ok) return fail(401, 'ugc_media_access_denied');
      user = await auth.json();
      if (!UUID.test(user?.id) || user.is_anonymous === true) return fail(401, 'ugc_media_access_denied');
    } catch { return fail(503, 'ugc_publication_unavailable'); }
    const ownerId = user.id.toLowerCase(), claimId = newId();
    let claim;
    try { claim = await rpc('claim_profile_media_publication', { p_owner_id: ownerId, p_request_id: requestId, p_claim_id: claimId }); }
    catch (error) { return fail(error.message === 'ugc_media_access_denied' ? 403 : 409, error.safe ? error.message : 'ugc_publication_failed'); }
    if (claim?.status === 'published') return validResult(claim, requestId, ownerId) ? { status: 200, body: publishedBody(claim) } : fail(503, 'ugc_publication_failed');
    if (claim?.requestId === requestId && claim.status === 'publishing') return { status: 202, body: { requestId, status: 'publishing' } };
    if (claim?.status !== 'claimed' || !validClaim(claim, ownerId, requestId)) return fail(503, 'ugc_publication_failed');
    const storageHeaders = serviceHeaders(env.SUPABASE_SECRET_KEY);
    let unsafe = false;
    try {
      const source = await fetchImpl(`${base}${storagePath(claim.sourceBucket, claim.sourcePath)}`, { redirect: 'error', headers: storageHeaders, signal: AbortSignal.timeout(20000) });
      if (!source.ok) throw new Error('source');
      const bytes = await boundedBytes(source, claim.byteSize);
      if (bytes.length !== claim.byteSize || !matchesMediaSignature(bytes, claim.mimeType)) { unsafe = true; throw new Error('signature'); }
      const digest = createHash('sha256').update(bytes).digest('hex');
      // The copy API carries authoritative source metadata into Storage's
      // permission probe. Keep the strict destination guard and verify the
      // actual copied bytes below. Preserve file metadata but drop unreviewed
      // user metadata, matching raw uploads; never fall back to raw upload.
      const copy = await fetchImpl(`${base}/storage/v1/object/copy`, { method: 'POST', redirect: 'error', headers: { ...storageHeaders, 'x-upsert': 'false' },
        body: JSON.stringify({ bucketId: claim.sourceBucket, sourceKey: claim.sourcePath, destinationBucket: claim.targetBucket, destinationKey: claim.targetPath, copyMetadata: false }), signal: AbortSignal.timeout(25000) });
      if (!copy.ok && ![400, 409].includes(copy.status)) throw new Error('copy');
      // Download even after successful upload. Unknown earlier copies must contain exactly the reviewed source bytes.
      const target = await fetchImpl(`${base}${storagePath(claim.targetBucket, claim.targetPath)}`, { redirect: 'error', headers: storageHeaders, signal: AbortSignal.timeout(20000) });
      if (!target.ok) throw new Error('target');
      const copied = await boundedBytes(target, claim.byteSize);
      if (copied.length !== bytes.length || createHash('sha256').update(copied).digest('hex') !== digest) throw new Error('target_mismatch');
      const result = await rpc('finish_profile_media_publication', { p_owner_id: ownerId, p_request_id: requestId, p_claim_id: claimId, p_sha256: digest });
      if (!validResult(result, requestId, ownerId)) throw new Error('result');
      return { status: 200, body: publishedBody(result) };
    } catch (error) {
      // Release only our matching lease. A committed finish is never reversed by this call.
      await rpc('fail_profile_media_publication', { p_owner_id: ownerId, p_request_id: requestId, p_claim_id: claimId, p_unsafe: unsafe }).catch(() => {});
      return fail(unsafe ? 422 : 409, unsafe ? 'ugc_invalid_media' : error.safe ? error.message : 'ugc_publication_failed');
    }
  };
}

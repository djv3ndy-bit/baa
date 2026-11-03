import { randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/;
const MAX_AGE_MS = 23 * 60 * 60 * 1000;
const MAX_ITEMS = 25;
export const OWNER_EMAIL = 'hello@baristajobmatch.com';
export const MODERATION_CONSOLE_URL = 'https://supabase.com/dashboard/project/lmwqrxoitraofaftpwhe/editor?schema=private';

function date(value) {
  if (typeof value !== 'string' || !DATE.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid moderation date');
  }
  return new Date(value).toISOString();
}

export function validateNoticeBatch(value, claimId, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.claimId !== claimId || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new Error('Invalid moderation batch');
  }
  const needsAttentionCount = value.needsAttentionCount ?? 0;
  if (!Number.isSafeInteger(needsAttentionCount) || needsAttentionCount < 0) throw new Error('Invalid attention count');
  if (value.items.length === 0) return { claimId, deliveryId: null, items: [], needsAttentionCount };
  if (typeof value.deliveryId !== 'string' || !UUID.test(value.deliveryId)) throw new Error('Invalid delivery ID');
  const firstAttemptAt = date(value.firstAttemptAt);
  if (!Number.isFinite(now) || Date.parse(firstAttemptAt) > now + 300000
      || now - Date.parse(firstAttemptAt) >= MAX_AGE_MS) {
    throw new Error('Delivery requires manual attention');
  }
  const seen = new Set();
  const items = value.items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.noticeId !== 'string' || !UUID.test(item.noticeId)
        || seen.has(item.noticeId.toLowerCase())
        || !['media_pending', 'safety_report'].includes(item.eventType)) {
      throw new Error('Invalid moderation item');
    }
    seen.add(item.noticeId.toLowerCase());
    const createdAt = date(item.createdAt), dueAt = date(item.dueAt);
    if (Date.parse(createdAt) > Date.parse(firstAttemptAt) + 1000
        || Date.parse(dueAt) < Date.parse(createdAt)) throw new Error('Invalid moderation deadline');
    return { noticeId: item.noticeId.toLowerCase(), eventType: item.eventType, createdAt, dueAt };
  }).sort((a, b) => a.noticeId.localeCompare(b.noticeId));
  return { claimId, deliveryId: value.deliveryId.toLowerCase(), firstAttemptAt, items, needsAttentionCount };
}

function ownerTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso));
}

export function moderationNoticeEmail(batch) {
  // Only fixed labels, validated IDs/dates and derived counts enter the email.
  // Raw report text, member identity, media and URLs never cross this boundary.
  const media = batch.items.filter(item => item.eventType === 'media_pending').length;
  const reports = batch.items.length - media;
  const due = batch.items.map(item => item.dueAt).sort()[0];
  const deadline = ownerTime(due);
  const count = batch.items.length;
  const subject = '[BaristaMatch] ' + count + ' moderation item' + (count === 1 ? '' : 's') + ' need review';
  const text = [
    'BaristaMatch moderation',
    '', 'New items awaiting owner review:',
    'Safety reports: ' + reports,
    'Photos or videos: ' + media,
    'Earliest review deadline: ' + deadline,
    '', 'Open your private Supabase moderation queue:',
    MODERATION_CONSOLE_URL,
    '', 'Check the current queue before acting; an item may have been handled after this notice was queued.',
    'Review requests and the response steps are documented in your moderation runbook.',
    '', 'Delivery reference: ' + batch.deliveryId,
  ].join('\n');
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;background:#f7f4ef;color:#2d211b;font-family:Arial,sans-serif">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #e7ded4;border-radius:16px">',
    '<tr><td style="padding:28px;font-size:16px;line-height:1.6">',
    '<h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">BaristaMatch moderation</h1>',
    '<p>New items awaiting owner review:</p><ul>',
    '<li>Safety reports: ' + reports + '</li>',
    '<li>Photos or videos: ' + media + '</li></ul>',
    '<p><strong>Earliest review deadline:</strong><br>' + deadline + '</p>',
    '<p style="margin:24px 0"><a href="' + MODERATION_CONSOLE_URL + '" style="display:inline-block;background:#a95820;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;min-height:24px">Open private review queue</a></p>',
    '<p>Check the current queue before acting; an item may already have been handled.</p>',
    '<p>Use the response steps in your moderation runbook.</p>',
    '<p style="font-size:12px;color:#746a61">Delivery reference: ' + batch.deliveryId + '</p>',
    '</td></tr></table></td></tr></table></body></html>',
  ].join('');
  return {
    from: 'BaristaMatch Support <updates@updates.baristajobmatch.com>',
    to: [OWNER_EMAIL], reply_to: OWNER_EMAIL, subject, text, html,
  };
}

function authorized(header, secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
      || typeof header !== 'string' || header.length > 300) return false;
  const expected = Buffer.from('Bearer ' + secret), actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createModerationNoticesHandler({
  env = process.env, rpc, sendEmail, uuid = randomUUID, clock = Date.now,
  signalFactory = () => AbortSignal.timeout(20000), cleanup,
  log = () => console.error('Moderation maintenance needs attention.'),
}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (env.VERCEL_ENV !== 'production') return res.status(404).json({ error: 'Not found.' });
    if (!authorized(req.headers?.authorization, env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized.' });
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    // Start bounded maintenance independently: a storage failure must not stop
    // the notice from reaching the owner, nor be reported as a clean run.
    const cleanupJob = cleanup ? Promise.resolve().then(cleanup).catch(() => ({ ok: false })) : null;
    const finish = async (status, body) => {
      if (cleanupJob) {
        const result = await cleanupJob;
        if (result?.ok !== true || !Number.isSafeInteger(result.claimed) || !Number.isSafeInteger(result.deleted)
            || result.claimed < 0 || result.claimed > 25 || result.deleted < 0 || result.deleted > result.claimed) {
          log();
          return res.status(503).json({ ...body, ok: false, error: 'Moderation maintenance needs attention.' });
        }
        body = { ...body, cleanedStagingItems: result.deleted };
      }
      return res.status(status).json(body);
    };
    let batch;
    const signal = signalFactory();
    try {
      const claimId = uuid();
      if (!UUID.test(claimId)) throw new Error('Invalid claim');
      const claimed = await rpc('claim_moderation_notices', { p_claim_id: claimId, p_limit: MAX_ITEMS }, signal);
      batch = validateNoticeBatch(claimed, claimId, clock());
      if (batch.items.length === 0) {
        if (batch.needsAttentionCount > 0) {
          log();
          return finish(503, { ok: false, notifiedItems: 0, needsAttentionCount: batch.needsAttentionCount, error: 'Moderation notices need attention.' });
        }
        return finish(200, { ok: true, notifiedItems: 0 });
      }
      const key = 'bjm/moderation/' + batch.deliveryId;
      const delivered = await sendEmail(moderationNoticeEmail(batch), key, signal);
      if (delivered !== true) throw new Error('Delivery unconfirmed');
      const acknowledged = await rpc('ack_moderation_notices', {
        p_claim_id: claimId, p_notice_ids: batch.items.map(item => item.noticeId), p_delivered: true,
      }, signal);
      if (acknowledged !== batch.items.length) throw new Error('Acknowledgement unconfirmed');
      if (batch.needsAttentionCount > 0) {
        log();
        return finish(503, { ok: false, notifiedItems: batch.items.length, needsAttentionCount: batch.needsAttentionCount, error: 'Moderation notices need attention.' });
      }
      return finish(200, { ok: true, notifiedItems: batch.items.length });
    } catch {
      // Do not log provider responses, headers, payloads or database errors.
      // An ambiguous send is retried with the same durable delivery ID/body.
      // Its database group stops automatic delivery before the 24h key horizon.
      if (batch?.items.length && !signal.aborted) {
        try {
          await rpc('ack_moderation_notices', {
            p_claim_id: batch.claimId, p_notice_ids: batch.items.map(item => item.noticeId), p_delivered: false,
          }, signal);
        } catch { /* Lease expires; the durable group remains unchanged. */ }
      }
      log();
      return finish(503, { error: 'Moderation notices need attention.' });
    }
  };
}

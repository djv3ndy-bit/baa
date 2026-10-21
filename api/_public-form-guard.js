import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REQUEST_TIMEOUT_MS = 20000;
const DEPENDENCY_TIMEOUT_MS = 5000;
const BUDGETS = {
  support: [[10, 600], [40, 86400], [5, 3600]],
  waitlist: [[20, 600], [100, 86400], [3, 3600]],
};

export class PublicFormError extends Error {
  constructor(status, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function requestSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

export function boundedFetch(url, options = {}, signal) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(DEPENDENCY_TIMEOUT_MS)]),
  });
}

export function adminHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  return {
    apikey: key,
    ...(key && !key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}),
    'Content-Type': 'application/json',
    ...extra,
  };
}

export function formBody(req, maxBytes) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
    throw new PublicFormError(400, 'Please send a valid form.');
  }
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) {
    throw new PublicFormError(400, 'Please send a valid form.');
  }
  if (length !== undefined && Number(length) > maxBytes) {
    throw new PublicFormError(413, 'The form is too large. Please shorten it and try again.');
  }
  let size;
  try { size = Buffer.byteLength(JSON.stringify(body)); }
  catch { throw new PublicFormError(400, 'Please send a valid form.'); }
  if (size > maxBytes) throw new PublicFormError(413, 'The form is too large. Please shorten it and try again.');
  return body;
}

export function formText(value, max, required = false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) {
    throw new PublicFormError(400, 'Please check the form fields and try again.');
  }
  const text = value.trim();
  if ((required && !text) || /[\u0000\u000b\u000c]/.test(text)) {
    throw new PublicFormError(400, 'Please complete all required fields.');
  }
  return text;
}

export function formEmail(value) {
  const raw = formText(value, 320, true).toLowerCase();
  const parts = raw.split('@');
  const local = parts[0];
  // domainToASCII uses URL host parsing, so reject URL delimiters before it can
  // turn an invalid value such as example.com/path into a valid-looking host.
  const domain = parts.length === 2 && /^[\p{L}\p{M}\p{N}.-]+$/u.test(parts[1]) ? domainToASCII(parts[1]) : '';
  const email = `${local}@${domain}`;
  if (parts.length !== 2 || !local || local.length > 64 || email.length > 254
      || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
      || local.startsWith('.') || local.endsWith('.') || local.includes('..')
      || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new PublicFormError(400, 'Please enter a valid email address.');
  }
  return email;
}

function clientAddress(req) {
  // Vercel overwrites this header at its edge. Never trust arbitrary forwarded
  // headers on a standalone/local server. See https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
  const address = process.env.VERCEL === '1'
    ? req.headers?.['x-vercel-forwarded-for']
    : req.socket?.remoteAddress;
  if (typeof address !== 'string' || !isIP(address)) {
    throw new PublicFormError(503, 'The form service is temporarily unavailable. Please try again later.');
  }
  if (isIP(address) === 4) return address;
  // Normalize equivalent IPv6 spellings and group a /64 so rotating temporary
  // addresses within one client network cannot bypass the IP budget.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const start = left ? left.split(':') : [], end = right ? right.split(':') : [];
  const groups = right !== undefined ? [...start, ...Array(8 - start.length - end.length).fill('0'), ...end] : start;
  if (groups.slice(0, 5).every(part => Number.parseInt(part, 16) === 0) && groups[5] === 'ffff') {
    const number = Number.parseInt(groups[6], 16) * 65536 + Number.parseInt(groups[7], 16);
    return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.');
  }
  return `${groups.slice(0, 4).map(part => part.padStart(4, '0')).join(':')}::/64`;
}

export async function consumePublicFormBudget(req, form, email, signal) {
  const key = process.env.SUPABASE_SECRET_KEY;
  const limits = BUDGETS[form];
  if (!key || !process.env.SUPABASE_URL || !limits) throw new PublicFormError(503, 'The form service is temporarily unavailable.');
  const address = clientAddress(req);
  const p_buckets = limits.map(([max_requests, window_seconds], index) => ({
    bucket_key: createHmac('sha256', key)
      .update(['bjm-public-form-v1', form, index === 2 ? 'recipient' : 'ip', String(window_seconds), index === 2 ? email : address].join('\0'))
      .digest('hex'),
    max_requests,
    window_seconds,
  }));
  let result;
  try {
    const response = await boundedFetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/consume_public_form_budget`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ p_buckets }),
    }, signal);
    if (!response.ok) throw new Error('Budget service failed');
    result = await response.json();
    if (!result || Array.isArray(result) || typeof result.allowed !== 'boolean'
        || !Number.isSafeInteger(result.retry_after_seconds)
        || result.retry_after_seconds < 0 || result.retry_after_seconds > 86400
        || (result.allowed ? result.retry_after_seconds !== 0 : result.retry_after_seconds < 1)) throw new Error('Invalid budget response');
  } catch {
    throw new PublicFormError(503, 'The form service is temporarily unavailable. Please try again later.');
  }
  if (!result.allowed) throw new PublicFormError(429, 'Too many requests. Please wait before trying again.', result.retry_after_seconds);
}

export function formFailure(res, error, fallback) {
  if (error instanceof PublicFormError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message });
  }
  // Provider responses and exception messages may contain personal data or
  // credentials. Return and log only our own service message.
  console.error(fallback);
  return res.status(503).json({ error: fallback });
}

export async function sendFormEmail(payload, idempotencyKey, signal) {
  if (!process.env.RESEND_API_KEY) return false;
  // Resend keeps Idempotency-Key for 24 hours. A retry reuses both the key and
  // payload, including after an ambiguous network failure. https://resend.com/docs/dashboard/emails/idempotency-keys
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt += 1) {
    let retryDelayMs = 250;
    try {
      const response = await boundedFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body,
      }, signal);
      if (response.ok) {
        const result = await response.json();
        return typeof result?.id === 'string' && Boolean(result.id);
      }
      if (response.status === 429) {
        // Only a brief per-second limit can recover within this request. Quota
        // exhaustion and unknown 429 responses must not amplify provider load.
        // Cap Retry-After at two seconds and keep the shared request deadline.
        // https://resend.com/docs/api-reference/rate-limit
        let problem;
        try { problem = await response.json(); } catch { return false; }
        const retryAfter = response.headers.get('retry-after');
        if (problem?.name !== 'rate_limit_exceeded' || !/^[12]$/.test(retryAfter || '')) return false;
        retryDelayMs = Number(retryAfter) * 1000;
      } else {
        await response.body?.cancel().catch(() => {});
        if (response.status < 500) return false;
      }
    } catch {
      // One bounded retry with the same idempotency key also covers timeouts.
    }
    if (attempt === 0) {
      try { await delay(retryDelayMs, undefined, { signal }); }
      catch { return false; }
    }
  }
  return false;
}

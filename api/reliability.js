const REPOSITORY = 'djv3ndy-bit/baa';
const WORKFLOW_FILE = 'engineering-reliability-monitor.yml';
const GITHUB_API = 'https://api.github.com';
const SITE_ORIGIN = 'https://www.baristajobmatch.com';
const FETCH_TIMEOUT_MS = 6500;
const CACHE_TTL_MS = 30000;

let officeCache = { expiresAt: 0, value: null };

const clean = (value, max = 180) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function serverHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;
  const headers = { apikey: key, 'Content-Type': 'application/json', ...extra };
  if (key && !key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function owner(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY || !process.env.SUPABASE_SECRET_KEY) return null;
  const auth = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!auth.ok) return null;
  const user = await auth.json();
  const check = await fetch(`${process.env.SUPABASE_URL}/rest/v1/support_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`, { headers: serverHeaders() });
  if (!check.ok) return null;
  return (await check.json()).length ? user : null;
}

async function boundedFetch(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function github(path) {
  const response = await boundedFetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'BaristaMatch-Reliability-Office',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json();
}

async function probe(id, label, url) {
  const startedAt = Date.now();
  try {
    const response = await boundedFetch(url, { cache: 'no-store', redirect: 'error' });
    await response.body?.cancel().catch(() => {});
    return {
      id,
      label,
      status: response.ok ? 'healthy' : 'down',
      detail: `HTTP ${response.status}`,
      latency_ms: Date.now() - startedAt,
    };
  } catch {
    return { id, label, status: 'down', detail: 'Request failed', latency_ms: Date.now() - startedAt };
  }
}

export function normalizeRun(run) {
  const id = Number(run?.id);
  const runNumber = Number(run?.run_number);
  const status = clean(run?.status, 30) || 'unknown';
  const conclusion = run?.conclusion ? clean(run.conclusion, 30) : null;
  const started = Date.parse(run?.run_started_at || run?.created_at || '');
  const finished = Date.parse(run?.updated_at || '');
  return {
    id: Number.isSafeInteger(id) && id > 0 ? id : null,
    number: Number.isSafeInteger(runNumber) && runNumber > 0 ? runNumber : null,
    title: clean(run?.display_title || run?.name || 'Engineering reliability monitor', 120),
    event: clean(run?.event, 30),
    branch: clean(run?.head_branch, 80),
    sha: /^[0-9a-f]{7,40}$/i.test(String(run?.head_sha || '')) ? String(run.head_sha).slice(0, 7).toLowerCase() : null,
    status,
    conclusion,
    started_at: Number.isFinite(started) ? new Date(started).toISOString() : null,
    updated_at: Number.isFinite(finished) ? new Date(finished).toISOString() : null,
    duration_seconds: Number.isFinite(started) && Number.isFinite(finished) && finished >= started ? Math.round((finished - started) / 1000) : null,
    url: Number.isSafeInteger(id) && id > 0 ? `https://github.com/${REPOSITORY}/actions/runs/${id}` : `https://github.com/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}`,
  };
}

function statusForRun(run) {
  if (!run) return { status: 'data_unavailable', severity: 'Unavailable', label: 'Workflow data unavailable' };
  if (run.status !== 'completed') return { status: 'running', severity: 'Pending', label: 'Monitoring in progress' };
  if (run.conclusion === 'success') return { status: 'healthy', severity: 'P3', label: 'All monitored systems healthy' };
  if (run.conclusion === 'cancelled') return { status: 'overdue', severity: 'Review', label: 'Latest monitor was cancelled' };
  return { status: 'review_required', severity: 'P0–P2', label: 'Incident review required' };
}

export function deriveOfficeStatus(runs, probes = [], now = Date.now()) {
  const latest = runs[0] || null;
  const base = statusForRun(latest);
  if (probes.some((item) => item.status === 'down')) {
    return { status: 'review_required', severity: 'P0–P2', label: 'A live health check needs review' };
  }
  const latestTime = Date.parse(latest?.started_at || '');
  if (base.status === 'healthy' && Number.isFinite(latestTime) && now - latestTime > 100 * 60 * 1000) {
    return { status: 'overdue', severity: 'Review', label: 'The hourly monitor is overdue' };
  }
  return base;
}

function findStep(jobs, stepName) {
  for (const job of jobs || []) {
    const step = (job.steps || []).find((item) => item.name === stepName);
    if (step) return { status: clean(step.status, 30), conclusion: step.conclusion ? clean(step.conclusion, 30) : null };
  }
  return null;
}

export function integrationFromStep(id, label, step, successDetail, skippedDetail) {
  if (!step) return { id, label, status: 'unavailable', detail: 'No recent step result is available' };
  if (step.status !== 'completed') return { id, label, status: 'running', detail: 'Check is currently running' };
  if (step.conclusion === 'success') return { id, label, status: 'healthy', detail: successDetail };
  if (step.conclusion === 'skipped') return { id, label, status: 'inactive', detail: skippedDetail };
  return { id, label, status: 'review', detail: `Latest step result: ${clean(step.conclusion || 'unknown', 30)}` };
}

function nextHourlyCheck(now = new Date()) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  if (next.getUTCMinutes() < 17) next.setUTCMinutes(17);
  else {
    next.setUTCHours(next.getUTCHours() + 1);
    next.setUTCMinutes(17);
  }
  return next.toISOString();
}

function runMetrics(runs) {
  const completed = runs.filter((run) => run.status === 'completed');
  const successful = completed.filter((run) => run.conclusion === 'success');
  let consecutiveFailures = 0;
  for (const run of completed) {
    if (run.conclusion === 'success') break;
    consecutiveFailures += 1;
  }
  return {
    runs_reviewed: completed.length,
    successful_runs: successful.length,
    success_rate: completed.length ? Math.round(successful.length / completed.length * 100) : null,
    consecutive_failures: consecutiveFailures,
    last_success_at: successful[0]?.started_at || null,
  };
}

async function collectOffice() {
  const [website, publicConfig, workflowResult] = await Promise.all([
    probe('website', 'Website', `${SITE_ORIGIN}/`),
    probe('public_config', 'Public API configuration', `${SITE_ORIGIN}/api/public-config`),
    github(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&per_page=12`).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: { workflow_runs: [] } })),
  ]);

  const runs = (workflowResult.value.workflow_runs || []).map(normalizeRun).filter((run) => run.id);
  const latestRun = runs[0] || null;
  const latestPush = runs.find((run) => run.event === 'push') || null;
  const jobTargets = [...new Set([latestRun?.id, latestPush?.id].filter(Boolean))];
  const jobEntries = await Promise.all(jobTargets.map(async (runId) => {
    try {
      const value = await github(`/repos/${REPOSITORY}/actions/runs/${runId}/jobs?per_page=10`);
      return [runId, value.jobs || []];
    } catch {
      return [runId, []];
    }
  }));
  const jobsByRun = new Map(jobEntries);
  const latestJobs = jobsByRun.get(latestRun?.id) || [];
  const pushJobs = jobsByRun.get(latestPush?.id) || [];

  const probes = [website, publicConfig];
  const overall = deriveOfficeStatus(runs, probes);
  const integrations = [
    website,
    publicConfig,
    {
      id: 'github_actions',
      label: 'GitHub Actions',
      status: workflowResult.ok ? 'healthy' : 'unavailable',
      detail: workflowResult.ok ? `${runs.length} recent runs available` : 'Workflow history could not be read',
    },
    integrationFromStep('private_providers', 'Vercel and Supabase', findStep(latestJobs, 'Collect private-provider read-only evidence'), 'Private read-only checks completed', 'Private monitoring is disabled'),
    integrationFromStep('owner_email', 'P0/P1 email alerts', findStep(latestJobs, 'Send the owner-approved P0/P1 email alert'), 'Alert channel is enabled', 'Owner email alerts are disabled'),
    integrationFromStep('deployment_verification', 'Post-deployment verification', findStep(pushJobs, 'Wait for the exact approved production revision'), 'Latest merged revision was verified', 'No recent push verification result'),
  ];

  return {
    generated_at: new Date().toISOString(),
    status: overall,
    latest_run: latestRun,
    latest_push_run: latestPush,
    next_scheduled_check_at: nextHourlyCheck(),
    metrics: runMetrics(runs),
    integrations,
    runs,
    policy: {
      cadence: 'Hourly at minute 17 UTC and after every push to main',
      artifact_retention_days: 14,
      model_used_for_monitoring: false,
      production_writes_enabled: false,
      alert_rule: 'Email only for P0 or P1 incidents',
    },
  };
}

async function cachedOffice() {
  if (officeCache.value && officeCache.expiresAt > Date.now()) return officeCache.value;
  const value = await collectOffice();
  officeCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  try {
    if (!await owner(req)) return res.status(403).json({ error: 'Owner access required' });
    return res.status(200).json(await cachedOffice());
  } catch (error) {
    console.error('Reliability Office read failed', clean(error?.message || error, 200));
    return res.status(503).json({ error: 'Reliability status is temporarily unavailable' });
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const dashboard = read('dashboard.html');
const cafeTrial = read('cafe-trial.html');

function source(name) {
  const start = dashboard.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `missing ${name}`);
  const tail = dashboard.slice(start);
  const next = tail.slice(1).search(/\n(?=(?:async )?function )/);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function context(names, extra = {}) {
  const value = { console, Date, ...extra };
  vm.createContext(value);
  vm.runInContext(names.map(source).join('\n'), value);
  return value;
}

const paid = { connectedToBilling: true, plan: 'pro', status: 'active', canManageBilling: true, billingPaused: false };
const session = id => ({ user: { id }, access_token: `token-${id}` });

test('only an active or trialing connected Pro subscription unlocks another job', () => {
  const ctx = context(['billingAllowsAdditionalJobs']);
  assert.equal(ctx.billingAllowsAdditionalJobs(paid), true);
  assert.equal(ctx.billingAllowsAdditionalJobs({ ...paid, status: 'trialing' }), true);
  for (const change of [
    { connectedToBilling: false },
    { plan: 'free' },
    { status: 'past_due' },
    { status: 'unpaid' },
    { status: 'incomplete' },
    { status: 'canceled' },
    { status: undefined },
  ]) assert.equal(ctx.billingAllowsAdditionalJobs({ ...paid, ...change }), false, JSON.stringify(change));
});

function accessHarness({ canCreate = true, rpcError = null, activeJobCount = 0, countError = null, billing = paid, billingOK = true, identities = ['cafe', 'cafe'] } = {}) {
  let authReads = 0, billingReads = 0, rpcReads = 0, activeCountReads = 0;
  const activeClient = {
    auth: { getSession: async () => ({ data: { session: session(identities[Math.min(authReads++, identities.length - 1)]) } }) },
    rpc(name) { rpcReads++; assert.equal(name, 'cafe_can_create_job'); return Promise.resolve({ data: canCreate, error: rpcError }); },
    from(table) {
      assert.equal(table, 'jobs'); activeCountReads++;
      return {
        select(columns, options) { assert.equal(columns, 'id'); if (options) { assert.equal(options.count, 'exact'); assert.equal(options.head, true); } return this; },
        eq(column, value) { if (column === 'active') { assert.equal(value, true); return Promise.resolve({ count: activeJobCount, error: countError }); } assert.deepEqual([column, value], ['owner_id', 'cafe']); return this; },
      };
    },
  };
  const ctx = context(['billingAllowsAdditionalJobs', 'currentCafeBillingSession', 'loadCafeBillingStatus', 'loadJobCreationAccess'], {
    currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, activeClient,
    fetch: async (url, options) => {
      billingReads++; assert.equal(url, '/api/billing-status'); assert.equal(options.cache, 'no-store');
      assert.equal(options.headers.Authorization, 'Bearer token-cafe');
      return { ok: billingOK, json: async () => billingOK ? billing : { error: 'Billing offline' } };
    },
  });
  return { ctx, counts: () => ({ authReads, billingReads, rpcReads, activeCountReads }) };
}

test('the authoritative entitlement RPC keeps an allowed post free of unnecessary billing calls', async () => {
  const h = accessHarness();
  const access = await h.ctx.loadJobCreationAccess();
  assert.equal(access.allowed, true); assert.equal(access.billing, null);
  assert.deepEqual(h.counts(), { authReads: 2, billingReads: 0, rpcReads: 1, activeCountReads: 0 });
});

test('a denied lifetime entitlement uses current billing only to classify the Pro prompt', async () => {
  const inactive = accessHarness({ canCreate: false, billing: { ...paid, plan: 'free', status: 'past_due' } });
  const blocked = await inactive.ctx.loadJobCreationAccess();
  assert.equal(blocked.allowed, false); assert.equal(blocked.reason, 'subscription'); assert.equal(blocked.billing.status, 'past_due');
  assert.equal(inactive.counts().billingReads, 1);

  const lagging = accessHarness({ canCreate: false, billing: paid });
  assert.equal((await lagging.ctx.loadJobCreationAccess()).reason, 'entitlement_pending', 'API status cannot overrule the database preflight');
});

test('three active jobs stop before billing and tell the café to pause one', async () => {
  const h = accessHarness({ canCreate: false, activeJobCount: 3 });
  const access = await h.ctx.loadJobCreationAccess();
  assert.equal(access.allowed, false); assert.equal(access.reason, 'active_limit'); assert.equal(access.activeJobCount, 3);
  assert.equal(h.counts().billingReads, 0);
});

test('the entry-point active-job cap never opens the subscription prompt', async () => {
  const alerts = []; let prompts = 0, editors = 0;
  const ctx = context(['requestNewJobEditor'], {
    currentRole: 'cafe_owner_manager', loadJobCreationAccess: async () => ({ allowed: false, reason: 'active_limit', activeJobCount: 3 }),
    resumePendingJobDraft: () => false, openJobEditor: () => { editors++; }, readPendingJobDraft: () => null,
    persistPendingJobDraft: () => true, showJobUpgradePrompt: () => { prompts++; }, alert: message => alerts.push(message),
  });
  const button = { disabled: false, textContent: 'Post a job' };
  await ctx.requestNewJobEditor(button);
  assert.equal(prompts, 0); assert.equal(editors, 0); assert.match(alerts[0], /Pause one before publishing another/);
  assert.equal(button.disabled, false); assert.equal(button.textContent, 'Post a job');
});

test('entitlement, active-count, billing, and account-switch failures fail closed', async () => {
  await assert.rejects(accessHarness({ canCreate: null }).ctx.loadJobCreationAccess(), /verify your lifetime job access/);
  await assert.rejects(accessHarness({ rpcError: { code: 'missing' } }).ctx.loadJobCreationAccess(), /verify your lifetime job access/);
  await assert.rejects(accessHarness({ canCreate: false, billingOK: false }).ctx.loadJobCreationAccess(), /Billing offline/);
  await assert.rejects(accessHarness({ canCreate: false, activeJobCount: null }).ctx.loadJobCreationAccess(), /verify your active jobs/);
  await assert.rejects(accessHarness({ canCreate: false, countError: { code: 'offline' } }).ctx.loadJobCreationAccess(), /verify your active jobs/);
  await assert.rejects(accessHarness({ identities: ['cafe', 'other'] }).ctx.loadJobCreationAccess(), /signed-in account changed/);
});

function validJobForm() {
  const fields = { title: 'Second role', city: 'Miami', state: 'FL', postal_code: '33101', address_line1: '123 Main', address_line2: '', description: 'Join our team', hourly_pay: '22', max_hourly_pay: '25', skills: 'Espresso' };
  return { get: name => fields[name] ?? '', getAll: name => name === 'schedule' ? ['Full-time'] : [] };
}

function saveHarness(access) {
  const writes = [], filters = []; let accessReads = 0;
  const query = {
    eq(column, value) { filters.push([column, value]); return this; },
    select(columns) { assert.equal(columns, 'id'); return this; },
    async single() { return { data: { id: 'saved-job' }, error: null }; },
  };
  const activeClient = { from(table) { assert.equal(table, 'jobs'); return {
    insert(payload) { writes.push({ kind: 'insert', payload }); return query; },
    update(payload) { writes.push({ kind: 'update', payload }); return query; },
  }; } };
  const ctx = context(['jobPayloadFromForm', 'jobSubscriptionRequiredError', 'jobActiveLimitError', 'isJobSubscriptionRequiredError', 'isJobActiveLimitError', 'saveJobPost'], {
    currentRole: 'cafe_owner_manager', currentUser: { id: 'cafe' }, editingJobId: null, activeClient,
    profileVisibilityReady: () => true,
    loadJobCreationAccess: async () => { accessReads++; return access; },
  });
  return { ctx, writes, filters, accessReads: () => accessReads };
}

test('a blocked new job never reaches insert, while an existing job edit stays free', async () => {
  const blocked = saveHarness({ allowed: false, firstJob: false, billing: { plan: 'free', status: 'free' } });
  await assert.rejects(blocked.ctx.saveJobPost(validJobForm(), null), error => error.code === 'JOB_SUBSCRIPTION_REQUIRED');
  assert.equal(blocked.writes.length, 0);

  const edit = saveHarness({ allowed: false });
  await edit.ctx.saveJobPost(validJobForm(), 'first-job');
  assert.equal(edit.accessReads(), 0, 'editing the original job must not consume or check another-job access');
  assert.equal(edit.writes[0].kind, 'update');
  assert.deepEqual(edit.filters, [['id', 'first-job'], ['owner_id', 'cafe']]);
});

test('a freshly confirmed active subscription permits the second-job insert as visible', async () => {
  const h = saveHarness({ allowed: true, firstJob: false, billing: paid });
  await h.ctx.saveJobPost(validJobForm(), null);
  assert.equal(h.accessReads(), 1); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].kind, 'insert');
  assert.equal(h.writes[0].payload.owner_id, 'cafe'); assert.equal(h.writes[0].payload.active, true);
});

test('the proactive cap and the PJB04 race both become a friendly non-billing error', async () => {
  const proactive = saveHarness({ allowed: false, reason: 'active_limit', activeJobCount: 3 });
  await assert.rejects(proactive.ctx.saveJobPost(validJobForm(), null), error => error.code === 'JOB_ACTIVE_LIMIT' && /Pause one/.test(error.message));
  assert.equal(proactive.writes.length, 0);

  const raced = saveHarness({ allowed: true });
  raced.ctx.activeClient.from = () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: 'PJB04', message: 'JOB_ACTIVE_LIMIT_REACHED' } }) }) }) });
  await assert.rejects(raced.ctx.saveJobPost(validJobForm(), null), error => error.code === 'JOB_ACTIVE_LIMIT' && !/subscription/i.test(error.message));
});

test('a PJB01 race returns to the preserved Pro prompt instead of leaking a database error', async () => {
  const raced = saveHarness({ allowed: true });
  raced.ctx.activeClient.from = () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: 'PJB01', message: 'JOB_PRO_SUBSCRIPTION_REQUIRED' } }) }) }) });
  await assert.rejects(raced.ctx.saveJobPost(validJobForm(), null), error => error.code === 'JOB_SUBSCRIPTION_REQUIRED' && /still a draft/.test(error.message));
});

test('pending drafts are account-scoped, safely restored, and forced back to Florida', () => {
  const values = new Map(), sessionStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const schedules = [{ value: 'Full-time', checked: false }, { value: 'Part-time', checked: true }];
  const form = { elements: { title: { value: '' }, state: { value: '' }, description: { value: '' } }, querySelectorAll: () => schedules };
  const ctx = context(['normalizePendingJobEntries', 'pendingJobDraftKey', 'readPendingJobDraft', 'persistPendingJobDraft', 'clearPendingJobDraft', 'applyPendingJobDraft'], {
    currentUser: { id: 'cafe' }, pendingJobDraftMemory: null, sessionStorage, document: { getElementById: () => form },
  });
  assert.equal(ctx.persistPendingJobDraft([['title', 'Weekend barista'], ['state', 'NY'], ['schedule', 'Full-time'], ['description', 'Saved before Checkout']]), true);
  assert.match([...values.keys()][0], /cafe$/);
  assert.equal(ctx.applyPendingJobDraft(form), true); assert.equal(form.elements.title.value, 'Weekend barista'); assert.equal(form.elements.state.value, 'FL');
  assert.equal(schedules[0].checked, true); assert.equal(schedules[1].checked, false);
  ctx.currentUser = { id: 'another-cafe' }; assert.equal(ctx.readPendingJobDraft(), null);
  ctx.currentUser = { id: 'cafe' }; ctx.clearPendingJobDraft(); assert.equal(values.size, 0);
});

test('storage failure keeps the in-page draft but prevents an unsafe Stripe redirect', async () => {
  const status = { textContent: '' }, button = { disabled: false, textContent: '' }; let fetches = 0;
  const ctx = context(['continueJobUpgrade'], {
    readPendingJobDraft: () => ({ entries: [['title', 'Do not lose me']] }), persistPendingJobDraft: () => false,
    document: { getElementById: id => id === 'job-upgrade-status' ? status : null }, fetch: async () => { fetches++; },
  });
  await ctx.continueJobUpgrade(button);
  assert.equal(fetches, 0); assert.equal(button.disabled, false); assert.equal(button.textContent, 'Try again'); assert.match(status.textContent, /safely keep your draft/);
});

async function checkoutRoute(canManageBilling) {
  const calls = [], assigned = [], status = { textContent: '' }, dialog = { close() { calls.push('close'); } }, button = { disabled: false, textContent: '' };
  const ctx = context(['continueJobUpgrade'], {
    readPendingJobDraft: () => ({ entries: [['title', 'Saved role']] }), persistPendingJobDraft: () => true,
    loadJobCreationAccess: async () => ({ allowed: false, firstJob: false, billing: { connectedToBilling: canManageBilling, plan: 'free', status: canManageBilling ? 'past_due' : 'free', canManageBilling } }),
    currentCafeBillingSession: async () => session('cafe'), showJobUpgradePrompt() {}, resumePendingJobDraft() {},
    document: { getElementById: id => id === 'job-upgrade-status' ? status : id === 'job-upgrade-dialog' ? dialog : null },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.example/session' }) }; },
    location: { assign: url => assigned.push(url) },
  });
  await ctx.continueJobUpgrade(button); return { calls, assigned, status };
}

test('the upgrade retry keeps new Checkout on the website and Portal only for manageable billing', async () => {
  const checkout = await checkoutRoute(false), portal = await checkoutRoute(true);
  assert.equal(checkout.calls.length, 0);
  assert.deepEqual(checkout.assigned, ['/checkout.html']);
  assert.equal(portal.calls[0].url, '/api/create-portal-session');
  for (const result of [portal]) {
    assert.equal(JSON.parse(result.calls[0].options.body).channel, 'web');
    assert.equal(result.calls[0].options.headers.Authorization, 'Bearer token-cafe');
    assert.deepEqual(result.assigned, ['https://checkout.stripe.example/session']);
  }
});

test('database entitlement lag retries in place instead of opening Stripe again', async () => {
  let fetches = 0, prompt;
  const status = { textContent: '' }, button = { disabled: false, textContent: '' };
  const ctx = context(['continueJobUpgrade'], {
    readPendingJobDraft: () => ({ entries: [] }), persistPendingJobDraft: () => true,
    loadJobCreationAccess: async () => ({ allowed: false, reason: 'entitlement_pending', billing: paid }),
    showJobUpgradePrompt: (...args) => { prompt = args; button.disabled = false; },
    document: { getElementById: id => id === 'job-upgrade-status' ? status : null }, fetch: async () => { fetches++; },
  });
  await ctx.continueJobUpgrade(button);
  assert.equal(fetches, 0); assert.equal(prompt[2], 'entitlement_pending');
});

test('a publish-time Pro block saves the filled form before opening the upgrade prompt', async () => {
  const button = { disabled: false, textContent: 'Publish job' }, status = { textContent: '' }, dialog = { open: true }, content = { firstElementChild: {} };
  let savedForm, prompted, resets = 0;
  const form = { querySelector: () => button, reset: () => { resets++; } };
  const ctx = context(['submitJobForm'], {
    editingJobId: null, jobEditorVersion: 4, currentSection: 'Job Posts', currentRole: 'cafe_owner_manager', currentView: {},
    document: { getElementById: id => ({ 'job-status': status, 'job-dialog': dialog, content }[id]) },
    FormData: class { constructor() {} [Symbol.iterator]() { return [['title', 'Preserved role']][Symbol.iterator](); } },
    saveJobPost: async () => { const error = new Error('Pro required'); error.code = 'JOB_SUBSCRIPTION_REQUIRED'; error.billing = { status: 'free' }; throw error; },
    persistPendingJobDraft: value => { savedForm = value; return true; }, showJobUpgradePrompt: billing => { prompted = billing; dialog.open = false; },
  });
  await ctx.submitJobForm({ preventDefault() {}, currentTarget: form });
  assert.equal(savedForm, form); assert.equal(prompted.status, 'free'); assert.equal(resets, 0); assert.equal(button.disabled, false); assert.equal(button.textContent, 'Publish job');
});

function returnHarness(returned, response = { ok: true, status: 200, body: { confirmed: true } }) {
  const replacements = [], resumes = [], notice = { textContent: '' }; let confirms = 0;
  const ctx = context(['reconcileBillingReturn'], {
    billingReturnReconciled: false, billingReturnState: () => returned,
    history: { replaceState: (_a, _b, url) => replacements.push(url) }, document: { querySelector: () => notice },
    resumePendingJobDraft: message => { resumes.push(message); return true; }, currentCafeBillingSession: async () => session('cafe'),
    fetch: async () => { confirms++; return { ok: response.ok, status: response.status, json: async () => response.body }; },
  });
  return { ctx, replacements, resumes, notice, confirms: () => confirms };
}

test('Checkout return resumes the saved draft only after confirmation; cancel and Portal keep it as a draft', async () => {
  const success = returnHarness({ result: 'success', sessionId: 'cs_test_ok' }); await success.ctx.reconcileBillingReturn();
  assert.deepEqual(success.replacements, ['/dashboard.html?section=subscription']); assert.equal(success.resumes.length, 1); assert.match(success.resumes[0], /Payment confirmed/);

  const processing = returnHarness({ result: 'success', sessionId: 'cs_test_wait' }, { ok: true, status: 202, body: { confirmed: false } }); await processing.ctx.reconcileBillingReturn();
  assert.equal(processing.resumes.length, 0); assert.equal(processing.replacements.length, 0); assert.match(processing.notice.textContent, /still processing/);

  for (const result of ['canceled', 'portal']) {
    const h = returnHarness({ result, sessionId: '' }); await h.ctx.reconcileBillingReturn();
    assert.equal(h.confirms(), 0); assert.equal(h.resumes.length, 1); assert.match(h.resumes[0], /draft/);
  }
});

test('a plain Dashboard return from Stripe Portal restores the pending draft on startup', () => {
  let resumes = 0;
  const ctx = context(['resumePendingJobDraftOnStartup'], {
    currentRole: 'cafe_owner_manager', location: { search: '' }, billingReturnState: search => search ? { result: 'success' } : null,
    resumePendingJobDraft: message => { resumes++; assert.match(message, /recheck current Pro access/); return true; },
  });
  assert.equal(ctx.resumePendingJobDraftOnStartup(''), true); assert.equal(resumes, 1);
  assert.equal(ctx.resumePendingJobDraftOnStartup('?billing=success'), false); assert.equal(resumes, 1);
  ctx.currentRole = 'barista'; assert.equal(ctx.resumePendingJobDraftOnStartup(''), false);
});

test('website copy and handlers describe and enforce the lifetime-job boundary', () => {
  assert.match(dashboard, /first lifetime job post is free/i); assert.match(dashboard, /second distinct job can be published/i);
  assert.match(dashboard, /data-post-job[^\n]+requestNewJobEditor|requestNewJobEditor\(button\)/);
  const save = source('saveJobPost'); assert.ok(save.indexOf('loadJobCreationAccess()') < save.indexOf("from('jobs').insert"));
  assert.doesNotMatch(source('toggleJob'), /loadJobCreationAccess|billing-status/);
  assert.match(cafeTrial, /first lifetime job/i); assert.match(cafeTrial, /second job[^<]+second distinct lifetime post[^<]+requires active Pro/i);
});

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const configPath = process.argv[2], outputPath = process.argv[3];
if (!configPath || !outputPath || (statSync(configPath).mode & 0o077)) throw new Error('Private test configuration and output required');
if (existsSync(outputPath)) throw new Error('Test accounts already recorded; inspect and reuse them instead of creating duplicates');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.BJM_TEST_PROJECT_REF !== 'iqtpsxxlpncaeabbcxht'
  || config.SUPABASE_URL !== 'https://iqtpsxxlpncaeabbcxht.supabase.co'
  || !config.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) throw new Error('Unexpected test project');
const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const { data: before, error: lookupError } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
if (lookupError || before.users.length) throw new Error('Expected empty dedicated test project; no accounts created');
const suffix = randomBytes(5).toString('hex');
const manifest = { projectRef: config.BJM_TEST_PROJECT_REF, createdAt: new Date().toISOString(),
  scope: 'Synthetic admin-confirmed fixtures; not evidence of signup/email delivery', accounts: [] };
writeFileSync(outputPath, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
for (const [label, role] of [['cafe', 'cafe_owner_manager'], ['barista', 'barista'], ['other-cafe', 'cafe_owner_manager']]) {
  const email = `bjm-${suffix}-${label}@example.invalid`, password = `BjmTest${randomBytes(16).toString('hex')}!`;
  const draft = { role, location: 'Miami, FL', ...(role === 'barista' ? { display_name: 'Test Barista' } : { cafe_name: label === 'cafe' ? 'Test Café' : 'Other Test Café' }) };
  const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: draft });
  if (error || !data.user) throw new Error('Test account creation failed; inspect the partial manifest before retrying');
  manifest.accounts.push({ label, id: data.user.id, role, email, password });
  writeFileSync(outputPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const profile = await client.from('profiles').select('id,role').eq('id', data.user.id).single();
  if (profile.error || profile.data.role !== role) throw new Error('Test signup trigger did not preserve the selected role');
  console.log(JSON.stringify({ fixture: label, role, profileCreatedByExistingTrigger: true, emailSent: false }));
}

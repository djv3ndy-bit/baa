import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

// Only the separately approved Free testing project. No source objects copied.
const path = process.argv[2];
if (!path || (statSync(path).mode & 0o077)) throw new Error('Private test configuration required');
const config = JSON.parse(readFileSync(path, 'utf8'));
if (config.BJM_TEST_PROJECT_REF !== 'iqtpsxxlpncaeabbcxht'
  || config.SUPABASE_URL !== 'https://iqtpsxxlpncaeabbcxht.supabase.co'
  || !config.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) throw new Error('Unexpected test project');
const require = createRequire(new URL('../../mobile/package.json', import.meta.url));
const { createClient } = require('@supabase/supabase-js');
const client = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});
const definitions = [
  { id: 'cafe-images', public: true, fileSizeLimit: 5242880, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
  { id: 'coffee-videos', public: false, fileSizeLimit: 52428800, allowedMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'] },
];
const { data: existing, error } = await client.storage.listBuckets();
if (error) throw new Error('Could not inspect test storage');
for (const definition of definitions) {
  if (!existing.some(bucket => bucket.id === definition.id)) {
    const { id, ...options } = definition;
    const result = await client.storage.createBucket(id, options);
    if (result.error) throw new Error(`Could not create test bucket ${id}`);
  }
  const { data, error } = await client.storage.getBucket(definition.id);
  if (error || data.public !== definition.public || Number(data.file_size_limit) !== definition.fileSizeLimit
    || JSON.stringify(data.allowed_mime_types) !== JSON.stringify(definition.allowedMimeTypes)) {
    throw new Error(`Unexpected settings for test bucket ${definition.id}; no settings overwritten`);
  }
  console.log(JSON.stringify({ projectRef: config.BJM_TEST_PROJECT_REF, ...definition, verified: true }));
}

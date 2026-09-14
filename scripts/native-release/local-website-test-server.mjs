import { createServer } from 'node:http';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';

// Serve the unchanged public website with the isolated test backend. No test
// controls, credentials, payment adapters, or copied screens enter app source.
const directory = process.argv[2];
if (!directory || (statSync(directory).mode & 0o077)) throw Error('Private test directory required');
function readPrivate(name) {
  const path = `${directory}/${name}`;
  if (statSync(path).mode & 0o077) throw Error('Private configuration required');
  return JSON.parse(readFileSync(path));
}
const database = readPrivate('test-server.json');
const payments = readPrivate('stripe-test.json');
const project = 'iqtpsxxlpncaeabbcxht';
const databaseOrigin = `https://${project}.supabase.co`;
if (database.BJM_TEST_PROJECT_REF !== project || database.SUPABASE_URL !== databaseOrigin
  || payments.BJM_TEST_PROJECT_REF !== project || !payments.STRIPE_RESTRICTED_KEY?.startsWith('rk_test_')
  || !payments.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_') || !database.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')
  || payments.STRIPE_EXPECTED_ACCOUNT_ID !== 'acct_1UANO72euSkBN6zq'
  || payments.STRIPE_PRICE_ID !== 'price_1UEqOV2euSkBN6zqUJJE5G81') throw Error('Isolated test configuration required');
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|STRIPE_|APPLE_IAP_|GOOGLE_PLAY_|RESEND_|NATIVE_|BILLING_|PUBLIC_SITE_URL$)/.test(key)) delete process.env[key];
Object.assign(process.env, database, {
  VERCEL_ENV:'preview', BILLING_ENABLED:'true', STRIPE_LIVEMODE:'false',
  NATIVE_BILLING_ENVIRONMENT:'Sandbox', NATIVE_PURCHASES_ENABLED:'false', PUBLIC_SITE_URL:'http://127.0.0.1:3998',
  STRIPE_RESTRICTED_KEY:payments.STRIPE_RESTRICTED_KEY, STRIPE_PUBLISHABLE_KEY:payments.STRIPE_PUBLISHABLE_KEY,
  STRIPE_ACCOUNT_ID:payments.STRIPE_EXPECTED_ACCOUNT_ID, STRIPE_MONTHLY_PRICE_ID:payments.STRIPE_PRICE_ID,
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init={}) => {
  const url = new URL(typeof input==='string' || input instanceof URL ? input : input.url);
  if (url.origin !== databaseOrigin) throw Error('External app services are disabled during website testing');
  return originalFetch(input,{...init,redirect:'error'});
};
const root = fileURLToPath(new URL('../../',import.meta.url));
const publicNames = new Set(readdirSync(root).filter(name=>/^[a-zA-Z0-9_-]+\.(html|js|css)$/.test(name)));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp','.woff2':'font/woff2'};
const aliases = new Map(JSON.parse(readFileSync(resolve(root,'vercel.json'))).rewrites.filter(row=>row.source.startsWith('/api/')).map(row=>[row.source,row.destination]));
const allowed = new Set(['config','billing','account-billing','native-billing','native-purchases']);
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.status=code=>{res.statusCode=code;return res;};
  res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
  res.send=value=>{res.end(value);return res;};
  try {
    if (!['127.0.0.1:3998','localhost:3998'].includes(req.headers.host)) return res.status(400).send('Unexpected host');
    if (req.method!=='GET' && req.headers.origin && !['http://127.0.0.1:3998','http://localhost:3998'].includes(req.headers.origin)) return res.status(403).send('Unexpected origin');
    const requested = new URL(req.url,'http://127.0.0.1:3998');
    if (requested.pathname.startsWith('/api/')) {
      const routed = new URL(aliases.get(requested.pathname)||req.url,'http://127.0.0.1:3998');
      const name = routed.pathname.slice('/api/'.length);
      if (!allowed.has(name)) return res.status(404).json({error:'This API route is outside the isolated payment test.'});
      req.query=Object.fromEntries(routed.searchParams);
      const module = await import(new URL(`../../api/${name}.js`,import.meta.url));
      if (module.config?.api?.bodyParser!==false && req.method!=='GET') {
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>100000)return res.status(413).send('Request too large');chunks.push(chunk);}
        const body=Buffer.concat(chunks).toString();req.body=body?JSON.parse(body):{};
      }
      return await module.default(req,res);
    }
    if(req.method!=='GET')return res.status(405).send('Method not allowed');
    let name=decodeURIComponent(requested.pathname).slice(1)||'login.html';
    if(!name.includes('.') && !name.includes('/'))name+='.html';
    const file=resolve(root,name),extension=extname(file);
    const asset = name.startsWith('assets/') && file.startsWith(resolve(root,'assets')+'/') && types[extension];
    if(!publicNames.has(name) && !asset)return res.status(404).send('Test file unavailable');
    res.setHeader('Content-Type',types[extension]);res.end(readFileSync(file));
  }catch{if(!res.headersSent)res.status(503).json({error:'The isolated website request could not complete. Please retry.'});else res.end();}
}).listen(3998,'127.0.0.1',()=>console.log('Isolated website listening on http://127.0.0.1:3998; Stripe test mode and test database only.'));

const TRUSTED_ORIGINS=new Set(['https://lmwqrxoitraofaftpwhe.supabase.co','https://auth.baristajobmatch.com']);
export function supabaseOrigin(value){
 const u=new URL(value);
 if(!TRUSTED_ORIGINS.has(u.origin)||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('ugc_provider_unavailable');
 return u.origin;
}
// Matches current main api/_public-form-guard.js: new secret keys are gateway API keys, not JWTs.
export function serviceHeaders(key,extra={}){
 return {apikey:key,...(key&&!key.startsWith('sb_secret_')?{Authorization:`Bearer ${key}`}:{ }),'Content-Type':'application/json',...extra};
}

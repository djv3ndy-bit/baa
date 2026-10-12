import {timingSafeEqual} from 'node:crypto';
import {readAndroidPublicBillingConfiguration} from './configuration.mjs';
import {verifiedAndroidDeploymentIdentity} from './deploymentIdentity.mjs';
import {androidSupabaseTransport} from './supabaseTransport.mjs';

const off=['ANDROID_GOOGLE_RECEIPTS_ACTIVE','ANDROID_GOOGLE_EVENTS_ACTIVE','NATIVE_PURCHASES_ENABLED',
  'BILLING_ENABLED','ANDROID_DIRECT_FCM_ENABLED','ANDROID_PUBLIC_NOTIFICATIONS_ACTIVE','ANDROID_REVIEW_ACCESS_ENABLED'];
const keys=[...off,'ANDROID_GOOGLE_BILLING_ACTIVE','ANDROID_BILLING_CONNECTION_SECRET',
  'VERCEL_PROJECT_ID','VERCEL_ENV','VERCEL_TARGET_ENV','VERCEL_URL','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY','NATIVE_BILLING_ENVIRONMENT','GOOGLE_PLAY_AUTH_MODE','GOOGLE_PLAY_PRODUCT_ID',
  'GOOGLE_PLAY_BASE_PLAN_ID','GOOGLE_PLAY_WIF_PROJECT_NUMBER','GOOGLE_PLAY_WIF_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PLAY_WIF_PROVIDER_RESOURCE','GOOGLE_PLAY_WIF_VERCEL_ISSUER','GOOGLE_PLAY_WIF_VERCEL_AUDIENCE',
  'GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID','GOOGLE_PLAY_SERVICE_ACCOUNT_JSON'];
const canonical=value=>typeof value==='string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value,'base64url').length===32 && Buffer.from(value,'base64url').toString('base64url')===value;

/** Private read-only staging probe. It checks only a reserved absent account ID
 * and a fixed service-only SELECT RPC, never a real account or purchase. */
export function androidBillingConnectionCheck({env=process.env,verifyIdentity=verifiedAndroidDeploymentIdentity,
  createTransport=androidSupabaseTransport}={}) {
  return async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const unavailable=()=>res.status(503).json({error:'Android connection check unavailable.'});
    try {
      const snapshot=Object.freeze(Object.fromEntries(keys.map(key=>[key,env[key]])));
      if(req.method!=='GET' || Object.keys(req.query || {}).length || typeof req.url==='string' && req.url.includes('?')
        || off.some(key=>snapshot[key]!=='false') || !canonical(snapshot.ANDROID_BILLING_CONNECTION_SECRET)) {
        return res.status(404).json({error:'Not found.'});
      }
      const config=readAndroidPublicBillingConfiguration(snapshot,req.headers?.host);
      // Diagnostic is for only the exact generated deployment, never an alias.
      if(!config || req.headers?.host!==snapshot.VERCEL_URL)return res.status(404).json({error:'Not found.'});
      const authorization=req.headers?.authorization;
      const supplied=typeof authorization==='string' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
      if(!supplied || !timingSafeEqual(Buffer.from(supplied[1]),Buffer.from(snapshot.ANDROID_BILLING_CONNECTION_SECRET))) {
        return res.status(401).json({error:'Unauthorized.'});
      }
      await verifyIdentity();
      await createTransport(config).connectionCheck();
      return res.status(200).json({databaseConnectionChecked:true,serviceLookupAvailable:true,
        existingAccountDataReturned:false,purchasesEnabled:false,receiptProcessingEnabled:false,eventsEnabled:false});
    } catch {return unavailable();}
  };
}

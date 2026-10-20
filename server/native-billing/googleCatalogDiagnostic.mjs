import {timingSafeEqual} from 'node:crypto';
import {readGoogleWifConfiguration} from './googleAuth.mjs';
import {verifyGoogleCheckoutCatalog} from './googleCheckoutReadiness.mjs';

const productId='baristamatch_cafe_pro',basePlanId='monthly-us',packageName='com.baristajobmatch.app';
const secretPattern=/^[A-Za-z0-9_-]{43}$/;

/** Temporary, server-only connection check. No database, checkout, receipt,
 * reconciliation, acknowledgement or notification code is imported/called. */
export function googleCatalogDiagnosticHandler({env=process.env,verifyCatalog=verifyGoogleCheckoutCatalog}={}) {
  return async(req,res)=> {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const unavailable=()=>res.status(404).json({error:'Not found.'});
    const secret=env.GOOGLE_PLAY_CATALOG_DIAGNOSTIC_SECRET;
    const host=env.VERCEL_URL;
    if(req.method!=='GET' || Object.keys(req.query || {}).length!==0
      || env.GOOGLE_PLAY_AUTH_MODE!=='vercel_oidc' || env.NATIVE_BILLING_ENVIRONMENT!=='Sandbox'
      || env.VERCEL_ENV!=='preview' || env.VERCEL_TARGET_ENV!=='android-testing'
      || env.NATIVE_PURCHASES_ENABLED!=='false' || env.BILLING_ENABLED!=='false'
      || env.GOOGLE_PLAY_PRODUCT_ID!==productId || env.GOOGLE_PLAY_BASE_PLAN_ID!==basePlanId
      || typeof host!=='string' || !/^baa-[a-z0-9-]{1,120}\.vercel\.app$/.test(host)
      || req.headers?.host!==host || typeof secret!=='string' || !secretPattern.test(secret)
      || Buffer.from(secret,'base64url').length!==32 || Buffer.from(secret,'base64url').toString('base64url')!==secret) return unavailable();
    const authorization=req.headers?.authorization;
    const bearer=typeof authorization==='string' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if(!bearer || !timingSafeEqual(Buffer.from(bearer[1]),Buffer.from(secret))) return res.status(401).json({error:'Unauthorized.'});
    try {
      // The private server configuration pins the Custom Environment ID. The
      // existing supplier verifies its exact signed match; Google's provider
      // condition must independently bind that same ID. No local/file bypass.
      const config={provider:'google',environment:'Sandbox',packageName,productId,basePlanId,...readGoogleWifConfiguration(env)};
      await verifyCatalog(config);
      return res.status(200).json({catalogValidated:true,provider:'google',environment:'Sandbox',
        packageName,productId,basePlanId,billingPeriod:'P1M',region:'US',price:'USD 9.99',
        customEnvironmentVerified:true,purchasePermissionsVerified:false});
    } catch {
      // SDK errors can contain authorization material. Never log or return them.
      return res.status(503).json({error:'Catalog validation unavailable.'});
    }
  };
}

import {createHash} from 'node:crypto';
import {googleProvider} from './providers.mjs';
import {readGoogleWifConfiguration} from './googleAuth.mjs';
import {PurchaseVerificationError,verifiedGoogleStatus,verifiedGooglePurchaseDetails} from './verifiedStatus.mjs';

const check=(value,code='ACCOUNT_MISMATCH')=>{if(!value)throw new PurchaseVerificationError(code);};
const record=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const own=(value,key)=>record(value) && Object.hasOwn(value,key);
const token=value=>typeof value==='string' && value.length>0 && value.length<=8192 && !/\s/.test(value);
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const date=value=>typeof value==='string' && Number.isFinite(Date.parse(value)) && Date.parse(value)>0;
const key=value=>createHash('sha256').update(value).digest('hex');
const capabilities=new WeakSet();
const identity=Object.freeze({projectId:'prj_VuAxQpdhDJPeTPdanA5HjtOrylA5',ownerId:'team_W7sLByby0CKVDax9uhMshO5I',
  environment:'android-testing',customEnvironmentId:'env_E4F5E2NjsH4RaKOs0Jxp4Zo3AxDQ',
  issuer:'https://oidc.vercel.com/baristamatch',audience:'https://vercel.com/baristamatch',
  subject:'owner:baristamatch:project:baa:environment:android-testing'});

/** Default off. Environment checks are safeguards; the signed request context
 * and Google's existing WIF condition independently verify the deployment. */
export function readQaGoogleResubscribeConfiguration(env) {
  const flag=env.ANDROID_QA_GOOGLE_OUT_OF_APP_RESTORE_ENABLED;
  if(flag!== 'true') {check(flag===undefined || flag==='' || flag==='false','SERVER_CONFIGURATION');return null;}
  check(env.SUPABASE_URL==='https://ojvjlvojvozvhktbclcg.supabase.co'
    && env.NATIVE_BILLING_ENVIRONMENT==='Sandbox' && env.VERCEL_ENV==='preview'
    && env.VERCEL_TARGET_ENV===identity.environment && env.VERCEL_PROJECT_ID===identity.projectId
    && env.GOOGLE_PLAY_AUTH_MODE==='vercel_oidc' && env.GOOGLE_PLAY_PRODUCT_ID==='baristamatch_cafe_pro'
    && env.GOOGLE_PLAY_BASE_PLAN_ID==='monthly-us'
    && env.GOOGLE_PLAY_WIF_VERCEL_CUSTOM_ENVIRONMENT_ID===identity.customEnvironmentId,'SERVER_CONFIGURATION');
  readGoogleWifConfiguration(env);
  const result=Object.freeze({packageName:'com.baristajobmatch.app',productId:'baristamatch_cafe_pro',basePlanId:'monthly-us',environment:'Sandbox'});
  capabilities.add(result);return result;
}

async function signedQaContext(loadOidc) {
  try {
    const {getContext,verifyVercelOidcToken}=await loadOidc();
    const raw=getContext()?.headers?.['x-vercel-oidc-token'];
    check(typeof raw==='string' && raw.length>0 && raw.length<=32768,'SERVER_CONFIGURATION');
    const {payload}=await verifyVercelOidcToken(raw,{issuer:identity.issuer,audience:identity.audience,subject:identity.subject,
      projectId:identity.projectId,ownerId:identity.ownerId,environment:identity.environment,algorithms:['RS256'],
      requiredClaims:['exp','iat','nbf','sub','custom_environment_id']});
    check(payload.custom_environment_id===identity.customEnvironmentId,'SERVER_CONFIGURATION');
  } catch {throw new PurchaseVerificationError('SERVER_CONFIGURATION');}
}

const states=new Set(['SUBSCRIPTION_STATE_PENDING','SUBSCRIPTION_STATE_ACTIVE','SUBSCRIPTION_STATE_PAUSED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD','SUBSCRIPTION_STATE_ON_HOLD','SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_EXPIRED','SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED']);
const acknowledgements=new Set(['ACKNOWLEDGEMENT_STATE_PENDING','ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED']);
const stages=new Set(['scope','current','predecessor-ledger','predecessor-provider','owner','verified','ack']);
const reasons=new Set(['ACCOUNT_MISMATCH','PURCHASE_MISMATCH','PRODUCT_MISMATCH','ENVIRONMENT_MISMATCH',
  'INVALID_PROOF','INVALID_RESPONSE','INVALID_EXPIRY','UNKNOWN_STATE','UNSUPPORTED_PURCHASE','SERVER_CONFIGURATION','ACCOUNT_UNAVAILABLE']);
const flags=['currentBindingPresent','outOfAppContextPresent','expiredBindingPresent','expiredTokenPresent',
  'linkedTokenPresent','predecessorKnown','predecessorEligible','ownerMatches','activeCafe','conflict'];
function diagnostic(input) {
  return Object.freeze({event:'google_qa_resubscribe_association',stage:stages.has(input.stage)?input.stage:'scope',
    outcome:input.outcome==='verified'?'verified':'rejected',reason:reasons.has(input.reason)?input.reason:'UNCLASSIFIED',
    subscriptionState:states.has(input.subscriptionState)?input.subscriptionState:'UNKNOWN',
    acknowledgementState:acknowledgements.has(input.acknowledgementState)?input.acknowledgementState:'UNKNOWN',
    ...Object.fromEntries(flags.map(name=>[name,input[name]===true]))});
}

/** Only authoritative provider responses and the existing service-only ledger
 * are inputs. No caller account, token cache, ownership allocation or client
 * assertion can create a binding. The normal reconciler checks caller identity. */
export function qaGoogleResubscribeProvider({configuration,authClient,repository,now=Date.now,
  loadOidc=()=>import('@vercel/oidc'),logDiagnostic=report=>console.warn(JSON.stringify(report))}) {
  check(capabilities.has(configuration) && repository && typeof repository.googleQaPredecessor==='function','SERVER_CONFIGURATION');
  const config=configuration,root=`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.packageName}/purchases`;
  const ordinary=googleProvider({...config,authClient,now}),trustedStatuses=new WeakSet();
  const emit=value=>{try{logDiagnostic(diagnostic(value));}catch{/* Observability cannot change verification. */}};
  const read=async proof=>{
    check(token(proof),'INVALID_PROOF');
    return (await authClient.request({url:`${root}/subscriptionsv2/tokens/${encodeURIComponent(proof)}`,method:'GET',timeout:15000})).data;
  };
  function binding(data) {
    if(!own(data,'externalAccountIdentifiers'))return undefined;
    check(record(data.externalAccountIdentifiers),'INVALID_RESPONSE');
    if(!own(data.externalAccountIdentifiers,'obfuscatedExternalAccountId'))return undefined;
    const value=data.externalAccountIdentifiers.obfuscatedExternalAccountId;
    check(uuid(value));return value;
  }
  function predecessor(row,proof,clock) {
    check(record(row) && uuid(row.userId) && Number.isSafeInteger(row.revision) && row.revision>0
      && row.productId===config.productId && date(row.periodEnd) && Date.parse(row.periodEnd)<=clock
      && date(row.verifiedAt) && ['active','grace','payment_required','expired','revoked'].includes(row.status)
      && (row.supersededBy===null || row.supersededBy===key(proof))
      && (row.status!=='revoked' || row.supersededBy===key(proof)));
    return row;
  }
  async function status(proof,expectedBinding) {
    const observation={stage:'scope'};
    try {
      await signedQaContext(loadOidc);observation.stage='current';
      const current=await read(proof),clock=now();check(Number.isFinite(clock),'SERVER_CONFIGURATION');
      check(record(current),'INVALID_RESPONSE');
      observation.subscriptionState=current.subscriptionState;observation.acknowledgementState=current.acknowledgementState;
      // Sandbox marker must have Google's documented object shape.
      check(record(current.testPurchase),'ENVIRONMENT_MISMATCH');
      const details=verifiedGooglePurchaseDetails(current,{...config,purchaseToken:proof},clock);
      observation.currentBindingPresent=own(current.externalAccountIdentifiers,'obfuscatedExternalAccountId');
      const present=binding(current);
      observation.outOfAppContextPresent=own(current,'outOfAppPurchaseContext');
      if(!observation.outOfAppContextPresent) {
        const strict=verifiedGoogleStatus(current,{...config,purchaseToken:proof,binding:expectedBinding??present},clock);
        check(uuid(strict.binding));return Object.freeze(strict);
      }
      const context=current.outOfAppPurchaseContext;
      check(record(context) && current.acknowledgementState==='ACKNOWLEDGEMENT_STATE_PENDING','INVALID_RESPONSE');
      const oldToken=context.expiredPurchaseToken;
      observation.expiredTokenPresent=own(context,'expiredPurchaseToken');
      check(token(oldToken) && oldToken!==proof);
      const hasExpired=own(context,'expiredExternalAccountIdentifiers');
      observation.expiredBindingPresent=own(context?.expiredExternalAccountIdentifiers,'obfuscatedExternalAccountId');
      let expiredBinding;
      if(hasExpired) {check(record(context.expiredExternalAccountIdentifiers),'INVALID_RESPONSE');
        expiredBinding=context.expiredExternalAccountIdentifiers.obfuscatedExternalAccountId;check(uuid(expiredBinding));}
      observation.linkedTokenPresent=own(current,'linkedPurchaseToken');
      if(observation.linkedTokenPresent)check(current.linkedPurchaseToken===oldToken);
      observation.stage='predecessor-ledger';
      const old=await repository.googleQaPredecessor(oldToken);observation.predecessorKnown=old!==null;
      predecessor(old,proof,clock);observation.predecessorEligible=true;
      observation.stage='predecessor-provider';
      const past=await read(oldToken);check(record(past) && !own(past,'outOfAppPurchaseContext'),'INVALID_RESPONSE');
      const oldBinding=binding(past);check(uuid(oldBinding));
      check(record(past.testPurchase),'ENVIRONMENT_MISMATCH');
      const verifiedOld=verifiedGoogleStatus(past,{...config,purchaseToken:oldToken,binding:oldBinding},clock);
      check(past.subscriptionState==='SUBSCRIPTION_STATE_EXPIRED' && date(verifiedOld.currentPeriodEnd)
        && Date.parse(verifiedOld.currentPeriodEnd)<=clock);
      if(own(past,'linkedPurchaseToken'))check(token(past.linkedPurchaseToken) && past.linkedPurchaseToken!==proof && past.linkedPurchaseToken!==oldToken);
      observation.conflict=(present!==undefined && present!==oldBinding) || (expiredBinding!==undefined && expiredBinding!==oldBinding)
        || (expectedBinding!==undefined && expectedBinding!==oldBinding);
      check(!observation.conflict);
      observation.stage='owner';const owner=await repository.owner(oldBinding);
      observation.ownerMatches=owner?.userId===old.userId;check(observation.ownerMatches);
      observation.activeCafe=await repository.activeCafe(old.userId);check(observation.activeCafe,'ACCOUNT_UNAVAILABLE');
      const result=Object.freeze({...details,binding:oldBinding,googleQaPredecessor:Object.freeze({id:oldToken,
        revision:old.revision,periodEnd:new Date(Date.parse(old.periodEnd)).toISOString(),
        providerExpiry:verifiedOld.currentPeriodEnd,providerState:past.subscriptionState})});
      trustedStatuses.add(result);emit({...observation,stage:'verified',outcome:'verified'});return result;
    } catch(error) {emit({...observation,reason:error?.code});throw error;}
  }
  return Object.freeze({
    async identify(proof) {const value=await status(proof);return {providerSubscriptionId:value.providerSubscriptionId,binding:value.binding};},
    verify:status,
    async acknowledge(proof,value) {
      if(value===undefined)return ordinary.acknowledge(proof);
      try {
        check(trustedStatuses.has(value) && value.providerSubscriptionId===proof && value.needsAcknowledgement
          && value.environment==='Sandbox' && value.googleQaPredecessor,'PURCHASE_MISMATCH');
        trustedStatuses.delete(value);await signedQaContext(loadOidc);
        const durable=await repository.googleQaPredecessor(proof),owner=await repository.owner(value.binding);
        check(record(durable) && durable.userId===owner?.userId && durable.productId===config.productId
          && Number.isSafeInteger(durable.revision) && durable.revision>0 && durable.status===value.status && durable.supersededBy===null
          && date(durable.periodEnd) && Date.parse(durable.periodEnd)===Date.parse(value.currentPeriodEnd)
          && await repository.activeCafe(durable.userId),'ACCOUNT_UNAVAILABLE');
        await authClient.request({url:`${root}/subscriptions/${config.productId}/tokens/${encodeURIComponent(proof)}:acknowledge`,
          method:'POST',data:{externalAccountIds:{obfuscatedAccountId:value.binding}},timeout:15000});
      } catch(error) {emit({stage:'ack',reason:error?.code});throw error;}
    },
  });
}

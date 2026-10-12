import {createHash,randomUUID} from 'node:crypto';
import {PurchaseVerificationError} from '../native-billing/verifiedStatus.mjs';

const check=(value,code)=>{if(!value)throw new PurchaseVerificationError(code);};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The caller has verified Pub/Sub OIDC/package/envelope. A notification never
 * selects a user or environment. Validated Sandbox purchases and genuinely
 * absent/deleted account bindings are out of scope, with durable event dedup
 * only. Provider/DB failures stay retryable; ignored purchases are never ACKed.
 * Known Production bindings still use fresh reconciliation before store ACK. */
export async function androidGooglePublicEvent({event,payload,repository,runtime,reconcile}) {
  check(event?.provider==='google' && typeof event.eventId==='string' && event.eventId.length>0 && event.eventId.length<=255,'INVALID_EVENT');
  check(typeof payload==='string' && payload.length>0 && payload.length<=262144,'INVALID_EVENT');
  check(event.ignored==null || event.ignored==='google-one-time-voided-purchase','INVALID_EVENT');
  check(event.test===undefined || event.test===true,'INVALID_EVENT');
  check(!(event.test && event.ignored) && (!(event.test || event.ignored) || event.providerSubscriptionId==null && event.proof==null),'INVALID_EVENT');
  const key={provider:'google',environment:'Production',eventId:event.eventId,claimId:randomUUID()};
  const claim=await repository.claimEvent({...key,payloadHash:createHash('sha256').update(payload).digest('hex')});
  if(claim==='duplicate')return {kind:'duplicate'};
  check(claim==='claimed','EVENT_BUSY');
  try {
    let result={kind:event.ignored?'ignored':'processed',status:null};
    if(!event.test && !event.ignored) {
      const proof=event.proof || event.providerSubscriptionId;
      const identity=await runtime.inspectNotification(proof);
      check(identity?.providerSubscriptionId===proof && ['Sandbox','Production'].includes(identity.environment)
        && uuid.test(identity.binding || ''),'PURCHASE_MISMATCH');
      if(identity.environment==='Sandbox')result={kind:'ignored',reason:'sandbox-purchase'};
      else {
        const owner=await repository.owner(identity.binding);
        if(owner===null)result={kind:'ignored',reason:'unbound-purchase'};
        else {
          check(owner && uuid.test(owner.userId || ''),'ACCOUNT_MISMATCH');
          // Reconciliation re-fetches provider identity/current state and checks
          // owner/revision again; the preliminary classification is no grant.
          result={kind:'processed',status:await reconcile({provider:'google',proof})};
        }
      }
    }
    check(await repository.finishEvent({...key,success:true})===true,'EVENT_LEASE_EXPIRED');
    return result;
  } catch(error) {
    try{await repository.finishEvent({...key,success:false});}catch{/* Lease expiry permits retry. */}
    throw error;
  }
}

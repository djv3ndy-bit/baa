import { randomUUID } from 'node:crypto';
import {supabaseOrigin,serviceHeaders} from './providerRequest.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validCleanupBatch(batch,claimId){
 if(batch?.claimId!==claimId||!Array.isArray(batch.items)||batch.items.length>25)return false;
 const ids=new Set(),paths=new Set();
 for(const item of batch.items){
  if(!UUID.test(item?.uploadId)||!UUID.test(item?.ownerId)||typeof item.objectPath!=='string'
    ||!['jpg','png','webp','mp4','mov','webm'].some(ext=>item.objectPath===`${item.ownerId}/${item.uploadId}.${ext}`)
    ||ids.has(item.uploadId)||paths.has(item.objectPath))return false;
  ids.add(item.uploadId);paths.add(item.objectPath);
 }
 return true;
}
// Called by the existing authenticated hourly worker after notice delivery, with a separate20s budget.
// Deletion is limited to NEW private temporary objects whose irreversible TTL was disclosed on intake.
export function createStagingCleaner({fetchImpl=fetch,env=process.env,newId=randomUUID}={}){
 return async function cleanup(){
  let base;try{base=supabaseOrigin(env.SUPABASE_URL);}catch{return {ok:false,claimed:0,deleted:0};}
  if(!env.SUPABASE_SECRET_KEY)return {ok:false,claimed:0,deleted:0};
  const claimId=newId(),signal=AbortSignal.timeout(20000),headers=serviceHeaders(env.SUPABASE_SECRET_KEY);
  const rpc=async(name,args)=>{const r=await fetchImpl(`${base}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',headers,body:JSON.stringify(args),signal});if(!r.ok)throw Error('cleanup');return r.json();};
  let batch;
  try{batch=await rpc('claim_staged_media_cleanup',{p_claim_id:claimId,p_limit:25});}catch{return {ok:false,claimed:0,deleted:0};}
  if(!validCleanupBatch(batch,claimId))return {ok:false,claimed:0,deleted:0};
  if(!batch.items.length)return {ok:true,claimed:0,deleted:0};
  const ids=batch.items.map(x=>x.uploadId);
  try{
   const response=await fetchImpl(`${base}/storage/v1/object/ugc-media-staging`,{method:'DELETE',redirect:'error',headers,body:JSON.stringify({prefixes:batch.items.map(x=>x.objectPath)}),signal});
   if(!response.ok)throw Error('cleanup');
   const ack=await rpc('ack_staged_media_cleanup',{p_claim_id:claimId,p_upload_ids:ids,p_deleted:true});
   return {ok:ack===ids.length,claimed:ids.length,deleted:Number.isSafeInteger(ack)&&ack>=0&&ack<=ids.length?ack:0};
  }catch{
   if(!signal.aborted)await rpc('ack_staged_media_cleanup',{p_claim_id:claimId,p_upload_ids:ids,p_deleted:false}).catch(()=>{});
   return {ok:false,claimed:ids.length,deleted:0};
  }
 };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMediaPublisher,matchesMediaSignature } from '../server/moderation/mediaPublication.mjs';
const owner='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222',claim='33333333-3333-4333-8333-333333333333';
const jpeg=Buffer.from('ffd8ffe000000000','hex');
const env={SUPABASE_URL:'https://lmwqrxoitraofaftpwhe.supabase.co',SUPABASE_PUBLISHABLE_KEY:'synthetic-public',SUPABASE_SECRET_KEY:'synthetic-server'};
const result={requestId:request,status:'published',field:'avatar_url',value:`https://lmwqrxoitraofaftpwhe.supabase.co/storage/v1/object/public/cafe-images/${owner}/approved-${request}.jpg`};
const lease={requestId:request,status:'claimed',field:'avatar_url',sourceBucket:'ugc-media-staging',sourcePath:`${owner}/${request}.jpg`,targetBucket:'cafe-images',targetPath:`${owner}/approved-${request}.jpg`,mimeType:'image/jpeg',byteSize:jpeg.length};
function harness(options={}) {
 const calls=[];
 const fetchImpl=async(url,init={})=>{
  calls.push({url,init});
  if(url.endsWith('/auth/v1/user')) return Response.json(options.user??{id:owner},{status:options.authStatus??200});
  if(url.endsWith('/claim_profile_media_publication')) return Response.json(options.claim??lease,{status:options.claimStatus??200});
  if(url.includes('/storage/v1/object/ugc-media-staging/'))return new Response(options.source??jpeg,{status:options.sourceStatus??200,headers:options.sourceHeaders??{}});
  if(url.includes('/storage/v1/object/cafe-images/')) return init.method==='POST' ? new Response('',{status:options.uploadStatus??200}) : new Response(options.target??jpeg,{status:options.targetStatus??200});
  if(url.endsWith('/finish_profile_media_publication')) {if(options.finishThrows)throw Error('PRIVATE forbidden raw content');return Response.json(options.result??result,{status:options.finishStatus??200});}
  if(url.endsWith('/fail_profile_media_publication'))return Response.json(true);
  throw Error('Unexpected request');
 };
 return {calls,publish:createMediaPublisher({env:options.env??env,fetchImpl,newId:()=>claim})};
}
const input={authorization:'Bearer synthetic-owner-token',body:{requestId:request}};
test('publisher verifies Auth ownership, copies reviewed bytes without overwrite and finalizes exact digest',async()=>{
 const h=harness();assert.deepEqual(await h.publish(input),{status:200,body:result});
 const auth=h.calls.find(x=>x.url.endsWith('/auth/v1/user'));assert.equal(auth.init.headers.apikey,'synthetic-public');
 const c=h.calls.find(x=>x.url.endsWith('/claim_profile_media_publication'));assert.equal(JSON.parse(c.init.body).p_owner_id,owner);
 const upload=h.calls.find(x=>x.init.method==='POST'&&x.url.includes('/storage/'));assert.equal(upload.init.headers['x-upsert'],'false');assert.deepEqual(upload.init.body,jpeg);
 const f=h.calls.find(x=>x.url.endsWith('/finish_profile_media_publication'));assert.equal(JSON.parse(f.init.body).p_sha256,createHash('sha256').update(jpeg).digest('hex'));
});
for (const body of [null,{},[],{requestId:request,ownerId:owner},{requestId:request,url:'https://attacker.invalid'},{requestId:'bad'}]) test('rejects malformed/client-authority input '+JSON.stringify(body),async()=>{const h=harness();assert.equal((await h.publish({...input,body})).status,400);assert.equal(h.calls.length,0);});
test('missing bearer and failed Auth do not use service RPCs',async()=>{const h=harness({authStatus:401});assert.equal((await h.publish({...input,authorization:''})).status,401);assert.equal(h.calls.length,0);assert.equal((await h.publish(input)).status,401);assert.equal(h.calls.length,1);});
test('anonymous Auth account denied without private claim',async()=>{const h=harness({user:{id:owner,is_anonymous:true}});assert.equal((await h.publish(input)).status,401);assert.equal(h.calls.length,1);});
test('invalid environment fails closed before any request',async()=>{for(const e of [{...env,SUPABASE_URL:'http://backend.example'},{...env,SUPABASE_URL:'https://lmwqrxoitraofaftpwhe.supabase.co/path'},{...env,SUPABASE_SECRET_KEY:''}]){const h=harness({env:e});assert.equal((await h.publish(input)).status,503);assert.equal(h.calls.length,0);}});
test('published replay returns whitelisted result without recopy or private fields',async()=>{const h=harness({claim:{...result,private_note:'private'}});assert.deepEqual(await h.publish(input),{status:200,body:result});assert.equal(h.calls.length,2);});
test('live claim returns202 without duplicate copy',async()=>{const h=harness({claim:{requestId:request,status:'publishing'}});assert.deepEqual(await h.publish(input),{status:202,body:{requestId:request,status:'publishing'}});assert.equal(h.calls.length,2);});
test('unapproved/global-disabled claim returns safe typed code without raw diagnostics',async()=>{const h=harness({claim:{message:'ugc_publication_unavailable'},claimStatus:400});assert.deepEqual(await h.publish(input),{status:409,body:{error:'ugc_publication_unavailable'}});const bad=harness({claim:{message:'PRIVATE raw content'},claimStatus:500});assert.equal((await bad.publish(input)).body.error,'ugc_publication_failed');});
for(const change of [{sourceBucket:'cafe-images'},{sourcePath:`${request}/${request}.jpg`},{targetPath:`${owner}/different.jpg`},{targetBucket:'coffee-videos'},{byteSize:5242881},{mimeType:'image/svg+xml'},{field:'video_path'}])test('rejects invalid server copy contract '+JSON.stringify(change),async()=>{const h=harness({claim:{...lease,...change}});assert.equal((await h.publish(input)).status,503);assert.equal(h.calls.length,2);});
test('signature mismatch rejects unsafe content, releases only matching claim, and never uploads',async()=>{const h=harness({source:Buffer.from('notjpeg!')});assert.equal((await h.publish(input)).status,422);assert(!h.calls.some(x=>x.url.includes('cafe-images')));const f=h.calls.find(x=>x.url.endsWith('/fail_profile_media_publication'));assert.equal(JSON.parse(f.init.body).p_unsafe,true);assert.equal(JSON.parse(f.init.body).p_claim_id,claim);});
test('oversized streaming source never uploads',async()=>{const h=harness({source:Buffer.concat([jpeg,Buffer.from('x')])});assert.equal((await h.publish(input)).status,409);assert(!h.calls.some(x=>x.url.includes('cafe-images')));});
test('unknown earlier target copy is reused only after byte equality; mismatch cannot finish',async()=>{const good=harness({uploadStatus:409});assert.equal((await good.publish(input)).status,200);const bad=harness({uploadStatus:409,target:Buffer.from('ffd8ffe011111111','hex')});assert.equal((await bad.publish(input)).status,409);assert(!bad.calls.some(x=>x.url.endsWith('/finish_profile_media_publication')));});
test('unknown finalize outcome is safe and never exposes raw exception text',async()=>{const h=harness({finishThrows:true});const out=await h.publish(input);assert.deepEqual(out,{status:409,body:{error:'ugc_publication_failed'}});assert(h.calls.some(x=>x.url.endsWith('/fail_profile_media_publication')));});
test('container signature checks cover allowed types and reject SVG/executable disguises',()=>{
 assert(matchesMediaSignature(jpeg,'image/jpeg'));assert(!matchesMediaSignature(Buffer.from('<svg>'),'image/jpeg'));
 assert(matchesMediaSignature(Buffer.from('89504e470d0a1a0a0000000d494844520000000000000000','hex'),'image/png'));
 assert(matchesMediaSignature(Buffer.from('RIFF0000WEBPVP8 '),'image/webp'));
 assert(matchesMediaSignature(Buffer.from('0000ftypisom0000'),'video/mp4'));
 assert(matchesMediaSignature(Buffer.from('0000moov00000000'),'video/quicktime'));
 assert(matchesMediaSignature(Buffer.from('1a45dfa300000000','hex'),'video/webm'));
 assert(!matchesMediaSignature(Buffer.from('MZfake executable'),'video/mp4'));
});
for(const key of ['sb_secret_synthetic_placeholder','synthetic-legacy-jwt'])test('service header compatibility '+(key.startsWith('sb_secret_')?'modern API key':'legacy JWT'),async()=>{
 const h=harness({env:{...env,SUPABASE_SECRET_KEY:key}});assert.equal((await h.publish(input)).status,200);
 for(const c of h.calls.filter(x=>!x.url.endsWith('/auth/v1/user'))){assert.equal(c.init.headers.apikey,key);assert.equal(c.init.headers.Authorization,key.startsWith('sb_secret_')?undefined:`Bearer ${key}`);}
});
test('trusted custom Auth origin works, unknown external origin fails closed without sending a key',async()=>{
 const h=harness({env:{...env,SUPABASE_URL:'https://auth.baristajobmatch.com'}});assert.equal((await h.publish(input)).status,200);assert(h.calls.every(x=>x.url.startsWith('https://auth.baristajobmatch.com/')));
 const bad=harness({env:{...env,SUPABASE_URL:'https://attacker.example'}});assert.equal((await bad.publish(input)).status,503);assert.equal(bad.calls.length,0);
});

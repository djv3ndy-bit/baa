(function(root){
  'use strict';
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const FIELDS=['avatar_url','bar_picture_url','video_path'];
  const STATUSES=['pending','approved','rejected','publishing','published','cancelled'];
  const CANONICAL='https://lmwqrxoitraofaftpwhe.supabase.co';
  const TYPES={'image/jpeg':{ext:'jpg',names:['jpg','jpeg'],limit:5242880},'image/png':{ext:'png',names:['png'],limit:5242880},'image/webp':{ext:'webp',names:['webp'],limit:5242880},'video/mp4':{ext:'mp4',names:['mp4'],limit:52428800},'video/quicktime':{ext:'mov',names:['mov'],limit:52428800},'video/webm':{ext:'webm',names:['webm'],limit:52428800}};
  const MESSAGES={
    ugc_content_not_allowed:'Please edit the wording before saving. Some content is not allowed.',
    ugc_reviewed_media_required:'Photos and videos need review before publication. Save text separately, then use the media review controls.',
    ugc_invalid_media:'Choose a JPEG, PNG or WebP photo up to 5 MB, or an MP4, MOV or WebM video up to 50 MB.',
    ugc_media_access_denied:'Please sign in again with the account that submitted this media.',
    ugc_media_review_exists:'This photo or video already has a review in progress. Check its status or cancel it before choosing another.',
    ugc_rate_limited:'You have reached the media upload limit. Please wait before trying again.',
    ugc_staging_quota_reached:'Your private upload limit has been reached. Please contact support before uploading more.',
    ugc_upload_expired:'This unfinished upload expired. Check its status, then forget it before choosing the file again.',
    ugc_upload_not_found:'This upload is not confirmed yet. Continue the same upload to check it before choosing another.',
    ugc_profile_changed:'Your profile changed while this media was being reviewed. Your current media is unchanged. Check status or contact support.',
    ugc_publication_in_progress:'Publication is still being checked. Use Check status before continuing.',
    ugc_publication_unavailable:'Media publication is not available yet. Your current photo or video is unchanged.',
    ugc_media_not_approved:'This media has not been approved for publication. Check its status first.',
    ugc_publication_failed:'Publication could not be confirmed. Check status before continuing the same request.',
    capability_unavailable:'Media review is not available right now. You can still save profile text; your current media is unchanged.',
    account_changed:'Your account changed. Please reopen your profile before continuing.',
    busy:'Another media action is still being checked. Please wait.',
    unfinished_upload:'An earlier upload is unfinished. Continue or forget it before choosing another file.',
    upload_unknown:'The upload result is not confirmed. Continue the same private upload to check it; your current media is unchanged.',
    submit_unknown:'The review request is not confirmed. Continue the same upload or check status; your current media is unchanged.',
    cannot_cancel:'This media can no longer be cancelled here. Check its status.',
    result_mismatch:'The media result could not be confirmed for this account. Check status or contact support.'
  };
  function code(error){for(const value of [error?.code,error?.message,error?.error])if(Object.hasOwn(MESSAGES,value))return value;if(['PGRST202','PGRST204','42883'].includes(error?.code))return 'capability_unavailable';return null;}
  function flowError(key){const error=new Error(MESSAGES[key]||MESSAGES.result_mismatch);error.name='ProfileMediaReviewError';error.code=key;return error;}
  function safeMessage(error,fallback='We could not complete this action. Check status before trying again.'){return MESSAGES[code(error)]||fallback;}
  function allowedField(field,role){return field==='avatar_url'||field==='video_path'&&role==='barista'||field==='bar_picture_url'&&role==='cafe_owner_manager';}
  function validPublished(value,field,id,accountId){
    const extension=field==='video_path'?'(?:mp4|mov|webm)':'(?:jpg|png|webp)';
    const prefix=field==='video_path'?`${accountId}/approved-${id}.`:`${CANONICAL}/storage/v1/object/public/cafe-images/${accountId}/approved-${id}.`;
    return typeof value==='string'&&value.startsWith(prefix)&&new RegExp('^'+extension+'$').test(value.slice(prefix.length));
  }
  function createController(deps){
    const initial=deps.context();
    if(!initial||!UUID.test(initial.accountId)||!['barista','cafe_owner_manager'].includes(initial.role))throw flowError('account_changed');
    const owner={accountId:initial.accountId.toLowerCase(),role:initial.role,generation:initial.generation,client:initial.client};
    let stopped=false,busy=false,sequence=0,reviews=[],error='',notice='';
    const drafts=new Map();
    function same(){const now=deps.context();return !stopped&&now&&now.accountId?.toLowerCase()===owner.accountId&&now.role===owner.role&&now.generation===owner.generation&&now.client===owner.client;}
    function assert(){if(!same())throw flowError('account_changed');}
    function snapshot(){return{reviews:reviews.map(row=>({...row})),drafts:[...drafts].map(([field,draft])=>({field,phase:draft.phase})),busy,error,notice};}
    function emit(){if(same())deps.changed?.(snapshot());}
    async function checked(task){assert();await deps.confirm(owner);assert();const result=await task();assert();return result;}
    async function rpc(name,args){return checked(()=>deps.rpc(owner,name,args));}
    function row(value){
      if(!value||!UUID.test(value.request_id)||!FIELDS.includes(value.field)||!STATUSES.includes(value.status)||!Number.isFinite(Date.parse(value.submitted_at)))throw flowError('result_mismatch');
      if(value.status==='published'&&value.published_value==null)throw flowError('result_mismatch');
      if(value.published_value!=null&&!validPublished(value.published_value,value.field,value.request_id.toLowerCase(),owner.accountId))throw flowError('result_mismatch');
      return {...value,request_id:value.request_id.toLowerCase(),can_publish:value.can_publish===true};
    }
    async function read(){
      const result=await rpc('my_profile_media_reviews',{});
      if(!Array.isArray(result)||result.length>3)throw flowError('capability_unavailable');
      const next=result.map(row);if(new Set(next.map(item=>item.field)).size!==next.length)throw flowError('result_mismatch');
      reviews=next.filter(item=>allowedField(item.field,owner.role));
      for(const [field,draft]of drafts)if(reviews.some(item=>item.request_id===draft.intent.upload_id)){draft.file=null;drafts.delete(field);}
      return reviews;
    }
    async function acceptPublished(result){
      if(!result||!UUID.test(result.requestId)||result.status!=='published'||!allowedField(result.field,owner.role)||!validPublished(result.value,result.field,result.requestId.toLowerCase(),owner.accountId))throw flowError('result_mismatch');
      const profile=await checked(()=>deps.readProfile(owner));
      if(profile?.id?.toLowerCase()!==owner.accountId||profile.role!==owner.role||profile[result.field]!==result.value)throw flowError('result_mismatch');
      assert();deps.acceptProfile?.(profile,owner);notice='Media published. Your profile now uses the approved photo or video.';
    }
    async function execute(work){
      assert();if(busy)throw flowError('busy');const ownSequence=++sequence;busy=true;error='';notice='';emit();
      try{const result=await work();assert();return result;}
      catch(cause){if(same()){error=safeMessage(cause);emit();}throw cause?.name==='ProfileMediaReviewError'?cause:flowError(code(cause)||'result_mismatch');}
      finally{if(same()&&sequence===ownSequence){busy=false;emit();}}
    }
    function validateFile(field,file){
      const spec=TYPES[file?.type],extension=String(file?.name||'').split('.').pop().toLowerCase();
      if(!allowedField(field,owner.role)||!spec||!spec.names.includes(extension)||!Number.isSafeInteger(file.size)||file.size<1||file.size>spec.limit||(field==='video_path')!==file.type.startsWith('video/'))throw flowError('ugc_invalid_media');
      return spec;
    }
    async function submit(draft){
      draft.phase='submit_unknown';emit();
      let result;
      try{result=await rpc('submit_profile_media_review',{p_field:draft.field,p_object_path:draft.intent.object_path});}
      catch(cause){if(code(cause))throw cause;throw flowError('submit_unknown');}
      if(!result||!UUID.test(result.request_id)||result.request_id.toLowerCase()!==draft.intent.upload_id||result.field!==draft.field||!STATUSES.includes(result.status)||!Number.isFinite(Date.parse(result.submitted_at)))throw flowError('result_mismatch');
      const accepted={request_id:result.request_id.toLowerCase(),field:result.field,status:result.status,submitted_at:result.submitted_at};
      draft.file=null;drafts.delete(draft.field);await read();notice=accepted.status==='pending'?'Media submitted for review. Your current photo or video stays visible.':'Review status confirmed. Your current media stays unchanged until approved publication.';return accepted;
    }
    async function upload(draft){
      if(!draft.file||Date.parse(draft.intent.expires_at)<=Date.now())throw flowError('ugc_upload_expired');
      draft.phase='upload_unknown';emit();
      try{await checked(()=>deps.upload(owner,draft.intent,draft.file,{upsert:false,contentType:draft.file.type}));}
      catch(cause){if(code(cause))throw cause;throw flowError('upload_unknown');}
      draft.phase='uploaded';emit();return submit(draft);
    }
    return{
      state:snapshot,
      isCurrent:same,
      invalidate(){stopped=true;sequence++;busy=false;reviews=[];drafts.clear();error='';notice='';},
      refresh(){return execute(async()=>{await read();const published=reviews.filter(item=>item.status==='published');if(published.length){const profile=await checked(()=>deps.readProfile(owner));if(profile?.id?.toLowerCase()!==owner.accountId||profile.role!==owner.role)throw flowError('result_mismatch');assert();deps.acceptProfile?.(profile,owner);}return snapshot();});},
      stage(field,file){return execute(async()=>{
        const spec=validateFile(field,file);await read();if(drafts.has(field))throw flowError('unfinished_upload');
        if(reviews.some(item=>item.field===field&&['pending','approved','publishing'].includes(item.status)))throw flowError('ugc_media_review_exists');
        let intent;try{intent=await rpc('reserve_profile_media_upload',{p_field:field,p_mime_type:file.type,p_size:file.size});}catch(cause){if(code(cause))throw cause;throw flowError('capability_unavailable');}
        if(!intent||!UUID.test(intent.upload_id)||intent.bucket!=='ugc-media-staging'||intent.object_path!==`${owner.accountId}/${intent.upload_id.toLowerCase()}.${spec.ext}`||!Number.isFinite(Date.parse(intent.expires_at))||Date.parse(intent.expires_at)<=Date.now())throw flowError('result_mismatch');
        intent={...intent,upload_id:intent.upload_id.toLowerCase()};const draft={field,file,intent,phase:'reserved'};drafts.set(field,draft);return upload(draft);
      });},
      continueUpload(field){return execute(async()=>{
        const draft=drafts.get(field);if(!draft)throw flowError('ugc_upload_not_found');await read();if(!drafts.has(field))return snapshot();
        try{return await submit(draft);}catch(cause){if(code(cause)==='ugc_upload_not_found'||code(cause)==='ugc_upload_expired'&&Date.parse(draft.intent.expires_at)>Date.now())return upload(draft);throw cause;}
      });},
      forgetUpload(field){return execute(async()=>{
        const draft=drafts.get(field);if(!draft)return;await read();const existing=reviews.find(item=>item.request_id===draft.intent.upload_id);
        if(existing&&['pending','approved'].includes(existing.status)){const cancelled=await rpc('cancel_profile_media_review',{p_request_id:existing.request_id});if(cancelled!==true)throw flowError('cannot_cancel');await read();}
        else if(existing&&existing.status==='publishing')throw flowError('ugc_publication_in_progress');
        draft.file=null;drafts.delete(field);notice='Unfinished upload cleared from this page. Your current media is unchanged.';
      });},
      cancel(requestId){return execute(async()=>{
        if(!UUID.test(requestId))throw flowError('result_mismatch');await read();const existing=reviews.find(item=>item.request_id===requestId.toLowerCase());
        if(!existing||!['pending','approved','cancelled'].includes(existing.status))throw flowError('cannot_cancel');
        if(existing.status!=='cancelled'){const result=await rpc('cancel_profile_media_review',{p_request_id:existing.request_id});if(result!==true)throw flowError('cannot_cancel');}
        await read();notice='Review cancelled. Your current photo or video is unchanged.';
      });},
      publish(requestId){return execute(async()=>{
        if(!UUID.test(requestId))throw flowError('result_mismatch');await read();const existing=reviews.find(item=>item.request_id===requestId.toLowerCase());
        if(!existing)throw flowError('ugc_media_not_approved');
        if(existing.status==='published'){await acceptPublished({requestId:existing.request_id,status:'published',field:existing.field,value:existing.published_value});return;}
        if(!existing.can_publish||!['approved','publishing'].includes(existing.status))throw flowError('ugc_media_not_approved');
        let result;try{result=await checked(()=>deps.publish(owner,existing.request_id));}catch(cause){await read().catch(()=>{});if(code(cause))throw cause;throw flowError('ugc_publication_failed');}
        if(result?.requestId?.toLowerCase()!==existing.request_id)throw flowError('result_mismatch');
        if(result.status==='publishing'){notice='Publication is still being checked. Use Check status before continuing.';await read();return;}
        await acceptPublished(result);await read();
      });}
    };
  }
  // Capture the actor's JWT before constructing each request. Shared SDK auth may
  // switch accounts while its fetch wrapper awaits a token; per-request headers
  // keep that request bound to its original owner, and generation checks discard
  // late responses. Tokens are never persisted by this module.
  async function withOwnerSession(owner,context,work){
    const current=()=>{const now=context();return now&&now.accountId===owner.accountId&&now.role===owner.role&&now.generation===owner.generation&&now.client===owner.client;};
    if(!current())throw flowError('account_changed');
    const result=await owner.client.auth.getSession(),session=result?.data?.session;
    if(!current()||result.error||session?.user?.id!==owner.accountId||typeof session.access_token!=='string'||!session.access_token||!Number.isFinite(session.expires_at)||session.expires_at*1000<=Date.now())throw flowError('account_changed');
    const response=await work(session.access_token);
    if(!current())throw flowError('account_changed');
    return response;
  }
  root.BaristaMatchProfileMediaReview={createController,safeMessage,allowedField,validPublished,withOwnerSession};
})(globalThis);

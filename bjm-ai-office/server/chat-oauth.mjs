/** Office-owned OAuth tokens. Supabase is used only for interactive owner
 * authentication; its owner access/refresh credentials never reach the chat
 * client or persistent store. Reporting uses a separate aggregate credential.
 */
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

export const CHAT_SCOPE='office.read';
const FLOW_TTL=600,ACCESS_TTL=900,REFRESH_TTL=30*86400;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid=value=>typeof value==='string'&&UUID.test(value)&&value.toLowerCase()!=='00000000-0000-0000-0000-000000000000';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clean=value=>typeof value==='string'?value.trim():'';
const hash=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const challenge=verifier=>createHash('sha256').update(verifier).digest('base64url');
const tokenPattern={access:/^bjm_at_[A-Za-z0-9_-]{43}$/,refresh:/^bjm_rt_[A-Za-z0-9_-]{43}$/,code:/^bjm_code_[A-Za-z0-9_-]{43}$/};

export class ChatOAuthError extends Error {
  constructor(status,code){super(code);this.name='ChatOAuthError';this.status=status;this.code=code;}
}
const reject=(status=400,code='invalid_request')=>{throw new ChatOAuthError(status,code);};
function publicConfiguration(env){
  let base;
  try{base=new URL(clean(env.BJM_OFFICE_BASE_URL));}catch{reject(503,'temporarily_unavailable');}
  if(base.protocol!=='https:'||base.username||base.password||base.port||base.pathname!=='/'||base.search||base.hash)reject(503,'temporarily_unavailable');
  return{issuer:base.origin,resource:`${base.origin}/mcp`,authorizeUrl:`${base.origin}/oauth/authorize`,tokenUrl:`${base.origin}/oauth/token`,revokeUrl:`${base.origin}/oauth/revoke`,ownerCallback:`${base.origin}/oauth/owner/callback`};
}
export function chatAuthorizationMetadata(env=process.env){
  const config=publicConfiguration(env);
  return{issuer:config.issuer,authorization_endpoint:config.authorizeUrl,token_endpoint:config.tokenUrl,revocation_endpoint:config.revokeUrl,
    response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],
    token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none'],scopes_supported:[CHAT_SCOPE],
    authorization_response_iss_parameter_supported:true};
}
export function chatOAuthConfiguration(env=process.env){
  const config=publicConfiguration(env);
  let upstream,redirect;
  try{upstream=new URL(clean(env.SUPABASE_URL));redirect=new URL(clean(env.BJM_CHAT_OAUTH_REDIRECT_URI));}catch{reject(503,'temporarily_unavailable');}
  const flowKey=clean(env.BJM_CHAT_OAUTH_FLOW_KEY),clientId=clean(env.BJM_CHAT_OAUTH_CLIENT_ID);
  if(upstream.protocol!=='https:'||upstream.username||upstream.password||upstream.port||upstream.pathname!=='/'||upstream.search||upstream.hash||
    redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.port||redirect.hash||
    !/^https:\/\/chatgpt\.com\/(?:connector\/oauth\/[A-Za-z0-9_-]+|connector_platform_oauth_redirect)$/.test(redirect.href)||
    !clientId||clientId.length>200||!/^[-A-Za-z0-9_.:]+$/.test(clientId)||
    !uuid(clean(env.BJM_AI_OFFICE_OWNER_USER_ID))||!uuid(clean(env.BJM_CHAT_UPSTREAM_CLIENT_ID))||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(clean(env.SUPABASE_PUBLISHABLE_KEY))||
    clean(env.SUPABASE_SECRET_KEY)||clean(env.SUPABASE_SERVICE_ROLE_KEY)||
    !/^[A-Za-z0-9_-]{43}$/.test(flowKey)||Buffer.from(flowKey,'base64url').length!==32||Buffer.from(flowKey,'base64url').toString('base64url')!==flowKey||
    clean(env.BJM_CHAT_OAUTH_ENABLED)!=='true')reject(503,'temporarily_unavailable');
  return{...config,clientId,redirectUri:redirect.href,ownerId:clean(env.BJM_AI_OFFICE_OWNER_USER_ID),upstreamClientId:clean(env.BJM_CHAT_UPSTREAM_CLIENT_ID),
    upstreamIssuer:`${upstream.origin}/auth/v1`,publishableKey:clean(env.SUPABASE_PUBLISHABLE_KEY),flowKey};
}
const headers={'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
function setHeaders(res){for(const[key,value]of Object.entries(headers))res.setHeader(key,value);}
function json(res,status,value){setHeaders(res);res.status(status).json(value);}
function error(res,failure){
  const known=failure instanceof ChatOAuthError?failure:new ChatOAuthError(503,'temporarily_unavailable');
  const descriptions={invalid_request:'The OAuth request is invalid.',invalid_client:'The OAuth client is not authorized.',invalid_grant:'The authorization grant is invalid or expired.',invalid_scope:'The requested scope is not supported.',unsupported_grant_type:'The grant type is not supported.',access_denied:'Owner authorization was not completed.',invalid_token:'The Office token is invalid or expired.',temporarily_unavailable:'Office authorization is temporarily unavailable.'};
  json(res,known.status,{error:known.code,error_description:descriptions[known.code]||descriptions.temporarily_unavailable});
}
function authorizationError(res,failure,config,state){
  const known=failure instanceof ChatOAuthError?failure:new ChatOAuthError(503,'temporarily_unavailable');
  const allowed=['access_denied','invalid_request','invalid_scope','temporarily_unavailable'];
  const redirect=new URL(config.redirectUri);
  redirect.searchParams.set('error',allowed.includes(known.code)?known.code:'access_denied');
  redirect.searchParams.set('state',state);redirect.searchParams.set('iss',config.issuer);
  setHeaders(res);res.redirect(302,redirect.href);
}
function method(req,res,expected){
  if(String(req.method||'').toUpperCase()===expected)return true;
  res.setHeader('Allow',expected);json(res,405,{error:'invalid_request',error_description:'The method is not supported.'});return false;
}
function query(req,config){
  let url;try{url=new URL(req.url,config.issuer);}catch{reject();}
  if(url.origin!==config.issuer||url.hash||url.username||url.password||url.href.length>8192)reject();
  return url.searchParams;
}
function fields(params,allowed){
  for(const key of params.keys())if(!allowed.includes(key)||params.getAll(key).length!==1)reject();
  for(const value of params.values())if(value.length>4096)reject();
}
async function form(req){
  if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(String(req.headers?.['content-type']||'')))reject();
  let params;
  if(typeof req.body==='string'){
    if(Buffer.byteLength(req.body)>8192)reject();params=new URLSearchParams(req.body);
  }else if(object(req.body)){
    params=new URLSearchParams();let size=0;
    for(const[key,value]of Object.entries(req.body)){if(typeof value!=='string')reject();size+=Buffer.byteLength(key)+Buffer.byteLength(value);if(size>8192)reject();params.append(key,value);}
  }else{
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)reject();}params=new URLSearchParams(text);
  }
  return params;
}
function client(params,req,config){
  if(req.headers?.authorization!==undefined||params.has('client_secret')||params.get('client_id')!==config.clientId)reject(400,'invalid_client');
}
function exactResource(value,config){if(value!==config.resource)reject();}
function encrypt(config,flowHash,payload){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(config.flowKey,'base64url'),iv);
  cipher.setAAD(Buffer.from(`bjm-office-flow-v1|${config.issuer}|${flowHash}`));
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return[iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
}
function decrypt(config,flowHash,text,now){
  if(typeof text!=='string'||text.length>65536||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(text))reject(400,'invalid_grant');
  let payload;
  try{
    const[iv,tag,ciphertext]=text.split('.').map(part=>Buffer.from(part,'base64url'));
    if(iv.length!==12||tag.length!==16)reject(400,'invalid_grant');
    const decipher=createDecipheriv('aes-256-gcm',Buffer.from(config.flowKey,'base64url'),iv);
    decipher.setAAD(Buffer.from(`bjm-office-flow-v1|${config.issuer}|${flowHash}`));decipher.setAuthTag(tag);
    payload=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
  }catch{reject(400,'invalid_grant');}
  const allowed=['v','clientId','redirectUri','challenge','resource','state','upstreamVerifier','issuedAt'];
  if(!object(payload)||Object.keys(payload).some(key=>!allowed.includes(key))||Object.keys(payload).length!==allowed.length||payload.v!==1||
    payload.clientId!==config.clientId||payload.redirectUri!==config.redirectUri||payload.resource!==config.resource||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.challenge)||!/^[A-Za-z0-9_-]{43}$/.test(payload.upstreamVerifier)||
    typeof payload.state!=='string'||!payload.state||payload.state.length>1024||
    !Number.isSafeInteger(payload.issuedAt)||payload.issuedAt>now+30||payload.issuedAt<now-FLOW_TTL)reject(400,'invalid_grant');
  return payload;
}
async function limitedJson(response,limit=65536){
  if(!String(response.headers.get('content-type')||'').toLowerCase().includes('application/json')||!response.body)reject(503,'temporarily_unavailable');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)reject(503,'temporarily_unavailable');chunks.push(Buffer.from(value));}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size)));}
  catch{reject(503,'temporarily_unavailable');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function discard(response){await response.body?.cancel().catch(()=>{});}
function freshUpstreamClaims(config,token,issuedAt,now){
  if(typeof token!=='string'||token.length>8192||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(token))reject(403,'access_denied');
  let header,claims;try{[header,claims]=token.split('.').slice(0,2).map(part=>JSON.parse(Buffer.from(part,'base64url').toString('utf8')));}catch{reject(403,'access_denied');}
  if(!object(header)||!object(claims)||!['ES256','RS256'].includes(header.alg)||['crit','b64','jku','jwk','x5u','x5c'].some(key=>header[key]!==undefined)||
    claims.iss!==config.upstreamIssuer||!uuid(claims.sub)||claims.client_id!==config.upstreamClientId||!uuid(claims.session_id)||
    !Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)||claims.iat<issuedAt-2||claims.iat>now+30||claims.exp<=now||claims.exp<=claims.iat||claims.exp-claims.iat>3600||
    (claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now+30)))reject(403,'access_denied');
  return claims;
}
function authorizeOwner(config,claims,user,now){
  const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(claims.sub!==config.ownerId||claims.role!=='authenticated'||audiences.length!==1||audiences[0]!=='authenticated'||
    claims.scope!=='openid'||claims.is_anonymous!==false||!Number.isFinite(Date.parse(user.email_confirmed_at))||user.is_anonymous!==false||user.deleted_at||
    (user.banned_until&&(!Number.isFinite(Date.parse(user.banned_until))||Date.parse(user.banned_until)>now)))reject(403,'access_denied');
}
function expiry(value,config,now,refresh=false){
  if(!object(value)||value.ownerId!==config.ownerId||!Number.isSafeInteger(value.accessExpiresAt)||value.accessExpiresAt<=now||value.accessExpiresAt>now+ACCESS_TTL+30||
    (refresh&&(!Number.isSafeInteger(value.refreshExpiresAt)||value.refreshExpiresAt<=now||value.refreshExpiresAt>now+REFRESH_TTL+30)))reject(503,'temporarily_unavailable');
  return value;
}
export function createChatOAuthHandlers({env=process.env,store,fetchImpl=globalThis.fetch,now=()=>Date.now()}={}){
  const seconds=()=>Math.floor(now()/1000);
  const configuration=()=>chatOAuthConfiguration(env);
  async function operation(op,args){
    try{if(typeof store!=='function')reject(503,'temporarily_unavailable');return await store(op,args);}
    catch{reject(503,'temporarily_unavailable');}
  }
  const upstream=(config,path,init={})=>fetchImpl(`${config.upstreamIssuer}${path}`,{...init,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{apikey:config.publishableKey,Accept:'application/json',...init.headers}});
  async function authorize(req,res){
    if(!method(req,res,'GET'))return;
    let approvedRedirect;
    try{
      const config=configuration(),params=query(req,config);
      fields(params,['response_type','client_id','redirect_uri','scope','state','code_challenge','code_challenge_method','resource']);
      client(params,req,config);
      if(params.get('redirect_uri')!==config.redirectUri||!params.get('state')||params.get('state').length>1024)reject();
      approvedRedirect={config,state:params.get('state')};
      if(params.get('response_type')!=='code'||params.get('code_challenge_method')!=='S256'||
        !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge')||'')||!params.get('state')||params.get('state').length>1024)reject();
      exactResource(params.get('resource'),config);if(params.get('scope')!==CHAT_SCOPE)reject(400,'invalid_scope');
      const upstreamState=random(),upstreamVerifier=random(),flowHash=hash(upstreamState);
      const payload={v:1,clientId:config.clientId,redirectUri:config.redirectUri,challenge:params.get('code_challenge'),resource:config.resource,state:params.get('state'),upstreamVerifier,issuedAt:seconds()};
      const created=await operation('create_flow',{flowHash,encryptedPayload:encrypt(config,flowHash,payload)});
      if(!object(created)||created.ok!==true)reject(503,'temporarily_unavailable');
      const url=new URL(`${config.upstreamIssuer}/oauth/authorize`);
      url.search=new URLSearchParams({response_type:'code',client_id:config.upstreamClientId,redirect_uri:config.ownerCallback,scope:'openid',resource:config.resource,state:upstreamState,code_challenge:challenge(upstreamVerifier),code_challenge_method:'S256'}).toString();
      setHeaders(res);res.redirect(302,url.href);
    }catch(failure){if(approvedRedirect)authorizationError(res,failure,approvedRedirect.config,approvedRedirect.state);else error(res,failure);}
  }
  async function ownerCallback(req,res){
    if(!method(req,res,'GET'))return;
    let approvedRedirect,verifiedFreshSession,cleanupAttempted=false;
    async function cleanupFreshSession(){
      // This context exists only after a state+PKCE-bound exchange, strict
      // issuer/client/fresh-session claims and authoritative Auth/user identity.
      // Owner authorization is separate: denied accounts still get local cleanup.
      if(!verifiedFreshSession||cleanupAttempted)return;
      cleanupAttempted=true;
      const {config,accessToken}=verifiedFreshSession;
      const logout=await upstream(config,'/logout?scope=local',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`}});
      const loggedOut=logout.status===204;await discard(logout);
      if(!loggedOut)reject(503,'temporarily_unavailable');
    }
    try{
      const config=configuration(),params=query(req,config);
      fields(params,['code','state','iss','error','error_description']);
      if(!/^[A-Za-z0-9_-]{43}$/.test(params.get('state')||'')||(params.has('iss')&&params.get('iss')!==config.upstreamIssuer))reject();
      const flowHash=hash(params.get('state')),stored=await operation('consume_flow',{flowHash});
      if(!object(stored)||typeof stored.encryptedPayload!=='string')reject(400,'invalid_grant');
      const payload=decrypt(config,flowHash,stored.encryptedPayload,seconds());
      approvedRedirect={config,state:payload.state};
      if(params.has('error'))reject(403,'access_denied');
      const code=params.get('code');if(!/^[A-Za-z0-9_-]{16,1024}$/.test(code||''))reject();
      const response=await upstream(config,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.upstreamClientId,redirect_uri:config.ownerCallback,code,code_verifier:payload.upstreamVerifier,resource:config.resource})});
      if(response.status!==200){await discard(response);reject(403,'access_denied');}
      const value=await limitedJson(response);
      if(!object(value)||value.token_type?.toLowerCase()!=='bearer')reject(403,'access_denied');
      // Never persist or forward refresh/ID/provider credentials returned by Auth.
      delete value.refresh_token;delete value.id_token;delete value.provider_token;delete value.provider_refresh_token;
      const accessToken=value.access_token;delete value.access_token;
      const claims=freshUpstreamClaims(config,accessToken,payload.issuedAt,seconds());
      const userResponse=await upstream(config,'/user',{headers:{Authorization:`Bearer ${accessToken}`}});
      if(userResponse.status!==200){await discard(userResponse);reject(403,'access_denied');}
      const user=await limitedJson(userResponse);
      if(!object(user)||user.id!==claims.sub)reject(403,'access_denied');
      verifiedFreshSession={config,accessToken};
      authorizeOwner(config,claims,user,now());
      // The only upstream Auth mutation targets the fresh, nonzero session from
      // this state+PKCE-bound code exchange. Acknowledged local logout is required
      // BEFORE creating any Office code or grant. No global/others fallback.
      await cleanupFreshSession();
      const officeCode=`bjm_code_${random()}`;
      const created=await operation('create_code',{codeHash:hash(officeCode),clientId:payload.clientId,redirectUri:payload.redirectUri,challenge:payload.challenge,resource:payload.resource,ownerId:user.id});
      if(!object(created)||created.ok!==true)reject(503,'temporarily_unavailable');
      const redirect=new URL(config.redirectUri);redirect.searchParams.set('code',officeCode);redirect.searchParams.set('state',payload.state);redirect.searchParams.set('iss',config.issuer);
      setHeaders(res);res.redirect(302,redirect.href);
    }catch(failure){
      try{await cleanupFreshSession();}catch{failure=new ChatOAuthError(503,'temporarily_unavailable');}
      if(approvedRedirect)authorizationError(res,failure,approvedRedirect.config,approvedRedirect.state);else error(res,failure);
    }finally{verifiedFreshSession=undefined;}
  }
  async function token(req,res){
    if(!method(req,res,'POST'))return;
    try{
      const config=configuration(),params=await form(req);
      fields(params,['grant_type','client_id','client_secret','code','redirect_uri','code_verifier','resource','refresh_token','scope']);
      client(params,req,config);exactResource(params.get('resource'),config);
      const accessToken=`bjm_at_${random()}`,refreshToken=`bjm_rt_${random()}`,at=seconds();let value;
      if(params.get('grant_type')==='authorization_code'){
        if(params.has('refresh_token')||params.has('scope')||!tokenPattern.code.test(params.get('code')||'')||params.get('redirect_uri')!==config.redirectUri||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier')||''))reject(400,'invalid_grant');
        value=await operation('exchange_code',{codeHash:hash(params.get('code')),clientId:config.clientId,redirectUri:config.redirectUri,challenge:challenge(params.get('code_verifier')),accessHash:hash(accessToken),refreshHash:hash(refreshToken)});
      }else if(params.get('grant_type')==='refresh_token'){
        if(params.has('code')||params.has('redirect_uri')||params.has('code_verifier')||!tokenPattern.refresh.test(params.get('refresh_token')||''))reject(400,'invalid_grant');
        if(params.has('scope')&&params.get('scope')!==CHAT_SCOPE)reject(400,'invalid_scope');
        value=await operation('refresh',{refreshHash:hash(params.get('refresh_token')),clientId:config.clientId,resource:config.resource,newAccessHash:hash(accessToken),newRefreshHash:hash(refreshToken)});
      }else reject(400,'unsupported_grant_type');
      if(value===null||value===false||value===undefined)reject(400,'invalid_grant');
      expiry(value,config,at,true);
      json(res,200,{access_token:accessToken,token_type:'Bearer',expires_in:value.accessExpiresAt-at,refresh_token:refreshToken,scope:CHAT_SCOPE});
    }catch(failure){error(res,failure);}
  }
  async function revoke(req,res){
    if(!method(req,res,'POST'))return;
    try{
      const config=configuration(),params=await form(req);fields(params,['client_id','client_secret','token','token_type_hint']);client(params,req,config);
      const value=params.get('token');if(typeof value!=='string'||!value)reject();
      // RFC7009 does not disclose unknown tokens. JWTs from other issuers are
      // never forwarded upstream or accepted as Office credentials.
      if(tokenPattern.access.test(value)||tokenPattern.refresh.test(value)){
        const revoked=await operation('revoke',{tokenHash:hash(value),clientId:config.clientId});
        if(!object(revoked)||revoked.revoked!==true)reject(503,'temporarily_unavailable');
      }
      json(res,200,{});
    }catch(failure){error(res,failure);}
  }
  async function verifyAccessToken(accessToken){
    const config=configuration();if(typeof accessToken!=='string'||!tokenPattern.access.test(accessToken))reject(401,'invalid_token');
    const accessHash=hash(accessToken),value=await operation('verify',{accessHash,clientId:config.clientId,resource:config.resource});
    if(!object(value)||value.ownerId!==config.ownerId||value.clientId!==config.clientId||value.resource!==config.resource||!Number.isSafeInteger(value.accessExpiresAt)||value.accessExpiresAt<=seconds())reject(401,'invalid_token');
    expiry(value,config,seconds());return{ownerId:value.ownerId,accessHash};
  }
  return{authorize,ownerCallback,token,revoke,verifyAccessToken};
}

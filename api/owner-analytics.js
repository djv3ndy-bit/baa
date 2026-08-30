function headers(extra={}){const key=process.env.SUPABASE_SECRET_KEY;const value={apikey:key,'Content-Type':'application/json',...extra};if(key&&!key.startsWith('sb_secret_'))value.Authorization=`Bearer ${key}`;return value}
async function rest(path,options={}){return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{...options,headers:{...headers(),...(options.headers||{})}})}
async function owner(req){const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!token)return null;const auth=await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});if(!auth.ok)return null;const user=await auth.json();const check=await rest(`support_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id&limit=1`);if(!check.ok)return null;return (await check.json()).length?user:null}
async function count(table,filter=''){const response=await rest(`${table}?select=id${filter}`,{headers:{Prefer:'count=exact',Range:'0-0'}});if(!response.ok)throw new Error(`Could not count ${table}`);return Number((response.headers.get('content-range')||'0/0').split('/')[1]||0)}
const dayKey=value=>new Date(value).toISOString().slice(0,10);
export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
  res.setHeader('Cache-Control','private, no-store');
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY||!process.env.SUPABASE_PUBLISHABLE_KEY)return res.status(503).json({error:'Owner analytics unavailable'});
  if(!await owner(req))return res.status(403).json({error:'Owner access required'});
  try{
    const now=Date.now(),since30=new Date(now-30*86400000).toISOString(),since7=new Date(now-7*86400000).toISOString();
    const [signups,baristas,cafes,jobs,activeJobs,legacyMatches,profileMatches,messages,profileMessages,trafficResponse]=await Promise.all([
      count('profiles'),count('profiles','&role=eq.barista'),count('profiles','&role=eq.cafe_owner_manager'),count('jobs'),count('jobs','&active=eq.true'),count('applications','&status=eq.matched'),count('discovery_matches'),count('messages'),count('discovery_messages'),rest(`traffic_pageviews?select=path,referrer_host,device_type,created_at&created_at=gte.${encodeURIComponent(since30)}&order=created_at.asc&limit=10000`)
    ]);
    if(!trafficResponse.ok)throw new Error('Could not load traffic');const traffic=await trafficResponse.json();
    const days={};for(let i=29;i>=0;i--){const date=new Date(now-i*86400000).toISOString().slice(0,10);days[date]=0}traffic.forEach(row=>{const key=dayKey(row.created_at);if(key in days)days[key]++});
    const rank=field=>Object.entries(traffic.reduce((acc,row)=>{const key=row[field]||'Direct / none';acc[key]=(acc[key]||0)+1;return acc},{})).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([label,value])=>({label,value}));
    return res.status(200).json({generated_at:new Date().toISOString(),metrics:{signups,baristas,cafes,jobs,active_jobs:activeJobs,matches:legacyMatches+profileMatches,messages:messages+profileMessages,pageviews_30d:traffic.length,pageviews_7d:traffic.filter(row=>row.created_at>=since7).length},daily:Object.entries(days).map(([date,value])=>({date,value})),top_pages:rank('path'),referrers:rank('referrer_host'),devices:rank('device_type')});
  }catch(error){console.error('Owner analytics failed',error?.message||error);return res.status(500).json({error:'Could not load business analytics'})}
}

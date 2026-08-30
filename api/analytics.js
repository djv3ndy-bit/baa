const clean=(value,max)=>String(value??'').trim().slice(0,max);
function serverHeaders(){const key=process.env.SUPABASE_SECRET_KEY;const headers={apikey:key,'Content-Type':'application/json',Prefer:'return=minimal'};if(key&&!key.startsWith('sb_secret_'))headers.Authorization=`Bearer ${key}`;return headers}
function deviceType(userAgent){const ua=String(userAgent||'');if(/iPad|Tablet|PlayBook|Silk/i.test(ua))return'tablet';if(/Mobi|Android|iPhone|iPod/i.test(ua))return'mobile';return'desktop'}
export default async function handler(req,res){
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).end()}
  res.setHeader('Cache-Control','no-store');
  if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY)return res.status(204).end();
  const fetchSite=clean(req.headers['sec-fetch-site'],30);if(fetchSite&&fetchSite!=='same-origin')return res.status(204).end();
  const path=clean(req.body?.path,300);if(!path.startsWith('/')||path.startsWith('/owner-dashboard')||path.startsWith('/support-admin'))return res.status(204).end();
  const payload={path,referrer_host:clean(req.body?.referrer_host,200)||null,device_type:deviceType(req.headers['user-agent'])};
  try{await fetch(`${process.env.SUPABASE_URL}/rest/v1/traffic_pageviews`,{method:'POST',headers:serverHeaders(),body:JSON.stringify(payload)})}catch(error){console.error('Analytics event failed',error?.message||error)}
  return res.status(204).end();
}

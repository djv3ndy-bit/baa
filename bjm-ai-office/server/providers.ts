type Json = Record<string, any>;

const env = (name:string) => String(process.env[name] || '').trim();
const safeFetch = async (url:string, init:RequestInit={}) => { try { const r=await fetch(url,{...init,signal:AbortSignal.timeout(5000)}); const text=await r.text(); let data:any=null; try{data=text?JSON.parse(text):null}catch{data=null} return {ok:r.ok,status:r.status,data}; } catch(e:any){ return {ok:false,status:0,error:String(e?.message||e)}; } };

const supabaseHeaders=()=>({apikey:env('SUPABASE_SERVICE_ROLE_KEY'),Authorization:`Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`});
const sb=async(path:string)=>{const base=env('SUPABASE_URL').replace(/\/$/,''); if(!base||!env('SUPABASE_SERVICE_ROLE_KEY')) return {ok:false,status:0,error:'supabase_not_configured'}; return safeFetch(`${base}/rest/v1/${path}`,{headers:supabaseHeaders()});};

async function count(table:string, query='select=id&limit=1'){const base=env('SUPABASE_URL').replace(/\/$/,''); if(!base||!env('SUPABASE_SERVICE_ROLE_KEY')) return null; try{const r=await fetch(`${base}/rest/v1/${table}?${query}`,{headers:{...supabaseHeaders(),Prefer:'count=exact'},signal:AbortSignal.timeout(5000)}); const range=r.headers.get('content-range')||''; const total=range.split('/')[1]; return total && total!=='*' ? Number(total) : null;}catch{return null;}}

export async function getLiveOverview(){
 const [profiles,cafes,baristas,jobs,apps,subs,payments]=await Promise.all([
  count('profiles'),count('cafe_profiles'),count('barista_profiles'),count('jobs'),count('applications'),count('cafe_subscriptions'),count('subscription_payments')
 ]);
 const configured=Boolean(env('SUPABASE_URL')&&env('SUPABASE_SERVICE_ROLE_KEY'));
 return {source:'supabase',configured,metrics:{profiles,cafes,baristas,jobs,applications:apps,subscriptions:subs,payments},status:configured?'connected':'configuration_required'};
}

export async function getSupportSummary(){
 const candidates=['support_tickets','support_requests'];
 for(const table of candidates){const r=await sb(`${table}?select=id,status,created_at&order=created_at.desc&limit=100`); if(r.ok&&Array.isArray(r.data)){const open=r.data.filter((x:any)=>!['resolved','closed'].includes(String(x.status||'').toLowerCase())).length; return {source:`supabase:${table}`,configured:true,total_recent:r.data.length,open};}}
 return {source:'supabase',configured:Boolean(env('SUPABASE_URL')),total_recent:null,open:null,note:'Support intake may currently be email-based; no readable support table was found by the adapter.'};
}

export async function getBillingSummary(){
 const [subs,payments]=await Promise.all([sb('cafe_subscriptions?select=status,cancel_at_period_end,complimentary_access&limit=500'),sb('subscription_payments?select=status,amount_cents,currency,paid_at&order=paid_at.desc&limit=500')]);
 const subRows=subs.ok&&Array.isArray(subs.data)?subs.data:[]; const payRows=payments.ok&&Array.isArray(payments.data)?payments.data:[];
 return {source:'supabase-billing',configured:subs.status!==0||payments.status!==0,subscriptions:{total:subRows.length,active:subRows.filter((x:any)=>String(x.status).toLowerCase()==='active').length,past_due:subRows.filter((x:any)=>['past_due','unpaid','incomplete'].includes(String(x.status).toLowerCase())).length,canceling:subRows.filter((x:any)=>Boolean(x.cancel_at_period_end)).length},payments:{recent:payRows.length,failed:payRows.filter((x:any)=>String(x.status).toLowerCase()==='failed').length,refunded:payRows.filter((x:any)=>String(x.status).toLowerCase()==='refunded').length}};
}

export async function getSystemHealth(){
 const checks:any[]=[];
 const publicUrl=env('BJM_PUBLIC_URL')||'https://www.baristajobmatch.com';
 const web=await safeFetch(publicUrl,{method:'HEAD'}); checks.push({service:'website',ok:web.ok,status:web.status});
 const supabaseConfigured=Boolean(env('SUPABASE_URL')&&env('SUPABASE_SERVICE_ROLE_KEY')); checks.push({service:'supabase',ok:supabaseConfigured,status:supabaseConfigured?'configured':'missing_config'});
 checks.push({service:'resend',ok:Boolean(env('RESEND_API_KEY')),status:env('RESEND_API_KEY')?'configured':'missing_config'});
 checks.push({service:'stripe',ok:Boolean(env('STRIPE_SECRET_KEY')),status:env('STRIPE_SECRET_KEY')?'configured':'missing_config'});
 return {source:'server-health',overall:checks.every(x=>x.ok)?'healthy':checks.some(x=>x.ok)?'attention':'unavailable',checks};
}

export async function getDecisionSignals(){
 const [billing,health,support]=await Promise.all([getBillingSummary(),getSystemHealth(),getSupportSummary()]); const items:any[]=[];
 if(billing.subscriptions.past_due>0||billing.payments.failed>0) items.push({agent:'billing-subscriptions',severity:'P1',title:'Billing issues need review',summary:`${billing.subscriptions.past_due} past-due subscriptions and ${billing.payments.failed} failed payments detected.`,protected:true});
 if(health.overall!=='healthy') items.push({agent:'engineering-reliability',severity:'P1',title:'System configuration/health needs attention',summary:'One or more monitored services are unavailable or not configured for the private Office.',protected:true});
 if(typeof support.open==='number'&&support.open>0) items.push({agent:'customer-support',severity:'P2',title:'Open support requests',summary:`${support.open} recent support requests appear open.`,protected:false});
 return items;
}

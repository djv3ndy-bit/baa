import test from 'node:test';
import assert from 'node:assert/strict';

const registry={
  manager:'prepare',engineering:'prepare',security:'prepare',support:'prepare',marketing:'prepare',sales:'prepare',
  'barista-acquisition':'prepare',marketplace:'recommend',product:'recommend',seo:'prepare',matching:'recommend',
  communications:'prepare',billing:'prepare',finance:'recommend','trust-safety':'prepare',data:'prepare',release:'prepare',
  compliance:'recommend','owner-intelligence':'observe'
};
const rank={observe:0,recommend:1,prepare:2,execute:3};
const permission=(id,requested)=>Boolean(registry[id])&&rank[requested]<=rank[registry[id]];
const route=event=>{
 const v=event.toLowerCase();
 if(/security|credential|secret|vulnerab|suspicious login/.test(v))return'security';
 if(/seo|indexing|sitemap|schema|search console/.test(v))return'seo';
 if(/database|query|index|migration|rls/.test(v))return'data';
 if(/crash|api failure|ci failure|performance|outage|bug/.test(v))return'engineering';
 if(/refund|subscription|payment|billing/.test(v))return'billing';
 if(/support|customer issue|help request/.test(v))return'support';
 if(/café prospect|cafe prospect|sales lead/.test(v))return'sales';
 if(/barista acquisition|barista signup|barista prospect/.test(v))return'barista-acquisition';
 if(/marketplace|zero applicants|supply|demand|liquidity/.test(v))return'marketplace';
 if(/ux|product friction|drop-off|dropoff/.test(v))return'product';
 if(/notification|transactional email|push notification/.test(v))return'communications';
 if(/app store|testflight|release|build submission/.test(v))return'release';
 if(/privacy|terms|compliance|legal/.test(v))return'compliance';
 if(/fraud|fake job|fake profile|abuse|scam/.test(v))return'trust-safety';
 if(/matching|recommendation|job fit/.test(v))return'matching';
 if(/revenue|cost|margin|finance/.test(v))return'finance';
 if(/growth|activation|marketing|campaign/.test(v))return'marketing';
 return'manager';
};

test('registry contains all 19 V1 operating roles',()=>assert.equal(Object.keys(registry).length,19));
test('orchestrator routes representative events',()=>{
 assert.equal(route('production API failure on jobs'),'engineering');
 assert.equal(route('suspicious login security alert'),'security');
 assert.equal(route('database query is slow'),'data');
 assert.equal(route('SEO sitemap indexing issue'),'seo');
 assert.equal(route('barista signup acquisition cohort'),'barista-acquisition');
 assert.equal(route('fake job scam report'),'trust-safety');
});
test('permission ceilings block overreach',()=>{
 assert.equal(permission('owner-intelligence','recommend'),false);
 assert.equal(permission('marketplace','prepare'),false);
 assert.equal(permission('engineering','prepare'),true);
 assert.equal(permission('engineering','execute'),false);
});
test('unknown agent cannot act',()=>assert.equal(permission('unknown','observe'),false));

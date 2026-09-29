export type PermissionLevel = 'observe' | 'recommend' | 'prepare' | 'execute';

export type AgentRegistryEntry = {
  id: string;
  name: string;
  ceiling: PermissionLevel;
  responsibility: string;
};

export const AGENT_REGISTRY: readonly AgentRegistryEntry[] = [
  {id:'manager',name:'Operations Manager / Orchestrator',ceiling:'prepare',responsibility:'Route, deduplicate, coordinate, and escalate work.'},
  {id:'engineering',name:'Engineering & Reliability',ceiling:'prepare',responsibility:'Incidents, bugs, performance, CI, and prepared fixes.'},
  {id:'security',name:'Security',ceiling:'prepare',responsibility:'Authentication, secrets, permissions, and vulnerabilities.'},
  {id:'support',name:'Customer Support',ceiling:'prepare',responsibility:'Support triage, reply drafts, and escalations.'},
  {id:'marketing',name:'Marketing & Growth',ceiling:'prepare',responsibility:'Activation analysis, experiments, and campaign drafts.'},
  {id:'sales',name:'Café Sales',ceiling:'prepare',responsibility:'Café prospects, prioritization, and outreach drafts.'},
  {id:'barista-acquisition',name:'Barista Acquisition',ceiling:'prepare',responsibility:'Barista acquisition sources, cohorts, and signup messaging.'},
  {id:'marketplace',name:'Marketplace Health',ceiling:'recommend',responsibility:'Marketplace supply, demand, liquidity, and funnel health.'},
  {id:'product',name:'Product & UX',ceiling:'recommend',responsibility:'Product friction analysis and UX proposals.'},
  {id:'seo',name:'SEO & Web Discovery',ceiling:'prepare',responsibility:'Indexing, sitemap, schema, and technical SEO.'},
  {id:'matching',name:'Matching & Recommendations',ceiling:'recommend',responsibility:'Job/profile relevance recommendations without hiring decisions.'},
  {id:'communications',name:'Notifications & Communications',ceiling:'prepare',responsibility:'Transactional messaging and notification policy.'},
  {id:'billing',name:'Billing & Subscriptions',ceiling:'prepare',responsibility:'Billing health and subscription issue analysis.'},
  {id:'finance',name:'Finance & Business Ops',ceiling:'recommend',responsibility:'Revenue, costs, and operating metrics.'},
  {id:'trust-safety',name:'Trust & Safety / Integrity',ceiling:'prepare',responsibility:'Abuse, scams, fake jobs/profiles, and fraud patterns.'},
  {id:'data',name:'Data & Database',ceiling:'prepare',responsibility:'Queries, indexes, migrations, and data quality.'},
  {id:'release',name:'Release & App Store',ceiling:'prepare',responsibility:'Builds, release readiness, and store coordination.'},
  {id:'compliance',name:'Legal / Privacy / Compliance',ceiling:'recommend',responsibility:'Policy, privacy, and compliance review.'},
  {id:'owner-intelligence',name:'Owner Intelligence',ceiling:'observe',responsibility:'Cross-agent owner brief and attention queue; no execution.'}
] as const;

export const AGENTS = AGENT_REGISTRY.map(({id,name})=>[id,name] as const);

export const PROTECTED = /deploy|production|merge|refund|charge|billing|price|cancel|delete|ban|suspend|security|rls|password|credential|secret|publish|post|send|email|dm|ad spend|paid service|plan upgrade|app store|user change/i;

export const MAX_AUTOMATIC_RETRIES = 3;
export const MAX_SPECIALIST_HANDOFFS = 2;

export type ModelTier = 'routine' | 'standard' | 'escalated';

const LEVEL_RANK: Record<PermissionLevel,number> = {observe:0,recommend:1,prepare:2,execute:3};

export function getAgent(agentId:string){
  const normalized=String(agentId||'').trim().toLowerCase();
  return AGENT_REGISTRY.find(agent=>agent.id===normalized);
}

export function permissionDecision(agentId:string,requested:PermissionLevel){
  const agent=getAgent(agentId);
  if(!agent) return {allowed:false,reason:'Unknown agent. Orchestrator review required.'};
  const allowed=LEVEL_RANK[requested]<=LEVEL_RANK[agent.ceiling];
  return {
    allowed,
    agent:agent.id,
    ceiling:agent.ceiling,
    requested,
    reason:allowed ? 'Requested work is within the agent permission ceiling.' : 'Requested work exceeds the agent permission ceiling.'
  };
}

export function routeAgentFor(event:string){
  const value=String(event||'').toLowerCase();
  if(/security|credential|secret|vulnerab|suspicious login/.test(value)) return 'security';
  if(/database|query|index|migration|rls/.test(value)) return 'data';
  if(/crash|api failure|ci failure|performance|outage|bug/.test(value)) return 'engineering';
  if(/refund|subscription|payment|billing/.test(value)) return 'billing';
  if(/support|customer issue|help request/.test(value)) return 'support';
  if(/seo|indexing|sitemap|schema|search console/.test(value)) return 'seo';
  if(/café prospect|cafe prospect|sales lead/.test(value)) return 'sales';
  if(/barista acquisition|barista signup|barista prospect/.test(value)) return 'barista-acquisition';
  if(/marketplace|zero applicants|supply|demand|liquidity/.test(value)) return 'marketplace';
  if(/ux|product friction|drop-off|dropoff/.test(value)) return 'product';
  if(/notification|transactional email|push notification/.test(value)) return 'communications';
  if(/app store|testflight|release|build submission/.test(value)) return 'release';
  if(/privacy|terms|compliance|legal/.test(value)) return 'compliance';
  if(/fraud|fake job|fake profile|abuse|scam/.test(value)) return 'trust-safety';
  if(/matching|recommendation|job fit/.test(value)) return 'matching';
  if(/revenue|cost|margin|finance/.test(value)) return 'finance';
  if(/growth|activation|marketing|campaign/.test(value)) return 'marketing';
  return 'manager';
}

export function ownerApprovalFor(action:string){
  const approvalRequired = PROTECTED.test(String(action || ''));
  return {
    approvalRequired,
    reason: approvalRequired
      ? 'This action can affect production, money, users, security, external communications, releases, or paid services.'
      : 'This is an internal read/analyze/draft action.'
  };
}

export function modelTierFor(task:string):ModelTier {
  const value = String(task || '').toLowerCase();
  if (/security incident|production outage|complex migration|architecture decision|repeated failure|difficult debugging/.test(value)) return 'escalated';
  if (/support triage|growth analysis|product analysis|seo review|marketplace analysis|debug/.test(value)) return 'standard';
  return 'routine';
}

export function retryDecision(attempts:number){
  const normalized = Math.max(0, Math.floor(Number(attempts) || 0));
  return normalized >= MAX_AUTOMATIC_RETRIES
    ? {allowed:false, escalate:true, reason:'Automatic retry ceiling reached.'}
    : {allowed:true, escalate:false, reason:'Retry remains within the automatic ceiling.'};
}

export function handoffDecision(handoffs:number, activeIncident=false){
  const normalized = Math.max(0, Math.floor(Number(handoffs) || 0));
  const allowed = activeIncident || normalized < MAX_SPECIALIST_HANDOFFS;
  return {
    allowed,
    orchestratorReview: !allowed,
    reason: allowed ? 'Handoff allowed.' : 'Specialist handoff ceiling reached; Orchestrator review required.'
  };
}

export function canonicalEventKey(agentId:string, eventType:string, resourceId:string){
  return [agentId,eventType,resourceId].map(value=>String(value || '').trim().toLowerCase()).join(':');
}

export function duplicateDecision(eventKey:string, activeEventKeys:Iterable<string>){
  const normalized = String(eventKey || '').trim().toLowerCase();
  const duplicate = new Set(Array.from(activeEventKeys, key=>String(key).trim().toLowerCase())).has(normalized);
  return {
    duplicate,
    createTask: !duplicate,
    reason: duplicate ? 'An active task already owns this event key.' : 'No active duplicate found.'
  };
}

export function usageSpike(current:number, recentAverage:number, multiplier=2){
  const currentValue = Math.max(0, Number(current) || 0);
  const baseline = Math.max(0, Number(recentAverage) || 0);
  const threshold = baseline * Math.max(1, Number(multiplier) || 2);
  return {
    spike: baseline > 0 && currentValue >= threshold,
    current: currentValue,
    recentAverage: baseline,
    threshold
  };
}

export function teamSnapshot(){
  return AGENT_REGISTRY.map(agent=>({
    id:agent.id,
    name:agent.name,
    status:'ready',
    permissionCeiling:agent.ceiling,
    responsibility:agent.responsibility,
    mode:agent.id==='manager'?'coordinate_prioritize_escalate':'analyze_draft_recommend'
  }));
}

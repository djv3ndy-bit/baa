export const AGENTS = [
  ['manager','Operations Manager'],
  ['engineering','Engineering & Reliability'],
  ['support','Customer Support'],
  ['billing','Billing & Subscriptions'],
  ['marketing','Marketing & Growth'],
  ['social','Social Media'],
  ['sales','Café Sales'],
  ['analytics','Analytics & Product']
] as const;

export const PROTECTED = /deploy|production|merge|refund|charge|billing|price|cancel|delete|ban|suspend|security|rls|password|credential|secret|publish|post|send|email|dm|ad spend|paid service|plan upgrade|app store|user change/i;

export const MAX_AUTOMATIC_RETRIES = 3;
export const MAX_SPECIALIST_HANDOFFS = 2;

export type ModelTier = 'routine' | 'standard' | 'escalated';

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
  return AGENTS.map(([id,name])=>({
    id,
    name,
    status:'ready',
    mode:id==='manager'?'coordinate_prioritize_escalate':'analyze_draft_recommend'
  }));
}

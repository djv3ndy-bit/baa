export const AGENTS = [
  ['manager','Operations Manager'],['engineering','Engineering & Reliability'],['support','Customer Support'],['billing','Billing & Subscriptions'],['marketing','Marketing & Growth'],['social','Social Media'],['sales','Café Sales'],['analytics','Analytics & Product']
] as const;

export const PROTECTED = /deploy|production|merge|refund|charge|billing|price|cancel|delete|ban|suspend|security|rls|password|publish|post|send|email|dm|ad spend|user change/i;

export function ownerApprovalFor(action:string){
  const approvalRequired = PROTECTED.test(String(action || ''));
  return { approvalRequired, reason: approvalRequired ? 'This action can affect production, money, users, security, or external communications.' : 'This is an internal read/analyze/draft action.' };
}

export function teamSnapshot(){
  return AGENTS.map(([id,name])=>({id,name,status:'ready',mode:id==='manager'?'coordinate_prioritize_escalate':'analyze_draft_recommend'}));
}

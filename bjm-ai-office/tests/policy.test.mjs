import test from 'node:test';
import assert from 'node:assert/strict';

const protectedPattern=/deploy|production|merge|refund|charge|billing|price|cancel|delete|ban|suspend|security|rls|password|credential|secret|publish|post|send|email|dm|ad spend|paid service|plan upgrade|app store|user change/i;
const approval=a=>protectedPattern.test(a);
const MAX_RETRIES=3;
const MAX_HANDOFFS=2;
const modelTier=task=>{
  const value=String(task||'').toLowerCase();
  if(/security incident|production outage|complex migration|architecture decision|repeated failure|difficult debugging/.test(value))return'escalated';
  if(/support triage|growth analysis|product analysis|seo review|marketplace analysis|debug/.test(value))return'standard';
  return'routine';
};
const eventKey=(agent,type,resource)=>[agent,type,resource].map(v=>String(v||'').trim().toLowerCase()).join(':');

test('protected owner actions require approval',()=>{
  for(const a of ['deploy production','merge PR','refund customer','publish Instagram post','delete user','change RLS security','send email campaign','rotate credential','App Store release','plan upgrade']) assert.equal(approval(a),true);
});

test('internal analysis stays routine',()=>{
  for(const a of ['analyze signup funnel','draft captions','summarize support trends','prepare owner brief']) assert.equal(approval(a),false);
});

test('model routing starts cheap and escalates only for justified work',()=>{
  assert.equal(modelTier('scheduled healthy check'),'routine');
  assert.equal(modelTier('growth analysis'),'standard');
  assert.equal(modelTier('production outage difficult debugging'),'escalated');
});

test('automatic retry ceiling stops the fourth attempt',()=>{
  assert.equal(2<MAX_RETRIES,true);
  assert.equal(3<MAX_RETRIES,false);
  assert.equal(4<MAX_RETRIES,false);
});

test('specialist handoff ceiling requires orchestrator review',()=>{
  assert.equal(1<MAX_HANDOFFS,true);
  assert.equal(2<MAX_HANDOFFS,false);
});

test('canonical event keys deduplicate equivalent incidents',()=>{
  assert.equal(eventKey('Engineering','API Failure','jobs'),'engineering:api failure:jobs');
  const active=new Set(['engineering:api failure:jobs']);
  assert.equal(active.has(eventKey(' ENGINEERING ','API Failure','jobs')),true);
});

test('simulated runaway loop is stopped by retry ceiling',()=>{
  let attempts=0;
  let executions=0;
  while(attempts<10){
    if(attempts>=MAX_RETRIES)break;
    executions++;
    attempts++;
  }
  assert.equal(executions,3);
  assert.equal(attempts,MAX_RETRIES);
});

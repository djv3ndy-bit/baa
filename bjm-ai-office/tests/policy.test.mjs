import test from'node:test';import assert from'node:assert/strict';
const protectedPattern=/deploy|production|merge|refund|charge|billing|price|cancel|delete|ban|suspend|security|rls|password|publish|post|send|email|dm|ad spend|user change/i;
const approval=a=>protectedPattern.test(a);
test('protected owner actions require approval',()=>{for(const a of ['deploy production','merge PR','refund customer','publish Instagram post','delete user','change RLS security','send email campaign'])assert.equal(approval(a),true)});
test('internal analysis stays routine',()=>{for(const a of ['analyze signup funnel','draft captions','summarize support trends','prepare owner brief'])assert.equal(approval(a),false)});

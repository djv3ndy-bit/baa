import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('let messageRealtimeChannel=null;'), html.indexOf('function accountSettingsHtml(){'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no; }); return {promise, resolve, reject}; };
const session = {data:{session:{access_token:'local-test-token',user:{id:'sender'}}}};
const message = (id, body=id) => ({id,body,sender_id:'sender',created_at:'2026-09-07T12:00:00Z'});

function harness() {
  const nodes={},calls={fetch:[],inserts:[],reads:[],rpc:[],push:[],channels:[],removed:[]};
  function stream() {
    let markup='';
    return {dataset:{},scrollHeight:100,scrollTop:0,appends:[],
      get innerHTML(){return markup}, set innerHTML(value){markup=value;this.appends=[]},
      querySelectorAll(){return [...markup.matchAll(/data-message-id="([^"]+)"/g)].map(match=>({dataset:{messageId:match[1]}}))},
      querySelector(selector){if(selector==='[data-message-id]')return this.querySelectorAll()[0]||null;if(selector==='.message-empty')return markup.includes('message-empty')?{}:null;if(selector==='[data-retry-messages]')return markup.includes('data-retry-messages')?(this.retry||={onclick:null}):null;return null},
      insertAdjacentHTML(position,value){markup+=value;this.appends.push(value)}
    };
  }
  function mount(kind,id,body='') {
    const button={disabled:false},textarea={value:body,style:{},focus(){this.focused=true},addEventListener(event,fn){this[event]=fn}},form={id:kind==='discovery'?'discovery-chat-compose':'chat-compose',dataset:{conversationId:id},querySelector(selector){return selector==='textarea'||selector==='[name="body"]'?textarea:button}};
    delete nodes['chat-compose'];delete nodes['discovery-chat-compose'];nodes[form.id]=form;nodes['chat-stream']=stream();nodes['chat-status']={textContent:''};
    context.activeMessageApplicationId=kind==='application'?id:null;context.activeDiscoveryMatchId=kind==='discovery'?id:null;
    return {form,button,textarea,stream:nodes['chat-stream'],status:nodes['chat-status'],event:{preventDefault(){},currentTarget:form}};
  }
  const panel={closest(){return {classList:{add(){},remove(){}}}},querySelector(){return {addEventListener(){}}},scrollIntoView(){},set innerHTML(value){const kind=value.includes('id="discovery-chat-compose"')?'discovery':'application';mount(kind,kind==='discovery'?context.activeDiscoveryMatchId:context.activeMessageApplicationId)}};
  nodes['chat-panel']=panel;
  const context={console:{warn(){}},currentUser:{id:'sender'},currentRole:'cafe_owner_manager',currentSection:'Messages',activeMessageApplicationId:null,activeDiscoveryMatchId:null,notificationRows:[],innerWidth:1024,
    escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    document:{getElementById:id=>nodes[id]||null,querySelectorAll:()=>[]},refreshNotifications:async()=>{},
    sendPhoneNotificationEvent:payload=>calls.push.push(payload),
    fetch:async(url,options)=>{calls.fetch.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({message:message('sent')})}},
    activeClient:{auth:{getSession:async()=>session},from(table){return {select(){return this},eq(column,id){this.column=column;this.id=id;return this},order(){calls.reads.push({table,id:this.id});return Promise.resolve({data:[]})},insert(payload){calls.inserts.push({table,payload});return this},single:async()=>({data:message('sent')})}},rpc:async(name,args)=>{calls.rpc.push({name,args});return {}},removeChannel:channel=>calls.removed.push(channel),channel(name){const channel={name,on(event,filter,callback){this.callback=callback;return this},subscribe(){return this}};calls.channels.push(channel);return channel}}
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {context,calls,nodes,mount,run:code=>vm.runInContext(code,context)};
}

test('application send preserves its recipient while session refresh and conversation selection overlap',async()=>{
  const h=harness(),a=h.mount('application','A','For A'),gate=deferred();h.context.activeClient.auth.getSession=()=>gate.promise;
  const pending=h.context.sendInboxMessage(a.event);const b=h.mount('application','B','Draft for B');gate.resolve(session);await pending;
  assert.equal(h.calls.fetch[0].body.application_id,'A');assert.equal(h.calls.fetch[0].body.body,'For A');assert.equal(b.textarea.value,'Draft for B');assert.equal(b.stream.appends.length,0);assert.equal(a.button.disabled,false);
});

test('discovery send preserves notification destination and never inserts into another chat',async()=>{
  const h=harness(),a=h.mount('discovery','A','For A'),gate=deferred();h.context.activeClient.from=table=>({insert(payload){h.calls.inserts.push({table,payload});return this},select(){return this},single:()=>gate.promise});
  const pending=h.context.sendDiscoveryMessage(a.event);await Promise.resolve();const b=h.mount('discovery','B','Draft for B');gate.resolve({data:message('discovery-message','For A')});await pending;
  assert.equal(h.calls.inserts[0].payload.match_id,'A');assert.equal(h.calls.push[0].match_id,'A');assert.equal(h.calls.push[0].message_id,'discovery-message');assert.equal(b.stream.appends.length,0);assert.equal(b.textarea.value,'Draft for B');
});

test('repeated submits during one send produce one request and preserve edits typed meanwhile',async()=>{
  const h=harness(),a=h.mount('application','A','First message'),gate=deferred();h.context.activeClient.auth.getSession=()=>gate.promise;
  const pending=h.context.sendInboxMessage(a.event);await h.context.sendInboxMessage(a.event);a.textarea.value='Next message';h.run("messageDrafts.set('application:A','Next message')");gate.resolve(session);await pending;
  assert.equal(h.calls.fetch.length,1);assert.equal(a.textarea.value,'Next message');assert.equal(a.button.disabled,false);
});

test('offline application sends keep the draft, show a recoverable error and allow retry',async()=>{
  const h=harness(),a=h.mount('application','A','Keep this text');h.context.fetch=async()=>{throw new TypeError('Failed to fetch')};await h.context.sendInboxMessage(a.event);
  assert.equal(a.textarea.value,'Keep this text');assert.equal(a.button.disabled,false);assert.match(a.status.textContent,/Connection lost/);
  h.context.fetch=async()=>({ok:true,json:async()=>({message:message('retry')})});await h.context.sendInboxMessage(a.event);
  assert.equal(a.textarea.value,'');assert.equal(a.status.textContent,'');assert.equal(a.stream.querySelectorAll().length,1);
});

test('failed discovery inserts do not notify, retain text and restore the send button',async()=>{
  const h=harness(),a=h.mount('discovery','A','Keep this text');h.context.activeClient.from=()=>({insert(){return this},select(){return this},single:async()=>({error:{message:'Conversation is unavailable'}})});await h.context.sendDiscoveryMessage(a.event);
  assert.equal(a.button.disabled,false);assert.equal(a.textarea.value,'Keep this text');assert.match(a.status.textContent,/unavailable/);assert.equal(h.calls.push.length,0);
});

test('session expiration and account switches stop sending before a write',async()=>{
  for(const sessionResult of [{data:{session:null}},{data:{session:{access_token:'other',user:{id:'someone-else'}}}}]){
    const h=harness(),a=h.mount('application','A','Private draft');h.context.activeClient.auth.getSession=async()=>sessionResult;await h.context.sendInboxMessage(a.event);
    assert.equal(h.calls.fetch.length,0);assert.equal(a.button.disabled,false);assert.equal(a.textarea.value,'Private draft');assert.ok(a.status.textContent);
  }
});

test('older loads cannot overwrite new messages or mark the wrong conversation read',async()=>{
  const h=harness(),a=h.mount('application','A'),gate=deferred();h.context.activeClient.from=()=>({select(){return this},eq(){return this},order:()=>gate.promise});
  const pending=h.context.loadInboxMessages();const b=h.mount('discovery','B');gate.resolve({data:[message('stale-A')]});await pending;
  assert.equal(b.stream.innerHTML,'');assert.equal(h.calls.rpc.length,0);assert.equal(a.stream.innerHTML,'');
});

test('the latest load wins even when two requests for the same chat finish out of order',async()=>{
  const h=harness(),a=h.mount('application','A'),first=deferred(),second=deferred(),queue=[first,second];h.context.activeClient.from=()=>({select(){return this},eq(){return this},order:()=>queue.shift().promise});
  const one=h.context.loadInboxMessages(),two=h.context.loadInboxMessages();second.resolve({data:[message('new')]});await two;first.resolve({data:[message('old')]});await one;
  assert.match(a.stream.innerHTML,/data-message-id="new"/);assert.doesNotMatch(a.stream.innerHTML,/data-message-id="old"/);assert.equal(h.calls.rpc.length,1);
});

test('a send invalidates an older list response and identical message IDs render once',async()=>{
  const h=harness(),a=h.mount('application','A'),gate=deferred();h.context.activeClient.from=()=>({select(){return this},eq(){return this},order:()=>gate.promise});
  const pending=h.context.loadInboxMessages();h.context.appendChatMessage('application','A',message('sent'));h.context.appendChatMessage('application','A',message('sent'));gate.resolve({data:[]});await pending;
  assert.equal(a.stream.querySelectorAll().length,1);assert.match(a.stream.innerHTML,/data-message-id="sent"/);
});

test('switching chats removes the old subscription and stale events do not load the current chat',async()=>{
  const h=harness();await h.context.selectConversation('A','Alice','Role A');await h.context.selectDiscoveryConversation('B','Bob','Mutual match');const count=h.calls.reads.length;
  h.calls.channels[0].callback({new:{sender_id:'other'}});await Promise.resolve();assert.equal(h.calls.reads.length,count);assert.equal(h.calls.removed.length,1);assert.equal(h.calls.channels.at(-1).name,'discovery-messages-B');
  assert.equal(h.calls.rpc.at(-1).name,'mark_discovery_conversation_read');assert.equal(h.calls.rpc.at(-1).args.p_match_id,'B');
});

test('a failed load exposes a retry and does not mark messages read',async()=>{
  const h=harness(),a=h.mount('discovery','A');h.context.activeClient.from=()=>({select(){return this},eq(){return this},order:async()=>({error:new Error('Offline')})});await h.context.loadDiscoveryMessages();
  assert.match(a.stream.innerHTML,/Try again/);assert.equal(typeof a.stream.retry.onclick,'function');assert.equal(h.calls.rpc.length,0);
});

test('returning to a pending conversation restores its draft and sending state',async()=>{
  const h=harness(),a=h.mount('application','A','Unsent draft'),gate=deferred();h.context.activeClient.auth.getSession=()=>gate.promise;const pending=h.context.sendInboxMessage(a.event);
  await h.context.selectDiscoveryConversation('B','Bob','');await h.context.selectConversation('A','Alice','');const form=h.nodes['chat-compose'];assert.equal(form.querySelector('textarea').value,'Unsent draft');assert.equal(form.querySelector('[type="submit"]').disabled,true);gate.resolve(session);await pending;
  assert.equal(form.querySelector('textarea').value,'');assert.equal(form.querySelector('[type="submit"]').disabled,false);
});

test('discovery notification integration uses a separate receipt table and matching conversation only',()=>{
  assert.match(html,/from\('discovery_message_notifications'\)\.select\('id,discovery_match_id,created_at,read_at'\)/);
  assert.match(html,/activeDiscoveryMatchId===row\.discovery_match_id/);
  assert.match(html,/n\.discovery_match_id===match\.id/);
});

function notificationHarness(){
  const calls={queries:[],listeners:[],applicationLoads:0,discoveryLoads:0,sections:0};
  const rows={notifications:[{id:'legacy',type:'message',application_id:'A',read_at:null,created_at:'2026-09-06'}],discovery_message_notifications:[{id:'receipt',discovery_match_id:'B',read_at:null,created_at:'2026-09-07'}]};
  const channel={on(event,filter,callback){calls.listeners.push({filter,callback});return this},subscribe(){return this}};
  const context={console,currentUser:{id:'recipient'},currentSection:'Messages',currentView:{},currentRole:'barista',activeMessageApplicationId:null,activeDiscoveryMatchId:'B',notificationRealtimeChannel:null,notificationRows:[],
    document:{querySelectorAll:()=>[],visibilityState:'visible'},updateMessageUnreadBadges(){},openSection(){calls.sections++},
    loadInboxMessages(){calls.applicationLoads++},loadDiscoveryMessages(){calls.discoveryLoads++},
    activeClient:{channel:()=>channel,removeChannel(){},from(table){calls.queries.push(table);return {select(){return this},eq(){return this},order(){return this},limit:async()=>({data:rows[table]})}}}};
  vm.createContext(context);vm.runInContext(html.slice(html.indexOf('async function refreshNotifications('),html.indexOf('async function enableBrowserNotifications(')),context);
  return {context,calls,rows};
}

test('notification refresh merges application and discovery unread without replacing an open chat',async()=>{
  const h=notificationHarness();await h.context.refreshNotifications();
  assert.deepEqual(h.calls.queries,['notifications','discovery_message_notifications']);assert.equal(h.calls.sections,0);
  assert.equal(h.context.notificationRows.length,2);assert.equal(h.context.notificationRows[0].discovery_match_id,'B');assert.equal(h.context.notificationRows[0].type,'message');
});

test('discovery realtime events refresh the matching chat and acknowledgements update without reloading it',()=>{
  const h=notificationHarness();h.context.subscribeNotifications();
  const insert=h.calls.listeners.find(x=>x.filter.table==='discovery_message_notifications'&&x.filter.event==='INSERT');
  const update=h.calls.listeners.find(x=>x.filter.table==='discovery_message_notifications'&&x.filter.event==='UPDATE');
  assert.equal(insert.filter.filter,'recipient_id=eq.recipient');insert.callback({new:h.rows.discovery_message_notifications[0]});
  assert.equal(h.calls.discoveryLoads,1);assert.equal(h.calls.applicationLoads,0);
  update.callback({new:{...h.rows.discovery_message_notifications[0],read_at:'2026-09-07'}});
  assert.equal(h.calls.discoveryLoads,1);assert.equal(h.context.notificationRows.length,1);assert.equal(h.context.notificationRows[0].read_at,'2026-09-07');
});

test('legacy modal sends also capture the original recipient before awaiting the session',async()=>{
  const h=harness(),a=h.mount('application','A','Modal message'),gate=deferred();a.form.id='message-form';h.nodes['message-form']=a.form;delete h.nodes['chat-compose'];h.nodes['message-dialog']={open:true};h.nodes['message-status']=a.status;h.context.activeClient.auth.getSession=()=>gate.promise;
  const pending=h.context.sendInboxMessage(a.event);a.form.dataset.conversationId='B';a.textarea.value='Modal B draft';h.context.activeMessageApplicationId='B';gate.resolve(session);await pending;
  assert.equal(h.calls.fetch[0].body.application_id,'A');assert.equal(a.textarea.value,'Modal B draft');assert.equal(a.button.disabled,false);
});

test('unread badges distinguish discovery matches from application conversations',()=>{
  const h=harness(),row=dataset=>({dataset,badge:'',querySelector(){return {remove:()=>{this.badge=''}}},insertAdjacentHTML(position,value){this.badge=value}}),app=row({conversationApp:'A'}),discovery=row({conversationMatch:'B'});
  h.context.document.querySelectorAll=()=>[app,discovery];h.context.notificationRows=[{type:'message',application_id:'A',read_at:null},{type:'message',discovery_match_id:'B',read_at:null},{type:'message',discovery_match_id:'B',read_at:null},{type:'message',discovery_match_id:'B',read_at:'already-read'}];h.context.updateMessageUnreadBadges();
  assert.match(app.badge,/1 unread messages/);assert.match(discovery.badge,/2 unread messages/);
});

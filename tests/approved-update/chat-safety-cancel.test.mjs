import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTypescript } from './load-typescript.mjs';

function harness() {
  let alert = null;
  const writes = [], navigation = [];
  const jsx = (type, props) => ({ type, props });
  const ui = Object.fromEntries(['ActivityIndicator','Pressable','RefreshControl','SafeAreaView','ScrollView','Text','View'].map(x => [x,x]));
  const { default: Chat } = loadTypescript('mobile/app/chat/[id].tsx', {
    react: { useRef: value => ({current:value}), useState: value => [value,()=>{}] },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { ...ui, StyleSheet:{create:x=>x}, Alert:{alert:(title,message,buttons,options)=>{alert={title,message,buttons,options};}} },
    'expo-router': {router:{back:()=>navigation.push('back'),replace:p=>navigation.push(p)},useLocalSearchParams:()=>({id:'test-conversation'})},
    '@/lib/safety': {blockUser:async id=>writes.push(['block',id]),reportUser:async data=>writes.push(['report',data])},
    '@/lib/useConversation': {useConversation:()=>({loading:false,refreshing:false,ready:true,messages:[],body:'Unsent draft',setBody:()=>{},me:'test-cafe',otherUserId:'test-barista',name:'Test Barista',sending:false,error:null,send:()=>{},retry:()=>{}})},
    '@/components/ConversationKeyboardView':{ConversationKeyboardView:'KeyboardView',ConversationTextInput:'Input'},
  });
  const root=Chat();
  function find(node,label){if(!node)return null;if(Array.isArray(node)){for(const child of node){const result=find(child,label);if(result)return result;}return null;}if(node.props?.accessibilityLabel===label)return node;return find(node.props?.children,label);}
  function choose(text){assert.ok(alert);const button=alert.buttons.find(b=>b.text===text);assert.ok(button);alert=null;return button.onPress?.();}
  return {
    open:()=>find(root,'Conversation safety options').props.onPress(),choose,
    get alert(){return alert;},writes,navigation,
    back(){if(alert?.options?.cancelable){const dismissed=alert;alert=null;dismissed.options.onDismiss?.();}},
    draft:()=>find(root,'Message').props.value,
  };
}
for(const dialog of ['menu','report','block']){
 test(`Android Back safely dismisses ${dialog} without a report, block or navigation`,()=>{
   const h=harness();h.open();
   if(dialog==='report')h.choose('Report conversation');
   if(dialog==='block')h.choose('Block account');
   assert.ok(h.alert);h.back();assert.equal(h.alert,null,'Android dialog must permit system Back');
   assert.deepEqual(h.writes,[]);assert.deepEqual(h.navigation,[]);assert.equal(h.draft(),'Unsent draft');
 });
}
test('explicit report selection still submits only the chosen report',async()=>{
 const h=harness();h.open();h.choose('Report conversation');await h.choose('Spam or scam');
 assert.equal(h.writes.length,1);assert.equal(h.writes[0][0],'report');assert.equal(h.writes[0][1].reason,'spam_or_scam');assert.equal(h.alert.title,'Report received');
});
test('explicit Block still requires confirmation and returns to Messages',async()=>{
 const h=harness();h.open();h.choose('Block account');assert.equal(h.writes.length,0);await h.choose('Block');
 assert.deepEqual(h.writes,[['block','test-barista']]);assert.equal(h.alert.title,'Account blocked');h.choose('OK');assert.deepEqual(h.navigation,['/messages']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './load-typescript.mjs';
const jsx=(type,props)=>({type,props});
function render(fontScale,active='home',role='cafe_owner_manager') {
  const destinations=[],offsets=[];
  const {ApprovedBottomNav}=loadTypescript('mobile/features/approved-dashboard/ApprovedBottomNav.tsx',{
    react:{useRef:()=>({current:{scrollTo:position=>offsets.push(position)}})},
    'react/jsx-runtime':{jsx,jsxs:jsx},
    'react-native':{Pressable:'tab',ScrollView:'scroll',Text:'text',View:'view',StyleSheet:{create:value=>value},useWindowDimensions:()=>({fontScale,width:375})},
    'expo-router':{usePathname:()=>'/'+active,router:{replace:path=>destinations.push(path)}},
    './DashboardPrimitives':{Icon:'icon'},
    './model':{countLabel:String},
    './theme':{dashboardTheme:{}},
    './useUnreadCount':{useUnreadCount:value=>value},
  });
  return {tree:ApprovedBottomNav({active,role,unread:12345}),destinations,offsets};
}
test('maximum accessibility text retains all five readable tabs in a single scrolling row',()=>{
 const {tree,destinations}=render(3.57);
 assert.equal(tree.type,'scroll');assert.equal(tree.props.horizontal,true);
 assert.equal(tree.props.style.flexGrow,0);
 const tabs=tree.props.children;
 assert.equal(tabs.length,5);
 assert.deepEqual(Array.from(tabs,t=>t.props.accessibilityLabel),['Home','Jobs','Matches','Messages, 12345 unread messages','Profile']);
 for(const tab of tabs){
  tab.props.onPress();
  const label=tab.props.children[1];
  assert.equal(label.props.allowFontScaling,undefined);
  assert.equal(label.props.maxFontSizeMultiplier,undefined);
  assert.equal(label.props.numberOfLines,undefined);
 }
 assert.deepEqual(destinations,['/jobs','/matches','/messages','/profile']);
});
test('the active tab is brought into view at maximum text size',()=>{
 const {tree,offsets}=render(3.57,'profile','barista');
 const profile=tree.props.children[4];
 assert.equal(profile.props.accessibilityState.selected,true);
 profile.props.onLayout({nativeEvent:{layout:{x:700}}});
 assert.equal(offsets.length,1);assert.equal(offsets[0].x,692);assert.equal(offsets[0].animated,false);
});
test('standard and moderate text sizes keep the existing five-tab layout and role routing',()=>{
 for(const scale of [1,2]){
  const {tree,destinations}=render(scale,'home','barista');
  assert.equal(tree.type,'view');
  tree.props.children[1].props.onPress();
  assert.deepEqual(destinations,['/discover']);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './load-typescript.mjs';
const jsx=(type,props)=>({type,props});
const {Action}=loadTypescript('mobile/features/approved-dashboard/DashboardPrimitives.tsx',{
  react:{useState:value=>[value,()=>{}]},
  'react/jsx-runtime':{jsx,jsxs:jsx},
  'react-native':{Pressable:'button',Text:'text',View:'view',Image:'image',StyleSheet:{create:value=>value}},
  '@expo/vector-icons/Ionicons':{default:'icon'},
  './theme':{dashboardTheme:{}},
});
test('native action exposes its wording without decorative icon glyphs in the spoken label',()=>{
  for(const [label,icon] of [['Post a job','add'],['Find barista jobs','search-outline'],['Restore purchases',undefined]]){
    let calls=0;
    const button=Action({label,icon,onPress:()=>calls++});
    assert.equal(button.props.accessibilityRole,'button');
    assert.equal(button.props.accessibilityLabel,label);
    button.props.onPress();
    assert.equal(calls,1);
  }
});

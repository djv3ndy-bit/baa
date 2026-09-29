import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('compiled IPA gate rejects remote loaders and missing embedded code', () => {
  const result = execFileSync('python3', ['-c', `
import importlib.util, pathlib, plistlib, tempfile, zipfile
script=pathlib.Path('mobile/scripts/verify-ios-bundled-code.py')
spec=importlib.util.spec_from_file_location('audit',script); audit=importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
info={'CFBundleIdentifier':'com.baristajobmatch.app','CFBundleExecutable':'BaristaMatch','CFBundleShortVersionString':'1.0.5','CFBundleVersion':'25'}
root='Payload/BaristaMatch.app/'
policy=b'BJM_RELEASE_BUNDLED_CODE_ONLY'
cases=[({},policy,True,None,True),({'EXUpdatesEnabled':False},policy,True,None,True),({'EXUpdatesEnabled':True},b'',True,None,False),({'EXUpdatesURL':'https://example.invalid'},b'',True,None,False),({'EXUpdatesRuntimeVersion':'1.0.5'},b'',True,None,False),({},b'EXUpdatesAppController',True,None,False),({},b'EXDevLauncher',True,None,False),({},b'',False,None,False),({},b'',True,'EXUpdates.bundle/Info.plist',False),({},b'no guard',True,None,False)]
with tempfile.TemporaryDirectory() as tmp:
 for i,(expo,binary,bundle,extra,expected) in enumerate(cases):
  p=pathlib.Path(tmp)/f'{i}.ipa'
  with zipfile.ZipFile(p,'w') as z:
   z.writestr(root+'Info.plist',plistlib.dumps(info));z.writestr(root+'Expo.plist',plistlib.dumps(expo));z.writestr(root+'BaristaMatch',binary)
   if bundle:z.writestr(root+'main.jsbundle',b'embedded code')
   if extra:z.writestr(root+extra,b'')
  assert audit.inspect_ipa(p)['passed']==expected, i
 for marker in [b'EXUpdatesModule',b'_UIButtonBarButton',b'_UINavigationBarContentView',b'UIKit.NavigationBarContentView',b'X-Metro-Files-Changed-Count']:
  p=pathlib.Path(tmp)/'embedded-framework.ipa'
  with zipfile.ZipFile(p,'w') as z:
   z.writestr(root+'Info.plist',plistlib.dumps(info));z.writestr(root+'BaristaMatch',policy)
   z.writestr(root+'main.jsbundle',b'embedded code')
   z.writestr(root+'Frameworks/ThirdParty.framework/ThirdParty',bytes.fromhex('cffaedfe')+marker)
  report=audit.inspect_ipa(p)
  assert not report['passed'] and len(report['executablesScanned'])==2,marker
print('15 artifact cases passed')
`], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.match(result, /15 artifact cases passed/);
});

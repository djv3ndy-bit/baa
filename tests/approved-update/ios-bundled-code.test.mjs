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
cases=[({},b'embedded native code',True,None,True),({'EXUpdatesEnabled':False},b'embedded native code',True,None,True),({'EXUpdatesEnabled':True},b'',True,None,False),({'EXUpdatesURL':'https://example.invalid'},b'',True,None,False),({'EXUpdatesRuntimeVersion':'1.0.5'},b'',True,None,False),({},b'EXUpdatesAppController',True,None,False),({},b'EXDevLauncher',True,None,False),({},b'',False,None,False),({},b'',True,'EXUpdates.bundle/Info.plist',False)]
with tempfile.TemporaryDirectory() as tmp:
 for i,(expo,binary,bundle,extra,expected) in enumerate(cases):
  p=pathlib.Path(tmp)/f'{i}.ipa'
  with zipfile.ZipFile(p,'w') as z:
   z.writestr(root+'Info.plist',plistlib.dumps(info));z.writestr(root+'Expo.plist',plistlib.dumps(expo));z.writestr(root+'BaristaMatch',binary)
   if bundle:z.writestr(root+'main.jsbundle',b'embedded code')
   if extra:z.writestr(root+extra,b'')
  assert audit.inspect_ipa(p)['passed']==expected, i
print('9 artifact cases passed')
`], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' });
  assert.match(result, /9 artifact cases passed/);
});

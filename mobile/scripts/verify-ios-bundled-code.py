"""Inspect an exported IPA before upload. This is a packaging gate, not App Review approval."""
import argparse
import hashlib
import json
import plistlib
import sys
import zipfile


def inspect_ipa(path):
    failures = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        roots = [n for n in names if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
        if len(roots) != 1:
            raise ValueError('Expected one top-level iOS app.')
        root = roots[0].rsplit('/', 1)[0] + '/'
        info = plistlib.loads(archive.read(roots[0]))
        expo = plistlib.loads(archive.read(root + 'Expo.plist')) if root + 'Expo.plist' in names else {}
        if expo.get('EXUpdatesEnabled') is True:
            failures.append('Remote updates are enabled in the compiled app.')
        if expo.get('EXUpdatesURL') or expo.get('EXUpdatesRuntimeVersion'):
            failures.append('The compiled app retains a remote-update URL/runtime mapping.')
        forbidden = ('EXUpdates.bundle/', 'EXDevLauncher.bundle/', 'EXDevMenu.bundle/', 'CodePush.framework/')
        if any(any(marker in n for marker in forbidden) for n in names):
            failures.append('The archive contains an update engine or development launcher resource.')
        binary = archive.read(root + info['CFBundleExecutable'])
        markers = ('EXUpdatesAppController', 'EXUpdatesModule', 'ExpoUpdatesReactDelegateHandler', 'EXDevLauncher', 'CodePushPackage')
        hits = [marker for marker in markers if marker.encode() in binary]
        if hits:
            failures.append('The app executable contains forbidden module markers: ' + ', '.join(hits))
        if root + 'main.jsbundle' not in names or archive.getinfo(root + 'main.jsbundle').file_size == 0:
            failures.append('A nonempty embedded JavaScript bundle is required.')
        if info.get('CFBundleIdentifier') != 'com.baristajobmatch.app':
            failures.append('Unexpected app identifier.')
    with open(path, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    return {'passed': not failures, 'failures': failures, 'appVersion': info.get('CFBundleShortVersionString'),
            'build': info.get('CFBundleVersion'), 'sha256': digest,
            'scope': 'Compiled packaging/configuration only; native journeys and Apple review remain separate.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa')
    args = parser.parse_args()
    try:
        report = inspect_ipa(args.ipa)
        print(json.dumps(report, indent=2))
        sys.exit(0 if report['passed'] else 1)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, plistlib.InvalidFileException) as error:
        print(json.dumps({'passed': False, 'error': str(error)}))
        sys.exit(1)

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
        # Inspect every Mach-O, including embedded frameworks. A clean app
        # executable alone does not establish that its libraries are clean.
        executable = root + info['CFBundleExecutable']
        magic = (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xcf',
                 b'\xfe\xed\xfa\xce', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf', b'\xbe\xba\xfe\xca')
        markers = ('EXUpdatesAppController', 'EXUpdatesModule', 'ExpoUpdatesReactDelegateHandler',
                   'EXDevLauncher', 'CodePushPackage', '_UIButtonBarButton',
                   '_UINavigationBarContentView', 'UIKit.NavigationBarContentView',
                   "Expected MIME-Type to be 'application/javascript' or 'text/javascript'",
                   'X-Metro-Files-Changed-Count')
        scanned = []
        has_policy = False
        for name in names:
            if not name.startswith(root) or name.endswith('/'):
                continue
            with archive.open(name) as stream:
                prefix = stream.read(4)
            if name != executable and prefix not in magic:
                continue
            binary = archive.read(name)
            scanned.append(name[len(root):])
            has_policy |= b'BJM_RELEASE_BUNDLED_CODE_ONLY' in binary
            hits = [marker for marker in markers if marker.encode() in binary]
            if hits:
                failures.append(name[len(root):] + ' retains disallowed loader/private-UI code: ' + ', '.join(hits))
        if not has_policy:
            failures.append('The compiled installed-bundle code policy is missing.')
        if root + 'main.jsbundle' not in names or archive.getinfo(root + 'main.jsbundle').file_size == 0:
            failures.append('A nonempty embedded JavaScript bundle is required.')
        if info.get('CFBundleIdentifier') != 'com.baristajobmatch.app':
            failures.append('Unexpected app identifier.')
    with open(path, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    return {'passed': not failures, 'failures': failures, 'appVersion': info.get('CFBundleShortVersionString'),
            'build': info.get('CFBundleVersion'), 'sha256': digest, 'executablesScanned': scanned,
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

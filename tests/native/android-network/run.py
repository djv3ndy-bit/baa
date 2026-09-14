"""Run public-only TLS checks inside the debug app on an isolated Android emulator."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--app-apk', required=True, type=Path)
parser.add_argument('--debug-keystore', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--build-tools', default='36.0.0')
parser.add_argument('--compile-api', default='36')
args = parser.parse_args()
if not args.device.startswith('emulator-'):
    parser.error('Use a dedicated Android emulator, never a real customer device.')
sdk = Path(os.environ['ANDROID_HOME'])
jdk = Path(os.environ['JAVA_HOME'])
tools = sdk / 'build-tools' / args.build_tools
android = sdk / 'platforms' / ('android-' + args.compile_api) / 'android.jar'
source = Path(__file__).resolve().parent
adb = [str(sdk / 'platform-tools/adb'), '-s', args.device]

def run(command, **kwargs):
    return subprocess.run(list(map(str, command)), check=True, **kwargs)

badging = run([tools / 'aapt', 'dump', 'badging', args.app_apk], capture_output=True, text=True).stdout
if "package: name='com.baristajobmatch.app'" not in badging or 'application-debuggable' not in badging:
    parser.error('A BaristaMatch debug APK connected only to isolated test data is required.')
with tempfile.TemporaryDirectory(prefix='baristamatch-tls-') as directory:
    work = Path(directory)
    classes = work / 'classes'
    dex = work / 'dex'
    classes.mkdir()
    dex.mkdir()
    run([jdk / 'bin/javac', '-source', '8', '-target', '8', '-bootclasspath', android,
         '-d', classes, source / 'TlsChecks.java'])
    run([tools / 'd8', '--min-api', '24', '--lib', android, '--output', dex,
         *classes.rglob('*.class')])
    unsigned = work / 'checks-unsigned.apk'
    aligned = work / 'checks-aligned.apk'
    signed = work / 'checks.apk'
    run([tools / 'aapt', 'package', '-f', '-M', source / 'AndroidManifest.xml',
         '-I', android, '-F', unsigned])
    with zipfile.ZipFile(unsigned, 'a') as archive:
        archive.write(dex / 'classes.dex', 'classes.dex')
    run([tools / 'zipalign', '-f', '4', unsigned, aligned])
    # Standard disposable Android debug credential, never a distribution signing key.
    run([tools / 'apksigner', 'sign', '--ks', args.debug_keystore,
         '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android',
         '--key-pass', 'pass:android', '--out', signed, aligned])
    run([*adb, 'install', '-r', args.app_apk])
    run([*adb, 'install', '-r', signed])
    result = run([*adb, 'shell', 'am', 'instrument', '-w',
                  'com.baristajobmatch.tlschecks/com.baristajobmatch.tlschecks.TlsChecks'],
                 capture_output=True, text=True, timeout=120)
    output = result.stdout + result.stderr
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output)
    print(output)
    if 'failures=0' not in output or 'OS selects intended trust configuration' not in output:
        raise SystemExit('Native TLS regression failed; inspect the preserved output.')

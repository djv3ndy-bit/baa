import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../mobile/scripts/verify-android-bundle.py', import.meta.url));
const android = 'http://schemas.android.com/apk/res/android';
const packageName = 'com.baristajobmatch.app';
const zipBuilder = `
import base64, json, struct, sys, zipfile
request = json.load(sys.stdin)
with zipfile.ZipFile(request['path'], 'w') as archive:
    for entry in request['entries']:
        info = zipfile.ZipInfo(entry['name'])
        info.compress_type = zipfile.ZIP_DEFLATED if entry.get('compressed') else zipfile.ZIP_STORED
        alignment = entry.get('alignment')
        if alignment:
            offset = archive.fp.tell() + 30 + len(info.filename.encode('utf-8'))
            padding = (-offset) % alignment
            if padding:
                if padding < 4:
                    padding += alignment
                info.extra = struct.pack('<HH', 0xffff, padding - 4) + bytes(padding - 4)
        archive.writestr(info, base64.b64decode(entry['data']))
        if entry.get('localExtraOnly'):
            info.extra = b''
`;

function vi(input) {
  let value = BigInt(input);
  const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
const number = (field, value) => Buffer.concat([vi(field * 8), vi(value)]);
const bytes = (field, value) => {
  const encoded = Buffer.from(value);
  return Buffer.concat([vi(field * 8 + 2), vi(encoded.length), encoded]);
};
const pb = (...parts) => Buffer.concat(parts);
function attr(name, value, ns = android, compiled = false) {
  const encoded = compiled
    ? bytes(6, bytes(7, number(typeof value === 'boolean' ? 8 : 6, Number(value))))
    : bytes(3, String(value));
  return bytes(4, pb(bytes(1, ns), bytes(2, name), encoded));
}
const element = (name, attrs = [], children = []) => bytes(1,
  pb(bytes(3, name), ...attrs, ...children.map(child => bytes(5, child))));
function manifest(pkg = packageName) {
  return element('manifest', [attr('package', pkg, ''), attr('versionCode', 14, android, true), attr('versionName', '1.0.4')], [
    element('uses-sdk', [attr('minSdkVersion', 24, android, true), attr('targetSdkVersion', 36, android, true)]),
    element('uses-permission', [attr('name', 'android.permission.INTERNET')]),
    element('application', [attr('extractNativeLibs', false, android, true)]),
  ]);
}
const config = (alignment = 2, enabled = true) => pb(bytes(1, bytes(2, '1.18.2')),
  bytes(2, bytes(2, pb(number(1, Number(enabled)), number(2, alignment)))));

function elf({ bits = 64, machine = bits === 64 ? 183 : 40, alignments = [16384], endian = 'LE', mutate } = {}) {
  const buffer = Buffer.alloc(1024);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, bits === 64 ? 2 : 1, endian === 'LE' ? 1 : 2, 1]);
  const u16 = (offset, value) => buffer[`writeUInt16${endian}`](value, offset);
  const u32 = (offset, value) => buffer[`writeUInt32${endian}`](value, offset);
  const u64 = (offset, value) => buffer[`writeBigUInt64${endian}`](BigInt(value), offset);
  const header = bits === 64 ? 64 : 52;
  const entry = bits === 64 ? 56 : 32;
  u16(16, 3); u16(18, machine); u32(20, 1);
  if (bits === 64) { u64(32, header); u16(52, header); u16(54, entry); u16(56, alignments.length); }
  else { u32(28, header); u16(40, header); u16(42, entry); u16(44, alignments.length); }
  alignments.forEach((alignment, index) => {
    const start = header + index * entry;
    u32(start, 1);
    if (bits === 64) {
      u32(start + 4, 5); u64(start + 8, 0); u64(start + 16, 0);
      u64(start + 32, 1024); u64(start + 40, 1024); u64(start + 48, alignment);
    } else {
      u32(start + 4, 0); u32(start + 8, 0); u32(start + 16, 1024);
      u32(start + 20, 1024); u32(start + 24, 5); u32(start + 28, alignment);
    }
  });
  mutate?.(buffer);
  return buffer;
}

const entry = (name, data, extra = {}) => ({ name, data: Buffer.from(data).toString('base64'), ...extra });
const lib = (options = {}, extra = {}) => entry('base/lib/arm64-v8a/libapp.so', elf(options), extra);
const bundle = (libraries = [lib()], options = {}) => [
  entry('BundleConfig.pb', options.config ?? config(), { compressed: true }),
  entry('base/manifest/AndroidManifest.xml', options.manifest ?? manifest(), { compressed: true }),
  ...libraries,
];
const apk = (libraries, extra = {}) => [
  entry('AndroidManifest.xml', '<manifest package="com.baristajobmatch.app"/>', { compressed: true }),
  ...libraries.map(item => ({ ...item, name: item.name.replace(/^base\//, '') })),
  ...(extra.entries ?? []),
];

function audit(entries, args = [], raw) {
  const directory = mkdtempSync(join(tmpdir(), 'bjm-bundle-'));
  const path = join(directory, 'build.zip');
  try {
    if (raw) writeFileSync(path, raw);
    else {
      const build = spawnSync('python3', ['-c', zipBuilder], {
        input: JSON.stringify({ path, entries }), encoding: 'utf8', timeout: 5000,
      });
      assert.equal(build.status, 0, build.stderr);
    }
    const run = spawnSync('python3', [script, path, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.signal, null, run.error?.message);
    assert.equal(run.stderr, '', run.stderr);
    return { code: run.status, report: JSON.parse(run.stdout) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('AAB reads actual protobuf package metadata and all 64-bit LOAD headers', () => {
  const { code, report } = audit(bundle([
    lib({ alignments: [16384, 65536] }),
    entry('feature/lib/x86_64/libfeature.so', elf({ machine: 62 })),
  ]), ['--expect-package', packageName]);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.format, 'aab');
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.native_64bit_count, 2);
  assert.equal(report.elf_16kb_load_alignment, 'passed');
  assert.deepEqual(report.package_info, {
    status: 'read', encoding: 'aapt2_protobuf', package: packageName,
    version_code: 14, version_name: '1.0.4', minimum_sdk: 24, target_sdk: 36,
    extract_native_libs: false, permissions: ['android.permission.INTERNET'],
  });
  assert.equal(report.packaging.status, 'requested_16kb_or_greater');
  assert.equal(report.packaging.bundletool_version, '1.18.2');
  assert.equal(report.verification.apk_zip_alignment_checked, false);
  assert.equal(report.verification.signature_verified, false);
  assert.equal(report.verification.runtime_16kb_tested, false);
  assert.equal(report.verification.installed, false);
  assert.equal(report.verification.physical_device_tested, false);
  assert.ok(report.limitations.some(text => text.includes('generated APKs')));
});

test('rejects one underaligned LOAD even if another LOAD is aligned', () => {
  const { code, report } = audit(bundle([lib({ alignments: [16384, 4096] })]));
  assert.equal(code, 1);
  assert.equal(report.elf_16kb_load_alignment, 'failed');
  assert.match(report.errors.join(' '), /below 16 KB/);
});

test('inventories little and big endian ARM32 without imposing a 16 KB requirement', () => {
  const { code, report } = audit(bundle([
    lib(), entry('base/lib/armeabi-v7a/lib32.so', elf({ bits: 32, alignments: [4096] })),
    entry('base/lib/armeabi/lib32be.so', elf({ bits: 32, alignments: [4096], endian: 'BE' })),
  ]));
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.native_32bit_count, 2);
  assert.equal(report.native_libraries[1].load_alignment, 'not_required_32bit');
  assert.equal(report.native_libraries[2].byte_order, 'big');
});

test('unknown ABI ELF64 cannot escape alignment checks', () => {
  const { code, report } = audit(bundle([
    entry('base/assets/libother.so', elf({ machine: 243, alignments: [4096], endian: 'BE' })),
  ]));
  assert.equal(code, 1);
  assert.equal(report.native_libraries[0].requires_16kb, true);
});

for (const [name, data, message] of [
  ['non-ELF', Buffer.from('not an ELF'), /not an ELF/],
  ['ABI mismatch', elf({ bits: 32 }), /does not match/],
  ['missing LOAD', elf({ mutate: b => b.writeUInt32LE(4, 64) }), /no LOAD/],
  ['short ELF header', elf().subarray(0, 24), /Truncated ELF header/],
  ['out of bounds table', elf({ mutate: b => b.writeBigUInt64LE(4096n, 32) }), /program header table/],
  ['too large table', elf({ mutate: b => b.writeUInt16LE(65534, 56) }), /program header table/],
  ['extended count', elf({ mutate: b => b.writeUInt16LE(65535, 56) }), /extended ELF/],
  ['invalid segment extent', elf({ mutate: b => b.writeBigUInt64LE(2048n, 64 + 32) }), /invalid file\/memory/],
  ['not power of two', elf({ alignments: [20000] }), /power of two/],
  ['incongruent address', elf({ mutate: b => b.writeBigUInt64LE(1n, 64 + 16) }), /incongruent/],
]) test(`rejects ${name} without reporting binary acceptance`, () => {
  const { code, report } = audit(bundle([entry('base/lib/arm64-v8a/libapp.so', data)]));
  assert.equal(code, 1);
  assert.match(report.errors.join(' '), message);
  assert.equal(report.verification.runtime_16kb_tested, false);
});

test('AAB 4 KB packaging request fails even with aligned libraries', () => {
  const { code, report } = audit(bundle([lib()], { config: config(1) }));
  assert.equal(code, 1);
  assert.equal(report.elf_16kb_load_alignment, 'passed');
  assert.equal(report.packaging.status, 'requested_below_16kb');
});

test('AAB compressed-library request reports its limited evidence without using AAB ZIP offsets', () => {
  const { code, report } = audit(bundle([lib()], { config: config(1, false) }));
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.packaging.status, 'uncompression_disabled');
  assert.equal(report.verification.apk_zip_alignment_checked, false);
});

test('AAB omitted alignment uses bundletool documented 4 KB default; unknown enums do not pass', () => {
  const omitted = pb(bytes(2, bytes(2, number(1, 1))));
  const { code, report } = audit(bundle([lib()], { config: omitted }));
  assert.equal(code, 1);
  assert.equal(report.packaging.status, 'default_4kb');
  assert.equal(report.packaging.effective_alignment_bytes, 4096);
  assert.equal(audit(bundle([lib()], { config: config(19) })).code, 1);
});

test('no native libraries does not manufacture a native compatibility claim', () => {
  const { code, report } = audit(bundle([], { config: config(1) }));
  assert.equal(code, 0);
  assert.equal(report.elf_16kb_load_alignment, 'not_applicable');
  assert.equal(report.native_64bit_count, 0);
});

test('APK checks real local-header data offsets and keeps ARM32 at 4 bytes', () => {
  const { code, report } = audit(apk([
    lib({}, { alignment: 16384 }),
    entry('base/lib/armeabi-v7a/lib32.so', elf({ bits: 32, alignments: [4096] }), { alignment: 4 }),
  ], { entries: [entry('resources.arsc', 'resources', { alignment: 4 })] }));
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.verification.apk_zip_alignment_checked, true);
  assert.equal(report.packaging.status, 'passed');
  assert.equal(report.native_libraries[0].apk_data_offset % 16384, 0);
  assert.equal(report.native_libraries[1].apk_required_alignment_bytes, 4);
  assert.notEqual(report.native_libraries[1].apk_data_offset % 16384, 0);
});

test('APK with ELF-aligned but archive-unaligned stored native library fails', () => {
  const { code, report } = audit(apk([lib({}, { alignment: 4 })]));
  assert.equal(code, 1);
  assert.equal(report.elf_16kb_load_alignment, 'passed');
  assert.equal(report.packaging.misaligned_entries[0].required_alignment_bytes, 16384);
});

test('APK alignment uses local header padding even when the central-directory extra field differs', () => {
  const { code, report } = audit(apk([lib({}, { alignment: 16384, localExtraOnly: true })]));
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.native_libraries[0].apk_data_offset % 16384, 0);
});

test('compressed APK native entries have no direct-map ZIP alignment requirement', () => {
  const { code, report } = audit(apk([lib({}, { compressed: true })]));
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.packaging.stored_entries_checked, 0);
});

test('stored non-native APK entries still require four-byte alignment', () => {
  const { code, report } = audit(apk([], { entries: [entry('a', 'content')] }));
  assert.equal(code, 1);
  assert.equal(report.packaging.misaligned_entries[0].required_alignment_bytes, 4);
});

test('package expectation fails mismatched metadata', () => {
  const { code, report } = audit(bundle([], { manifest: manifest('com.other.app') }), ['--expect-package', packageName]);
  assert.equal(code, 1);
  assert.match(report.errors.join(' '), /Package/);
});

test('binary APK manifest limitation is explicit and cannot pass a package expectation', () => {
  const entries = [entry('AndroidManifest.xml', Buffer.from([3, 0, 8, 0]), { compressed: true })];
  const result = audit(entries);
  assert.equal(result.code, 0);
  assert.equal(result.report.package_info.status, 'unavailable');
  assert.equal(audit(entries, ['--expect-package', packageName]).code, 1);
});

test('malformed protobuf and unsupported archives fail with structured diagnostics', () => {
  for (const options of [{ config: Buffer.from([0x12, 0xff]) }, { manifest: Buffer.from([0x0a, 0xff]) }]) {
    const { code, report } = audit(bundle([], options));
    assert.equal(code, 1);
    assert.match(report.errors.join(' '), /protobuf/);
  }
  assert.equal(audit([], [], Buffer.from('not a zip')).code, 1);
  assert.equal(audit([entry('unrelated.txt', 'hello')]).code, 1);
});

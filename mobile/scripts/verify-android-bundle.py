#!/usr/bin/env python3
"""Read-only AAB/APK static audit, using Python 3.9+ and no Android SDK.

Usage: python3 verify-android-bundle.py app.aab [--expect-package PACKAGE]
Exit 0 means the reported static checks passed; it is NOT device acceptance.
Exit 1 means a failed check or an unreadable/unsupported archive.

Sources (schema decoding below is an independent implementation):
https://developer.android.com/guide/practices/page-sizes
https://developer.android.com/tools/zipalign
https://github.com/google/bundletool/blob/master/src/main/proto/config.proto
https://github.com/aosp-mirror/platform_frameworks_base/blob/master/tools/aapt2/Resources.proto

ELF LOAD alignment is checked for every 64-bit .so, including all arm64-v8a
and x86_64 libraries. 32-bit libraries are inventoried, without imposing the
64-bit 16 KB requirement. For an APK we also check the actual local-header
data offsets: 16 KB for stored 64-bit .so files, 4 bytes for other stored
entries. This is intentionally narrower than SDK zipalign -P 16, which also
checks 32-bit .so files. An AAB's own ZIP offsets do not prove APK alignment.
Its BundleConfig request is reported separately; generated APKs still need
checking. No archive is extracted, changed, signed, installed, or executed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

PAGE = 16384
METADATA_LIMIT = 16 * 1024 * 1024
ELF_HEADER_LIMIT = 2 * 1024 * 1024
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
ABIS = {'arm64-v8a': (64, 183), 'x86_64': (64, 62),
        'armeabi-v7a': (32, 40), 'armeabi': (32, 40), 'x86': (32, 3)}


def varint(data, position):
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(data):
            raise ValueError('Truncated protobuf varint')
        byte = data[position]
        position += 1
        if shift == 63 and byte > 1:
            raise ValueError('Overflowing protobuf varint')
        value |= (byte & 127) << shift
        if not byte & 128:
            return value, position
    raise ValueError('Invalid protobuf varint')


def fields(data):
    """Return protobuf field occurrences, retaining their wire type."""
    result = {}
    position = 0
    count = 0
    while position < len(data):
        key, position = varint(data, position)
        number, wire = key >> 3, key & 7
        if not number or number >= (1 << 29):
            raise ValueError('Invalid protobuf field number')
        if wire == 0:
            value, position = varint(data, position)
        elif wire in (1, 2, 5):
            size = {1: 8, 5: 4}.get(wire)
            if wire == 2:
                size, position = varint(data, position)
            if size > len(data) - position:
                raise ValueError('Truncated protobuf field')
            value = data[position:position + size]
            position += size
        else:
            raise ValueError('Unsupported protobuf wire type')
        result.setdefault(number, []).append((wire, value))
        count += 1
        if count > 100000:
            raise ValueError('Too many protobuf fields')
    return result


def values(message, number, wire=2):
    occurrences = message.get(number, [])
    if any(item[0] != wire for item in occurrences):
        raise ValueError('Unexpected protobuf field type')
    return [item[1] for item in occurrences]


def one(message, number, default=b'', wire=2):
    occurrences = values(message, number, wire)
    if len(occurrences) > 1:
        raise ValueError('Duplicate singular protobuf field')
    return occurrences[0] if occurrences else default


def string(message, number):
    return one(message, number).decode('utf-8')


def bundle_config(data):
    config = fields(data)
    native = fields(one(fields(one(config, 2)), 2))
    enabled = one(native, 1, 0, 0)
    alignment = one(native, 2, 0, 0)
    return {
        'bundletool_version': string(fields(one(config, 1)), 2) or None,
        'uncompress_native_libraries': bool(enabled),
        'page_alignment': {0: 'UNSPECIFIED', 1: 'PAGE_ALIGNMENT_4K',
                           2: 'PAGE_ALIGNMENT_16K', 3: 'PAGE_ALIGNMENT_64K'}.get(
                               alignment, 'UNKNOWN_' + str(alignment)),
        'requested_alignment_bytes': {1: 4096, 2: PAGE, 3: 65536}.get(alignment),
        # Bundletool's config.proto documents 4 KB as the unspecified default.
        'effective_alignment_bytes': {0: 4096, 1: 4096, 2: PAGE, 3: 65536}.get(alignment),
    }


def attribute(data):
    attr = fields(data)
    raw = string(attr, 3)
    value = raw if raw else None
    if value is None and 6 in attr:
        item = fields(one(attr, 6))
        if 2 in item or 3 in item:
            value = string(fields(one(item, 2 if 2 in item else 3)), 1)
        elif 7 in item:
            primitive = fields(one(item, 7))
            for number in (6, 7, 8):
                if number in primitive:
                    value = one(primitive, number, None, 0)
                    if number == 8:
                        value = bool(value)
                    break
    return (string(attr, 1), string(attr, 2)), value


def xml_element(data):
    node = fields(data)
    if 1 not in node:
        return None
    element = fields(one(node, 1))
    attrs = {}
    for encoded in values(element, 4):
        key, value = attribute(encoded)
        if key in attrs:
            raise ValueError('Duplicate manifest attribute')
        attrs[key] = value
    return string(element, 3), attrs, values(element, 5)


def manifest_info(data, is_bundle):
    # APK manifests normally use binary AXML; report that limitation explicitly.
    if data.lstrip().startswith(b'<'):
        if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
            raise ValueError('Manifest contains a forbidden entity declaration')
        root = ET.fromstring(data)
        if root.tag != 'manifest':
            raise ValueError('Manifest root is not manifest')
        attrs = {('', key): value for key, value in root.attrib.items() if not key.startswith('{')}
        attrs.update({(ANDROID_NS, key.split('}', 1)[1]): value for key, value in root.attrib.items()
                      if key.startswith('{' + ANDROID_NS + '}')})
        children = []
        for child in root:
            child_attrs = {(ANDROID_NS, key.split('}', 1)[1]): value
                           for key, value in child.attrib.items() if key.startswith('{' + ANDROID_NS + '}')}
            children.append((child.tag, child_attrs, []))
        encoding = 'text_xml'
    elif is_bundle:
        root = xml_element(data)
        if root is None or root[0] != 'manifest':
            raise ValueError('Protobuf manifest root is not manifest')
        _, attrs, encoded_children = root
        children = [xml_element(child) for child in encoded_children]
        encoding = 'aapt2_protobuf'
    else:
        return {'status': 'unavailable', 'reason': 'Binary APK AXML requires an external manifest decoder'}
    report = {
        'status': 'read', 'encoding': encoding, 'package': attrs.get(('', 'package')),
        'version_code': attrs.get((ANDROID_NS, 'versionCode')),
        'version_name': attrs.get((ANDROID_NS, 'versionName')),
        'minimum_sdk': None, 'target_sdk': None, 'extract_native_libs': None,
        'permissions': [],
    }
    for child in children:
        if child is None:
            continue
        name, child_attrs, _ = child
        if name == 'uses-sdk':
            report['minimum_sdk'] = child_attrs.get((ANDROID_NS, 'minSdkVersion'))
            report['target_sdk'] = child_attrs.get((ANDROID_NS, 'targetSdkVersion'))
        elif name == 'application':
            report['extract_native_libs'] = child_attrs.get((ANDROID_NS, 'extractNativeLibs'))
        elif name in ('uses-permission', 'uses-permission-sdk-23'):
            permission = child_attrs.get((ANDROID_NS, 'name'))
            if permission is not None:
                if not isinstance(permission, str):
                    raise ValueError('Manifest permission name is not a string')
                report['permissions'].append(permission)
    report['permissions'] = sorted(set(report['permissions']))
    return report


def read_metadata(archive, name):
    entry = archive.getinfo(name)
    if entry.file_size > METADATA_LIMIT:
        raise ValueError(name + ': metadata exceeds 16 MB limit')
    return archive.read(entry)


def elf_info(archive, entry):
    parts = entry.filename.split('/')
    abi = next((part for part in parts if part in ABIS), None)
    with archive.open(entry) as stream:
        header = stream.read(64)
        if len(header) < 16 or header[:4] != b'\x7fELF':
            raise ValueError('Native library is not an ELF binary')
        elf_class, data_encoding = header[4], header[5]
        if elf_class not in (1, 2) or data_encoding not in (1, 2) or header[6] != 1:
            raise ValueError('Unsupported ELF class, byte order, or version')
        bits = {1: 32, 2: 64}[elf_class]
        endian = '<' if data_encoding == 1 else '>'
        header_format = endian + ('HHIIIIIHHHHHH' if bits == 32 else 'HHIQQQIHHHHHH')
        header_size = 16 + struct.calcsize(header_format)
        if len(header) < header_size:
            raise ValueError('Truncated ELF header')
        (_, machine, version, _, phoff, _, _, ehsize, phentsize,
         phnum, _, _, _) = struct.unpack_from(header_format, header, 16)
        if version != 1 or ehsize != header_size:
            raise ValueError('Invalid ELF header version or size')
        if abi in ABIS and (bits, machine) != ABIS[abi]:
            raise ValueError('ELF class/machine does not match archive ABI ' + abi)
        if phnum in (0, 65535):
            raise ValueError('Missing or unsupported extended ELF program header count')
        program_format = endian + ('IIIIIIII' if bits == 32 else 'IIQQQQQQ')
        if phentsize < struct.calcsize(program_format) or phoff < header_size:
            raise ValueError('Invalid ELF program header layout')
        table_end = phoff + phnum * phentsize
        if table_end > entry.file_size or table_end > ELF_HEADER_LIMIT:
            raise ValueError('Truncated or oversized ELF program header table')
        stream.seek(phoff)
        table = stream.read(phnum * phentsize)
        if len(table) != phnum * phentsize:
            raise ValueError('Truncated ELF program headers')
    loads = []
    for index in range(phnum):
        program = struct.unpack_from(program_format, table, index * phentsize)
        if program[0] != 1:  # PT_LOAD
            continue
        if bits == 64:
            _, _, offset, vaddr, _, filesz, memsz, alignment = program
        else:
            _, offset, vaddr, _, filesz, memsz, _, alignment = program
        if filesz > memsz or offset + filesz > entry.file_size:
            raise ValueError('ELF LOAD segment has invalid file/memory bounds')
        if alignment not in (0, 1) and alignment & (alignment - 1):
            raise ValueError('ELF LOAD alignment is not a power of two')
        if alignment > 1 and offset % alignment != vaddr % alignment:
            raise ValueError('ELF LOAD virtual address and file offset are incongruent')
        loads.append({'program_header': index, 'offset': offset, 'virtual_address': vaddr,
                      'alignment_bytes': alignment})
    if not loads:
        raise ValueError('ELF has no LOAD segments')
    required = bits == 64
    return {
        'path': entry.filename, 'abi': abi or 'unknown', 'bits': bits, 'machine': machine,
        'byte_order': 'little' if endian == '<' else 'big',
        'requires_16kb': required, 'load_segments': loads,
        'load_alignment': ('passed' if all(load['alignment_bytes'] >= PAGE for load in loads)
                           else 'failed') if required else 'not_required_32bit',
        'compression': 'stored' if entry.compress_type == zipfile.ZIP_STORED else 'compressed',
    }


def apk_offsets(file_path, entries, native_by_path):
    failures = []
    checked = 0
    with file_path.open('rb') as raw:
        for entry in entries:
            if entry.is_dir() or entry.compress_type != zipfile.ZIP_STORED:
                continue
            raw.seek(entry.header_offset)
            header = raw.read(30)
            if len(header) != 30:
                raise ValueError('Truncated ZIP local header')
            signature, _, flags, compression, _, _, _, _, _, name_size, extra_size = struct.unpack('<IHHHHHIIIHH', header)
            if signature != 0x04034b50 or compression != entry.compress_type or flags != entry.flag_bits:
                raise ValueError('Inconsistent ZIP local header')
            offset = entry.header_offset + 30 + name_size + extra_size
            native = native_by_path.get(entry.filename)
            required = PAGE if native and native['requires_16kb'] else 4
            if native is not None:
                native['apk_data_offset'] = offset
                native['apk_required_alignment_bytes'] = required
            if offset % required:
                failures.append({'path': entry.filename, 'data_offset': offset,
                                 'required_alignment_bytes': required})
            checked += 1
    return {'status': 'failed' if failures else 'passed', 'stored_entries_checked': checked,
            'misaligned_entries': failures,
            'scope': 'Stored ELF64 libraries: 16 KB; other stored entries: 4 bytes; compressed entries exempt'}


def inspect_archive(path, expected_package=None):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    report = {
        'archive': str(path.resolve()), 'sha256': digest.hexdigest(), 'size_bytes': path.stat().st_size,
        'errors': [], 'native_libraries': [],
        'verification': {'signature_verified': False, 'installed': False,
                         'runtime_16kb_tested': False, 'physical_device_tested': False},
        'limitations': [
            'Static binary alignment does not prove runtime compatibility with a 16 KB page size.',
            'Install and exercise the signed build on a 16 KB device/emulator; verify its actual page size.',
            'Signatures, every ZIP payload CRC, GNU RELRO, and hardcoded page-size assumptions are not validated.',
        ],
    }
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        if len(set(names)) != len(names):
            raise ValueError('Archive has duplicate entry names')
        if 'BundleConfig.pb' in names and 'base/manifest/AndroidManifest.xml' in names:
            kind, manifest_name = 'aab', 'base/manifest/AndroidManifest.xml'
        elif 'AndroidManifest.xml' in names:
            kind, manifest_name = 'apk', 'AndroidManifest.xml'
        else:
            raise ValueError('Archive is neither a regular AAB nor an APK')
        report['format'] = kind
        report['entry_count'] = len(entries)
        report['package_info'] = manifest_info(read_metadata(archive, manifest_name), kind == 'aab')
        if expected_package and report['package_info'].get('package') != expected_package:
            report['errors'].append('Package is unavailable or does not match --expect-package')
        for entry in entries:
            if entry.is_dir() or not entry.filename.endswith('.so'):
                continue
            try:
                native = elf_info(archive, entry)
                report['native_libraries'].append(native)
                if native['load_alignment'] == 'failed':
                    report['errors'].append(entry.filename + ': a 64-bit LOAD segment is aligned below 16 KB')
            except (ValueError, OSError, RuntimeError, struct.error, zipfile.BadZipFile) as error:
                report['native_libraries'].append({'path': entry.filename, 'load_alignment': 'invalid', 'error': str(error)})
                report['errors'].append(entry.filename + ': ' + str(error))
        natives = report['native_libraries']
        relevant = [native for native in natives if native.get('requires_16kb')]
        invalid = any(native['load_alignment'] in ('failed', 'invalid') for native in natives)
        report['elf_16kb_load_alignment'] = 'failed' if invalid else ('passed' if relevant else 'not_applicable')
        report['native_64bit_count'] = len(relevant)
        report['native_32bit_count'] = sum(native.get('bits') == 32 for native in natives)
        if kind == 'aab':
            config = bundle_config(read_metadata(archive, 'BundleConfig.pb'))
            requested = config['requested_alignment_bytes']
            effective = config['effective_alignment_bytes']
            enabled = config['uncompress_native_libraries']
            config['status'] = ('requested_16kb_or_greater' if requested and requested >= PAGE else
                                'requested_below_16kb' if requested else
                                'default_4kb' if effective == 4096 else 'unknown') if enabled else 'uncompression_disabled'
            report['packaging'] = config
            if relevant and enabled and effective is not None and effective < PAGE:
                report['errors'].append('BundleConfig requests uncompressed native libraries with alignment below 16 KB')
            elif relevant and enabled and effective is None:
                report['errors'].append('BundleConfig uses an unsupported native page-alignment value')
            report['verification']['apk_zip_alignment_checked'] = False
            report['limitations'].append('AAB ZIP offsets are not installable APK offsets. Audit generated APKs separately; unspecified/disabled requests do not prove their alignment.')
        else:
            by_path = {native['path']: native for native in natives if 'requires_16kb' in native}
            report['packaging'] = apk_offsets(path, entries, by_path)
            report['verification']['apk_zip_alignment_checked'] = True
            if report['packaging']['status'] == 'failed':
                report['errors'].append('APK contains misaligned uncompressed entries')
    report['static_checks'] = 'failed' if report['errors'] else 'passed'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--expect-package', help='Fail if archive package differs or cannot be read')
    args = parser.parse_args()
    try:
        report = inspect_archive(args.archive, args.expect_package)
    except (ValueError, OSError, RuntimeError, UnicodeError, struct.error, zipfile.BadZipFile, ET.ParseError) as error:
        report = {'archive': str(args.archive), 'static_checks': 'failed', 'errors': [str(error)],
                  'verification': {'signature_verified': False, 'installed': False,
                                   'runtime_16kb_tested': False, 'physical_device_tested': False}}
    print(json.dumps(report, indent=2))
    return 0 if report['static_checks'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())

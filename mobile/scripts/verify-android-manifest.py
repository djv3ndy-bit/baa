#!/usr/bin/env python3
"""Inspect an actual merged release manifest; never infer this from app.json alone."""
from __future__ import annotations
import json
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

ANDROID = '{http://schemas.android.com/apk/res/android}'
FORBIDDEN = {
    'android.permission.' + name for name in (
        'READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_AUDIO',
        'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'CAMERA', 'RECORD_AUDIO',
        'SYSTEM_ALERT_WINDOW'
    )
}

def inspect_manifest(xml: str) -> dict:
    if '<!DOCTYPE' in xml.upper() or '<!ENTITY' in xml.upper():
        raise ValueError('Unexpected XML declaration in release manifest.')
    root = ET.fromstring(xml)
    if root.tag != 'manifest' or root.get('package') != 'com.baristajobmatch.app':
        raise ValueError('Release package does not match the registered app.')
    sdk = root.find('uses-sdk')
    target = sdk.get(ANDROID + 'targetSdkVersion') if sdk is not None else None
    if not target or not target.isdigit() or int(target) < 36:
        raise ValueError('Merged release manifest must target API 36 or higher.')
    permissions = sorted({node.get(ANDROID + 'name', '') for node in root if node.tag in ('uses-permission', 'uses-permission-sdk-23')})
    forbidden = sorted(FORBIDDEN.intersection(permissions))
    if forbidden:
        raise ValueError('Unnecessary broad/recording permissions present: ' + ', '.join(forbidden))
    if 'android.permission.INTERNET' not in permissions:
        raise ValueError('Release is missing internet access for account services.')
    return {
        'package': root.get('package'), 'target_sdk': int(target),
        'minimum_sdk': sdk.get(ANDROID + 'minSdkVersion'), 'permissions': permissions,
        'manifest_checked': True, 'signed_binary_checked': False,
        'physical_device_tested': False,
    }

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: verify-android-manifest.py MERGED_RELEASE_AndroidManifest.xml')
        report = inspect_manifest(Path(sys.argv[1]).read_text(encoding='utf-8'))
        print(json.dumps(report, indent=2))
    except (ValueError, OSError, ET.ParseError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

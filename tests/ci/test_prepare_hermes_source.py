"""Exercise observed archive roots and fail-closed extraction without any network."""
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[2] / 'scripts/ci/prepare-hermes-source.py'
spec = importlib.util.spec_from_file_location('prepare_hermes_source', HELPER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
COMMIT = 'e0fc67142ec0763c6b6153ca2bf96df815539782'


class HermesSourcesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.output = self.root / 'prepared'
        self.addCleanup(self.temporary.cleanup)

    def archive(self, prefix='meta-hermes-e0fc671', extra=(), omit=(), comment=COMMIT):
        archive = self.root / 'hermes.tar.gz'
        with tarfile.open(archive, 'w:gz', format=tarfile.PAX_FORMAT, pax_headers={'comment': comment}) as stream:
            for name in module.REQUIRED:
                if name in omit:
                    continue
                data = b'# pinned source fixture\n'
                info = tarfile.TarInfo(prefix + '/' + name)
                info.size = len(data)
                stream.addfile(info, io.BytesIO(data))
            for info, data in extra:
                stream.addfile(info, io.BytesIO(data) if data is not None else None)
        return archive

    def assert_rejected(self, archive):
        with self.assertRaises((ValueError, tarfile.TarError, EOFError, OSError)):
            module.extract_archive(archive, self.output, COMMIT)
        self.assertFalse(self.output.exists())
        self.assertEqual([], list(self.root.glob('.bjm-hermes-*')))

    def test_observed_meta_archive_is_flattened(self):
        result = module.extract_archive(self.archive(), self.output, COMMIT)
        self.assertEqual('meta-hermes-e0fc671', result['archiveRoot'])
        self.assertEqual(3, result['sourceFiles'])
        self.assertTrue((self.output / 'CMakeLists.txt').is_file())
        self.assertFalse((self.output / result['archiveRoot']).exists())

    def test_previous_facebook_root_is_supported(self):
        result = module.extract_archive(self.archive(prefix='facebook-hermes-e0fc671'), self.output, COMMIT)
        self.assertEqual('facebook-hermes-e0fc671', result['archiveRoot'])

    def test_missing_root_cmake_is_rejected(self):
        self.assert_rejected(self.archive(omit=('CMakeLists.txt',)))

    def test_commit_metadata_is_required(self):
        self.assert_rejected(self.archive(comment='0' * 40))

    def test_wrong_commit_root_is_rejected(self):
        self.assert_rejected(self.archive(prefix='meta-hermes-0000000'))

    def test_multiple_roots_are_rejected(self):
        info = tarfile.TarInfo('facebook-hermes-e0fc671/file')
        info.size = 1
        self.assert_rejected(self.archive(extra=[(info, b'x')]))

    def test_parent_traversal_is_rejected(self):
        info = tarfile.TarInfo('meta-hermes-e0fc671/../../escape')
        self.assert_rejected(self.archive(extra=[(info, b'')]))
        self.assertFalse((self.root / 'escape').exists())

    def test_absolute_and_windows_paths_are_rejected(self):
        for name in ('/escape', 'meta-hermes-e0fc671/C:/escape', 'meta-hermes-e0fc671/dir\\escape'):
            with self.subTest(name=name):
                self.assert_rejected(self.archive(extra=[(tarfile.TarInfo(name), b'')]))

    def test_duplicate_file_is_rejected(self):
        info = tarfile.TarInfo('meta-hermes-e0fc671/CMakeLists.txt')
        self.assert_rejected(self.archive(extra=[(info, b'')]))

    def test_link_and_special_entries_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE):
            info = tarfile.TarInfo('meta-hermes-e0fc671/link')
            info.type, info.linkname = kind, '../../escape'
            with self.subTest(kind=kind):
                self.assert_rejected(self.archive(extra=[(info, None)]))

    def test_expansion_and_entry_limits(self):
        archive = self.archive()
        for name, limit in (('MAX_EXPANDED', 1), ('MAX_FILE', 1), ('MAX_MEMBERS', 1), ('MAX_DOWNLOAD', 1)):
            with self.subTest(name=name), patch.object(module, name, limit):
                self.assert_rejected(archive)

    def test_corrupt_archive_is_rejected(self):
        archive = self.root / 'corrupt.tar.gz'
        archive.write_bytes(b'not a tarball')
        self.assert_rejected(archive)

    def test_corrupt_gzip_crc_is_rejected_before_source_publish(self):
        archive = self.archive()
        data = bytearray(archive.read_bytes())
        data[-8] ^= 1
        archive.write_bytes(data)
        self.assert_rejected(archive)

    def test_existing_output_is_not_replaced(self):
        self.output.mkdir()
        (self.output / 'retained').write_text('keep')
        with self.assertRaises(ValueError):
            module.extract_archive(self.archive(), self.output, COMMIT)
        self.assertEqual('keep', (self.output / 'retained').read_text())

    def test_locked_package_and_full_commit_are_required(self):
        mobile = self.root / 'mobile'
        rn = mobile / 'node_modules/react-native'
        (rn / 'sdks').mkdir(parents=True)
        (rn / 'package.json').write_text(json.dumps({'name': 'react-native', 'version': '0.81.5'}))
        (mobile / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/react-native': {'version': '0.81.5'}}}))
        version = rn / 'sdks/.hermesversion'
        version.write_text('hermes-2025-07-07-RNv0.81.0-' + COMMIT + '\n')
        self.assertEqual(COMMIT, module.pinned_commit(rn))
        for invalid in ('main', 'e0fc671', '../escape', COMMIT + '\nnext'):
            version.write_text(invalid)
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.pinned_commit(rn)
        version.write_text(COMMIT)
        (rn / 'package.json').write_text(json.dumps({'name': 'react-native', 'version': '0.82.0'}))
        with self.assertRaises(ValueError):
            module.pinned_commit(rn)

    def test_download_origin_allowlist(self):
        self.assertTrue(module.allowed_download_url('https://github.com/facebook/hermes/tarball/' + COMMIT))
        self.assertTrue(module.allowed_download_url('https://codeload.github.com/meta/hermes/legacy.tar.gz/' + COMMIT))
        for invalid in ('http://github.com/facebook/hermes/tarball/a', 'https://example.com/meta/hermes/a',
                        'https://github.com.evil/meta/hermes/a', 'https://user:password@github.com/meta/hermes/a',
                        'https://github.com/meta/other/a', 'https://github.com/meta/hermes/a?token=value',
                        'https://github.com/meta/hermes/../../other/tarball/' + COMMIT,
                        'https://github.com/meta/hermes/%2e%2e/tarball/' + COMMIT,
                        'https://github.com/meta/hermes/tarball%2f' + COMMIT,
                        'https://github.com/meta/hermes/dir\\tarball/' + COMMIT,
                        'https://github.com:invalid/meta/hermes/tarball/' + COMMIT):
            with self.subTest(url=invalid):
                self.assertFalse(module.allowed_download_url(invalid))


if __name__ == '__main__':
    unittest.main()

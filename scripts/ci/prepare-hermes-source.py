"""Prepare locked Hermes sources for CI; never change the app or disable a build task."""
import argparse
import gzip
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_DOWNLOAD = 128 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_MEMBERS = 100000
REQUIRED = ('CMakeLists.txt', 'API/hermes/hermes.h', 'tools/hermesc/CMakeLists.txt')


def pinned_commit(react_native_root):
    root = Path(react_native_root)
    installed = json.loads((root / 'package.json').read_text())
    lock = json.loads((root.parent.parent / 'package-lock.json').read_text())
    locked = lock['packages']['node_modules/react-native']
    if installed.get('name') != 'react-native' or installed.get('version') != locked.get('version'):
        raise ValueError('Installed React Native must match the mobile lockfile.')
    version = (root / 'sdks/.hermesversion').read_text().strip()
    match = re.fullmatch(r'(?:hermes-[A-Za-z0-9_.-]+-)?([0-9a-f]{40})', version)
    if not match:
        raise ValueError('The locked Hermes version must pin a full commit.')
    return match.group(1)


def allowed_download_url(value):
    try:
        url = urlparse(value)
        port = url.port
    except ValueError:
        return False
    route = 'tarball' if url.hostname == 'github.com' else r'legacy\.tar\.gz'
    return (url.scheme == 'https' and url.hostname in ('github.com', 'codeload.github.com')
            and port in (None, 443) and not url.username and not url.password
            and not url.query and not url.fragment
            and re.fullmatch(r'/(?:facebook|meta)/hermes/' + route + r'/[0-9a-f]{40}', url.path) is not None)


class GithubRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not allowed_download_url(newurl):
            raise ValueError('Hermes download redirected outside the official repository.')
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download_archive(commit, destination):
    # The package's tag includes this immutable commit. Avoid following a mutable tag.
    url = 'https://github.com/facebook/hermes/tarball/' + commit
    request = Request(url, headers={'User-Agent': 'BaristaMatch-CI', 'Accept-Encoding': 'identity'})
    with build_opener(GithubRedirects()).open(request, timeout=120) as response:
        if not allowed_download_url(response.geturl()):
            raise ValueError('Unexpected Hermes download origin.')
        length = response.headers.get('Content-Length')
        if length and int(length) > MAX_DOWNLOAD:
            raise ValueError('Hermes archive exceeds the download limit.')
        size = 0
        with Path(destination).open('xb') as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise ValueError('Hermes archive exceeds the download limit.')
                output.write(chunk)


def extract_archive(archive_path, output, commit):
    archive_path, output = Path(archive_path), Path(output)
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('A full Hermes commit is required.')
    if output.exists() or output.is_symlink():
        raise ValueError('Refusing to overwrite an existing Hermes source directory.')
    if archive_path.stat().st_size > MAX_DOWNLOAD:
        raise ValueError('Hermes archive exceeds the download limit.')
    # tarfile's streaming reader can stop at TAR end markers before checking
    # the gzip trailer. Check the full compressed stream and CRC first, bounded
    # by payload plus permitted archive-header space, before publishing sources.
    decoded = 0
    with gzip.open(archive_path, 'rb') as compressed:
        while True:
            chunk = compressed.read(1024 * 1024)
            if not chunk:
                break
            decoded += len(chunk)
            if decoded > MAX_EXPANDED + MAX_MEMBERS * 1024:
                raise ValueError('Hermes compressed stream exceeds the expansion limit.')
    output.parent.mkdir(parents=True, exist_ok=True)
    root, seen, expanded, files = None, set(), 0, 0
    with tempfile.TemporaryDirectory(prefix='.bjm-hermes-', dir=output.parent) as temporary:
        staged = Path(temporary) / 'source'
        staged.mkdir()
        # Stream entries so declared expansion limits are checked before payload reads.
        with tarfile.open(archive_path, mode='r|gz') as archive:
            for number, member in enumerate(archive, 1):
                if number > MAX_MEMBERS:
                    raise ValueError('Hermes archive has too many entries.')
                if archive.pax_headers.get('comment') != commit:
                    raise ValueError('Hermes archive commit metadata does not match the lock.')
                name = member.name
                path = PurePosixPath(name)
                if (path.is_absolute() or '\\' in name or '..' in path.parts
                        or any(':' in part for part in path.parts)
                        or str(path) != name.rstrip('/') or not path.parts):
                    raise ValueError('Unsafe Hermes archive path.')
                prefix = re.fullmatch(r'(?:facebook|meta)-hermes-([0-9a-f]{7,40})', path.parts[0])
                if not prefix or not commit.startswith(prefix.group(1)):
                    raise ValueError('Unexpected Hermes archive root.')
                root = root or path.parts[0]
                if root != path.parts[0]:
                    raise ValueError('Hermes archive contains multiple roots.')
                relative = PurePosixPath(*path.parts[1:])
                key = str(relative)
                if key in seen:
                    raise ValueError('Hermes archive has duplicate paths.')
                seen.add(key)
                # The locked archive has no links. Reject links and special files rather
                # than allowing a future source layout to escape the staged directory.
                if not member.isdir() and not member.isreg():
                    raise ValueError('Hermes archive links or special files are unsupported.')
                if member.size < 0 or member.size > MAX_FILE:
                    raise ValueError('Hermes archive entry exceeds the size limit.')
                expanded += member.size
                if expanded > MAX_EXPANDED:
                    raise ValueError('Hermes archive exceeds the expansion limit.')
                target = staged.joinpath(*relative.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                if not relative.parts:
                    raise ValueError('The Hermes archive root must be a directory.')
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('xb') as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
                if target.stat().st_size != member.size:
                    raise ValueError('Truncated Hermes source entry.')
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
                files += 1
        if not root or not all((staged / name).is_file() and (staged / name).stat().st_size for name in REQUIRED):
            raise ValueError('The pinned Hermes build sources are incomplete.')
        result = {'commit': commit, 'archiveRoot': root, 'sourceFiles': files,
                  'expandedBytes': expanded, 'archiveSha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
                  'cmakeSha256': hashlib.sha256((staged / 'CMakeLists.txt').read_bytes()).hexdigest()}
        staged.rename(output)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--react-native-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path, help='Use a previously downloaded public archive for offline verification.')
    args = parser.parse_args()
    commit = pinned_commit(args.react_native_root)
    if args.archive:
        result = extract_archive(args.archive, args.output, commit)
    else:
        with tempfile.TemporaryDirectory(prefix='bjm-hermes-download-') as directory:
            archive = Path(directory) / 'hermes.tar.gz'
            download_archive(commit, archive)
            result = extract_archive(archive, args.output, commit)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Collect exact signed MSYS2 source packages for the runtime DLL closure.

Run on Linux/WSL with gpgv and the MSYS2 public keyring. No build recipes are
executed. An unavailable package or signature failure aborts the collection.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.request


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(url, path):
    if path.exists():
        return
    temporary = path.with_name(path.name + '.part')
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
            while data := response.read(1024 * 1024):
                output.write(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('cache', type=Path)
    parser.add_argument('--keyring', type=Path, required=True)
    parser.add_argument('--only', help='Collect one source base for an initial tooling check')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding='utf-8-sig'))
    packages = manifest.get('runtimePackages')
    if not packages:
        parser.error('The bundle must record exact runtime package ownership')
    sources = sorted({(row['base'], row['version'].split(':')[-1]) for row in packages})
    args.cache.mkdir(parents=True, exist_ok=True)
    keyring = args.keyring.resolve()
    if keyring.read_bytes().startswith(b'-----BEGIN'):
        converted = args.cache / 'msys2-public-keyring.gpg'
        home = args.cache / 'gpg-public'
        home.mkdir(mode=0o700, exist_ok=True)
        subprocess.run(['gpg', '--batch', '--no-options', '--homedir', str(home), '--yes', '--dearmor',
                        '--output', str(converted), str(keyring)], check=True)
        keyring = converted

    def collect(row):
        base, version = row
        if not re.fullmatch(r'[A-Za-z0-9+_.~-]+', base + version):
            raise ValueError('Unsupported source package name/version')
        stem = f'{base}-{version}.src.tar.'
        for extension in ('zst', 'xz', 'gz'):
            name = stem + extension
            url = 'https://repo.msys2.org/mingw/sources/' + name
            archive = args.cache / name
            try:
                fetch(url, archive)
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    continue
                raise
            signature = args.cache / (name + '.sig')
            fetch(url + '.sig', signature)
            checked = subprocess.run(['gpgv', '--keyring', str(keyring), str(signature), str(archive)],
                                     capture_output=True, text=True)
            if checked.returncode:
                raise ValueError(f'MSYS2 source signature failed for {name}: {checked.stderr}')
            # Verify the source archive includes its package recipe. Extraction
            # and execution of arbitrary PKGBUILDs are deliberately unnecessary.
            listing = subprocess.check_output(['tar', '-tf', str(archive)], text=True)
            if not any(Path(entry).name == 'PKGBUILD' for entry in listing.splitlines()):
                raise ValueError(f'The source archive has no package recipe: {name}')
            print(f'Verified source: {base} {version}', flush=True)
            return {'base': base, 'version': version, 'url': url, 'archive': name,
                    'sha256': digest(archive), 'signature': signature.name,
                    'signatureSha256': digest(signature), 'signatureVerified': True}
        raise FileNotFoundError(f'Exact corresponding source is unavailable: {base} {version}')

    selected = [row for row in sources if not args.only or row[0] == args.only]
    if not selected:
        parser.error('No matching runtime source package')
    with ThreadPoolExecutor(max_workers=4) as pool:
        verified = list(pool.map(collect, selected))
    receipt = {'format': 1, 'platform': 'windows-x64', 'complete': len(selected) == len(sources),
               'manifestSha256': digest(args.manifest), 'sources': verified}
    path = args.cache / ('windows-source-receipt.json' if not args.only else 'partial-source-receipt.json')
    path.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(f'Collected {len(verified)} of {len(sources)} exact source packages')


if __name__ == '__main__':
    main()

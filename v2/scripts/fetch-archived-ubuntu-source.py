#!/usr/bin/env python3
"""Fetch an exact superseded Ubuntu source from Canonical's HTTPS archive.

The primary Launchpad source-file service authenticates the .dsc; its SHA-256
list authenticates every tar component. No untrusted apt repository is enabled.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request


class HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != 'https':
            raise ValueError('An archive redirect attempted to leave HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('name')
    parser.add_argument('version')
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', args.name) or not re.fullmatch(r'[A-Za-z0-9.+:~_-]+', args.version):
        parser.error('Invalid source package name or version')
    root = args.directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(HttpsOnly())
    base = 'https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/' + urllib.parse.quote(args.name) + '/' + urllib.parse.quote(args.version) + '/'

    def fetch(name):
        if Path(name).name != name or name in {'.', '..'}:
            raise ValueError('Unsafe source archive filename')
        path = root / name
        if path.exists():
            return path
        temporary = path.with_name(path.name + '.part')
        try:
            with opener.open(base + urllib.parse.quote(name), timeout=60) as response, temporary.open('wb') as output:
                while data := response.read(1024 * 1024):
                    output.write(data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return path

    version = re.sub(r'^\d+:', '', args.version)
    dsc = fetch(f'{args.name}_{version}.dsc')
    text = dsc.read_text()
    if re.search(r'^Source: (.+)$', text, re.M).group(1) != args.name or re.search(r'^Version: (.+)$', text, re.M).group(1) != args.version:
        raise ValueError('The archive returned a different source version')
    checks = re.search(r'^Checksums-Sha256:\n((?: .+\n)+)', text, re.M).group(1)
    for row in checks.splitlines():
        checksum, size, name = row.split()
        path = fetch(name)
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if path.stat().st_size != int(size) or actual != checksum:
            raise ValueError(f'Archived source checksum failed: {name}')
    record = root.parent / 'launchpad-provenance.json'
    values = json.loads(record.read_text()) if record.exists() else []
    values = [row for row in values if (row['source'], row['version']) != (args.name, args.version)]
    values.append({'source': args.name, 'version': args.version, 'dscUrl': base + dsc.name,
                   'dscSha256': hashlib.sha256(dsc.read_bytes()).hexdigest(), 'authenticatedBy': 'Canonical Launchpad HTTPS'})
    record.write_text(json.dumps(values, indent=2))
    print(f'Verified archived source: {args.name} {args.version}')


if __name__ == '__main__':
    main()

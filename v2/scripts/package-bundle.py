#!/usr/bin/env python3
"""Verify a complete runtime bundle and archive it with safe, relative paths."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import zipfile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('bundle', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    root, output = args.bundle.resolve(), args.destination.resolve()
    manifest = json.loads((root / 'runtime-manifest.json').read_text(encoding='utf-8-sig'))
    names = {'runtime-manifest.json'}
    folded = set()
    for row in manifest['files']:
        name = row['path']
        parts = PurePosixPath(name).parts
        if not parts or PurePosixPath(name).is_absolute() or '..' in parts or '\\' in name or ':' in name or name.casefold() in folded:
            raise ValueError('Unsafe or conflicting package path')
        file = root / name
        if file.is_symlink() or root not in file.resolve().parents or file.stat().st_size != row['size'] or sha(file) != row['sha256']:
            raise ValueError(f'Package file failed verification: {name}')
        names.add(name)
        folded.add(name.casefold())
    for file in root.rglob('*'):
        if file.is_symlink() or (file.is_file() and file.relative_to(root).as_posix() not in names):
            raise ValueError('Bundle contains an unlisted file or symbolic link')
    if output.exists():
        raise FileExistsError('Use a fresh archive destination')
    output.parent.mkdir(parents=True, exist_ok=True)
    if manifest['platform'] == 'windows-x64':
        with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in sorted(names):
                archive.write(root / name, name)
    elif manifest['platform'] == 'linux-x64':
        with tarfile.open(output, 'x:gz', format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(names):
                archive.add(root / name, arcname=name, recursive=False)
    else:
        raise ValueError('Unsupported platform')
    result = {'version': manifest['version'], 'protocol': manifest['protocol'], 'platform': manifest['platform'],
              'size': output.stat().st_size, 'sha256': sha(output), 'file': output.name}
    output.with_suffix(output.suffix + '.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Assemble an exact source companion after both dependency collectors pass."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def private(path):
    name = path.name.lower()
    return (name.startswith('.env') and name != '.env.example') or name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.key', '.pfx', '.p12')) or name.endswith('-private.pem')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--windows-bundle', type=Path, required=True)
    parser.add_argument('--msys-cache', type=Path, required=True)
    parser.add_argument('--linux-bundle', type=Path, required=True)
    parser.add_argument('--linux-cache', type=Path, required=True)
    parser.add_argument('--qt-sources', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error('Use a fresh source-kit destination')
    windows = load(args.windows_bundle / 'runtime-manifest.json')
    linux = load(args.linux_bundle / 'runtime-manifest.json')
    if windows['version'] != linux['version']:
        parser.error('Platform bundle versions must match')
    msys = load(args.msys_cache / 'windows-source-receipt.json')
    ubuntu = load(args.linux_cache / 'linux-source-receipt.json')
    if not msys['complete'] or not ubuntu['complete']:
        parser.error('Collect and verify all exact dependency sources first')
    expected = {(row['base'], row['version'].split(':')[-1]) for row in windows['runtimePackages']}
    if expected != {(row['base'], row['version']) for row in msys['sources']}:
        parser.error('The verified MSYS source set does not match the runtime dependency versions')
    expected_linux = {tuple(row.split('\t')) for row in (args.linux_bundle / 'runtime-sources.tsv').read_text().splitlines()}
    if expected_linux != {(row['source'], row['version']) for row in ubuntu['sources']}:
        parser.error('The verified Ubuntu source set does not match this runtime')
    output.mkdir(parents=True)
    project = Path(__file__).resolve().parents[1]
    code = output / 'watchpair' / 'v2'
    code.mkdir(parents=True)
    for file in project.rglob('*'):
        relative = file.relative_to(project)
        if any(part in {'node_modules', 'dist', '.git', '__pycache__', 'outputs', 'profiles', 'data', '.cache'} or private(Path(part)) for part in relative.parts):
            continue
        if file.is_symlink():
            raise ValueError('Unexpected link in project source')
        if file.is_file():
            target = code / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
    for name in ('LICENSE', 'LICENSE.md', 'LICENSE.txt'):
        if (project.parent / name).is_file():
            shutil.copyfile(project.parent / name, output / 'watchpair' / name)
    plan = project.parent / 'docs' / 'watchpair-v2-plan.md'
    if plan.is_file():
        (output / 'watchpair' / 'docs').mkdir()
        shutil.copyfile(plan, output / 'watchpair' / 'docs' / plan.name)
    dependencies = output / 'dependencies'
    (dependencies / 'msys2').mkdir(parents=True)
    for row in msys['sources']:
        for field, hash_field in (('archive', 'sha256'), ('signature', 'signatureSha256')):
            name = row[field]
            file = args.msys_cache / name
            if Path(name).name != name or sha(file) != row[hash_field]:
                raise ValueError('A verified MSYS source file changed')
            shutil.copyfile(file, dependencies / 'msys2' / name)
    shutil.copyfile(args.msys_cache / 'msys2-public-keyring.gpg', dependencies / 'msys2' / 'msys2-public-keyring.gpg')
    (dependencies / 'ubuntu').mkdir()
    copied = set()
    for row in ubuntu['sources']:
        for item in row['files'] + [{'file': row['dsc']}]:
            file = args.linux_cache / item['file']
            if args.linux_cache.resolve() not in file.resolve().parents or (item.get('sha256') and sha(file) != item['sha256']):
                raise ValueError('An Ubuntu source file changed')
            if file.name not in copied:
                shutil.copyfile(file, dependencies / 'ubuntu' / file.name)
                copied.add(file.name)
    qt_version = load(args.linux_bundle / 'build-info.json')['qtVersion']
    qt_archive = dependencies / f'qt-{qt_version}-matching-modules.tar.gz'
    with tarfile.open(qt_archive, 'x:gz') as archive:
        for module in ('qtbase', 'qtwayland', 'qtsvg', 'qtwebsockets'):
            source = args.qt_sources / module
            if qt_version not in (source / '.cmake.conf').read_text():
                raise ValueError('Qt sources do not match the binary SDK version')
            archive.add(source, arcname=module)
    import re
    sdk = [tuple(line.split('\t')) for line in (args.linux_bundle / 'runtime-sdk.tsv').read_text().splitlines()]
    for name, actual in sdk:
        if not name.startswith(('libQt6', 'libicu')):
            raise ValueError(f'Add matching source provenance for the additional SDK library: {name}')
    icu_versions = {match.group(1) for _, actual in sdk if (match := re.fullmatch(r'libicuuc[.]so[.]([0-9]+[.][0-9]+)', actual))}
    if len(icu_versions) != 1:
        raise ValueError('Could not identify the exact ICU SDK source version')
    icu_version = icu_versions.pop()
    icu = dependencies / ('icu4c-' + icu_version.replace('.', '_') + '-src.tgz')
    icu_url = 'https://github.com/unicode-org/icu/releases/download/release-' + icu_version.replace('.', '-') + '/' + icu.name
    with urllib.request.urlopen(icu_url, timeout=60) as incoming, icu.open('wb') as target:
        shutil.copyfileobj(incoming, target)
    build = output / 'build-inputs'
    build.mkdir()
    for label, bundle in (('windows', args.windows_bundle), ('linux', args.linux_bundle)):
        for name in ('runtime-manifest.json', 'build-info.json', 'runtime-packages.tsv', 'runtime-sources.tsv', 'runtime-sdk.tsv'):
            if (bundle / name).is_file():
                shutil.copyfile(bundle / name, build / f'{label}-{name}')
    (output / 'windows-source-receipt.json').write_text(json.dumps(msys, indent=2))
    (output / 'linux-source-receipt.json').write_text(json.dumps(ubuntu, indent=2))
    (output / 'README.txt').write_text(
        'WatchPair corresponding-source companion\n\n'
        f"Version: {windows['version']}\n"
        'The watchpair/v2 directory is the complete application/coordinator source snapshot. '
        'Its build scripts and DISTRIBUTION.md describe rebuilding and replacing shared libraries. '
        'build-inputs records exact platform package versions, runtime files, public update key and compiler. '
        'Use the recorded application version/public key as CMake cache arguments when rebuilding.\n\n'
        'dependencies/msys2 contains exact, MSYS2-signature-verified complete source packages and PKGBUILDs. '
        'dependencies/ubuntu contains exact Ubuntu source packages authenticated by signed apt indices or Canonical’s HTTPS archive, and verified against their .dsc SHA-256 lists. '
        'The matching official Qt module sources and ICU SDK source accompany them. '
        'All upstream copyright notices and licenses remain in those source packages. '
        'No signing private keys, user profiles or media are included.\n', encoding='utf-8')
    files = [{'path': file.relative_to(output).as_posix(), 'sha256': sha(file), 'size': file.stat().st_size}
             for file in sorted(output.rglob('*')) if file.is_file()]
    (output / 'source-kit.json').write_text(json.dumps({'format': 1, 'version': windows['version'], 'complete': True, 'files': files}, indent=2))
    print(f'Complete source kit: {output}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Publish a complete application snapshot over an unchanged dependency source kit."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
from native_source_overrides import validate_windows_overrides


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-source-kit', type=Path, required=True)
    parser.add_argument('--windows-bundle', type=Path, required=True)
    parser.add_argument('--linux-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    base, output = args.base_source_kit.resolve(), args.output.resolve()
    receipt = load(base / 'source-kit.json')
    if not receipt['complete'] or output.exists():
        parser.error('Use a complete base kit and a fresh output directory')
    for row in receipt['files']:
        file = base / row['path']
        if file.is_symlink() or base not in file.resolve().parents or sha(file) != row['sha256']:
            raise ValueError('The base source kit failed verification')
    windows, linux = (load(bundle / 'runtime-manifest.json')
                      for bundle in (args.windows_bundle, args.linux_bundle))
    if windows['version'] != linux['version']:
        raise ValueError('Platform versions differ')
    old_windows = load(base / 'build-inputs/windows-runtime-manifest.json')
    package_set = lambda manifest: {(row['base'], row['version']) for row in manifest['runtimePackages']}
    if package_set(windows) != package_set(old_windows):
        raise ValueError('Windows dependencies changed; collect a new complete source kit')
    for name in ('runtime-sources.tsv', 'runtime-sdk.tsv'):
        if (args.linux_bundle / name).read_bytes() != (base / 'build-inputs' / ('linux-' + name)).read_bytes():
            raise ValueError('Linux dependencies changed; collect a new complete source kit')
    project = Path(__file__).resolve().parents[1]
    override_inputs = validate_windows_overrides(
        windows, args.windows_bundle, project,
        [{'name': Path(row['path']).name, 'sha256': row['sha256']} for row in receipt['files']
         if row['path'].startswith('dependencies/')])
    output.mkdir(parents=True)
    # Reuse the full collector's exclusion policy for profiles, outputs and keys.
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location('source_kit', project / 'scripts/create-source-kit.py')
    collector = module_from_spec(spec)
    spec.loader.exec_module(collector)
    for file in project.rglob('*'):
        relative = file.relative_to(project)
        if any(part in {'node_modules', 'dist', '.git', '__pycache__', 'outputs', 'profiles', 'data', '.cache'}
               or collector.private(Path(part)) for part in relative.parts):
            continue
        if file.is_symlink():
            raise ValueError('Unexpected source symlink')
        if file.is_file():
            target = output / 'watchpair/v2' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, target)
    shutil.copytree(base / 'watchpair/docs', output / 'watchpair/docs')
    shutil.copyfile(project.parent / 'docs/watchpair-v2-plan.md', output / 'watchpair/docs/watchpair-v2-plan.md')
    shutil.copyfile(project.parent / 'LICENSE', output / 'watchpair/LICENSE')
    (output / 'build-inputs').mkdir()
    for label, bundle in (('windows', args.windows_bundle), ('linux', args.linux_bundle)):
        for name in ('runtime-manifest.json', 'build-info.json', 'runtime-packages.tsv', 'runtime-sources.tsv', 'runtime-sdk.tsv'):
            if (bundle / name).is_file():
                shutil.copyfile(bundle / name, output / 'build-inputs' / f'{label}-{name}')
    for file in override_inputs:
        shutil.copyfile(file, output / 'build-inputs' / f'windows-{file.name}')
    (output / 'README.txt').write_text(
        f"WatchPair {windows['version']} corresponding source\n\n"
        f"Requires the complete {receipt['version']} source kit. All native dependency source archives "
        'are unchanged and remain available with that release. Remove only watchpair/ and build-inputs/ '
        'from an extracted copy of the base source kit, then extract this overlay into that same directory. '
        'Retain dependencies/ and both dependency source receipts. This archive supplies the complete new '
        'application source and build inputs, replacing the old snapshot. Verify every assembled file '
        'against source-kit.json before rebuilding. See watchpair/v2/README.md and DISTRIBUTION.md.\n',
        encoding='utf-8')
    retained = [row for row in receipt['files'] if row['path'].startswith('dependencies/')
                or row['path'] in ('windows-source-receipt.json', 'linux-source-receipt.json')]
    replacement = [{'path': file.relative_to(output).as_posix(), 'size': file.stat().st_size, 'sha256': sha(file)}
                   for file in sorted(output.rglob('*')) if file.is_file()]
    manifest = {'format': 1, 'version': windows['version'], 'complete': True,
                'baseVersion': receipt['version'], 'baseManifestSha256': sha(base / 'source-kit.json'),
                'files': retained + replacement}
    (output / 'source-kit.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    archive = output.with_name(output.name + '.tar.gz')
    with tarfile.open(archive, 'x:gz') as target:
        for file in sorted(output.rglob('*')):
            if file.is_file():
                target.add(file, arcname=file.relative_to(output).as_posix(), recursive=False)
    print(json.dumps({'archive': str(archive), 'size': archive.stat().st_size, 'sha256': sha(archive),
                      'baseVersion': receipt['version'], 'version': windows['version']}))


if __name__ == '__main__':
    main()

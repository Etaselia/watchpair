"""Verify rebuilt native binaries against their source and build provenance."""
import hashlib
import json


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_windows_overrides(manifest, bundle, project, source_archives):
    """Return verified receipt paths to include in either source-kit format.

    source_archives contains name/sha256 pairs from an already verified base
    kit or the full collector's authenticated source-package receipt.
    """
    overrides = manifest.get('runtimeOverrides', [])
    if (bundle / 'watchpair-libtorrent-build.json').exists() and not overrides:
        raise ValueError('The native build receipt is missing from the runtime overrides')
    inputs, seen = [], set()
    for override in overrides:
        if (override.get('file') != 'libtorrent-rasterbar.dll'
                or override.get('receipt') != 'watchpair-libtorrent-build.json'
                or override.get('recipe') != 'v2/scripts/build-libtorrent-matched.ps1'
                or override.get('asioThreadBackend') != 'pthread'
                or override['file'] in seen):
            raise ValueError('Unsupported or duplicate native build override')
        seen.add(override['file'])
        native_file = bundle / override['file']
        native_receipt = bundle / override['receipt']
        if native_file.is_symlink() or native_receipt.is_symlink():
            raise ValueError('A native override cannot be a symlink')
        build = json.loads(native_receipt.read_text(encoding='utf-8-sig'))
        recipe = project.parent / override['recipe']
        if (build.get('format') != 1 or build.get('complete') is not True
                or build.get('upstreamVersion') != '2.1.2'
                or build.get('asioThreadBackend') != 'pthread'
                or build.get('compileDefinitions') != ['BOOST_ASIO_HAS_PTHREADS=1']
                or build.get('recipe') != override['recipe']
                or build.get('recipeSha256') != sha(recipe)
                or build.get('dll', {}).get('file') != override['file']
                or build['dll'].get('sha256') != override.get('sha256')
                or sha(native_file) != override['sha256']):
            raise ValueError('The native override does not match its build receipt and source recipe')
        file_rows = [row for row in manifest['files'] if row['path'] == override['file']]
        receipt_rows = [row for row in manifest['files'] if row['path'] == override['receipt']]
        if (len(file_rows) != 1 or file_rows[0]['sha256'] != override['sha256']
                or len(receipt_rows) != 1 or receipt_rows[0]['sha256'] != sha(native_receipt)):
            raise ValueError('The native override is not pinned in the runtime manifest')
        source = build.get('sourcePackage', {})
        if (source != {'name': 'mingw-w64-libtorrent-rasterbar-2.1.2-1.src.tar.zst',
                       'sha256': '40239915ee2f2773685fa86d70675be893b674159136463d2513ebb46101933b'}
                or build.get('upstreamSource') != {
                    'name': 'libtorrent-rasterbar-2.1.2.tar.gz',
                    'sha256': '3362546d9cd71b9e49ee6cac7d3f1f914ce9cdb217c86b63d5b22cbed0334dbc'}):
            raise ValueError('The native override must rebuild the exact retained libtorrent sources')
        if (source_archives.count(source) != 1
                or source not in build.get('sourceArchives', [])
                or build.get('upstreamSource') not in build.get('sourceArchives', [])):
            raise ValueError('The native override source is not in the verified source set')
        inputs.append(native_receipt)
    return inputs

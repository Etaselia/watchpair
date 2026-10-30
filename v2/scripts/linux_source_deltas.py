"""Validate explicit Ubuntu source revisions layered over a verified source kit."""
import hashlib
import json
from pathlib import PurePosixPath
import re
from urllib.parse import unquote, urlsplit


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_versions(path):
    versions = {}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        fields = line.split('\t')
        if (len(fields) != 2 or not re.fullmatch(r'[a-z0-9][a-z0-9+.-]*', fields[0])
                or not re.fullmatch(r'[A-Za-z0-9.+:~_-]+', fields[1]) or fields[0] in versions):
            raise ValueError('Invalid or duplicate Linux source package')
        versions[fields[0]] = fields[1]
    return versions


def source_path(name, convention):
    path = PurePosixPath(name)
    prefix = ('dependencies', 'ubuntu') if convention == 'source-kit-relative' else ('packages',)
    if (path.parts[:-1] != prefix or path.name in {'', '.', '..'}
            or ':' in name or '\\' in name or name != path.as_posix()):
        raise ValueError('Unsafe Ubuntu source path')
    return 'dependencies/ubuntu/' + path.name


def dsc_metadata(path):
    # The PGP signature can carry its own Version header, outside the DSC data.
    text = path.read_text(encoding='utf-8').split('\n-----BEGIN PGP SIGNATURE-----', 1)[0]
    fields = [re.findall(r'^' + key + r': (.+)$', text, re.M) for key in ('Source', 'Version')]
    blocks = re.findall(r'^Checksums-Sha256:\n((?:[ \t].+\n)+)', text, re.M)
    if any(len(field) != 1 for field in fields) or len(blocks) != 1:
        raise ValueError('Invalid Ubuntu source descriptor: ' + path.name)
    files = {}
    for line in blocks[0].splitlines():
        values = line.split()
        if (len(values) != 3 or not re.fullmatch(r'[0-9a-f]{64}', values[0])
                or not values[1].isdigit() or values[2] in files):
            raise ValueError('Invalid or duplicate Ubuntu descriptor member')
        logical = source_path('packages/' + values[2], 'collector-cache-relative')
        files[logical] = {'sha256': values[0], 'size': int(values[1])}
    if not files:
        raise ValueError('Empty Ubuntu source descriptor')
    return fields[0][0], fields[1][0], files


def authenticated_dsc(row):
    proof = row.get('authenticatedBy')
    if not isinstance(proof, dict):
        raise ValueError('A source delta requires pinned Canonical HTTPS provenance')
    url = urlsplit(proof.get('dscUrl', ''))
    expected = '/ubuntu/+archive/primary/+sourcefiles/' + row['source'] + '/' + row['version'] + '/' + PurePosixPath(row['dsc']).name
    if (proof.get('authenticatedBy') != 'Canonical Launchpad HTTPS'
            or proof.get('source') != row['source'] or proof.get('version') != row['version']
            or url.scheme != 'https' or url.netloc != 'launchpad.net'
            or url.query or url.fragment or unquote(url.path) != expected
            or not re.fullmatch(r'[0-9a-f]{64}', proof.get('dscSha256', ''))):
        raise ValueError('The Ubuntu source descriptor provenance does not match')
    return proof['dscSha256']


def prepare_linux_delta(base, bundle, cache):
    """Return verified additions/composite receipt; never mutate source inputs.

    The caller has already verified every base manifest hash. Added/removed
    package names and SDK changes require the full collector, not this path.
    Composite receipt paths are explicit paths relative to the assembled kit.
    """
    old = source_versions(base / 'build-inputs/linux-runtime-sources.tsv')
    current = source_versions(bundle / 'runtime-sources.tsv')
    if old.keys() != current.keys():
        raise ValueError('Linux source package membership changed; collect a complete source kit')
    changed = {name: version for name, version in current.items() if old[name] != version}
    if not changed:
        if cache is not None:
            raise ValueError('A Linux source delta was supplied without a source revision change')
        return None
    if cache is None:
        raise ValueError('Linux source revisions changed; supply a verified --linux-source-delta')
    cache = cache.resolve()
    delta_file = cache / 'linux-source-receipt.json'
    if delta_file.is_symlink():
        raise ValueError('A source delta receipt cannot be a symlink')
    delta = json.loads(delta_file.read_text(encoding='utf-8-sig'))
    original = json.loads((base / 'linux-source-receipt.json').read_text(encoding='utf-8-sig'))

    def rows(receipt):
        if (receipt.get('format') != 1 or receipt.get('platform') != 'linux-x64'
                or receipt.get('complete') is not True):
            raise ValueError('An Ubuntu source receipt is incomplete')
        result = {}
        for row in receipt['sources']:
            if row['source'] in result:
                raise ValueError('Duplicate Ubuntu source receipt row')
            result[row['source']] = row
        return result

    original_rows, delta_rows = rows(original), rows(delta)
    if {name: row['version'] for name, row in original_rows.items()} != old:
        raise ValueError('The base Ubuntu receipt does not match its build inputs')
    if {name: row['version'] for name, row in delta_rows.items()} != changed:
        raise ValueError('The Ubuntu delta receipt must match exactly every changed revision')
    base_manifest = json.loads((base / 'source-kit.json').read_text(encoding='utf-8-sig'))
    base_files = {row['path']: row for row in base_manifest['files']}
    additions, active_files, composite, changes = {}, {}, [], []
    for name in sorted(current):
        is_delta = name in changed
        receipt = delta if is_delta else original
        row = (delta_rows if is_delta else original_rows)[name]
        convention = receipt.get('pathConvention', 'collector-cache-relative')
        if convention not in {'collector-cache-relative', 'source-kit-relative'}:
            raise ValueError('Unsupported Ubuntu receipt path convention')
        dsc = source_path(row['dsc'], convention)
        physical_dsc = cache / row['dsc'] if is_delta else base / dsc
        dsc_hash = authenticated_dsc(row) if is_delta else base_files[dsc]['sha256']
        payload = {}
        for item in row['files']:
            logical = source_path(item['file'], convention)
            if logical == dsc or logical in payload or type(item['size']) is not int or item['size'] < 0:
                raise ValueError('Duplicate or invalid Ubuntu receipt member')
            payload[logical] = {'sha256': item['sha256'], 'size': item['size']}
        if (physical_dsc.is_symlink() or not physical_dsc.is_file()
                or (is_delta and cache not in physical_dsc.resolve().parents)
                or sha(physical_dsc) != dsc_hash):
            raise ValueError('The pinned Ubuntu source descriptor changed')
        dsc_source, dsc_version, listed = dsc_metadata(physical_dsc)
        if dsc_source != name or dsc_version != current[name] or listed != payload:
            raise ValueError('Ubuntu descriptor identity or complete payload membership differs')
        all_files = {dsc: {'sha256': dsc_hash, 'size': physical_dsc.stat().st_size}, **payload}
        for logical, expected in all_files.items():
            if logical in active_files and active_files[logical] != expected:
                raise ValueError('Conflicting active Ubuntu source paths')
            active_files[logical] = expected
            if not is_delta:
                if any(base_files[logical][key] != expected[key] for key in ('size', 'sha256')):
                    raise ValueError('An unchanged active source differs from the verified base')
                continue
            path = cache / ('packages/' + PurePosixPath(logical).name) if convention == 'collector-cache-relative' else cache / logical
            if (path.is_symlink() or not path.is_file() or cache not in path.resolve().parents
                    or path.stat().st_size != expected['size'] or sha(path) != expected['sha256']):
                raise ValueError('A changed Ubuntu source payload failed checksum verification')
            if logical in base_files:
                if any(base_files[logical][key] != expected[key] for key in ('size', 'sha256')):
                    raise ValueError('A source delta cannot overwrite a different pinned base file')
            else:
                additions[logical] = path
        converted = dict(row, dsc=dsc, dscSha256=dsc_hash,
                         files=[dict(file=path, **value) for path, value in sorted(payload.items())])
        composite.append(converted)
        if is_delta:
            changes.append({'source': name, 'fromVersion': old[name], 'toVersion': current[name],
                            'dsc': dsc, 'dscSha256': dsc_hash,
                            'files': sorted(all_files),
                            'receipt': 'build-inputs/linux-source-delta-receipt.json'})
    return {'files': additions, 'deltaReceipt': delta,
            'receipt': {'format': 1, 'platform': 'linux-x64', 'complete': True,
                        'pathConvention': 'source-kit-relative', 'sources': composite},
            'changes': changes}

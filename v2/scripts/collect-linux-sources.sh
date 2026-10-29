#!/usr/bin/env bash
# Download exact Ubuntu corresponding sources using an isolated, authenticated
# apt source index. Leaves the machine's system apt configuration untouched.
set -euo pipefail
task_bundle=$(realpath -- "${1:?Pass the Linux runtime bundle}")
task_output=$(realpath -m -- "${2:?Pass a source cache directory}")
task_scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "$task_output/packages" "$task_output/apt/sources" "$task_output/apt/lists/partial" "$task_output/apt/cache/archives/partial"
python3 - "$task_output/apt/sources/ubuntu.sources" <<'PY'
import pathlib, re, sys
source = pathlib.Path('/etc/apt/sources.list.d/ubuntu.sources').read_text()
pathlib.Path(sys.argv[1]).write_text(re.sub(r'^Types:.*$', 'Types: deb-src', source, flags=re.M))
PY
task_options=(-o "Dir::Etc::sourcelist=/dev/null" -o "Dir::Etc::sourceparts=$task_output/apt/sources"
  -o "Dir::State::lists=$task_output/apt/lists" -o "Dir::Cache=$task_output/apt/cache"
  -o "APT::Sandbox::User=$(id -un)")
apt-get "${task_options[@]}" update
cd -- "$task_output/packages"
while IFS=$'\t' read -r task_name task_version; do
  [[ "$task_name" =~ ^[a-z0-9][a-z0-9+.-]*$ && -n "$task_version" ]] || { printf '%s\n' 'Invalid source package metadata.' >&2; exit 1; }
  if ! apt-get "${task_options[@]}" source --download-only -- "$task_name=$task_version"; then
    python3 "$task_scripts/fetch-archived-ubuntu-source.py" "$task_name" "$task_version" "$task_output/packages"
  fi
done < "$task_bundle/runtime-sources.tsv"
python3 - "$task_bundle" "$task_output" <<'PY'
import hashlib, json, pathlib, re, sys
bundle, root = map(pathlib.Path, sys.argv[1:])
expected = set(tuple(line.split('\t')) for line in (bundle / 'runtime-sources.tsv').read_text().splitlines())
found, sources = set(), []
archived = json.loads((root / 'launchpad-provenance.json').read_text()) if (root / 'launchpad-provenance.json').exists() else []
for dsc in sorted((root / 'packages').glob('*.dsc')):
    text = dsc.read_text()
    name = re.search(r'^Source: (.+)$', text, re.M).group(1)
    version = re.search(r'^Version: (.+)$', text, re.M).group(1)
    if (name, version) not in expected:
        continue
    checks = re.search(r'^Checksums-Sha256:\n((?: .+\n)+)', text, re.M).group(1)
    files = []
    for row in checks.splitlines():
        sha, size, filename = row.split()
        path = root / 'packages' / filename
        if pathlib.Path(filename).name != filename or not path.is_file() or path.stat().st_size != int(size):
            raise ValueError('Missing or unsafe corresponding-source file')
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != sha:
                raise ValueError('Source archive checksum failed')
        files.append({'file': 'packages/' + filename, 'sha256': sha, 'size': int(size)})
    found.add((name, version))
    provenance = next((row for row in archived if (row['source'], row['version']) == (name, version)), None)
    if provenance and hashlib.sha256(dsc.read_bytes()).hexdigest() != provenance['dscSha256']:
        raise ValueError('An archived .dsc changed after authenticated retrieval')
    sources.append({'source': name, 'version': version, 'dsc': 'packages/' + dsc.name, 'files': files,
                    'authenticatedBy': provenance or 'Ubuntu signed apt source index'})
if found != expected:
    raise ValueError('The authenticated source set is incomplete')
(root / 'linux-source-receipt.json').write_text(json.dumps({'format': 1, 'platform': 'linux-x64', 'complete': True, 'sources': sources}, indent=2))
print(f'Verified {len(found)} exact Ubuntu source packages')
PY

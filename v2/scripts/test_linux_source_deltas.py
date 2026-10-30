"""Source closure and rejection controls; uses synthetic source packages only."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from linux_source_deltas import prepare_linux_delta


class LinuxSourceDeltaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.base, self.bundle, self.cache = (root / name for name in ('base', 'bundle', 'delta'))
        (self.base / 'build-inputs').mkdir(parents=True)
        self.bundle.mkdir()
        (self.cache / 'packages').mkdir(parents=True)
        self.old = [self.package(self.base / 'dependencies/ubuntu', name, '1') for name in ('keep', 'librsvg')]
        self.new = self.package(self.cache / 'packages', 'librsvg', '2')
        self.write_versions('keep\t1\nlibrsvg\t2\n')
        (self.base / 'build-inputs/linux-runtime-sources.tsv').write_text('keep\t1\nlibrsvg\t1\n')
        self.write_receipt(self.base, self.old)
        self.write_receipt(self.cache, [self.new])
        self.manifest = {'files': [dict(path=p.relative_to(self.base).as_posix(), size=p.stat().st_size,
                                       sha256=hashlib.sha256(p.read_bytes()).hexdigest())
                                   for p in self.base.rglob('*') if p.is_file()]}
        (self.base / 'source-kit.json').write_text(json.dumps(self.manifest))

    def package(self, root, name, version):
        root.mkdir(parents=True, exist_ok=True)
        files = []
        for filename, data in ((name + '.orig.tar.xz', b'upstream-' + name.encode()),
                               (name + '_' + version + '.debian.tar.xz', b'patch-' + version.encode())):
            (root / filename).write_bytes(data)
            files.append(dict(file='packages/' + filename, size=len(data), sha256=hashlib.sha256(data).hexdigest()))
        dsc = root / (name + '_' + version + '.dsc')
        dsc.write_text('Source: ' + name + '\nVersion: ' + version + '\nChecksums-Sha256:\n' +
                       ''.join(' {sha256} {size} '.format(**f) + Path(f['file']).name + '\n' for f in files))
        return dict(source=name, version=version, dsc='packages/' + dsc.name, files=files,
                    authenticatedBy=dict(source=name, version=version, authenticatedBy='Canonical Launchpad HTTPS',
                                         dscSha256=hashlib.sha256(dsc.read_bytes()).hexdigest(),
                                         dscUrl='https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/' +
                                                name + '/' + version + '/' + dsc.name))

    def write_versions(self, text):
        (self.bundle / 'runtime-sources.tsv').write_text(text)

    def write_receipt(self, root, rows):
        (root / 'linux-source-receipt.json').write_text(json.dumps(
            dict(format=1, platform='linux-x64', complete=True, sources=rows)))

    def run_delta(self):
        return prepare_linux_delta(self.base, self.bundle, self.cache)

    def test_complete_delta_reuses_pinned_orig_and_materializes_all_active_paths(self):
        result = self.run_delta()
        self.assertEqual(set(result['files']), {'dependencies/ubuntu/librsvg_2.dsc',
                                               'dependencies/ubuntu/librsvg_2.debian.tar.xz'})
        self.assertEqual(result['receipt']['pathConvention'], 'source-kit-relative')
        self.assertEqual({r['source']: r['version'] for r in result['receipt']['sources']},
                         {'keep': '1', 'librsvg': '2'})
        for row in result['receipt']['sources']:
            for name in [row['dsc']] + [f['file'] for f in row['files']]:
                self.assertTrue(name.startswith('dependencies/ubuntu/'))
                self.assertTrue(name in result['files'] or (self.base / name).is_file())
        self.assertEqual(result['changes'][0]['fromVersion'], '1')
        self.assertEqual(result['changes'][0]['toVersion'], '2')

    def test_changed_source_requires_explicit_delta(self):
        with self.assertRaises(ValueError):
            prepare_linux_delta(self.base, self.bundle, None)

    def test_pgp_signature_headers_are_not_descriptor_fields(self):
        dsc = self.cache / self.new['dsc']
        dsc.write_text('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n' + dsc.read_text() +
                       '\n-----BEGIN PGP SIGNATURE-----\nVersion: GnuPG\n\nfixture\n-----END PGP SIGNATURE-----\n')
        self.new['authenticatedBy']['dscSha256'] = hashlib.sha256(dsc.read_bytes()).hexdigest()
        self.write_receipt(self.cache, [self.new])
        self.assertEqual(len(self.run_delta()['changes']), 1)

    def test_missing_extra_and_duplicate_source_rows_are_rejected(self):
        for rows in ([], [self.new, self.old[0]], [self.new, self.new]):
            with self.subTest(rows=len(rows)):
                self.write_receipt(self.cache, rows)
                with self.assertRaises(ValueError):
                    self.run_delta()

    def test_unpinned_or_wrong_authority_provenance_is_rejected(self):
        for proof in ('Ubuntu signed apt source index',
                      dict(self.new['authenticatedBy'], dscUrl='https://example.com/source.dsc')):
            with self.subTest(proof=proof):
                self.write_receipt(self.cache, [dict(self.new, authenticatedBy=proof)])
                with self.assertRaises(ValueError):
                    self.run_delta()

    def test_changed_dsc_or_archive_is_rejected(self):
        for name in (self.new['dsc'], self.new['files'][1]['file']):
            path = self.cache / name
            original = path.read_bytes()
            with self.subTest(file=name):
                path.write_bytes(original + b'tamper')
                with self.assertRaises(ValueError):
                    self.run_delta()
                path.write_bytes(original)

    def test_missing_extra_duplicate_and_unsafe_payload_paths_are_rejected(self):
        for files in (self.new['files'][:1], self.new['files'] + [self.new['files'][0]],
                      [dict(self.new['files'][0], file='packages/../outside')],
                      self.new['files'] + [dict(self.new['files'][0], file='packages/extra')]):
            with self.subTest(files=files):
                self.write_receipt(self.cache, [dict(self.new, files=files)])
                with self.assertRaises(ValueError):
                    self.run_delta()

    def test_removed_added_duplicate_and_noop_source_sets_are_rejected(self):
        for text in ('librsvg\t2\n', 'keep\t1\nlibrsvg\t2\nextra\t1\n',
                     'keep\t1\nlibrsvg\t2\nlibrsvg\t2\n', 'keep\t1\nlibrsvg\t1\n'):
            with self.subTest(text=text):
                self.write_versions(text)
                with self.assertRaises(ValueError):
                    self.run_delta()

    def test_a_delta_cannot_clobber_a_different_pinned_base_file(self):
        path = self.cache / self.new['files'][0]['file']
        path.write_bytes(b'changed upstream under the same filename')
        self.new['files'][0].update(size=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        dsc = self.cache / self.new['dsc']
        dsc.write_text('Source: librsvg\nVersion: 2\nChecksums-Sha256:\n' +
                       ''.join(' {sha256} {size} '.format(**f) + Path(f['file']).name + '\n' for f in self.new['files']))
        self.new['authenticatedBy']['dscSha256'] = hashlib.sha256(dsc.read_bytes()).hexdigest()
        self.write_receipt(self.cache, [self.new])
        with self.assertRaises(ValueError):
            self.run_delta()


if __name__ == '__main__':
    unittest.main()

import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';

const source = process.env.WATCHPAIR_DATABASE ?? './data/watchpair-v2.sqlite';
const target = process.argv[2];
if (!target || resolve(source) === resolve(target) || existsSync(target))
  throw new Error('Supply a new destination file for the coordinator backup');
process.umask(0o077);
mkdirSync(dirname(target),{recursive:true,mode:0o700});
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, target); } finally { db.close(); }
chmodSync(target,0o600);
const check = new DatabaseSync(target, { readOnly: true });
try {
  if (check.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Backup integrity check failed');
} finally { check.close(); }
process.stdout.write('Coordinator backup verified. Keep it private; it contains room credentials.\n');

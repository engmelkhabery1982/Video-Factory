/** Offline G11/G12 recovery tests using only disposable synthetic files. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBackup, restoreBackup, verifyBackup } from '../scripts/factory-data-recovery.mjs';

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-recovery-'));
  roots.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'factory', 'drafts'), { recursive: true });
  fs.mkdirSync(path.join(data, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(data, 'factory', 'drafts', 'draft.json'), '{"revision":4,"title":"synthetic"}\n');
  fs.writeFileSync(path.join(data, 'assets', 'owned.bin'), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(data, 'empty.txt'), '');
  return { root, data, backup: path.join(root, 'backup'), restored: path.join(root, 'restored') };
}
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('offline backup -> hash verification -> non-merging restore round trip', async () => {
  const f = fixture();
  const manifest = await createBackup({ dataDir: f.data, outputDir: f.backup });
  assert.equal(manifest.fileCount, 3);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(JSON.stringify(manifest).includes(f.root), false, 'manifest contains no machine-specific absolute path');
  assert.equal((await verifyBackup({ backupDir: f.backup })).fileCount, 3);
  await restoreBackup({ backupDir: f.backup, dataDir: f.restored, confirmed: true });
  for (const relative of ['factory/drafts/draft.json', 'assets/owned.bin', 'empty.txt']) {
    assert.deepEqual(fs.readFileSync(path.join(f.restored, relative)), fs.readFileSync(path.join(f.data, relative)));
  }
});

test('tampering, missing and extra files fail verification before restore', async () => {
  const f = fixture();
  await createBackup({ dataDir: f.data, outputDir: f.backup });
  fs.writeFileSync(path.join(f.backup, 'files', 'assets', 'owned.bin'), 'tampered');
  await assert.rejects(verifyBackup({ backupDir: f.backup }), /size\/type mismatch|SHA-256 mismatch/);
  await assert.rejects(restoreBackup({ backupDir: f.backup, dataDir: f.restored, confirmed: true }));
  assert.equal(fs.existsSync(f.restored), false);
});

test('an unexpected extra file fails closed rather than being silently omitted', async () => {
  const f = fixture();
  await createBackup({ dataDir: f.data, outputDir: f.backup });
  fs.writeFileSync(path.join(f.backup, 'files', 'extra.json'), '{}');
  await assert.rejects(verifyBackup({ backupDir: f.backup }), /Unexpected extra backup file/);
});

test('restore refuses a nonempty destination and preserves its sentinel', async () => {
  const f = fixture();
  await createBackup({ dataDir: f.data, outputDir: f.backup });
  fs.mkdirSync(f.restored);
  fs.writeFileSync(path.join(f.restored, 'owner-sentinel'), 'preserve');
  await assert.rejects(restoreBackup({ backupDir: f.backup, dataDir: f.restored, confirmed: true }), /nonempty destination/);
  assert.equal(fs.readFileSync(path.join(f.restored, 'owner-sentinel'), 'utf8'), 'preserve');
});

test('restore requires explicit confirmation and refuses overlapping locations', async () => {
  const f = fixture();
  await createBackup({ dataDir: f.data, outputDir: f.backup });
  await assert.rejects(restoreBackup({ backupDir: f.backup, dataDir: f.restored }), /explicit confirmation/);
  await assert.rejects(restoreBackup({ backupDir: f.backup, dataDir: path.join(f.backup, 'restored'), confirmed: true }), /must not contain/);
  await assert.rejects(createBackup({ dataDir: f.data, outputDir: path.join(f.data, 'backup-inside') }), /outside the data directory/);
});

test('symlink entries are refused instead of following data outside the root', async (t) => {
  const f = fixture();
  const outside = path.join(f.root, 'outside-secret');
  fs.writeFileSync(outside, 'do not copy');
  try { fs.symlinkSync(outside, path.join(f.data, 'assets', 'link')); } catch { t.skip('symlinks unavailable on this host'); return; }
  await assert.rejects(createBackup({ dataDir: f.data, outputDir: f.backup }), /Symbolic links/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'do not copy');
});

test('duplicate and traversal manifest paths are rejected', async () => {
  const f = fixture();
  const manifest = await createBackup({ dataDir: f.data, outputDir: f.backup });
  const file = path.join(f.backup, 'manifest.json');
  const duplicate = structuredClone(manifest);
  duplicate.entries.push(duplicate.entries[0]);
  duplicate.fileCount += 1;
  duplicate.totalBytes += duplicate.entries[0].size;
  fs.writeFileSync(file, JSON.stringify(duplicate));
  await assert.rejects(verifyBackup({ backupDir: f.backup }), /Duplicate backup entry/);
  const traversal = structuredClone(manifest);
  traversal.entries[0].path = '../outside';
  fs.writeFileSync(file, JSON.stringify(traversal));
  await assert.rejects(verifyBackup({ backupDir: f.backup }), /Unsafe backup relative path/);
});

test('CLI backup/verify/restore works without any dependency install', () => {
  const f = fixture();
  const script = path.resolve('scripts/factory-data-recovery.mjs');
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.match(run('backup', '--data', f.data, '--output', f.backup), /backup: verified 3 files/);
  assert.match(run('verify', '--backup', f.backup), /verify: verified 3 files/);
  assert.match(run('restore', '--backup', f.backup, '--data', f.restored, '--yes'), /restore: verified 3 files/);
  assert.equal(fs.readFileSync(path.join(f.restored, 'factory', 'drafts', 'draft.json'), 'utf8'), '{"revision":4,"title":"synthetic"}\n');
});

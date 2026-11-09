#!/usr/bin/env node
/**
 * Offline factory backup/verify/restore. Node built-ins only; no network or Git data.
 * Restore is intentionally non-merging: the destination must be absent or empty.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const FORMAT = 'video-factory-offline-backup';
const MAX_FILES = 200_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

const contained = (root, candidate) => {
  const a = path.resolve(root);
  const b = path.resolve(candidate);
  return a === b || b.startsWith(a + path.sep);
};

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.includes(':') || path.posix.isAbsolute(value)) {
    throw new Error(`Unsafe backup relative path: ${String(value)}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe backup relative path: ${value}`);
  return parts.join('/');
}

// Validate existing ancestors too: lexical containment alone does not contain a junction.
function rejectLinkedPath(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symbolic link or junction paths are not supported: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function collectFiles(root) {
  const output = [];
  async function visit(directory, prefix = '') {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeRelative(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not backed up or restored: ${relative}`);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const stat = await fs.promises.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${relative}`);
        output.push({ relative, absolute, size: stat.size });
        if (output.length > MAX_FILES) throw new Error(`Backup exceeds the ${MAX_FILES}-file safety bound.`);
      } else {
        throw new Error(`Special filesystem entries are not supported: ${relative}`);
      }
    }
  }
  await visit(root);
  return output;
}

async function copyExclusive(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

export async function createBackup({ dataDir, outputDir }) {
  const data = path.resolve(dataDir);
  const output = path.resolve(outputDir);
  rejectLinkedPath(data);
  rejectLinkedPath(output);
  if (!fs.existsSync(data) || !fs.statSync(data).isDirectory()) throw new Error('The data directory does not exist or is not a directory.');
  if (contained(data, output)) throw new Error('The backup output must be outside the data directory.');
  if (fs.existsSync(output)) throw new Error('The backup output already exists; choose a new empty path. Nothing was overwritten.');
  const files = await collectFiles(data);
  await fs.promises.mkdir(output, { recursive: false });
  const entries = [];
  for (const file of files) {
    const destination = path.join(output, 'files', ...file.relative.split('/'));
    await copyExclusive(file.absolute, destination);
    // Offline operation is required. Matching both hashes also detects a source changed during its copy.
    const [sourceSha256, backupSha256] = [await hashFile(file.absolute), await hashFile(destination)];
    if (sourceSha256 !== backupSha256) throw new Error(`Source changed while it was being copied: ${file.relative}`);
    const copiedStat = await fs.promises.stat(destination);
    if (copiedStat.size !== file.size) throw new Error(`Source size changed while it was being copied: ${file.relative}`);
    entries.push({ path: file.relative, size: copiedStat.size, sha256: backupSha256 });
  }
  const manifest = {
    format: FORMAT,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    entries,
  };
  await fs.promises.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

async function readManifest(backup) {
  const file = path.join(backup, 'manifest.json');
  const stat = await fs.promises.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Backup manifest is missing, unsafe or too large.');
  const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  if (manifest?.format !== FORMAT || manifest?.schemaVersion !== 1 || !Array.isArray(manifest.entries)) throw new Error('Unsupported backup manifest.');
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    if (typeof entry !== 'object' || entry === null || Object.keys(entry).sort().join(',') !== 'path,sha256,size') throw new Error('Malformed backup entry.');
    const relative = safeRelative(entry.path);
    if (seen.has(relative)) throw new Error(`Duplicate backup entry: ${relative}`);
    seen.add(relative);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Malformed backup entry: ${relative}`);
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('Backup byte total is unsafe.');
  }
  if (manifest.fileCount !== manifest.entries.length || manifest.totalBytes !== totalBytes) throw new Error('Backup manifest totals do not match its entries.');
  return manifest;
}

export async function verifyBackup({ backupDir }) {
  const backup = path.resolve(backupDir);
  rejectLinkedPath(backup);
  rejectLinkedPath(path.join(backup, 'files'));
  const manifest = await readManifest(backup);
  const root = path.join(backup, 'files');
  if (!fs.existsSync(root) && manifest.entries.length > 0) throw new Error('Backup files directory is missing.');
  const actual = fs.existsSync(root) ? await collectFiles(root) : [];
  const expected = new Set(manifest.entries.map((entry) => entry.path));
  for (const file of actual) if (!expected.has(file.relative)) throw new Error(`Unexpected extra backup file: ${file.relative}`);
  for (const entry of manifest.entries) {
    const file = path.join(root, ...entry.path.split('/'));
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) throw new Error(`Backup size/type mismatch: ${entry.path}`);
    if (await hashFile(file) !== entry.sha256) throw new Error(`Backup SHA-256 mismatch: ${entry.path}`);
  }
  return manifest;
}

export async function restoreBackup({ backupDir, dataDir, confirmed = false }) {
  if (!confirmed) throw new Error('Restore requires explicit confirmation.');
  const backup = path.resolve(backupDir);
  const data = path.resolve(dataDir);
  rejectLinkedPath(backup);
  rejectLinkedPath(data);
  if (contained(backup, data) || contained(data, backup)) throw new Error('Backup and restore locations must not contain one another.');
  const manifest = await verifyBackup({ backupDir: backup });
  if (fs.existsSync(data)) {
    if (!fs.statSync(data).isDirectory()) throw new Error('Restore destination exists and is not a directory.');
    if ((await fs.promises.readdir(data)).length > 0) throw new Error('Restore refuses a nonempty destination. No files were merged or overwritten.');
  } else {
    await fs.promises.mkdir(data, { recursive: false });
  }
  for (const entry of manifest.entries) {
    const source = path.join(backup, 'files', ...entry.path.split('/'));
    const destination = path.join(data, ...entry.path.split('/'));
    await copyExclusive(source, destination);
    if (await hashFile(destination) !== entry.sha256) throw new Error(`Restored SHA-256 mismatch: ${entry.path}`);
  }
  return manifest;
}

function usage() {
  return [
    'Offline use only; stop the factory server before backup or restore.',
    'node scripts/factory-data-recovery.mjs backup --data <data-dir> --output <new-backup-dir>',
    'node scripts/factory-data-recovery.mjs verify --backup <backup-dir>',
    'node scripts/factory-data-recovery.mjs restore --backup <backup-dir> --data <absent-or-empty-dir> --yes',
  ].join('\n');
}

async function main(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--yes') { options.yes = true; continue; }
    if (!['--data', '--output', '--backup'].includes(token) || !tokens[i + 1]) throw new Error(usage());
    options[token.slice(2)] = tokens[++i];
  }
  let manifest;
  if (command === 'backup' && options.data && options.output && !options.backup && !options.yes) {
    manifest = await createBackup({ dataDir: options.data, outputDir: options.output });
  } else if (command === 'verify' && options.backup && !options.data && !options.output && !options.yes) {
    manifest = await verifyBackup({ backupDir: options.backup });
  } else if (command === 'restore' && options.backup && options.data && options.yes === true && !options.output) {
    manifest = await restoreBackup({ backupDir: options.backup, dataDir: options.data, confirmed: true });
  } else {
    throw new Error(usage());
  }
  console.log(`${command}: verified ${manifest.fileCount} files, ${manifest.totalBytes} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

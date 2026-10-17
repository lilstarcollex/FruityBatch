import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import yauzl from 'yauzl';
import { inspectFlp } from './flp.mjs';

const discard = () => new Writable({ write(_b, _encoding, cb) { cb(); } });

export async function hashFile(file, onBytes = () => {}) {
  const hash = crypto.createHash('sha256');
  for await (const b of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) { hash.update(b); onBytes(b.length); }
  return hash.digest('hex');
}

function record(stat) { return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev }; }
export const fingerprint = async file => record(await fsp.stat(file));
export function sameFingerprint(a, b) { return ['size','mtimeMs','ctimeMs','ino','dev'].every(k => a?.[k] === b?.[k]); }

export async function walk(folder, root = folder) {
  const result = [];
  for (const e of await fsp.readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, e.name); const stat = await fsp.lstat(full);
    if (stat.isSymbolicLink() || e.isSymbolicLink()) throw new Error(`Ссылки и junction не допускаются: ${full}`);
    if (stat.isDirectory()) result.push(...await walk(full, root));
    else if (stat.isFile()) result.push({ full, relative: path.relative(root, full).split(path.sep).join('/'), ...record(stat) });
    else throw new Error(`Неподдерживаемый объект: ${full}`);
  }
  return result.sort((a,b) => a.relative.localeCompare(b.relative));
}

export async function inventory(folder, { onProgress = () => {} } = {}) {
  const files = await walk(folder); const totalBytes = files.reduce((n,f) => n + f.size, 0); let bytes = 0, completed = 0;
  for (const file of files) {
    file.sha256 = await hashFile(file.full, n => { bytes += n; onProgress({ file: file.relative, bytes, totalBytes, completed, totalFiles: files.length }); });
    if (!sameFingerprint(file, await fingerprint(file.full))) throw new Error(`Файл изменился при чтении: ${file.relative}`);
    completed++;
  }
  onProgress({ file: '', bytes, totalBytes, completed, totalFiles: files.length });
  return files;
}

export async function assertUnchanged(folder, original, ignored = [], { metadataOnly = false, onProgress = () => {} } = {}) {
  const now = (await walk(folder)).filter(f => !ignored.includes(f.relative));
  if (now.length !== original.length) throw new Error('Состав исходной папки изменился во время обработки');
  const byName = new Map(original.map(f => [f.relative, f]));
  const totalBytes = now.reduce((n,f) => n + f.size, 0); let bytes = 0, completed = 0;
  for (const file of now) {
    const before = byName.get(file.relative);
    if (!before || before.size !== file.size) throw new Error(`Исходный файл изменился: ${file.relative}`);
    if (metadataOnly && before.ctimeMs !== undefined) {
      if (!sameFingerprint(before, file)) throw new Error(`Исходный файл изменился: ${file.relative}`);
      file.sha256 = before.sha256; bytes += file.size;
    } else {
      file.sha256 = await hashFile(file.full, n => { bytes += n; onProgress({ file: file.relative, bytes, totalBytes, completed, totalFiles: now.length }); });
      if (before.sha256 !== file.sha256 || !sameFingerprint(file, await fingerprint(file.full))) throw new Error(`Исходный файл изменился: ${file.relative}`);
    }
    completed++;
  }
  onProgress({ file: '', bytes, totalBytes, completed, totalFiles: now.length });
  return now;
}

// FL writes waveform-analysis sidecars and a temporary ZIP while exporting.
// Reconcile only those artifacts; FLP, audio and all other originals remain
// protected. The refreshed snapshot is checked in full before deletion.
export async function reconcileExportArtifacts(job) {
  const names = new Set(job.files.map(f => f.relative));
  const nativeName = path.basename(job.flp).replace(/\.flp$/i, '.zip');
  const tempName = nativeName + '~';
  const allowed = name => (/\.wav\.zpa$/i.test(name) && names.has(name.slice(0, -4))) ||
    (name === tempName && job.generatedNativeTemp);
  const current = await walk(job.folder);
  const ignored = current.filter(f => allowed(f.relative)).map(f => f.relative);
  ignored.push(nativeName);
  const stable = await assertUnchanged(job.folder, job.files.filter(f => !allowed(f.relative)), ignored, { metadataOnly: true });
  for (const file of current.filter(f => allowed(f.relative))) {
    file.sha256 = await hashFile(file.full);
    if (!sameFingerprint(file, await fingerprint(file.full))) throw new Error(`Файл изменился при чтении: ${file.relative}`);
    stable.push(file);
  }
  return stable.sort((a,b) => a.relative.localeCompare(b.relative));
}

async function openArchive(file) {
  const zip = await new Promise((resolve,reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (e,z) => e ? reject(e) : resolve(z)));
  const entries = [], seen = new Set();
  try {
    await new Promise((resolve,reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        try {
          const name = entry.fileName;
          if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || seen.has(name.normalize('NFC').toLowerCase())) throw new Error(`Опасное или повторное имя ZIP: ${name}`);
          seen.add(name.normalize('NFC').toLowerCase());
          if (entry.generalPurposeBitFlag & 1) throw new Error('Зашифрованный ZIP не поддерживается');
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error(`Ссылка внутри ZIP: ${name}`);
          if (!/\/$/.test(name)) entries.push(entry);
          if (entries.length > 1000000) throw new Error('Слишком много записей ZIP');
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    return { zip, entries };
  } catch (error) { zip.close(); throw error; }
}
const openEntry = (zip, entry) => new Promise((resolve,reject) => zip.openReadStream(entry, (e,s) => e ? reject(e) : resolve(s)));
async function pooled(items, concurrency, fn) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) { const item = items[next++]; try { await fn(item); } catch (error) { failure ||= error; } }
  }));
  if (failure) throw failure;
}

export async function readZip(file, visitor, { concurrency = 1 } = {}) {
  const { zip, entries } = await openArchive(file);
  try { await pooled(entries, concurrency, async entry => visitor(entry, await openEntry(zip,entry))); }
  finally { zip.close(); }
}

function meterFor(entry, onBytes = () => {}) {
  const hash = crypto.createHash('sha256'); let checksum = 0, length = 0; const chunks = [];
  const capture = /\.flp$/i.test(entry.fileName);
  const stream = new Transform({ transform(b, _encoding, cb) {
    length += b.length; checksum = crc32(b, checksum); hash.update(b); onBytes(b.length);
    if (capture) { if (length > 256 * 1024 * 1024) return cb(new Error(`Слишком большой FLP/manifest: ${entry.fileName}`)); chunks.push(b); }
    cb(null,b);
  } });
  return { stream, finish() {
    if (length !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error(`CRC/размер не совпадает: ${entry.fileName}`);
    const item = { name: entry.fileName, size: length, sha256: hash.digest('hex') };
    if (/\.flp$/i.test(item.name)) item.flp = inspectFlp(Buffer.concat(chunks));
    return item;
  } };
}

function baseReport(entries, expectedMain) {
  if (entries.some(e => e.name.startsWith('__flpack__/'))) throw new Error('Архив пересобран старой версией FL Pack; нужен штатный экспорт');
  const mains = entries.filter(e => e.flp);
  if (mains.length !== 1 || mains[0].name.includes('/')) throw new Error('ZIP должен содержать ровно один FLP в корне');
  if (expectedMain && mains[0].name !== expectedMain) throw new Error('В ZIP оказался другой основной проект');
  return { entries, main: mains[0] };
}

// Validation is read-only: inflate each entry once and check its CRC and size.
// The file produced by FL Studio is never opened for writing.
export async function validateZip(file, { expectedMain, onProgress = () => {}, concurrency = 3 } = {}) {
  const { zip, entries: index } = await openArchive(file);
  const entries = []; let bytes = 0, completed = 0;
  const totalBytes = index.reduce((n,e) => n + e.uncompressedSize,0);
  const activeFiles = new Set();
  const emit = () => onProgress({file:[...activeFiles][0] || '',activeFiles:[...activeFiles],bytes,totalBytes,completed,totalFiles:index.length});
  try {
    await pooled(index,Math.max(1,Math.min(4,concurrency)),async entry => {
      activeFiles.add(entry.fileName);
      try {
        const meter = meterFor(entry,n => { bytes += n; emit(); });
        await pipeline(await openEntry(zip,entry),meter.stream,discard());
        entries.push(meter.finish()); completed++;
      } finally { activeFiles.delete(entry.fileName); emit(); }
    });
    const report = baseReport(entries,expectedMain);
    report.metrics = {bytes,entries:entries.length,concurrency,crc:'native'};
    emit(); return report;
  } finally { zip.close(); }
}

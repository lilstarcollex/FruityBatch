import path from 'node:path';

// Read only the documented FLP container and TLV framing. Never rewrite FLP data.
export function inspectFlp(data) {
  if (data.length < 22 || data.toString('ascii', 0, 4) !== 'FLhd' || data.readUInt32LE(4) !== 6 || data.toString('ascii', 14, 18) !== 'FLdt' || data.readUInt32LE(18) !== data.length - 22) throw new Error('Повреждён контейнер FLP');
  const events = []; let at = 22; let version;
  while (at < data.length) {
    const id = data[at++]; let size;
    // Since FL 25, 0xAC carries THREE bytes rather than the classic DWORD.
    // Reading four consumes the next opcode and silently misframes later events.
    if (id === 0xac && Number(version?.split('.')[0]) >= 25) size = 3;
    else if (id < 192) size = id < 64 ? 1 : id < 128 ? 2 : 4;
    else {
      size = 0; let shift = 0, byte;
      do { if (at >= data.length || shift > 28) throw new Error('Повреждена длина события FLP'); byte = data[at++]; size += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    }
    if (at + size > data.length) throw new Error('Обрезано событие FLP');
    const payload=data.subarray(at,at+size);
    if(id===199){
      const parsed=payload.toString('ascii').replace(/\0/g,'');
      if(!/^\d+\.\d+(?:\.\d+)*$/.test(parsed))throw new Error('Некорректная версия FLP');
      if(version&&version!==parsed)throw new Error('Несогласованные события версии FLP');
      version=parsed;
    }
    events.push({ id, data: payload }); at += size;
  }
  if (!/^\d+\.\d+/.test(version || '')) throw new Error('Не удалось определить версию FLP');
  const samples = events.filter(e => e.id === 196).map(e => e.data.toString('utf16le').replace(/\0/g, '')).filter(Boolean);
  return { version, samples, format: data.readUInt16LE(8), ppq: data.readUInt16LE(12), eventCount:events.length };
}

export function assertExportMatches(original, exported) {
  if(original.format!==exported.format||original.ppq!==exported.ppq)throw new Error('Экспорт изменил формат или разрешение проекта');
  const expected=new Set(original.samples.map(sampleName));
  const actual=new Set(exported.samples.map(sampleName));
  const missing=[...expected].filter(name=>!actual.has(name));
  const added=[...actual].filter(name=>!expected.has(name));
  if(missing.length||added.length)throw new Error(`Список сэмплов экспорта отличается: отсутствуют [${missing.join(', ')}]; добавлены [${added.join(', ')}]`);
}

export function chooseInstallation(version, installations) {
  const required = version.split('.').map(Number);
  const compare = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; };
  const usable = installations.filter(i => compare(i.version.split('.').map(Number), required) >= 0).sort((a,b) => compare(a.version.split('.').map(Number), b.version.split('.').map(Number)));
  const preferred = usable.find(i => i.year === 2025) || usable.find(i => i.year === 2026);
  if (!preferred) throw new Error(`Нужна FL Studio ${version} или новее; подходящая версия не найдена`);
  return preferred;
}

export const sampleName = value => path.win32.basename(value).normalize('NFC').toLowerCase();

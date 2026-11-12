// CAD read/write. DWG through @node-projects/acad-ts (read + write, keeps ACAD version),
// ASCII DXF through a group-code reader. Only text is touched; geometry is never rebuilt.

import { CadReader, DwgWriter } from '@node-projects/acad-ts';
import iconv from 'iconv-lite';

const MAX_LINES = 5000;

/** \U+4E2D style escapes appear in older MTEXT. */
const unescape = (s) => s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

/** MTEXT/DIMENSION strings carry control codes: \P = newline, {...} = formatting run. */
export function cleanCadText(raw) {
  if (typeof raw !== 'string') return '';
  let s = unescape(raw);
  s = s
    .replace(/\\P/g, '\n') // uppercase only: \p is paragraph formatting
    .replace(/\\~/g, ' ')
    .replace(/\\S([^;]*);/g, (_, a) => a.replace(/\^/g, '/')) // stacked 1^2
    .replace(/%%d/gi, '°')
    .replace(/%%c/gi, 'Ø')
    .replace(/%%p/gi, '±')
    .replace(/%%%/g, '%')
    .replace(/\\[A-Za-z][^;\\{}]*;/g, '') // \fArial|b0;  \H2.5;  \W0.8;
    .replace(/[{}]/g, '');
  return normLines(s);
}

/** Collapse whitespace per line and drop empty lines. */
export function normLines(s) {
  return String(s)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** DWG in memory. Throws with a readable message on an unparseable file. */
export function openDwg(buffer, name = 'drawing.dwg') {
  try {
    return CadReader.createReader(name, new Uint8Array(buffer)).read();
  } catch (err) {
    throw new Error(`DWG 解析失败：${err.message}`);
  }
}

/** Serialize a document back to DWG bytes, header version unchanged. */
export function writeDwg(doc, spareMB = 24) {
  const out = new Uint8Array(spareMB * 1024 * 1024);
  const w = new DwgWriter(out, doc);
  w.write();
  return Buffer.from(out.buffer, out.byteOffset, w.bytesWritten);
}

/**
 * The objects that hold a string for one entity. TEXT/MTEXT carry .value;
 * an INSERT carries one per attribute. Every holder exposes a writable .value.
 */
export function textHolders(e) {
  const out = [];
  if (typeof e.value === 'string') out.push(e);
  if (e.attributes) for (const a of e.attributes) if (typeof a.value === 'string') out.push(a);
  return out;
}

/** Every text holder in the file: model space first, then each block definition. */
export function walkTexts(doc) {
  const out = [];
  for (const e of doc.modelSpace?.entities || []) for (const h of textHolders(e)) out.push({ h, e, scope: 'model' });
  for (const b of doc.blockRecords || []) {
    for (const e of b.entities || []) for (const h of textHolders(e)) out.push({ h, e, scope: b.name });
  }
  return out;
}

/** Drawings repeat notes and blocks repeat per insert: one string is one job. */
function dedupe(lines) {
  const seen = new Set();
  return lines.filter((t) => !seen.has(t) && seen.add(t));
}

export function extractDoc(doc) {
  let model = 0;
  let blocks = 0;
  const lines = [];
  for (const { h, scope } of walkTexts(doc)) {
    const text = cleanCadText(h.value);
    if (!text) continue;
    const got = text.split('\n');
    if (scope === 'model') model += got.length;
    else blocks += got.length;
    lines.push(...got);
  }
  const unique = dedupe(lines);
  return {
    lines: unique.slice(0, MAX_LINES),
    model,
    blocks,
    dropped: Math.max(0, unique.length - MAX_LINES),
  };
}

/** Walk every text-bearing entity: model space + each block definition. */
export function extractDwg(buffer, name) {
  return extractDoc(openDwg(buffer, name));
}

/**
 * R2007+ DXFs are UTF-8; older AutoCAD saved ANSI, which for Chinese drawings means GBK.
 * Group codes are ASCII either way, so decoding the whole file is safe.
 */
export function decodeDxf(buf) {
  const utf8 = buf.toString('utf8');
  if (/[一-鿿]/.test(utf8)) return utf8;
  const gbk = iconv.decode(buf, 'gb18030');
  return /[一-鿿]/.test(gbk) ? gbk : utf8;
}

/** ASCII DXF: alternating group code / value lines; code 0 starts an entity, code 1 is its text. */
export function extractDxf(text) {
  const rows = String(text).split(/\r?\n/);
  const lines = [];
  let inText = false;
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const code = rows[i].trim();
    const value = rows[i + 1];
    if (code === '0') {
      inText = ['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'ARCALIGNEDTEXT'].includes(value.trim());
    } else if (inText && code === '1') {
      const t = cleanCadText(value);
      if (t) lines.push(...t.split('\n'));
    }
  }
  const unique = dedupe(lines);
  return {
    lines: unique.slice(0, MAX_LINES),
    model: lines.length,
    blocks: 0,
    dropped: Math.max(0, unique.length - MAX_LINES),
  };
}

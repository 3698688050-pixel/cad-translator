import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parseGlossary, matchTerms, protect, restore, lostTokens, isFullyGlossary,
} from './lib/core.js';
import { extractDwg, extractDxf, openDwg, decodeDxf, decodeText } from './lib/cad.js';
import { applyTranslations, gates, writeDwg } from './lib/export.js';
import { dwgToSvg } from './lib/preview.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const STORE = process.env.GLOSSARY_FILE || path.join(ROOT, 'data', 'glossary.json');
// Uploaded drawings are kept so the export step can re-open the exact bytes the user sent.
const UPLOADS = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
const PORT = Number(process.env.PORT || 5177);

const API_BASE = process.env.TRANSLATE_BASE_URL || 'https://api.deepseek.com';
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.TRANSLATE_API_KEY || '';
const MODEL = process.env.TRANSLATE_MODEL || 'deepseek-chat';
const CHUNK = 12;

// ---------- glossary store ----------
let glossary = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return {};
  }
}

function save() {
  // shortcut: whole-file write, fine at this size (<10k terms); switch to a real db if it ever grows
  const tmp = `${STORE}.tmp`;
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(glossary, null, 2));
  fs.renameSync(tmp, STORE);
}

function upsert(items) {
  let added = 0;
  let updated = 0;
  for (const { zh, en } of items) {
    const z = String(zh || '').trim();
    const e = String(en || '').trim();
    if (!z || !e) continue;
    if (glossary[z] === undefined) added++;
    else if (glossary[z] === e) continue;
    else updated++;
    glossary[z] = e;
  }
  if (added + updated) save();
  return { added, updated, total: Object.keys(glossary).length };
}

/** acad-ts writes non-ASCII as '?' until scripts/patch-acadts.py runs. Cheap check at boot. */
function gbkPatched() {
  try {
    const f = path.join(ROOT, 'node_modules/@node-projects/acad-ts/dist/IO/TextEncoding.js');
    return fs.readFileSync(f, 'utf8').includes('_GBK_MAP');
  } catch {
    return false;
  }
}

// ---------- translation ----------
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function callApi(payload) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '你是机械制图与工程图纸领域的中英翻译引擎。把中文图纸文字译成简洁、地道、符合欧美制图习惯的英文。'
            + '只输出 JSON，不要任何解释。',
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`翻译 API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('翻译 API 返回的不是 JSON');
  return JSON.parse(match[0]);
}

const RULES = [
  'segments 里的 zh 含 ⟦n⟧ 形式的占位符，代表已确定术语。译文必须逐字保留占位符（编号不可改、不可增删），按英文语序放到正确位置。',
  'glossary 只用于帮你理解上下文，不要把它作为输出内容。',
  '术语优先用英文短称或行业常用缩写（图面空间有限，长全称会压线）。例外：占位符 ⟦n⟧ 里的译法就是标准答案，即使它比短称长也必须照用——词库永远优先于短称。',
  '标题栏、图框、表格里的文字（图名、公司名、日期、图号、材料、比例）同样要译成英文，不要原样保留中文，也不要跳过。',
  'newTerms 只收录原文中真实出现、但 glossary 里没有的专业名词，最多 8 条；zh 必须是原文的连续子串，长度 ≥ 2；普通动词助词不要收录。',
  '返回 {"items":[{"id":数字,"en":"译文"}],"newTerms":[{"zh":"中文","en":"English"}]}。',
];

async function translateChunk(entries) {
  const subset = {};
  for (const e of entries) for (const h of e.hits) subset[h.zh] = h.en;
  const out = await callApi({
    task: 'translate',
    rules: RULES,
    glossary: subset,
    segments: entries.map((e) => ({ id: e.id, zh: e.template })),
  });
  const byId = new Map();
  for (const it of out.items || []) byId.set(Number(it.id), String(it.en || '').trim());
  return { byId, newTerms: Array.isArray(out.newTerms) ? out.newTerms : [] };
}

/** Second chance for a line whose placeholders the model ate: plain text, glossary as hints only. */
async function translatePlain(entry) {
  const out = await callApi({
    task: 'translate',
    rules: [
      '译文必须采用 glossary 中给出的固定译法，不要改写这些术语。',
      '只返回 {"items":[{"id":数字,"en":"译文"}],"newTerms":[]}。',
    ],
    glossary: Object.fromEntries(entry.hits.map((h) => [h.zh, h.en])),
    segments: [{ id: entry.id, zh: entry.src }],
  });
  const it = (out.items || []).find((x) => Number(x.id) === entry.id);
  return it ? String(it.en || '').trim() : '';
}

async function translateLines(lines) {
  const entries = lines.map((src, i) => {
    const hits = matchTerms(src, glossary);
    return { id: i, src, hits, template: protect(src, hits) };
  });

  const results = new Map();
  const todo = [];
  for (const e of entries) {
    if (isFullyGlossary(e.src, e.hits)) {
      results.set(e.id, { out: e.hits[0].en, source: 'glossary', misses: false });
    } else if (!/[\u4e00-\u9fff]/.test(e.src)) {
      // part numbers, sizes, ASCII notes: nothing to translate, and no API call paid for
      results.set(e.id, { out: e.src, source: 'asis', misses: false });
    } else {
      todo.push(e);
    }
  }

  const candidates = new Map(); // zh -> en
  const warnings = [];
  if (todo.length && !API_KEY) {
    throw new Error('未配置 DEEPSEEK_API_KEY，无法翻译词库以外的行。设置环境变量后重启服务，或先把这些术语加进词库。');
  }

  for (const part of chunk(todo, CHUNK)) {
    let reply;
    try {
      reply = await translateChunk(part);
    } catch (err) {
      warnings.push(err.message);
      continue;
    }
    for (const e of part) {
      let en = reply.byId.get(e.id) || '';
      let misses = false;
      if (!en || lostTokens(en, e.hits)) {
        // placeholder lost (or empty) -> retry this line as plain text
        try {
          const plain = await translatePlain(e);
          if (plain) en = plain;
        } catch (err) {
          warnings.push(err.message);
        }
        misses = e.hits.length > 0;
      }
      const out = e.hits.length ? restore(en, e.hits) : en;
      results.set(e.id, {
        out,
        source: e.hits.length ? 'mixed' : 'api',
        misses,
      });
    }
    for (const t of reply.newTerms) {
      const zh = String(t?.zh || '').trim();
      const en = String(t?.en || '').trim();
      if (zh.length < 2 || !en) continue;
      if (glossary[zh] !== undefined) continue;
      if (!part.some((e) => e.src.includes(zh))) continue;
      if (!candidates.has(zh)) candidates.set(zh, en);
    }
  }

  const segments = entries.map((e) => {
    const r = results.get(e.id) || { out: '', source: 'error', misses: false };
    return {
      i: e.id + 1,
      src: e.src,
      out: r.out,
      source: r.source,
      misses: r.misses,
      hits: e.hits.map((h) => ({ zh: h.zh, en: h.en })),
    };
  });

  return { segments, candidates: [...candidates].map(([zh, en]) => ({ zh, en })), warnings };
}

// ---------- http ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (b) => {
      size += b.length;
      if (size > limit) {
        reject(new Error('内容过大'));
        req.destroy();
        return;
      }
      parts.push(b);
    });
    req.on('end', () => {
      const buf = Buffer.concat(parts);
      resolve(encoding ? buf.toString(encoding) : buf);
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  // One line per request: without it a browser-side failure is invisible from here.
  res.on('finish', () => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${p} ${res.statusCode}`));
  try {
    if (p === '/api/state') {
      return json(res, 200, {
        terms: Object.keys(glossary).length,
        apiReady: Boolean(API_KEY),
        engine: API_KEY ? MODEL : '未配置',
      });
    }

    if (p === '/api/glossary' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const all = Object.entries(glossary).map(([zh, en]) => ({ zh, en }));
      const list = q
        ? all.filter((t) => t.zh.toLowerCase().includes(q) || t.en.toLowerCase().includes(q))
        : all;
      list.sort((a, b) => b.zh.length - a.zh.length || a.zh.localeCompare(b.zh, 'zh'));
      return json(res, 200, { total: all.length, matched: list.length, terms: list.slice(0, 200) });
    }

    if (p === '/api/glossary/import' && req.method === 'POST') {
      // Excel on a Chinese Windows saves CSV as GBK, not UTF-8; decode both.
      const text = decodeText(await readBody(req, 8 * 1024 * 1024, null));
      const rows = parseGlossary(text);
      if (!rows.length) return json(res, 400, { error: '没解析出词条，检查是否为「中文,English」每行一条' });
      return json(res, 200, { ...upsert(rows), parsed: rows.length });
    }

    if (p === '/api/glossary/items' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = Array.isArray(body.items) ? body.items : [body];
      return json(res, 200, upsert(items));
    }

    if (p === '/api/glossary/item' && req.method === 'DELETE') {
      const zh = url.searchParams.get('zh') || '';
      if (glossary[zh] === undefined) return json(res, 404, { error: '词条不存在' });
      delete glossary[zh];
      save();
      return json(res, 200, { total: Object.keys(glossary).length });
    }

    if (p === '/api/glossary/clear' && req.method === 'POST') {
      glossary = {};
      save();
      return json(res, 200, { total: 0 });
    }

    if (p === '/api/glossary/export') {
      const rows = Object.entries(glossary)
        .map(([zh, en]) => `"${zh.replace(/"/g, '""')}","${en.replace(/"/g, '""')}"`)
        .join('\r\n');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="glossary.csv"',
      });
      return res.end(`\ufeff中文,English\r\n${rows}\r\n`);
    }

    if (p === '/api/extract' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || '').toLowerCase();
      const buf = await readBody(req, 80 * 1024 * 1024, null);
      const started = Date.now();
      const isDwg = name.endsWith('.dwg');
      if (!isDwg && !name.endsWith('.dxf')) return json(res, 400, { error: '只支持 .dwg 和 .dxf' });
      const out = isDwg ? extractDwg(buf, name) : extractDxf(decodeDxf(buf));

      // Keep the bytes: the export step re-opens the original, never a re-read of extracted text.
      let id = null;
      if (isDwg && out.lines.length) {
        id = crypto.randomBytes(8).toString('hex');
        fs.mkdirSync(UPLOADS, { recursive: true });
        fs.writeFileSync(path.join(UPLOADS, `${id}.dwg`), buf);
        fs.writeFileSync(path.join(UPLOADS, `${id}.json`), JSON.stringify({ id, name: url.searchParams.get('name') || 'drawing.dwg' }));
      }

      if (!out.lines.length) {
        return json(res, 200, {
          ...out,
          id,
          tookMs: Date.now() - started,
          errorText:
            '这个文件里没读到文字。常见原因：文字在外部参照（xref）里、图块未被展开，或文字是图形化的线条。\n' +
            '办法：在 CAD 里 XREF 绑定外部参照、分解图块后另存为 DXF，再导入（DXF 一定能读）。',
        });
      }
      return json(res, 200, { ...out, id, canExport: isDwg, tookMs: Date.now() - started });
    }

    if (p === '/api/export' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '').replace(/[^a-f0-9]/g, '');
      const src = path.join(UPLOADS, `${id}.dwg`);
      if (!id || !fs.existsSync(src)) return json(res, 400, { error: '找不到原图，请重新导入 DWG' });
      const map = body.map && typeof body.map === 'object' ? body.map : {};
      if (!Object.keys(map).length) return json(res, 400, { error: '还没有译文可以写回' });

      const started = Date.now();
      const raw = fs.readFileSync(src);
      const before = openDwg(raw);
      const doc = openDwg(raw);
      const applied = applyTranslations(doc, map);
      const bytes = writeDwg(doc);
      const after = openDwg(bytes);
      const check = gates(before, after);

      const meta = JSON.parse(fs.readFileSync(path.join(UPLOADS, `${id}.json`), 'utf8'));
      const outName = `${meta.name.replace(/\.dwg$/i, '')}-EN.dwg`;
      fs.writeFileSync(path.join(UPLOADS, `${id}-EN.dwg`), bytes);
      // The preview of the previous export would otherwise keep showing the old text.
      fs.rmSync(path.join(UPLOADS, `${id}-EN.svg`), { force: true });
      const small = applied.log.filter((x) => x.hTo < x.hFrom * 0.7 - 0.01).length;

      return json(res, 200, {
        id,
        name: outName,
        bytes: bytes.length,
        changed: applied.changed,
        shrunk: applied.shrunk,
        shrunkHard: small,
        skipped: applied.residual.length,
        gates: check,
        download: `/api/export/download?id=${id}`,
        tookMs: Date.now() - started,
      });
    }

    // The drawing itself, drawn in the browser. which=en is the rewritten file if it exists.
    if (p === '/api/preview' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      const want = url.searchParams.get('which') === 'en' ? '-EN' : '';
      const src = path.join(UPLOADS, `${id}${want}.dwg`);
      if (!id || !fs.existsSync(src)) return json(res, 404, { error: '找不到图纸，请重新导入' });
      const cache = path.join(UPLOADS, `${id}${want}.svg`);
      let svg = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : null;
      if (!svg) {
        try {
          svg = (await dwgToSvg(fs.readFileSync(src))).svg;
        } catch (err) {
          return json(res, 500, { error: `图形渲染失败：${err.message}` });
        }
        fs.writeFileSync(cache, svg);
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(svg);
    }

    if (p === '/api/export/download' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '').replace(/[^a-f0-9]/g, '');
      const file = path.join(UPLOADS, `${id}-EN.dwg`);
      if (!id || !fs.existsSync(file)) return json(res, 404, { error: '还没有导出文件' });
      const meta = JSON.parse(fs.readFileSync(path.join(UPLOADS, `${id}.json`), 'utf8'));
      const name = `${meta.name.replace(/\.dwg$/i, '')}-EN.dwg`;
      res.writeHead(200, {
        'content-type': 'application/acad',
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      return fs.createReadStream(file).pipe(res);
    }

    if (p === '/api/translate' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const lines = String(body.text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!lines.length) return json(res, 400, { error: '原文是空的' });
      if (lines.length > 400) return json(res, 400, { error: '一次最多 400 行，请分批翻译' });
      const started = Date.now();
      const result = await translateLines(lines);
      return json(res, 200, { ...result, tookMs: Date.now() - started, terms: Object.keys(glossary).length });
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'no such endpoint' });
    return serveStatic(res, p);
  } catch (err) {
    return json(res, 500, { error: err.message || '服务出错' });
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`图译 running at http://localhost:${PORT}`);
  console.log(`词库: ${STORE} (${Object.keys(glossary).length} 条)`);
  if (!gbkPatched()) {
    console.log('⚠ acad-ts 未打 GBK 补丁，导出 DWG 时中文会变成 ? —— 先跑 npm run setup');
  }
  console.log(
    API_KEY
      ? `翻译引擎: ${MODEL} @ ${API_BASE}`
      : '翻译引擎: 未配置 —— 只做词库翻译。设置 DEEPSEEK_API_KEY 后重启。',
  );
});

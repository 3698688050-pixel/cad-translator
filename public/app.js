const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const el = {
  rows: $('#rows'),
  empty: $('#empty'),
  notice: $('#notice'),
  run: $('#run'),
  source: $('#source'),
  srcMeta: $('#srcMeta'),
  statTerms: $('#statTerms'),
  statEngine: $('#statEngine'),
  statHits: $('#statHits'),
  termCount: $('#termCount'),
  termList: $('#termList'),
  termQuery: $('#termQuery'),
  drop: $('#drop'),
  candBar: $('#candBar'),
  candCount: $('#candCount'),
  candList: $('#candList'),
  copyAll: $('#copyAll'),
  downloadCsv: $('#downloadCsv'),
  exportDwg: $('#exportDwg'),
};

let segments = [];
let pending = [];
// The uploaded drawing the export step writes into. Cleared when the source is replaced by text.
let cad = null;
const added = new Set();
let searchTimer = 0;

/* ---------------- glossary rail ---------------- */

async function refreshState() {
  const s = await fetch('/api/state').then((r) => r.json());
  el.statTerms.textContent = s.terms;
  el.statEngine.textContent = s.apiReady ? s.engine : '未配置';
  el.termCount.textContent = `${s.terms} 条`;
  return s;
}

async function loadTerms() {
  const q = el.termQuery.value.trim();
  const data = await fetch(`/api/glossary?q=${encodeURIComponent(q)}`).then((r) => r.json());
  el.termCount.textContent = q ? `${data.matched} / ${data.total} 条` : `${data.total} 条`;
  el.statTerms.textContent = data.total;
  if (!data.terms.length) {
    el.termList.innerHTML = `<li class="terms-empty">${q ? '没有匹配的词条' : '词库是空的，导入 CSV 或手动添加第一条'}</li>`;
    return;
  }
  el.termList.innerHTML = data.terms
    .map(
      (t) => `<li>
        <span class="zh">${esc(t.zh)}</span>
        <span class="en" title="${esc(t.en)}">${esc(t.en)}</span>
        <button type="button" class="del" data-zh="${esc(t.zh)}" title="删除 ${esc(t.zh)}" aria-label="删除 ${esc(t.zh)}">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>
        </button>
      </li>`,
    )
    .join('');
}

async function addTerms(items, label) {
  if (!items.length) return;
  const res = await fetch('/api/glossary/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
  }).then((r) => r.json());
  if (res.error) return say(res.error, 'warn');
  items.forEach((t) => added.add(t.zh));
  await Promise.all([refreshState(), loadTerms()]);
  renderChips();
  say(`${label || '已加入词库'}：新增 ${res.added}，覆盖 ${res.updated}，现有 ${res.total} 条`, 'ok');
}

/* ---------------- translation ---------------- */

function lineCount() {
  return el.source.value.split('\n').filter((s) => s.trim()).length;
}

function markupZh(src, hits) {
  let out = '';
  let pos = 0;
  hits.forEach((h, n) => {
    const i = src.indexOf(h.zh, pos);
    if (i < 0) return;
    out += esc(src.slice(pos, i));
    out += `<span class="hit">${esc(h.zh)}<sup class="balloon">${n + 1}</sup></span>`;
    pos = i + h.zh.length;
  });
  return out + esc(src.slice(pos));
}

function markupEn(dst, hits) {
  let out = '';
  let pos = 0;
  hits.forEach((h, n) => {
    const i = dst.toLowerCase().indexOf(h.en.toLowerCase(), pos);
    if (i < 0) return;
    out += esc(dst.slice(pos, i));
    out += `<span class="hit">${esc(dst.slice(i, i + h.en.length))}<sup class="balloon">${n + 1}</sup></span>`;
    pos = i + h.en.length;
  });
  return out + esc(dst.slice(pos));
}

function chipHtml(item) {
  const done = added.has(item.zh);
  return `<span class="chip${done ? ' done' : ''}">
    <span>${esc(item.zh)}</span>
    <span class="pair">${esc(item.en)}</span>
    ${done
      ? '<button type="button" disabled>已入库</button>'
      : `<button type="button" data-add="${esc(item.zh)}">加入词库</button>`}
  </span>`;
}

function rowHtml(s, idx) {
  const hits = s.hits || [];
  const prov =
    s.source === 'glossary'
      ? '整行命中词库'
      : s.source === 'asis'
        ? '无需翻译'
        : hits.length
          ? `词库命中 ${hits.length} 处`
          : 'API 自动翻译';
  return `<article class="row" data-i="${s.i}" style="--d:${Math.min(idx, 24) * 55}ms">
    <div class="row-i">${String(s.i).padStart(2, '0')}</div>
    <div class="row-body">
      <p class="src">${markupZh(s.src, hits)}</p>
      <p class="dst${s.out ? '' : ' pending'}">${s.out ? markupEn(s.out, hits) : '这一行没能译出，检查 API 配置后重试'}</p>
      <div class="row-meta">
        <span class="tag${s.source === 'glossary' ? ' gloss' : ''}">${esc(prov)}</span>
        ${s.misses ? '<span class="tag warn">词库译法未采用，请人工核对</span>' : ''}
      </div>
    </div>
  </article>`;
}

function renderChips() {
  const open = pending.filter((c) => !added.has(c.zh));
  el.candList.innerHTML = open.map(chipHtml).join('');
  el.candCount.textContent = String(open.length);
  el.candBar.hidden = open.length === 0;
}

function renderRows() {
  el.rows.innerHTML = segments.map(rowHtml).join('');
  const has = segments.length > 0;
  el.rows.hidden = !has;
  el.empty.hidden = has;
  el.copyAll.disabled = !has;
  el.downloadCsv.disabled = !has;
  el.exportDwg.setAttribute('aria-disabled', String(!(has && cad?.canExport)));
}

function say(msg, kind = '') {
  el.notice.textContent = msg;
  el.notice.className = `notice${kind ? ` ${kind}` : ''}`;
}

async function translate() {
  const lines = el.source.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return say('先粘贴或导入要翻译的图纸文字', 'warn');
  el.run.disabled = true;
  el.run.setAttribute('aria-busy', 'true');
  segments = [];
  pending = [];
  added.clear();
  renderRows();
  renderChips();
  const BATCH = 150;
  const batches = [];
  for (let i = 0; i < lines.length; i += BATCH) batches.push(lines.slice(i, i + BATCH));
  let hitCount = 0;
  let terms = 0;
  const warnText = [];
  const started = Date.now();
  try {
    for (let k = 0; k < batches.length; k++) {
      say(
        batches.length > 1
          ? `正在翻译第 ${k + 1}/${batches.length} 批（共 ${lines.length} 行）…`
          : `正在翻译 ${lines.length} 行…`,
      );
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: batches[k].join('\n') }),
      }).then((r) => r.json());
      if (res.error) {
        say(res.error, 'warn');
        break;
      }
      const base = segments.length;
      for (const s of res.segments) segments.push({ ...s, i: base + s.i });
      for (const c of res.candidates) if (!pending.some((p) => p.zh === c.zh)) pending.push(c);
      hitCount += res.segments.reduce((n, s) => n + (s.hits ? s.hits.length : 0), 0);
      terms = res.terms;
      if (res.warnings) warnText.push(...res.warnings);
      renderRows();
      renderChips();
    }
    el.statHits.textContent = String(hitCount);
    el.statTerms.textContent = String(terms);
    el.termCount.textContent = `${terms} 条`;
    const bits = [
      `${segments.length} 行译完 · 词库命中 ${hitCount} 处 · ${Date.now() - started} ms`,
    ];
    if (pending.length) bits.push(`${pending.length} 个新术语待确认`);
    if (warnText.length) bits.push(`API 警告：${warnText[0]}`);
    say(bits.join(' · '), warnText.length ? 'warn' : '');
  } catch (err) {
    say(`翻译失败：${err.message}`, 'warn');
  } finally {
    el.run.disabled = false;
    el.run.removeAttribute('aria-busy');
  }
}

/* ---------------- clipboard / export ---------------- */

async function copyAll() {
  const text = segments.map((s) => s.out).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    say(`已复制 ${segments.length} 行译文`, 'ok');
  } catch {
    say('浏览器拒绝了剪贴板访问，请手动选择译文复制', 'warn');
  }
}

function downloadCsv() {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const body = segments.map((s) => [q(s.src), q(s.out), q(s.source)].join(',')).join('\r\n');
  const blob = new Blob([`\ufeff原文,译文,来源\r\n${body}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'translation.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- write back into the drawing ---------------- */

function exportBlocker() {
  if (!cad) return '上面还没导入 DWG 原图 —— 拖入 .dwg 文件，或点「导入 DWG」。贴在框里的文字只能翻译，不能写回图纸。';
  if (!cad.canExport) return '这张是 DXF，只能翻译。写回请先在 CAD 里另存为 DWG，再导入这个 DWG。';
  if (!cad.id) return '这个 DWG 里没读到文字，没有可写回的内容。检查文字是否在未绑定的外部参照里。';
  if (!segments.length) return '先点「翻译」。译文出来后这个按钮才能把译文写回原图。';
  return '';
}

async function exportDwg() {
  const blocked = exportBlocker();
  if (blocked) return say(blocked, 'warn');
  const map = {};
  for (const s of segments) if (s.src && s.out) map[s.src] = s.out;
  if (!Object.keys(map).length) return say('还没有译文可写回', 'warn');

  el.exportDwg.disabled = true; // real disabled only while the request is in flight
  say(`正在把 ${Object.keys(map).length} 条译文写回图纸并校验…`);
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: cad.id, map }),
    }).then((r) => r.json());
    if (res.error) return say(res.error, 'warn');

    const g = res.gates;
    const bits = [`${res.name}：改写 ${res.changed} 处文字`];
    if (res.shrunk) {
      bits.push(
        res.shrunkHard
          ? `缩字号 ${res.shrunk} 处，其中 ${res.shrunkHard} 处低于原字号 70%`
          : `缩字号 ${res.shrunk} 处`,
      );
    }
    bits.push(g.residualChinese ? `⚠ 残留中文 ${g.residualChinese} 处` : '残留中文 0');
    if (g.entityCounts.length) bits.push(`⚠ 实体数变化 ${g.entityCounts.length} 类`);
    if (g.layers.lost.length) bits.push(`⚠ 丢了图层 ${g.layers.lost.slice(0, 3).join('、')}`);
    if (g.blocks.lost.length) bits.push(`⚠ 丢了图块 ${g.blocks.lost.slice(0, 3).join('、')}`);
    if (g.newCollisions.length) bits.push(`⚠ ${g.newCollisions.length} 处文字新压线（${g.newCollisions[0].handle} 等）`);
    say(bits.join(' · '), g.ok && !g.newCollisions.length ? 'ok' : 'warn');

    // WeChat / DingTalk / some mobile browsers silently drop a programmatic click,
    // so the download is also offered as a real link.
    const a = document.createElement('a');
    a.href = res.download;
    a.download = res.name;
    a.textContent = `↓ ${res.name}`;
    a.className = 'dl';
    a.click();
    el.notice.append(' ', a);
  } catch (err) {
    say(`导出失败：${err.message}`, 'warn');
  } finally {
    el.exportDwg.disabled = false;
    renderRows();
  }
}

/* ---------------- events ---------------- */

el.source.addEventListener('input', () => {
  el.srcMeta.textContent = `${lineCount()} 行`;
});
el.source.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    translate();
  }
});

el.run.addEventListener('click', translate);
el.copyAll.addEventListener('click', copyAll);
el.exportDwg.addEventListener('click', exportDwg);
el.downloadCsv.addEventListener('click', downloadCsv);

$('#sample').addEventListener('click', () => {
  el.source.value = [
    '底板采用Q235钢板，未注倒角C1',
    'M8螺栓与垫圈按装配图顺序拧紧，力矩18 N·m',
    '技术要求：去毛刺，表面粗糙度Ra3.2',
    '轴承座与支架焊接后加工，保证同轴度φ0.02',
    '装配后手动盘车，不得有卡滞',
  ].join('\n');
  el.srcMeta.textContent = `${lineCount()} 行`;
});

$('#pickSource').addEventListener('click', () => $('#sourceFile').click());
$('#sourceFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadSource(file);
  e.target.value = '';
});

async function loadSource(file) {
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.dwg') || name.endsWith('.dxf')) {
      say(`正在从 ${file.name} 里读文字…`);
      const res = await fetch(`/api/extract?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      }).then((r) => r.json());
      if (res.error) return say(res.error, 'warn');
      if (res.errorText) return say(`${file.name}：${res.errorText}`, 'warn');
      el.source.value = res.lines.join('\n');
      el.srcMeta.textContent = `${lineCount()} 行`;
      // Without this the export step has no drawing to write into.
      cad = { id: res.id, name: file.name, canExport: Boolean(res.canExport) };
      renderRows();
      const where = res.blocks ? `模型空间 ${res.model} 行 + 图块内 ${res.blocks} 行` : `${res.model} 行`;
      const extra = res.dropped ? `（超过 ${res.lines.length} 行的部分已截断）` : '';
      const note = res.canExport ? '；点「翻译」，之后就能导出改好的 DWG' : '；DXF 只做翻译，写回请在 CAD 里另存为 DWG 后导入';
      return say(`已从 ${file.name} 读到 ${res.lines.length} 行去重文字：${where}，${res.tookMs} ms${extra}${note}`, 'ok');
    }
    cad = null;
    renderRows();
    el.source.value = await file.text();
    el.srcMeta.textContent = `${lineCount()} 行`;
    say(`已载入 ${file.name}`, 'ok');
  } catch (err) {
    say(`读取 ${file.name} 失败：${err.message}`, 'warn');
  }
}

/* drop a drawing / text file straight onto the text area */
['dragenter', 'dragover'].forEach((ev) =>
  el.source.addEventListener(ev, (e) => {
    e.preventDefault();
    el.source.classList.add('drop-hot');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  el.source.addEventListener(ev, (e) => {
    e.preventDefault();
    el.source.classList.remove('drop-hot');
  }),
);
el.source.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadSource(file);
});

/* glossary upload: click, drag & drop */
$('#pickGlossary').addEventListener('click', () => $('#glossaryFile').click());
$('#glossaryFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await importGlossary(file);
  e.target.value = '';
});

async function importGlossary(file) {
  const text = await file.text();
  const res = await fetch('/api/glossary/import', { method: 'POST', body: text }).then((r) => r.json());
  if (res.error) return say(res.error, 'warn');
  await Promise.all([refreshState(), loadTerms()]);
  say(`${file.name}：新增 ${res.added} 条，覆盖 ${res.updated} 条，现共 ${res.total} 条`, 'ok');
}

['dragenter', 'dragover'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  el.drop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.drop.classList.remove('over');
  }),
);
el.drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) importGlossary(file);
});

$('#termForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const zh = form.zh.value.trim();
  const en = form.en.value.trim();
  if (!zh || !en) return;
  addTerms([{ zh, en }], `已加入「${zh}」`);
  form.reset();
  form.zh.focus();
});

el.termList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-zh]');
  if (!btn) return;
  const zh = btn.dataset.zh;
  const res = await fetch(`/api/glossary/item?zh=${encodeURIComponent(zh)}`, { method: 'DELETE' }).then((r) => r.json());
  if (res.error) return say(res.error, 'warn');
  await Promise.all([refreshState(), loadTerms()]);
  say(`已删除「${zh}」`, 'ok');
});

el.termQuery.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadTerms, 160);
});

$('#clearGlossary').addEventListener('click', async () => {
  if (!el.termCount.textContent) return;
  if (!window.confirm('清空整个词库？此操作不可撤销（可先导出 CSV 备份）。')) return;
  await fetch('/api/glossary/clear', { method: 'POST' });
  await Promise.all([refreshState(), loadTerms()]);
  say('词库已清空', 'ok');
});

/* candidate chips in the pending bar */
function onChipClick(e) {
  const btn = e.target.closest('[data-add]');
  if (!btn) return;
  const zh = btn.dataset.add;
  const item = pending.find((c) => c.zh === zh);
  if (item) addTerms([item], `已入库「${zh}」`);
}

el.candList.addEventListener('click', onChipClick);

$('#addAllCands').addEventListener('click', () => {
  const open = pending.filter((c) => !added.has(c.zh));
  addTerms(open, `已加入 ${open.length} 个新术语`);
});

$('#dismissCands').addEventListener('click', () => {
  pending = [];
  renderChips();
  say('这批新术语没有入库', '');
});

/* ---------------- boot ---------------- */
refreshState().catch(() => say('服务未响应，确认 node server.js 在运行', 'warn'));
loadTerms().catch(() => {});
el.srcMeta.textContent = '0 行';
renderChips();

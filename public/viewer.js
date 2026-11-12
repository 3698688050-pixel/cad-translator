// Pan/zoom preview of the drawing. Zoom works by rewriting the SVG viewBox instead of a CSS
// transform: a CSS scale just stretches an already-rasterised picture, which turns small CAD
// text into smears, while a viewBox change makes the browser redraw it sharp at any zoom.
const paper = document.querySelector('#paper');
const pct = document.querySelector('#pct');
const dl = document.querySelector('#dl');
const btnSrc = document.querySelector('#whichSrc');
const btnEn = document.querySelector('#whichEn');
const fit = document.querySelector('#fit');

const params = new URLSearchParams(location.search);
const id = params.get('id') || '';
const hasEn = params.get('en') === '1' || params.get('which') === 'en';
let which = hasEn ? 'en' : 'src';

let svg = null;
let base = null; // the drawing's own viewBox: { x, y, w, h }
let view = null; // what is currently shown, same units, aspect locked to the box

const box = () => {
  const r = paper.getBoundingClientRect();
  return { w: r.width || 1, h: r.height || 1 };
};

/** Whole drawing visible, no letterbox (the viewBox aspect always matches the box). */
function fitView() {
  const { w, h } = box();
  const ratio = h / w;
  let vw = base.w;
  let vh = base.w * ratio;
  if (vh < base.h) {
    vh = base.h;
    vw = base.h / ratio;
  }
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  view = { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
  apply();
}

function apply() {
  if (!svg || !view) return;
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  pct.textContent = `${Math.round((view.w ? baseW / view.w : 1) * 100)}%`;
}

let baseW = 1;

async function load() {
  paper.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'msg',
    textContent: '正在生成图形…',
  }));
  fit.hidden = true;
  let res = await fetch(`/api/preview?id=${id}&which=${which}`);
  // The rewritten file may not exist yet; showing the original beats showing an error.
  if (!res.ok && which === 'en') {
    which = 'src';
    res = await fetch(`/api/preview?id=${id}&which=src`);
  }
  const body = await res.text();
  if (!res.ok) {
    let msg = '图形打不开';
    try { msg = JSON.parse(body).error || msg; } catch {}
    paper.innerHTML = '';
    paper.append(Object.assign(document.createElement('p'), { className: 'msg', textContent: msg }));
    return;
  }
  paper.innerHTML = body.replace(/<\?xml[^>]*\?>/, '');
  svg = paper.querySelector('svg');
  if (!svg) return;
  // The server's own sizing attributes fight the viewBox we drive, so drop them.
  for (const a of ['width', 'height', 'style', 'preserveAspectRatio']) svg.removeAttribute(a);
  // The preview only has to answer "is anything missing / is the text right": lines white, text
  // yellow, nothing else. Layer colours and fills are dropped (a white-filled solid reads as a
  // smear over the text), and hairlines are pinned to 1px — DWG strokes are 1 drawing unit wide,
  // which at this zoom is a fraction of a pixel and looks like the line is missing.
  // Block instances (<use>) are clones, so their own attributes miss CSS/DOM edits: the same
  // rewrite on the <defs> source is what the clone inherits.
  for (const el of svg.querySelectorAll('*')) {
    const isText = el.tagName === 'text' || el.tagName === 'tspan';
    if (isText) {
      el.setAttribute('stroke', 'none');
      el.setAttribute('fill', '#ffe14d');
      continue;
    }
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', '#fff');
    el.setAttribute('stroke-width', '1');
    el.setAttribute('vector-effect', 'non-scaling-stroke');
  }
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  base = vb.length === 4 && vb.every((n) => Number.isFinite(n))
    ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }
    : { x: 0, y: 0, w: 100, h: 100 };
  baseW = base.w;
  fit.hidden = false;
  renderTabs();
  fitView();
}

function renderTabs() {
  btnSrc.setAttribute('aria-pressed', String(which === 'src'));
  btnEn.setAttribute('aria-pressed', String(which === 'en'));
  btnEn.hidden = !hasEn;
  dl.href = `/api/export/download?id=${id}`;
  dl.hidden = !hasEn;
}

/* drag to pan */
let drag = null;
paper.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  paper.classList.add('drag');
  paper.setPointerCapture(e.pointerId);
});
paper.addEventListener('pointermove', (e) => {
  if (!drag || !view) return;
  const { w, h } = box();
  view.x = drag.vx - ((e.clientX - drag.x) / w) * view.w;
  view.y = drag.vy - ((e.clientY - drag.y) / h) * view.h;
  apply();
});
const endDrag = () => { drag = null; paper.classList.remove('drag'); };
paper.addEventListener('pointerup', endDrag);
paper.addEventListener('pointercancel', endDrag);

/* wheel zoom around the cursor */
paper.addEventListener('wheel', (e) => {
  if (!svg || !view) return;
  e.preventDefault();
  const r = paper.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  const zoom = Math.min(200, Math.max(0.25, (baseW / view.w) * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  const nw = baseW / zoom;
  const nh = nw * (r.height / r.width);
  const ux = view.x + fx * view.w;
  const uy = view.y + fy * view.h;
  view = { x: ux - fx * nw, y: uy - fy * nh, w: nw, h: nh };
  apply();
}, { passive: false });

fit.addEventListener('click', fitView);
btnSrc.addEventListener('click', () => { if (which !== 'src') { which = 'src'; load(); } });
btnEn.addEventListener('click', () => { if (which !== 'en') { which = 'en'; load(); } });

if (!id) {
  paper.innerHTML = '<p class="msg">缺少图纸 id。回到主页面导入 DWG 再点「看图」。</p>';
} else {
  load();
}

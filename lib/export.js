// Write translations back into a DWG: same position, same layer, same size where it fits.
// Pure helpers are exported so the assertions in test/export.test.js can check them.

import { cleanCadText, normLines, writeDwg } from './cad.js';

/** MTEXT/TEXT inline codes. Braces are formatting runs, not text, so they stay verbatim. */
const CTRL = /\\[A-Za-z][^;\\{}]*;|\\P|[{}]/g;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Map key for one text run: whitespace collapsed, so wrapped MTEXT still matches. */
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Replace only the text runs of one string, leaving every control code in place.
 * `map` is { 原文: 译文 }.
 */
export function replaceRuns(raw, map, re = new RegExp(CTRL.source, 'g')) {
  const parts = [];
  let last = 0;
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) parts.push({ ctl: false, v: raw.slice(last, m.index) });
    parts.push({ ctl: true, v: m[0] });
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ ctl: false, v: raw.slice(last) });

  let changed = false;
  const missed = [];
  for (const p of parts) {
    if (p.ctl) continue;
    const key = norm(p.v);
    if (!key) continue;
    if (map[key]) {
      p.v = map[key];
      changed = true;
    } else if (CJK.test(key)) {
      missed.push(key);
    }
  }
  return { text: parts.map((p) => p.v).join(''), changed, missed };
}

/** Estimate rendered width. Coefficients are deliberately different from the gate's. */
export function textWidth(str, h, wf, k = {}) {
  const CJK_W = k.cjk ?? 1.0;
  const ASC = k.ascii ?? 0.5;
  const SPC = k.space ?? 0.28;
  let w = 0;
  for (const ch of str) {
    if (CJK.test(ch)) w += CJK_W;
    else if (ch === ' ') w += SPC;
    else w += ASC;
  }
  return w * h * wf;
}

export const widthFactorOf = (e) => e.widthFactor ?? e.horizontalWidth ?? 0.9;

/** TEXT uses horizontalAlignment, MTEXT uses attachmentPoint (9 values, 3 columns). */
export function anchorOf(e) {
  if (e.constructor.name === 'MText') {
    const ap = e.attachmentPoint ?? 1;
    if ([1, 4, 7].includes(ap)) return 'left';
    if ([2, 5, 8].includes(ap)) return 'center';
    return 'right';
  }
  const ha = e.horizontalAlignment ?? 0;
  if (ha === 0) return 'left';
  if ([1, 4].includes(ha)) return 'center';
  return 'right';
}

/** Vertical lines bound the free space a text may grow into. */
export function buildVLineIndex(entities) {
  const v = [];
  for (const e of entities || []) {
    if (e.constructor.name !== 'Line' || !e.startPoint || !e.endPoint) continue;
    const { startPoint: s, endPoint: t } = e;
    if (Math.abs(s.x - t.x) < 1) v.push({ x: s.x, y1: Math.min(s.y, t.y), y2: Math.max(s.y, t.y) });
  }
  return v;
}

export function freeSpaceAt(vlines, x, y, tol = 5) {
  const near = vlines.filter((l) => y >= l.y1 - tol && y <= l.y2 + tol);
  const L = near.filter((l) => l.x < x).sort((a, b) => b.x - a.x)[0];
  const R = near.filter((l) => l.x > x).sort((a, b) => a.x - b.x)[0];
  return { left: L ? x - L.x : Infinity, right: R ? R.x - x : Infinity };
}

/** Width the text may occupy before it hits something: MText's own box wins. */
export function availableWidth(e, vlines) {
  const rectW = e.rectangleWidth > 10 ? e.rectangleWidth : null;
  if (rectW) return rectW * 0.98;
  const ip = e.insertPoint || e.alignmentPoint;
  if (!ip) return null;
  const sp = freeSpaceAt(vlines, ip.x, ip.y);
  const a = anchorOf(e);
  const avail = a === 'center' ? 2 * Math.min(sp.left, sp.right) : a === 'left' ? sp.right : sp.left;
  return Number.isFinite(avail) && avail > 0 ? avail * 0.9 : null;
}

/** Liang–Barsky: does a segment pass through the rect? eps shrinks the rect to ignore grazes. */
export function segHitsRect(x1, y1, x2, y2, r, eps = 2) {
  const rx0 = r.x0 + eps;
  const ry0 = r.y0 + eps;
  const rx1 = r.x1 - eps;
  const ry1 = r.y1 - eps;
  if (rx1 <= rx0 || ry1 <= ry0) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - rx0], [dx, rx1 - x1], [-dy, y1 - ry0], [dy, ry1 - y1]]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/** Text box in drawing coordinates: (x0,y0) bottom-left. */
export function textBox(e, text, h) {
  const p = e.insertPoint || e.alignmentPoint;
  if (!p) return null;
  const w = textWidth(text, h, widthFactorOf(e));
  const a = anchorOf(e);
  const x0 = a === 'center' ? p.x - w / 2 : a === 'right' ? p.x - w : p.x;
  // MTEXT hangs below its attachment point for the top row, above it for the bottom row.
  // Getting this wrong shifts every box by one line height and invents collisions.
  const ap = e.constructor.name === 'MText' ? e.attachmentPoint ?? 1 : 0;
  const top = [1, 2, 3].includes(ap);
  const middle = [4, 5, 6].includes(ap);
  const y0 = top ? p.y - h : middle ? p.y - h / 2 : p.y;
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

// acad-ts collections are iterable but not arrays
export const list = (c) => [...(c || [])];

export const lineSegments = (entities) =>
  list(entities).flatMap((e) =>
    e.constructor.name === 'Line' && e.startPoint && e.endPoint
      ? [[e.startPoint.x, e.startPoint.y, e.endPoint.x, e.endPoint.y]]
      : [],
  );

/**
 * Coarse y-grid over the segments so a text only tests the lines near it.
 * Big drawings have 100k+ lines; a full scan per text would stall the request.
 */
export function buildSegIndex(segs, cell = 800) {
  const grid = new Map();
  for (const s of segs) {
    const y0 = Math.min(s[1], s[3]);
    const y1 = Math.max(s[1], s[3]);
    for (let c = Math.floor(y0 / cell); c <= Math.floor(y1 / cell); c++) {
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(s);
    }
  }
  return { grid, cell };
}

export function segHitsIn(index, box) {
  const { grid, cell } = index;
  const seen = new Set();
  let n = 0;
  for (let c = Math.floor((box.y0 - 10) / cell); c <= Math.floor((box.y1 + 10) / cell); c++) {
    for (const s of grid.get(c) || []) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (segHitsRect(s[0], s[1], s[2], s[3], box)) n++;
    }
  }
  return n;
}

/** Texts whose box crosses a line. Counted per handle so before/after can be compared. */
export function collisions(doc) {
  const index = buildSegIndex(lineSegments(doc.modelSpace?.entities));
  const hits = new Map();
  for (const { h } of walkModelTexts(doc)) {
    const text = cleanCadText(h.value);
    if (!text) continue;
    const box = textBox(h, text, h.height || 60);
    if (!box) continue;
    const n = segHitsIn(index, box);
    if (n) hits.set(String(h.handle), { handle: String(h.handle), n, text });
  }
  return [...hits.values()];
}

/**
 * Width alone is not enough: text can grow into a line inside its box. Keep shrinking until the
 * box is clear, never below the floor. Texts that already crossed a line stay as they were.
 */
function fitToLines(h, text, oldText, h1, h0, floor, segIndex) {
  if (!h1 || !segIndex.grid.size) return h1;
  const boxAt = (raw, height) => textBox(h, cleanCadText(raw).replace(/\n/g, ' '), height);
  const before = boxAt(oldText, h0);
  if (!before || segHitsIn(segIndex, before) > 0) return h1; // already crossing: not ours to fix
  const count = (height) => {
    const box = boxAt(text, height);
    return box ? segHitsIn(segIndex, box) : 0;
  };
  const shrink = (start) => {
    let height = start;
    for (let i = 0; i < 12; i++) {
      if (count(height) === 0) break;
      if (height <= h0 * floor + 0.01) break;
      height = Math.max(h0 * floor, height * 0.92);
    }
    return height;
  };
  let height = shrink(h1);
  // A left-anchored label can only grow rightwards, into whatever sits there. Centring shares the
  // extra width both ways — but only keep it if it actually crosses fewer lines (a pipe often runs
  // just left of the label, and centring would drag the text straight through it).
  if (count(height) > 0 && anchorOf(h) === 'left') {
    const isMText = h.constructor.name === 'MText';
    const keep = isMText ? h.attachmentPoint : h.horizontalAlignment;
    const left = height;
    if (isMText) h.attachmentPoint = 2;
    else h.horizontalAlignment = 1;
    const centred = shrink(h1);
    if (count(centred) >= count(left)) {
      if (isMText) h.attachmentPoint = keep;
      else h.horizontalAlignment = keep;
    } else height = centred;
  }
  return height;
}

// Model space only: block texts are drawn through their INSERTs, so the box test cannot be
// trusted there (mirrored/rotated inserts). Structural counts still cover blocks.
function walkModelTexts(doc) {
  const out = [];
  for (const e of doc.modelSpace?.entities || []) {
    if (typeof e.value === 'string') out.push({ h: e });
    if (e.attributes) for (const a of e.attributes) if (typeof a.value === 'string') out.push({ h: a });
  }
  return out;
}

const countByKind = (doc) => {
  const c = {};
  for (const e of list(doc.modelSpace?.entities)) {
    const n = e.constructor.name;
    c[n] = (c[n] || 0) + 1;
  }
  return c;
};

/**
 * Rewrite every text run found in `map`, shrinking the height (floor 70%) where the English
 * would overrun the space its Chinese occupied, then switching to centred as a last resort.
 */
export function applyTranslations(doc, map, { floor = 0.7 } = {}) {
  const vlines = buildVLineIndex(doc.modelSpace?.entities);
  const segIndex = buildSegIndex(lineSegments(doc.modelSpace?.entities));
  const log = [];
  const residual = [];
  let changed = 0;
  let shrunk = 0;

  const all = [];
  for (const e of list(doc.modelSpace?.entities)) all.push(e);
  for (const b of list(doc.blockRecords)) for (const e of list(b.entities)) all.push(e);

  for (const e of all) {
    const holders = [];
    if (typeof e.value === 'string') holders.push(e);
    if (e.attributes) for (const a of e.attributes) if (typeof a.value === 'string') holders.push(a);

    for (const h of holders) {
      const raw = h.value;
      const before = cleanCadText(raw);
      if (!before) continue;
      const { text, changed: did, missed } = replaceRuns(raw, map);
      for (const m of missed) residual.push({ handle: String(h.handle), text: m });
      if (!did) continue;

      const h0 = h.height || 0;
      let h1 = h0;
      if (h0) {
        const oldW = textWidth(normLines(before).replace(/\n/g, ' '), h0, widthFactorOf(h));
        const newW = textWidth(normLines(cleanCadText(text)).replace(/\n/g, ' '), h0, widthFactorOf(h));
        if (newW > oldW) {
          const avail = availableWidth(h, vlines);
          if (avail && newW > avail) {
            h1 = Math.max(h0 * floor, h0 * (avail / newW));
            // still too wide at the floor: centre it so it grows both ways instead of into the right edge
            if (textWidth(normLines(cleanCadText(text)), h1, widthFactorOf(h)) > avail && anchorOf(h) === 'left') {
              if (h.constructor.name === 'MText') h.attachmentPoint = 2;
              else h.horizontalAlignment = 1;
            }
          } else if (!avail) {
            h1 = Math.max(h0 * 0.8, h0 * (oldW / newW));
          }
        }
        h1 = fitToLines(h, text, before, h1, h0, Math.min(floor, 0.55), segIndex);
      }
      h.value = text;
      if (h0 && Math.abs(h1 - h0) > 0.01) {
        h.height = h1;
        shrunk++;
      }
      changed++;
      log.push({ handle: String(h.handle), from: before, to: cleanCadText(text), hFrom: +h0.toFixed(1), hTo: +h1.toFixed(1) });
    }
  }

  return { changed, shrunk, log, residual };
}

/**
 * Compare a rewritten document with the original and report what a CAD drafter would
 * refuse to accept: Chinese left behind, lost entities/layers/blocks, new text-on-line.
 */
export function gates(before, after) {
  const ca = countByKind(before);
  const cb = countByKind(after);
  const kinds = [];
  for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
    if ((ca[k] || 0) !== (cb[k] || 0)) kinds.push({ kind: k, before: ca[k] || 0, after: cb[k] || 0 });
  }

  const names = (doc, coll) => [...(doc[coll] || [])].map((x) => x.name).filter(Boolean);
  const la = names(before, 'layers');
  const lb = names(after, 'layers');
  const ba = names(before, 'blockRecords');
  const bb = names(after, 'blockRecords');

  let leftover = 0;
  const samples = [];
  for (const { h } of walkModelTexts(after)) {
    const t = cleanCadText(h.value);
    if (!t || !CJK.test(t)) continue;
    leftover++;
    if (samples.length < 8) samples.push(t.slice(0, 40));
  }
  for (const b of after.blockRecords || []) {
    for (const e of b.entities || []) {
      for (const h of [e, ...(e.attributes || [])]) {
        const t = typeof h.value === 'string' ? cleanCadText(h.value) : '';
        if (t && CJK.test(t)) leftover++;
      }
    }
  }

  const pre = new Set(collisions(before).map((x) => x.handle));
  const added = collisions(after).filter((x) => !pre.has(x.handle));

  const structural = leftover === 0 && kinds.length === 0 && la.length === lb.length && ba.length === bb.length;
  return {
    ok: structural,
    residualChinese: leftover,
    residualSamples: samples,
    entityCounts: kinds,
    layers: { before: la.length, after: lb.length, lost: la.filter((n) => !lb.includes(n)) },
    blocks: { before: ba.length, after: bb.length, lost: ba.filter((n) => !bb.includes(n)) },
    newCollisions: added.slice(0, 12),
  };
}

export { writeDwg };

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  replaceRuns, textWidth, anchorOf, textBox, segHitsRect,
  buildSegIndex, segHitsIn, applyTranslations, gates, norm,
} from '../lib/export.js';
import { openDwg, writeDwg, extractDwg } from '../lib/cad.js';

// --- run replacement keeps every control code in place ---
const raw = '\\T1.1;{\\H1.52738x;特别提示：\\P本流程图仅供销售参考。\\P2026.11\\P}';
const map = { '特别提示：': 'NOTE:', '本流程图仅供销售参考。': 'For sales reference only.', '2026.11': '2026.11' };
const r = replaceRuns(raw, map);
assert.equal(r.text, '\\T1.1;{\\H1.52738x;NOTE:\\PFor sales reference only.\\P2026.11\\P}');
assert.equal(r.changed, true);
assert.deepEqual(r.missed, []);

// unmatched Chinese is reported, unmatched ASCII is not
const r2 = replaceRuns('\\T1.1;排水管道需方自备', {});
assert.equal(r2.changed, false);
assert.deepEqual(r2.missed, ['排水管道需方自备']);
assert.deepEqual(replaceRuns('\\T1.1;PI', {}).missed, []);

// wrapped MTEXT: whitespace inside a run must not stop the match
assert.equal(replaceRuns('\\P料  仓', { '料 仓': 'SILO' }).text, '\\PSILO');

// braces stay outside the replaced text, otherwise formatting runs would be broken
const braces = replaceRuns('{\\C0;气流粉碎机}', { 气流粉碎机: 'jet mill' });
assert.equal(braces.text, '{\\C0;jet mill}');

// --- geometry helpers ---
assert.equal(norm('  a\n b '), 'a b');
assert.ok(textWidth('中文', 10, 1) > textWidth('ab', 10, 1)); // CJK is wider than ASCII
assert.equal(textWidth('', 10, 1), 0);

const mtext = (ap) => ({ constructor: { name: 'MText' }, attachmentPoint: ap, insertPoint: { x: 0, y: 0 }, height: 10, rectangleWidth: 0 });
assert.equal(anchorOf(mtext(1)), 'left'); // 1/4/7 left, 2/5/8 centre, 3/6/9 right
assert.equal(anchorOf(mtext(2)), 'center');
assert.equal(anchorOf({ constructor: { name: 'MText' }, attachmentPoint: 9 }), 'right');
assert.equal(anchorOf({ constructor: { name: 'TextEntity' }, horizontalAlignment: 0 }), 'left');
assert.equal(anchorOf({ constructor: { name: 'TextEntity' }, horizontalAlignment: 3 }), 'right');

// top attachment hangs below the insert point, bottom attachment above it
const boxTop = textBox(mtext(1), 'abcd', 10);
const boxBottom = textBox(mtext(7), 'abcd', 10);
assert.deepEqual([boxTop.y0, boxTop.y1], [-10, 0]);
assert.deepEqual([boxBottom.y0, boxBottom.y1], [0, 10]);
assert.equal(boxTop.x0, 0);

// --- collision test ---
const box = { x0: 0, y0: 0, x1: 10, y1: 10 };
assert.equal(segHitsRect(-5, 5, 5, 5, box), true); // crosses left edge
assert.equal(segHitsRect(-5, 50, 50, 50, box), false); // passes above
assert.equal(segHitsRect(-5, 0.5, 5, 0.5, box), false); // grazes inside the eps margin
const segs = [[-5, 5, 5, 5], [-5, 50, 50, 50]];
const idx = buildSegIndex(segs);
assert.equal(segHitsIn(idx, box), 1);
assert.equal(segHitsIn(idx, { x0: 0, y0: 40, x1: 10, y1: 60 }), 1);

// --- end to end on a real drawing, when one is present ---
const FIXTURE = process.env.CAD_FIXTURE || 'test/_fixture.dwg';
if (fs.existsSync(FIXTURE)) {
  const raw = fs.readFileSync(FIXTURE);
  const before = openDwg(raw, 'fixture.dwg');
  const doc = openDwg(raw, 'fixture.dwg');
  // cover every Chinese line so any Chinese left in the output is a real failure
  const map = {};
  for (const line of extractDwg(raw, 'fixture.dwg').lines) {
    if (/[一-鿿]/.test(line)) map[line] = `EN ${line.length}`;
  }
  const out = applyTranslations(doc, map);
  if (out.changed) {
    const after = openDwg(writeDwg(doc), 'fixture-EN.dwg');
    const g = gates(before, after);
    assert.equal(g.residualChinese, 0, 'no Chinese may survive the write');
    assert.deepEqual(g.entityCounts, [], 'entity counts must not change');
    assert.equal(g.layers.lost.length, 0);
    assert.equal(g.blocks.lost.length, 0);
    console.log(`export: fixture round trip ok (${out.changed} texts)`);
  } else {
    console.log('export: fixture has no Chinese, write path not exercised');
  }
} else {
  console.log(`export: 跳过真实图纸往返（把一张测试图放到 ${FIXTURE} 可启用）`);
}

console.log('export: all assertions passed');

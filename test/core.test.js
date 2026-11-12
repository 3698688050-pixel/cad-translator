import assert from 'node:assert/strict';
import { parseGlossary, matchTerms, protect, restore, lostTokens, isFullyGlossary } from '../lib/core.js';

// --- glossary parsing ---
const csv = `中文,English
底板,base plate
法兰,flange
"螺栓",bolt
`;
assert.deepEqual(parseGlossary(csv), [
  { zh: '底板', en: 'base plate' },
  { zh: '法兰', en: 'flange' },
  { zh: '螺栓', en: 'bolt' },
]);

assert.deepEqual(parseGlossary('中心线\tcenter line\n'), [{ zh: '中心线', en: 'center line' }]);
assert.deepEqual(parseGlossary('倒角;chamfer'), [{ zh: '倒角', en: 'chamfer' }]);
assert.deepEqual(parseGlossary('no delimiter here\n\n'), []);
assert.deepEqual(parseGlossary('底板,base plate, 3mm'), [{ zh: '底板', en: 'base plate, 3mm' }]);

// --- matching ---
const g = { 底板: 'base plate', 板: 'plate', 焊接: 'weld', 焊: 'solder', 中心线: 'center line', 线: 'line' };

// longest wins, no overlap
assert.deepEqual(
  matchTerms('底板与焊接', g).map((h) => h.zh),
  ['底板', '焊接'],
);
assert.deepEqual(matchTerms('中心线', g).map((h) => h.zh), ['中心线']);

// single-character keys never match inside a longer word
assert.deepEqual(matchTerms('同轴度', { 轴: 'shaft' }), []);
assert.deepEqual(matchTerms('轴', { 轴: 'shaft' }).map((h) => h.en), ['shaft']);

// same term twice keeps its order
const two = matchTerms('焊接焊接', g);
assert.deepEqual(two.map((h) => h.index), [0, 2]);

// keeps sentence order even though matching ran longest-first
assert.deepEqual(matchTerms('底板焊接', g).map((h) => h.zh), ['底板', '焊接']);

// no hit => no change
assert.deepEqual(matchTerms('普通文字', g), []);

// --- protect / restore round trip ---
const line = '底板用M8螺栓固定，中心线对齐';
const gh = { 底板: 'base plate', 螺栓: 'bolt', 中心线: 'center line' };
const hits = matchTerms(line, gh);
assert.equal(hits.length, 3);
const tpl = protect(line, hits);
assert.equal(tpl, '⟦1⟧用M8⟦2⟧固定，⟦3⟧对齐');
// restore only fills tokens; the untranslated zh in the middle stays until the model returns
assert.equal(restore(tpl, hits), 'Base plate用M8 bolt固定，center line对齐');

// tokens lost by the model are detected
const api = 'Use M8 ⟦2⟧ to fix the ⟦1⟧, align the ⟦3⟧';
assert.equal(lostTokens(api, hits), false);
assert.equal(lostTokens('Use M8 bolts to fix the base plate', hits), true);
assert.equal(restore(api, hits), 'Use M8 bolt to fix the base plate, align the center line');

// spacing + capital when a term lands next to Latin text or opens the line
assert.equal(restore('Q235⟦1⟧用M8', [{ zh: '钢板', en: 'steel plate' }]), 'Q235 steel plate用M8');
assert.equal(restore('⟦1⟧采用Q235', [{ zh: '底板', en: 'base plate' }]), 'Base plate采用Q235');

// --- fully-covered line skips the API ---
assert.equal(isFullyGlossary('底板', matchTerms('底板', g)), true);
assert.equal(isFullyGlossary('底板上', matchTerms('底板上', g)), false);

console.log('core: all assertions passed');

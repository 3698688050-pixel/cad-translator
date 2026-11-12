import assert from 'node:assert/strict';
import { cleanCadText, extractDxf } from '../lib/cad.js';

// MTEXT control codes: \P = newline, formatting runs dropped, %%c = Ø, \U+XXXX = char
assert.equal(cleanCadText('技术要求\\P未注倒角C1'), '技术要求\n未注倒角C1');
assert.equal(cleanCadText('{\\fSimSun|b0|i0;底板}采用Q235'), '底板采用Q235');
assert.equal(cleanCadText('孔径%%c12，公差%%p0.05'), '孔径Ø12，公差±0.05');
assert.equal(cleanCadText('45\\U+00B0倒角'), '45°倒角');
assert.equal(cleanCadText('  A   B  '), 'A B');
assert.equal(cleanCadText(undefined), '');

// DXF: only TEXT/MTEXT/ATTRIB/ATTDEF carry group code 1; DIMENSION etc. are ignored
const dxf = [
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'TEXT', '8', '0', '1', '底板采用Q235钢板',
  '0', 'MTEXT', '8', '0', '1', '技术要求：\\P去毛刺',
  '0', 'LINE', '8', '0', '1', '不该出现的图层名',
  '0', 'ATTRIB', '8', '0', '1', '审核',
  '0', 'ENDSEC', '0', 'EOF', '',
].join('\n');

const got = extractDxf(dxf);
assert.deepEqual(got.lines, ['底板采用Q235钢板', '技术要求：', '去毛刺', '审核']);

// duplicates collapse: drawings repeat notes
assert.deepEqual(extractDxf('0\nTEXT\n1\n底板\n0\nTEXT\n1\n底板\n').lines, ['底板']);

console.log('cad: all assertions passed');

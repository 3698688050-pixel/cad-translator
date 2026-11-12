// Patches @node-projects/acad-ts so it can write Chinese into DWG.
// Without it that library maps every non-ASCII char to '?' (encodeAsciiCompatible),
// so a round trip turns 中心线层 into ????. Idempotent; run from any cwd.
// Usage: node scripts/patch-acadts.mjs [root]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';

const MARK = '_GBK_MAP';
const TARGET = 'node_modules/@node-projects/acad-ts/dist/IO/TextEncoding.js';

const OLD_FN = `function encodeAsciiCompatible(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes[i] = code <= 0x7F ? code : REPLACEMENT_BYTE;
    }
    return bytes;
}`;

// an earlier patch version routed through a global TextEncoder shim, which never applied
const OLD_FN_ALT = `function encodeAsciiCompatible(text) {
    // PATCH: 交给全局 TextEncoder（已垫 GBK 编码器），避免中文被替换为 '?'
    return new TextEncoder().encode(text ?? '');
}`;

const NEW_FN = `function encodeAsciiCompatible(text) {
    const t = text ?? '';
    const out = [];
    for (const ch of t) {
        const c = ch.codePointAt(0);
        if (c <= 0x7F) { out.push(c); }
        else if (_GBK_MAP[ch]) { out.push(_GBK_MAP[ch][0], _GBK_MAP[ch][1]); }
        else { out.push(REPLACEMENT_BYTE); }
    }
    return new Uint8Array(out);
}`;

export function gbkMap() {
  const m = {};
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      const ch = iconv.decode(Buffer.from([hi, lo]), 'gbk');
      if (ch.length === 1 && ch.codePointAt(0) > 0x7f && ch !== '\ufffd') m[ch] = [hi, lo];
    }
  }
  return m;
}

const root = process.argv[2] || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, TARGET);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main(root) {

const file = path.join(root, TARGET);
if (!fs.existsSync(file)) {
  console.error(`找不到 ${file} —— 先在项目根目录 npm install`);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');
if (src.includes(MARK)) {
  console.log('acad-ts GBK 补丁已存在，跳过');
  process.exit(0);
}
if (!src.includes(OLD_FN) && !src.includes(OLD_FN_ALT)) {
  console.error('没找到 encodeAsciiCompatible 原函数 —— 库版本变了，需人工核对');
  process.exit(1);
}
const anchor = 'const REPLACEMENT_BYTE = 0x3F;';
if (!src.includes(anchor)) {
  console.error('没找到 REPLACEMENT_BYTE 锚点');
  process.exit(1);
}

const map = gbkMap();
if (Object.keys(map).length < 20000) {
  // a broken iconv build would silently produce a patch that still writes '?'
  console.error(`GBK 映射只有 ${Object.keys(map).length} 条，异常退出（应为 ~2.1 万）`);
  process.exit(1);
}

src = src.replace(anchor, `${anchor}\nconst ${MARK} = ${JSON.stringify(map)};`).replace(OLD_FN, NEW_FN).replace(OLD_FN_ALT, NEW_FN);
fs.writeFileSync(file, src);
console.log(`acad-ts GBK 补丁完成，注入 ${Object.keys(map).length} 条映射`);
}

if (isMain) main(root);

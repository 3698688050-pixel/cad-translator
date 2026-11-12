#!/usr/bin/env python3
"""
给 @node-projects/acad-ts 打 GBK 写出补丁。

为什么需要：
  该库写出 DWG 时，非 ASCII 字符一律走 IO/TextEncoding.js 里的
  encodeAsciiCompatible()，实现是 `code <= 0x7F ? code : 0x3F`，
  即中文全部变成 '?'。实测：原文一个字不改、仅"读出再写回"，
  图层名 `中心线层` 就变成 `????`。

修法：
  把 GBK 双字节映射表内联进该模块，重写 encodeAsciiCompatible。
  注意不能用全局 TextEncoder 垫片绕过 —— 该模块是独立作用域，
  读不到全局补丁（踩过这个坑）。

幂等：重复执行安全，已打过补丁会跳过。

用法：python3 patch_acadts.py <包含 node_modules 的目录>
"""
import json
import sys
from pathlib import Path

# Windows 默认 GBK 控制台装不下 ✓/✗，postinstall 会以 UnicodeEncodeError 退出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MARK = "_GBK_MAP"

TARGET = "node_modules/@node-projects/acad-ts/dist/IO/TextEncoding.js"

OLD_FN = """function encodeAsciiCompatible(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes[i] = code <= 0x7F ? code : REPLACEMENT_BYTE;
    }
    return bytes;
}"""

# 兼容：若之前打的是别的版本补丁，也一并覆盖
OLD_FN_ALT = """function encodeAsciiCompatible(text) {
    // PATCH: 交给全局 TextEncoder（已垫 GBK 编码器），避免中文被替换为 '?'
    return new TextEncoder().encode(text ?? '');
}"""

NEW_FN = """function encodeAsciiCompatible(text) {
    const t = text ?? '';
    const out = [];
    for (const ch of t) {
        const c = ch.codePointAt(0);
        if (c <= 0x7F) { out.push(c); }
        else if (_GBK_MAP[ch]) { out.push(_GBK_MAP[ch][0], _GBK_MAP[ch][1]); }
        else { out.push(REPLACEMENT_BYTE); }
    }
    return new Uint8Array(out);
}"""


def build_gbk_map():
    """生成 unicode -> [hi, lo] 的双字节 GBK 映射。"""
    m = {}
    for hi in range(0x81, 0xFF):
        for lo in range(0x40, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gbk")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1 and ord(ch) > 0x7F:
                m[ch] = [hi, lo]
    return m


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    path = root / TARGET
    if not path.exists():
        print(f"✗ 找不到 {path}")
        print("  先在目标目录 npm install @node-projects/acad-ts")
        return 1

    src = path.read_text(encoding="utf-8")

    if MARK in src:
        print("✓ 已打过补丁，跳过")
        return 0

    if OLD_FN not in src and OLD_FN_ALT not in src:
        print("✗ 未找到 encodeAsciiCompatible 原函数")
        print("  库版本可能变了，需要人工核对实现")
        return 1

    gbk = build_gbk_map()
    anchor = "const REPLACEMENT_BYTE = 0x3F;"
    if anchor not in src:
        print("✗ 未找到 REPLACEMENT_BYTE 锚点")
        return 1

    inject = anchor + "\nconst _GBK_MAP = " + json.dumps(
        gbk, ensure_ascii=False, separators=(",", ":")
    ) + ";"

    src = src.replace(anchor, inject, 1)
    src = src.replace(OLD_FN, NEW_FN, 1)
    src = src.replace(OLD_FN_ALT, NEW_FN, 1)

    path.write_text(src, encoding="utf-8")
    print(f"✓ 补丁完成，注入 {len(gbk)} 条 GBK 映射")
    return 0


if __name__ == "__main__":
    sys.exit(main())

// Pure helpers for glossary parsing + term matching. No I/O, so it can be tested directly.

// ⟦ ⟧ are rare in engineering text and survive most models untouched.
const tok = (n) => `⟦${n}⟧`;

function splitPair(line) {
  let d = '\t';
  if (!line.includes('\t')) d = line.includes(',') ? ',' : line.includes(';') ? ';' : null;
  if (!d) return null;
  const i = line.indexOf(d);
  const clean = (s) => s.trim().replace(/^"|"$/g, '').trim();
  const zh = clean(line.slice(0, i));
  const en = clean(line.slice(i + 1));
  if (!zh || !en || zh === en) return null;
  return { zh, en };
}

export function parseGlossary(text) {
  const rows = String(text || '').split(/\r?\n/);
  const out = [];
  let first = true;
  for (const raw of rows) {
    if (!raw.trim()) continue;
    const pair = splitPair(raw);
    if (first) {
      first = false;
      // header row: "中文,English" / "zh,en" / "Source,Target"
      if (pair && /^(en|english|target|translation|译文|英文)$/i.test(pair.en)) continue;
      if (/^(中文|zh|chinese|source|term|术语)/i.test(raw) && raw.includes(',')) continue;
    }
    if (pair) out.push(pair);
  }
  return out;
}

/**
 * Longest-first, non-overlapping match of glossary keys inside one line.
 * Returns hits sorted by position, each { zh, en, index }.
 * Single-character keys only hit when the whole line is that term, otherwise 轴 would
 * hijack 同轴度 and 键 would hijack 键盘.
 */
export function matchTerms(line, glossary) {
  if (Object.prototype.hasOwnProperty.call(glossary, line)) {
    return [{ zh: line, en: glossary[line], index: 0 }];
  }
  const keys = Object.keys(glossary)
    .filter((k) => k.length >= 2)
    .sort((a, b) => b.length - a.length);
  const taken = new Uint8Array(line.length);
  const hits = [];
  for (const zh of keys) {
    let from = 0;
    for (;;) {
      const i = line.indexOf(zh, from);
      if (i < 0) break;
      let free = true;
      for (let k = i; k < i + zh.length; k++) if (taken[k]) { free = false; break; }
      if (free) {
        for (let k = i; k < i + zh.length; k++) taken[k] = 1;
        hits.push({ zh, en: glossary[zh], index: i });
      }
      from = i + zh.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** Swap matched terms for ⟦n⟧ tokens so the model cannot rewrite them. */
export function protect(line, hits) {
  let out = '';
  let pos = 0;
  hits.forEach((h, n) => {
    out += line.slice(pos, h.index) + tok(n + 1);
    pos = h.index + h.zh.length;
  });
  return out + line.slice(pos);
}

export function restore(text, hits) {
  const raw = String(text);
  const atStart = /^\s*⟦\d+⟧/.test(raw);
  // a term dropped next to Latin text or digits needs a space: "Q235⟦1⟧" -> "Q235 steel plate"
  const spaced = raw.replace(/([A-Za-z0-9])⟦/g, '$1 ⟦').replace(/⟧([A-Za-z0-9])/g, '⟧ $1');
  const out = spaced.replace(/⟦(\d+)⟧/g, (m, d) => {
    const h = hits[Number(d) - 1];
    return h ? h.en : m;
  });
  // a sentence that opens on a glossary term still needs its capital
  return atStart ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

export function lostTokens(text, hits) {
  return hits.some((_, n) => !String(text).includes(tok(n + 1)));
}

export function isFullyGlossary(src, hits) {
  return hits.length === 1 && hits[0].zh === src;
}

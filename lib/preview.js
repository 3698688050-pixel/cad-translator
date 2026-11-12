// DWG → SVG for the in-browser preview. LibreDWG unlike acad-ts can render every entity
// (hatch, spline, dimension), so the preview shows the whole drawing, not just its text.
import { LibreDwg } from '@mlightcad/libredwg-web';

let lib = null;
const getLib = async () => (lib ||= await LibreDwg.create());

/** Returns { svg }. Throws when the file cannot be decoded at all. */
export async function dwgToSvg(buffer) {
  const dwg = await getLib();
  const bytes = new Uint8Array(buffer);
  const ptr = dwg.dwg_read_data(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 0);
  if (!ptr) throw new Error('DWG 解析失败');
  try {
    const db = dwg.convert(ptr);
    const svg = dwg.dwg_to_svg(db);
    if (!svg || !svg.includes('<svg')) throw new Error('没能生成图形');
    return { svg };
  } finally {
    dwg.dwg_free(ptr);
  }
}

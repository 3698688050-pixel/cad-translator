# 图译 · CAD 图纸中译英

中文图纸文字 → 英文，译完原地写回 DWG。词库优先，词库没有的术语交给 API，译完再问你要不要入库。

```bash
npm install                  # postinstall 自动给 acad-ts 打 GBK 补丁（纯 Node，无 python 依赖）
DEEPSEEK_API_KEY=sk-... npm start
# http://localhost:5177
```

Windows PowerShell：`$env:DEEPSEEK_API_KEY='sk-...'; npm start`。CMD：`set DEEPSEEK_API_KEY=sk-... && npm start`。

没有 API key 也能跑：词库命中的行照常翻译，未命中的行标红提示未译出。

## 流程

1. 拖入 `.dwg` / `.dxf` → 抽出模型空间 + 所有块定义的 TEXT / MTEXT / ATTRIB / ATTDEF（去重，上限 5000 行）
2. 无中文的行（型号、图号、纯数字）判为「无需翻译」，不占 API 额度
3. 词库命中的术语先替换成 `⟦n⟧` 占位符 → 模型看不到中文原文，物理上改不了词库译法；token 丢失则该行标红并重试一次
4. 候选术语条一次性入库（你确认后才写入 `data/glossary.json`）
5. 导出 DWG：只写回页面上的译文，改字高适配空间，跑三道校验后下载 `原名-EN.dwg`

## 导出 DWG 的三道校验

| 校验 | 口径 |
|---|---|
| 残留中文 | 必须为 0，否则列出 handle |
| 结构 | 实体总数 + 每类实体计数 + 图层名 + 块名，与原图逐项一致 |
| 压线 | 译文框与线条的相交数不得增加（Liang–Barsky，eps=2）；确实无解时降级为警告，不拦下载 |

字高策略：原文字高 → 若英文超宽则按 0.55～1.0 逐档缩小（`fitToLines`）；无宽度信息时居中（MTEXT attachmentPoint 2 / TEXT horizontalAlignment 1）。本来就压线的文字不动它。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` / `TRANSLATE_API_KEY` | 空 | 翻译 API key（OpenAI 兼容 `chat/completions`） |
| `TRANSLATE_BASE_URL` | `https://api.deepseek.com` | 换成任何 OpenAI 兼容端点 |
| `TRANSLATE_MODEL` | `deepseek-chat` | 模型名 |
| `PORT` | `5177` | 端口 |
| `HOST` | `127.0.0.1` | 设为 `0.0.0.0` 可让同一局域网内的手机访问 |
| `GLOSSARY_FILE` | `data/glossary.json` | 词库落盘位置 |

## 词库格式

CSV / TSV / 分号分隔都行，一行一对，可带表头（`中文,English`）：

```
中文,English
底板,base plate
螺栓,bolt
```

仓库不预置任何词条，`data/glossary.json` 初始为 `{}`，只留你自己导入的。

## 开发

```bash
npm test                      # core + cad + export 三个测试串跑
node test/core.test.js        # 解析 / 最长匹配 / token 保护 / 还原
node test/cad.test.js         # DWG/DXF 文字抽取：MTEXT 控制码 / 组码配对 / 去重
node test/export.test.js      # 占位符写回 / 字宽锚点 / 压线 / 真实图往返（可选）
```

真实图往返测试：把一张 DWG 放到 `test/_fixture.dwg`（已 gitignore）即可启用。

- `lib/core.js` 解析、匹配、占位、还原（无 I/O）
- `lib/cad.js` DWG/DXF 抽取与写回（`@node-projects/acad-ts`）
- `lib/export.js` `applyTranslations` / `fitToLines` / `gates`
- `server.js` HTTP + 词库读写 + API 调用 + 上传/导出
- `public/` 原生 JS 前端，无构建步骤
- `scripts/patch-acadts.mjs` 修 acad-ts 的 GBK 编码（不打补丁时中文会写成 `?`）

## 已知限制

- acad-ts 写出 AC1018 等旧版 DWG 正常；更新版本格式未逐一验证
- 只有同一个库能回读自校，缺第三方独立校验器——导出的图请在 CAD 里开一次确认
- 文字被炸成线条、或文字在未绑定的外部参照里，都读不到，页面会提示处置办法
- `data/uploads/` 会一直留存上传的原图，不自动清理
- DWG 按 GBK 存字，GBK 里没有的字符（`Ø`、`±`、部分符号）写回会变成 `?`；原文里本来就有的不受影响（旧图本来就存不了这些字符）

## 许可

**GPL-3.0**（见 `LICENSE`）。依赖 `@node-projects/acad-ts` 为 GPL-3.0，故本项目整体按 GPL-3.0 发布：可自由使用、修改、分发，衍生作品同样需以 GPL-3.0 开源并提供源码。

## 别人怎么用

```bash
git clone https://github.com/3698688050-pixel/cad-translator.git
cd cad-translator
npm install      # 自动给 acad-ts 打 GBK 补丁（纯 Node，无额外依赖）
DEEPSEEK_API_KEY=sk-... npm start
```

补丁没打上就手动跑 `npm run setup`（幂等）；不打补丁时导出会把中文写成 `?`，服务启动会告警。

# DESIGN.md

## World

**制图台的图纸 + 红铅笔改图 markup。** 蓝晒（cyanotype）色是图纸的骨架色，红铅笔只用来标记"待确认"，栅格来自标题栏的格线而不是背景装饰。界面是一张正在被改的图纸：字段线、编号、明细表节距。

不是：蓝图底的白色线稿海报、终端黑底绿字、SaaS 圆角卡片。

## Palette

| token | value | 用途 |
|---|---|---|
| `--sheet` | `#E7E8E2` | 工作区底色（冷调道林纸） |
| `--paper` | `#F4F6F3` | 输入/输出面板底（抬起的纸） |
| `--rail` | `#E1E7E8` | 左栏（蓝晒浅染） |
| `--blue` | `#1C4A66` | 结构色：标题栏、主按钮、词库命中 |
| `--blue-ink` | `#14405A` | 蓝上的深压 |
| `--blue-tint` | `#D3E0E6` | 命中标记底、选中态 |
| `--ink` | `#171A19` | 正文 |
| `--ink-2` | `#4A504C` | 次级文字、标签（≥4.5:1） |
| `--ink-3` | `#5A615D` | placeholder（≥4.5:1） |
| `--rule` | `#C3C6BC` | 1px 线、格线 |
| `--redline` | `#A9301C` | 仅用于"未收录 / 待确认" |
| `--redline-tint` | `#F0DFD9` | 红铅笔淡底 |
| `--settled` | `#2F6B4F` | 已入库确认 |

策略：**Committed**。蓝晒色占据标题栏与左栏两块整面区域，不是零散点缀。红只承担"待确认"这一种语义。

## Type

- UI / 标题：`Bahnschrift`（DIN 1451 系，Windows 自带，制图字体血统）→ 回退 `"Segoe UI Variable", "Segoe UI", system-ui`
- 正文（中英原文译文）：`"Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", ui-sans-serif`
- 编号 / 数字 / 代码：`"Cascadia Mono", Consolas, ui-monospace`，`font-variant-numeric: tabular-nums`
- 字号阶：11 / 12 / 13 / 15 / 18 / 22 / 28。正文 15px，行高 1.55，measure 62–70ch。
- 标签用 11px + `letter-spacing .04em`，不加全大写。

## Signature move（BOM 气球）

图纸明细表的零件编号气球，借来做**术语对应标记**：原文里命中的术语和译文中对应的英文，各自挂同一个编号气球（14px 圆，1.5px 蓝边，等宽数字）。一眼能看出"这个词来自词库第几条"，不需要图例。

- 命中 = 蓝实线气球 + 词下划细线
- 待确认（API 新译、未入库）= 红点线气球，入库后原地翻成蓝实线 + 绿色 "已入库" 一行

## Layout

标题栏（顶部蓝面，格线分区：产品名 | 词条数 | 引擎 | 本次命中）→ 左栏词库（导入 / 添加 / 搜索 / 列表 / 导出）→ 主区上下两屏：原文输入、译文明细表。明细表行之间只用 1px 线，不用卡片。

## Motion

只有一处编排：翻译完成后译文行为单位错峰浮现（60ms 步进，420ms `cubic-bezier(.16,1,.3,1)`，位移 6px + 透明度）。气球从红翻蓝时做 220ms 的颜色/边框过渡。`prefers-reduced-motion` 全关。

## Browser surfaces

选区底色 `--blue-tint`、光标 `--blue`、focus-visible 2px 蓝环 + 2px offset、细窄滚动条取自 `--rule`、数字等宽。

## Anti-slop 自查

无 eyebrow、无渐变文字、无玻璃拟态、无彩色 border-left 卡片、无硬偏移阴影、无卡片套卡片、无 emoji 图标（全部手写 SVG）、无紫蓝渐变、无 Inter。

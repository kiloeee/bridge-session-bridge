# Third-Party Notices · 第三方许可与出处

「桥 · Session Bridge」是一个浏览器扩展（Edge / Chrome，Manifest V3）。

## 版权与许可证总述

- **开发与原创：** 本作品由 **kiloeee** 开发。
- **版权归属：** kiloeee 对其原创部分，以及其在**有权修改的上游文件**上所做的**修改贡献**，
  保留版权。本作品**不把** kiloeee 的新增改动全部归给上游，**也不把**上游原始代码的版权
  据为己有——两部分的版权各自保留。
- **整体许可证：** 本作品**整体**按 **GNU GPL-3.0-only** 分发（全文见 [`LICENSE`](LICENSE)）。
  GPL 只约束**分发条款**，不改变各部分各自的版权归属。
- **上游代码保留原许可证：** 本作品中源自上游 `deepseek-archive` 的**原始代码**，版权归
  原作者 **Liuxd-1230**，继续以 **MIT License** 分发，**不随本作品整体重新授权**。

本文件逐类列出上述各部分，第三节附完整 MIT 全文。本文件随安装包一并分发。

---

## 一、上游作品：deepseek-archive

- **出处：** https://github.com/Liuxd-1230/deepseek-archive
- **固定版本：** 分支 `main`，提交 `ab202db540f8e2070b6056d324931962e294af5f`
- **许可证：** MIT License，Copyright (c) 2026 Liuxd-1230

### A. 原样沿用（逐字节未改；版权归 Liuxd-1230，以 MIT 分发）

| 文件 | 版权 | 许可证 |
|---|---|---|
| `src/markdown.js` | Liuxd-1230 | MIT |
| `src/rebuild.js` | Liuxd-1230 | MIT |
| `src/recorder-main.js` | Liuxd-1230 | MIT |
| `src/recorder-bridge.js` | Liuxd-1230 | MIT |
| `icons/icon16.png`、`icons/icon48.png`、`icons/icon128.png` | Liuxd-1230 | MIT |

### B. 在上游基础上修改（上游原始代码 + kiloeee 的修改，版权各自保留）

以下文件以**上游文件为起点**，由 **kiloeee** 修改。**上游作者的原始代码仍归 Liuxd-1230，
以 MIT 分发；kiloeee 新增或改写的部分归 kiloeee，作为本作品整体的一部分以 GPL-3.0-only
分发。** 两部分版权各自保留，互不覆盖。

| 文件 | 来自 Liuxd-1230（MIT）的原始代码 | kiloeee（GPL-3.0-only）的修改贡献 |
|---|---|---|
| `manifest.json` | 上游清单结构 | 更名、升版（0.4.2）、增加 recorder/transport 内容脚本与侧栏配置 |
| `src/background.js` | 上游后台骨架 | 扩展流生命周期：规范快照、draft/run 落库、结果判定、工作标签页驱动 |
| `src/content.js` | 上游内容脚本 | 扩展 `history_messages` 调用与自检接线 |
| `src/db.js` | 上游 IndexedDB 层 | 扩展 `drafts` / `runs` store |
| `src/normalize.js` | 上游快照规范化 | 规范化扩展 |
| `sidepanel/index.html`、`sidepanel/app.js`、`sidepanel/style.css` | 上游侧栏骨架 | 重写为三页产品流程 |

> 源码仓库中另有上游派生的**非运行时**文件（`test-rebuild.mjs`、`tools/make-icons.mjs`、
> `.gitignore`、`README.md`），不随本安装包分发；其上游代码归 Liuxd-1230（MIT），
> kiloeee 的修改贡献归 kiloeee。

---

## 二、本作品原创部分（原创：kiloeee；许可证：GPL-3.0-only）

以下文件由 **kiloeee** 原创，不源自上游，版权归 **kiloeee**，以 GPL-3.0-only 分发：

- **运行时：** `src/archive.js`、`src/draft.js`、`src/forge.js`、`src/forge-lineage.js`、
  `src/forge-provider.js`、`src/outcome.js`、`src/phase0.js`、`src/plan.js`、`src/transport.js`、`src/web-forge.js`
- **界面素材：** `sidepanel/assets/` 下随包分发的 6 张 PNG（背景、鲸鱼、图标）
- **打包与工具：** `scripts/*`、`forge-cli.mjs`

其中 `src/forge.js`、`src/phase0.js` 为冻结核心（tag `forge-core-v0`）。

---

## 三、完整 MIT 许可证全文（适用于第一节所列上游代码）

```
MIT License

Copyright (c) 2026 Liuxd-1230

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
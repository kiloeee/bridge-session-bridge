# NOTICE

「桥 · Session Bridge」由 **kiloeee** 开发与维护。版权归属：

- kiloeee 对其**原创代码与素材**，以及在**有权修改的上游文件中所做的原创修改贡献**，保留版权。
- 源自上游 `deepseek-archive` 的**原始代码**，版权归原作者 **Liuxd-1230**，继续以 **MIT** 分发。
- 本作品**整体**以 **GNU GPL-3.0-only** 分发；GPL 只约束**分发条款**，不改变上述各部分的
  版权归属，也不等于把所有代码的独占版权都归 kiloeee。全文见 [`LICENSE`](LICENSE)。

## 第三方部分（上游作品）

本作品包含源自第三方、按其**原始许可证**分发的部分：

- **deepseek-archive** — https://github.com/Liuxd-1230/deepseek-archive
  固定版本 `main` @ `ab202db540f8e2070b6056d324931962e294af5f`，
  **MIT License, Copyright (c) 2026 Liuxd-1230**。
  逐文件清单（含原样保留与派生修改）与完整 MIT 全文见
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

这些上游部分**保持其原始 MIT 许可证**，不随本作品整体重新授权。
更详细的逐文件归属（附 git blob 比对依据）见
[`docs/OPEN_SOURCE_PROVENANCE.md`](docs/OPEN_SOURCE_PROVENANCE.md)。

## 致谢（设计参考，非代码依赖）

"换窗续接" 的设计思路参考了：

- 蛋壳老师《Claude Code 长上下文续航：Swap 与 Forge 实战教程》
  （来源标识 `public-cc-swap-forge-guide-2026`）。
- [`Vivi-Seth/forge-reload`](https://github.com/Vivi-Seth/forge-reload) ——
  长会话滚动交接的设计参考。

两者都是"启发/参考"关系，**不是代码依赖，也未内嵌任何代码**。存档层、清洗规则、
代际追踪与 DeepSeek 专用协议处理均为本仓库自行实现。

## 第三方代码

本扩展**不内嵌任何第三方代码，也没有运行时依赖**。每个 `import` 都解析到
本仓库内的文件或 Node.js 内置模块（`node:*`）。

## 美术素材

- `sidepanel/assets/` 下的鲸鱼、背景与图标 PNG 为本项目作者**原创**。
- `icons/`（`icon16/48/128.png`）源自上游 deepseek-archive，**原样保留**，
  以 MIT 许可证分发（见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)）。

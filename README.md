# 桥 · Session Bridge

**DeepSeek 聊满了，不用重新认识一次。**

桥 · Session Bridge 把一段对话接到一个**新的** DeepSeek 会话里，让你接着聊，而不是从头自我介绍。

它是**对话续接工具，不只是导出工具**。导出器把文件交给你就走；Session Bridge 把对话本身交给一个新会话，让你继续。

| | |
|---|---|
| 清单名称 | `桥 · Session Bridge` |
| 版本 | 0.4.3 |
| 目标平台 | Edge / Chrome，Manifest V3，侧边栏 |
| 运行时依赖 | **无** |
| 许可证 | GPL-3.0-only（上游派生部分保留 MIT）—— 见 [`LICENSE`](LICENSE) 与 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |

英文文档见 [`README.en.md`](README.en.md)。

---

## 安装

两种方式都可以用。**GitHub 最新公开版为 v0.4.3**；**商店版目前仍是 v0.4.1**（**v0.4.2 已提交 Microsoft Edge 商店、正在审核中**，v0.4.3 待其出结果后再提交）。两者更新节奏独立 —— 想马上用到 v0.4.3 请用方式一。

### 方式一：从 GitHub Releases 下载（现在就用这个）

1. 打开 [Releases 页面](https://github.com/kiloeee/bridge-session-bridge/releases)。
2. 在 **Assets** 里下载 **`bridge-v0.4.3-edge.zip`** —— *不要*下载 GitHub 自动生成的「Source code」压缩包。
3. 解压到一个固定的文件夹。
4. 在 Edge 地址栏输入 `edge://extensions`。
5. 打开左下角的**开发人员模式**。
6. 点**加载解压缩的扩展**，选择包含 `manifest.json` 的那个文件夹。
7. 打开 `https://chat.deepseek.com/`，点扩展图标打开侧边栏。

带安全说明的完整分步教程见 [`docs/INSTALL.md`](docs/INSTALL.md)。

> **核对你的下载。** `bridge-v0.4.3-edge.zip` 的 SHA-256：
> `eaed4b060b6793744a6313b007dff094150f559043db5d8af3b8a4f9e4b2ead7`

- ZIP **不能**双击直接安装，Edge 需要的是解压后的文件夹。
- 使用基本功能**不需要** npm、Python 或 API Key。

### 方式二：Microsoft Edge 加载项商店

商店页：
<https://microsoftedge.microsoft.com/addons/detail/bbgdkplomihlcgndbjmcjmphgnabffbj>

商店版目前仍是 **v0.4.1**。**v0.4.2 已提交 Microsoft Edge 商店、正在审核中**；商店版由 Edge 自动更新，v0.4.3 会在 v0.4.2 审核结束后再提交，**在商店更新之前，GitHub 解压版（方式一）就是最新版**。想马上用到 v0.4.3，请用方式一。

### 更新

GitHub（解压）版**不会自动更新**。更新方法：下载新版 ZIP，覆盖同一文件夹里的文件，然后在扩展卡片上点**重新加载**（必要时刷新 DeepSeek 页面）。换了文件夹、或同时装商店版会发生什么，见 [`docs/INSTALL.md`](docs/INSTALL.md)。

---

## 功能

- **完整原文** —— 把对话清洗后的正文原样带进新会话。不摘要、不改写、不裁剪。**本地清洗**（去思考／工具／原始帧／附件）完全在本机完成，不经过本扩展开发者的服务器；清洗后的**最终正文**会作为一条新消息发送到**一个新的 DeepSeek 会话**。
- **滚动摘要** —— 面向装不下的长会话。较早的内容整理成一份*持续状态*，关键原话与最近对话**逐字保留**。
- **原生文本传输** —— 迁移正文通过 DeepSeek 页面自己的输入框和发送控件投递，而不是剪贴板；很长的迁移不会在页面里被悄悄变成 `.txt` 附件。
- **结果校验** —— 发送之后，运行会观察真实页面并报告实际结果（已完成 / 被拒 / 过长 / 请求过频 / 网络错误），而不是假定成功。
- **用户可控的重试** —— 若发送被拒，草稿会保留，由**你**修改后重新发送。不会静默发送，也不会用被改写过的内容重试。
- **本地存档** —— 会话存在浏览器 IndexedDB，支持 Markdown 导出与一键备份 / 恢复。
- **无账号、无后端、无遥测。**

---

## 两条迁移路径

### 完整原文 —— 逐字带过去

```
已存档会话
  → 清洗掉非对话内容（THINK、工具调用、原始帧、附件）
  → 原生输入框传输
  → 新的 DeepSeek 会话
  → 结果校验
```

完整原文迁移逐字保留当前父链的 `REQUEST` / `RESPONSE` 字符串，只添加迁移说明、角色标签与分隔符。兄弟分支不会拼进来；无法确认完整父链的快照会停止迁移，而不是猜测。

### 滚动摘要 —— 持续状态 + 关键原话 + 最近原文

```
已存档会话
  → Forge
  → 持续状态  （identity / stableFacts / activeThreads / decisions /
                openLoops / recentChanges / interactionPreferences）
  + 关键原话  （逐字保留）
  + 最近原文  （最后若干轮，逐字保留）
  → 新的 DeepSeek 会话
```

滚动摘要从不重发整段历史：每次请求只带*上一代*持续状态加当前分块。模型只返回状态和 message id —— **正文一律由程序从本地存档读回**，模型无法改写你的原文。

每次滚动迁移记录一个**代际**（`新会话 ← 源会话` 加那一代的持续状态）。新窗口第一次被读到时自动绑定，下一次滚动直接接上，不需要手工导入。完整原文迁移**不建立代际**。

如果滚动摘要的结果*反而更大*（短会话常见），扩展不会把更大的包迁过去：它会在**同一次**里**自动改用完整原文**发送，并在完成页说明本次实际采用的迁移方式（以及为整理已经发生的成本，如果有）。不会再让你二次确认。

---

## Provider

滚动摘要可以走两个 Provider，迁移结果形态一致。

| Provider | 需要 | 说明 |
|---|---|---|
| **DeepSeek 网页版** | 一个已登录的 DeepSeek 标签页 | 无需 API Key、无需额外权限；支持断点续跑 |
| **DeepSeek API** | 你自己的 DeepSeek API Key | 直接调用 `api.deepseek.com` |

- **API 是可选的**：完整原文迁移永远不需要它。
- API 权限**只在**你配置 API Provider 时申请，之后可以撤销。
- **没有 Session Bridge 账号、没有 Session Bridge 云、没有 Session Bridge 服务器。** 请求用你的 Key 直接发往 `api.deepseek.com`。

---

## 隐私

一句话：**没有服务器。** 完整策略见 [`PRIVACY.md`](PRIVACY.md)。

- **完整原文迁移的清洗在本机完成**，不经过本扩展开发者的服务器；清洗后的最终正文会作为一条新消息发送到**一个新的 DeepSeek 会话**，因此会到达 DeepSeek。
- **存档留在本地**，存在浏览器 IndexedDB；扩展能生成的备份 JSON 含完整对话内容，请按敏感数据对待。
- **只有滚动摘要会向模型发起整理请求**，可选**免费的网页版**（用你已登录的 DeepSeek 页面，无需 Key，会在你的账号下产生工作会话）或 **API 版**（你自己的 Key）。发送的是当前分块清洗后的对话正文加上一代持续状态；**不发送**思考过程、搜索记录、原始工具输出、原始 SSE 帧、附件。
- **你的 API Key** 只存在 `chrome.storage.local`（勾选「记住」时）或 `session` 存储（不勾选时）。它不进对话存档、不进备份、不写日志、不进诊断信息。
- **诊断报告可以放心分享**：「复制测试报告」只输出数量、字符数、比例和状态 —— 不含对话正文、不含迁移正文、不含 message id、不含你的 Key。

---

## 架构

一条刻意保持精简的管线，分段设计，任何一段都不能改写你的原文。

```
SOURCE ──▶ DRAFT ──▶ RUN
(存档)     (待迁移正文，  (传输 + 结果)
            带版本)

  background ──▶ recorder-main（主环境）  拦截原始传输帧
             ──▶ recorder-bridge          转发给后台
             ──▶ content（隔离环境）        调用 history_messages、响应自检
             ──▶ db                        IndexedDB：sessions / messages / raw / drafts / runs
             ──▶ transport                 把草稿注入页面输入框
             ──▶ outcome                   判定发送结果

  sidepanel  ──▶ app                          迁移 / 历史 / 设置界面
             ──▶ forge + phase0               生成式 Forge（冻结核心）
             ──▶ forge-provider               DeepSeek API Provider
             ──▶ web-forge                    DeepSeek 网页版 Provider（含断点续跑）
             ──▶ forge-lineage                代际绑定
```

数据形态与冻结核心的边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

有一条结构约束比其它都重要：**IndexedDB 只在后台与侧栏里访问。** 从内容脚本写 IndexedDB 会把存档落到 `chat.deepseek.com` 域名之下 —— 网站清缓存就能删掉，侧栏也读不到。内容脚本负责取数，后台负责落盘。

---

## 开发

无需构建步骤，无依赖。Node.js 只用于测试与打包。

```bash
npm test          # 全部 test-*.mjs
npm run package   # 确定性商店包
```

测试跑在本地 stub 上，从不调用 DeepSeek。见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

行尾由 [`.gitattributes`](.gitattributes)（`* text=auto eol=lf`）固定，保证任何平台全新检出构建出的字节一致。

---

## 已知限制

- **仅支持 DeepSeek。** 协议处理针对 `chat.deepseek.com`。
- **读取基于快照。** 每次读取整个会话并覆盖同一个键；没有增量同步，也没有自动清理。
- **`LONG_SESSION_FORGE_E2E = UNVALIDATED`。** 滚动摘要尚未在真正满窗口的真实会话上验证。这是已记录、且不阻塞发布的边界。
- 迁移是把历史**作为文本**交给新会话，无法还原服务器端的消息角色或模型内部状态。
- 合成样本（200 / 1000 / 3000 轮）验证的是本地归档、去重、清洗、分支顺序、性能与本地包预算 —— **不**证明 DeepSeek 网页版的真实容量。

---

## 许可证

「桥 · Session Bridge」由 **kiloeee** 开发与维护。版权归属：

- kiloeee 对其**原创代码与素材**，以及在**有权修改的上游文件中所做的原创修改贡献**，保留版权。
- 源自上游 `deepseek-archive` 的**原始代码**，版权归原作者 **Liuxd-1230**，继续以 **MIT** 分发。
- 本作品**整体**以 **GNU GPL-3.0-only** 分发；GPL 只约束**分发条款**，不改变上述各部分的版权归属，也不等于把所有代码的独占版权都归 kiloeee。全文见 [`LICENSE`](LICENSE)。

## 上游署名

Session Bridge 的本地存档层派生自
[`Liuxd-1230/deepseek-archive`](https://github.com/Liuxd-1230/deepseek-archive)
（**MIT**，Copyright (c) 2026 Liuxd-1230），固定在提交
`ab202db540f8e2070b6056d324931962e294af5f`。上游**原始代码**保留上游 MIT 许可证，
**不随本作品整体重新授权**；kiloeee 在这些文件上新增或改写的部分归 kiloeee，作为本作品
整体的一部分以 GPL-3.0-only 分发。逐文件清单（区分上游原始贡献与后续修改贡献）与完整
MIT 全文见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)，blob 比对依据见
[`docs/OPEN_SOURCE_PROVENANCE.md`](docs/OPEN_SOURCE_PROVENANCE.md)。

「换窗续接」的思路也参考了 [`NOTICE.md`](NOTICE.md) 中列出的先行工作。本项目不内嵌任何第三方代码。

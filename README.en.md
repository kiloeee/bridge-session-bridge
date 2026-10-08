# 桥 · Session Bridge

**Your DeepSeek conversation is full — you shouldn't have to start over.**

Session Bridge carries a conversation forward into a **new** DeepSeek session, so
you keep continuity instead of re-introducing yourself.

It is a **conversation-continuity tool, not an exporter.** An exporter hands you a
file and leaves you to it; Session Bridge hands the conversation itself to a fresh
session and lets you keep going.

| | |
|---|---|
| Manifest name | `桥 · Session Bridge` |
| Version | 0.4.1 |
| Target | Edge / Chrome, Manifest V3, side panel |
| Runtime dependencies | **none** |
| License | GPL-3.0-only (upstream-derived portions remain MIT) — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) |

Chinese documentation: [`README.md`](README.md).

---

## Install

There are two ways to install. **Method 1 works right now** (the Microsoft Edge
Add-ons build is still under review).

### Method 1 — download from GitHub Releases (use this today)

1. Open the [Releases page](https://github.com/kiloeee/bridge-session-bridge/releases).
2. Under **Assets**, download **`bridge-v0.4.1-edge.zip`** — *not* the
   "Source code" ZIP that GitHub adds automatically.
3. Unzip it to a folder you will keep.
4. In Edge's address bar, open `edge://extensions`.
5. Turn on **Developer mode** (bottom-left).
6. Click **Load unpacked** and select the folder that contains `manifest.json`.
7. Open `https://chat.deepseek.com/` and click the extension icon to open the
   side panel.

Full step-by-step guide with the security details: [`docs/INSTALL.md`](docs/INSTALL.md).

> **Verify your download.** `bridge-v0.4.1-edge.zip` SHA-256:
> `f5d09022f28efd42e8bb664f494cf3a3f2df3540212baf800c9f3f7a06058adb`

- The ZIP **cannot** be installed by double-clicking it. Edge needs the
  *unpacked* folder.
- You do **not** need npm, Python, or an API key to use the basic features.

### Method 2 — Microsoft Edge Add-ons

Store page:
<https://microsoftedge.microsoft.com/addons/detail/bbgdkplomihlcgndbjmcjmphgnabffbj>

The v0.4.1 submission is **still under review**. Once it clears, the store build
becomes the recommended install (Edge keeps it updated automatically). Until
then, use Method 1.

### Updating

The GitHub (unpacked) build **does not auto-update.** To update, download the
new ZIP, replace the files in the same folder, then click **Reload** on the
extension card (and refresh the DeepSeek tab if needed). See
[`docs/INSTALL.md`](docs/INSTALL.md) for what changes — and what does not — when
you move folders or install both build types.

---

## Features

- **Exact migration (完整原文)** — carries the conversation's cleaned dialogue
  text into a new session verbatim. No summarising, no rewriting, no trimming.
  Runs entirely on your machine; performs **no network request**.
- **Rolling compression (滚动摘要)** — for conversations too long to carry
  verbatim. Older turns are distilled into a *continuity state*, while key
  passages and the recent conversation are kept **word-for-word**.
- **Native text transport** — the migrated text is delivered through the DeepSeek
  page's own textarea and send control, not the clipboard, so a long migration is
  not silently turned into a `.txt` attachment.
- **Verified outcomes** — after sending, the run observes the real page and
  reports what actually happened (finished, declined, too long, rate-limited,
  network error) rather than assuming success.
- **User-controlled retry** — if a send is declined, the draft is kept and **you**
  edit and resend it. Nothing is sent silently and nothing is retried with
  altered content.
- **Local archive** — sessions are archived in your browser's IndexedDB, with
  Markdown export and one-click backup / restore.
- **No account, no backend, no telemetry.**

---

## The two migration paths

### Exact — verbatim carry-over

```
archived session
  → clean non-dialogue artifacts out (THINK, tool calls, raw frames, attachments)
  → native textarea transport
  → new DeepSeek session
  → outcome verification
```

Exact migration preserves the parent chain's `REQUEST` / `RESPONSE` strings
verbatim. It adds only migration framing, role labels and separators. Sibling
branches are not spliced in; a snapshot whose parent chain cannot be fully
confirmed stops the migration instead of guessing.

### Rolling — continuity + important exact + recent exact

```
archived session
  → Forge
  → Continuity state  (identity, stable facts, active threads, decisions,
                       open loops, recent changes, interaction preferences)
  + Important exact   (key passages, kept word-for-word)
  + Recent exact      (the last turns, kept word-for-word)
  → new DeepSeek session
```

Rolling compression never re-sends the whole history: each request carries the
*previous* continuity state plus the current chunk. The model returns state and
message ids only — **the body text is always read back from your local archive**,
so the model can never rewrite your words.

A rolling migration records a **generation** (`new session ← source session` plus
that generation's continuity state). The next window is bound automatically the
first time it is read, so the next rolling pass continues without any manual
import. Exact migration does **not** create a generation.

If rolling output turns out *larger* than the source (common for short
conversations), the extension does not migrate the larger packet — it says the
conversation does not need compression yet and offers exact migration instead.

---

## Providers

Rolling compression can run through either provider; the migration result is the
same shape either way.

| Provider | Requires | Notes |
|---|---|---|
| **DeepSeek Web** | a logged-in DeepSeek tab | no API key, no extra permission; supports checkpoint / resume |
| **DeepSeek API** | your own DeepSeek API key | calls `api.deepseek.com` directly |

- **The API is optional.** Exact migration never needs it.
- The API host permission is requested **only** when you configure the API
  provider, and can be revoked afterwards.
- There is **no Session Bridge account, no Session Bridge cloud, and no Session
  Bridge server.** Requests go straight to `api.deepseek.com` using your key.

---

## Privacy

The short version: **there is no server.** The full policy is in
[`PRIVACY.md`](PRIVACY.md).

- **Exact migration is entirely local** and makes no network request.
- **Archives stay local.** They live in your browser's IndexedDB; the backup JSON
  the extension can produce contains your full conversation content, so treat it
  as sensitive.
- **Rolling compression, and only rolling compression, goes online** — and only
  when you choose it and have configured a key. What is sent is the cleaned
  dialogue text for the current chunk plus the previous continuity state. Not
  sent: thinking traces, search records, raw tool output, raw SSE frames,
  attachments.
- **Your API key** lives only in `chrome.storage.local` (or `session` storage if
  you don't check "remember"). It never enters the conversation archive, never
  enters a backup, is never logged, and never appears in diagnostics.
- **Diagnostic reports are safe to share.** The "copy test report" button emits
  counts, sizes, ratios and status only — never conversation text, never the
  migrated packet, never message ids, never your key.

---

## Architecture

A deliberately small pipeline, split so that no single stage can rewrite your
words.

```
SOURCE ──▶ DRAFT ──▶ RUN
(archive)  (exact text,   (transport + outcome)
            versioned)

  background ──▶ recorder-main (MAIN world)  captures raw transport frames
             ──▶ recorder-bridge             forwards them to the background
             ──▶ content (isolated)          calls history_messages, responds to probes
             ──▶ db                          IndexedDB: sessions, messages, raw, drafts, runs
             ──▶ transport                   injects the draft into the page textarea
             ──▶ outcome                     classifies the send result

  sidepanel  ──▶ app                          migration / history / settings UI
             ──▶ forge + phase0               Generational Forge (frozen core)
             ──▶ forge-provider               DeepSeek API provider
             ──▶ web-forge                    DeepSeek Web provider (+ checkpoint/resume)
             ──▶ forge-lineage                generation binding
```

Details, data shapes and the frozen-core boundary are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

One structural rule matters more than the rest: **IndexedDB is only touched by
the background and the side panel.** Writing it from a content script would put
archive data under the `chat.deepseek.com` origin, where the site could clear it
and the side panel could not read it. Content scripts fetch; the background
stores.

---

## Development

No build step, no dependencies. Node.js is used only for tests and packaging.

```bash
npm test          # all test-*.mjs
npm run package   # deterministic store ZIP
```

The tests run against local stubs and never call DeepSeek. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

Line endings are pinned by [`.gitattributes`](.gitattributes) (`* text=auto
eol=lf`) so a fresh checkout builds the same bytes everywhere.

---

## Known limitations

- **DeepSeek only.** The protocol handling is specific to `chat.deepseek.com`.
- **Reading is snapshot-based.** Each read fetches the whole conversation and
  overwrites the same keys; there is no incremental sync and no automatic pruning.
- **`LONG_SESSION_FORGE_E2E = UNVALIDATED`.** Rolling compression has not been
  validated against a genuinely full-window real session. This is a known,
  documented boundary and does not block release.
- Migration passes history to the new session **as text**. It cannot restore
  server-side message roles or model-internal state.
- The synthetic fixtures (200 / 1000 / 3000 turns) validate local archiving,
  de-duplication, cleaning, branch ordering, performance and packet budgeting —
  they do **not** prove DeepSeek Web's real capacity.

---

## License

桥 · Session Bridge is developed and maintained by **kiloeee**. Copyright:

- kiloeee retains copyright in the original code and artwork, and in the
  original modifications made to upstream files kiloeee had the right to modify.
- Original code from the upstream `deepseek-archive` project remains copyright
  (c) 2026 **Liuxd-1230**, distributed under the **MIT** license.
- The work **as a whole** is distributed under **GNU GPL-3.0-only**. The GPL
  governs distribution terms only: it does not reassign the copyrights above, and
  "the whole work is under GPL-3.0-only" does **not** mean all code is
  exclusively copyrighted by kiloeee. Full text in [`LICENSE`](LICENSE).

## Upstream attribution

Session Bridge's local-archive layer is derived from
[`Liuxd-1230/deepseek-archive`](https://github.com/Liuxd-1230/deepseek-archive)
(**MIT**, Copyright (c) 2026 Liuxd-1230), pinned at commit
`ab202db540f8e2070b6056d324931962e294af5f`. The **upstream original code**
remains under the upstream MIT license and is not relicensed by this project;
the modifications kiloeee later made to those files belong to kiloeee and are
distributed as part of the GPL-3.0-only work. The per-file lists (separating
upstream original contributions from downstream modifications) and the full MIT
text are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), with the
blob-comparison basis in
[`docs/OPEN_SOURCE_PROVENANCE.md`](docs/OPEN_SOURCE_PROVENANCE.md).

The continuity-oriented framing was informed by prior art acknowledged in
[`NOTICE.md`](NOTICE.md). No third-party code is vendored.

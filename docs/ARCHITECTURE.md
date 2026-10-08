# Architecture

This document describes what the code actually does. It is written against
v0.4.1 and does not describe planned work.

## Shape of the system

Session Bridge is an MV3 extension with four execution contexts and a small set
of pure modules:

| Context | Entry | Role |
|---|---|---|
| Service worker (module) | `src/background.js` | owns IndexedDB writes, stream lifecycle, migration orchestration, worker-tab driving |
| MAIN world (page) | `src/recorder-main.js` | intercepts the page's transport, records raw bytes |
| Isolated world (content) | `src/recorder-bridge.js`, `src/content.js`, `src/transport.js` | nonce-checked relay, same-origin fetches, migration text injection |
| Side panel | `sidepanel/index.html` + `sidepanel/app.js` | UI, Forge orchestration, export, settings |

The load-bearing rule: **IndexedDB is only read or written from the background
and the side panel.** Archive data stored from a content script would live under
the `chat.deepseek.com` origin, where the site can evict it and the side panel
cannot read it. Content scripts fetch; the background stores. `chrome.storage`
holds exactly two things: `forgeConfig` (API key + model) and `forgeLineage`
(generation map), so the key can never physically enter a conversation backup.

## The three records: SOURCE → DRAFT → RUN

Migration state is deliberately split into three immutable-in-spirit records
(`src/draft.js`, stored via `src/db.js`):

- **SOURCE** — an archived session. Read-only. A draft never writes back to it.
- **DRAFT** — the exact text that will be sent, tagged with a `mode` (`exact` or
  `rolling`). Editing a draft produces a **new revision** (`parentDraftId`
  chain); the source is never mutated.
- **RUN** — transport + outcome for one send of one draft: what was attempted,
  and what actually happened.

This split is what makes "the model can never rewrite your words" structural
rather than a promise: model output only ever produces continuity *state* and
message *ids*, never draft body text.

## Ingest: snapshot + raw capture

Two paths, both landing in IndexedDB `ds-archive` (v3: `sessions`, `messages`,
`rawEvents`, `rawChunks`, `drafts`, `runs`).

1. **Authoritative snapshot** — `src/content.js` calls the page's own
   `history_messages` interface (same-origin fetch, bearer from
   `localStorage.userToken`). `src/normalize.js` maps server field names to the
   internal shape, preserving every fragment field it does not fully understand
   rather than dropping it. `src/archive.js` canonicalizes the snapshot (last
   record wins per message identity; repeated wording is not de-duplicated).
2. **Raw transcription** — `src/recorder-main.js` (MAIN world) intercepts the
   page's streaming transport and records the bytes as they arrive, with no
   parsing; `src/recorder-bridge.js` validates a page nonce and forwards batches
   to `src/background.js`, which appends them as immutable `rawEvents` /
   `rawChunks`.

The raw path exists because the snapshot path can only run after a response
finishes; bytes already on disk are unaffected by anything the server does
afterwards, and they let a body be re-derived if a parser assumption later proves
wrong.

`src/rebuild.js` replays the recorded `{p, o, v}` operation stream to
reconstruct a response body from raw frames. It is used by the side panel for
export and by the outcome classifier, and it is a pure function with no Chrome
dependency so it can be unit-tested in Node.

## DRAFT: the exact path

`src/phase0.js` is local measurement and verbatim export — no model request, no
trimming. `countChars` counts **Unicode code points** (not tokens, bytes,
graphemes or UTF-16 units), and this is the only unit used anywhere for budgets
and ratios.

Exact migration walks the current parent chain and emits `REQUEST` / `RESPONSE`
strings verbatim, adding only migration framing, role labels and separators.
`THINK`, search, tool, tip/template and attachment payloads stay in the local
archive and never enter the sent body. Sibling branches are not spliced in. A
snapshot whose full parent chain cannot be confirmed stops the migration instead
of guessing.

## DRAFT: the rolling path (Generational Forge)

`src/forge.js` is the Forge core, a pure function with **no network and no
Chrome dependency**; the semantic model call is injected. It is frozen at tag
`forge-core-v0`.

Rolling compression produces three bounded parts:

- **Continuity state** — a fixed schema (`identity`, `stableFacts`,
  `activeThreads`, `decisions`, `openLoops`, `recentChanges`,
  `interactionPreferences`). Every entry carries `source_message_ids`; free
  composition is not allowed.
- **Important exact** — key passages, kept word-for-word.
- **Recent exact** — the trailing turns, kept word-for-word (`buildRecentExact`
  in `phase0.js`).

Each request carries the *previous* continuity state plus the current chunk —
never the whole history. The model returns **state and message ids only**; body
text is always read back from the local archive. JSON parse failure retries
exactly once; there is no retry framework. The chunk budget
(`DEFAULT_CHUNK_CHARS = 12000`) is a **local determinism budget, not a DeepSeek
web limit**.

If the rolling output is larger than the source, the extension does not migrate
the larger packet; it surfaces that the conversation does not need compression
and offers the exact path, reusing the same snapshot.

### Generation / lineage

`src/forge-lineage.js` records `new session ← source session` plus that
generation's continuity state in `chrome.storage.local` under `forgeLineage`,
and the transient pending arm under `forgePending`. The next window is bound
automatically the first time it is read. The previous generation's bootstrap
message (a user message) is excluded on the next pass so the same information is
not processed twice. Exact migration does **not** create a generation.

## Providers

Both providers satisfy one contract from `forge.js`: `model(payload)` returns
`{continuity}` or `{important_message_ids}`.

- **`src/forge-provider.js` (ApiForgeProvider)** — reads/writes config, requests
  the optional `https://api.deepseek.com/*` permission, tests the connection,
  and serializes a single call to
  `POST https://api.deepseek.com/chat/completions` (default model
  `deepseek-flash`). It performs **no schema validation or rewriting** — source-id
  validation and bounding stay in `forge.js`. Config lives in
  `chrome.storage.local` (`forgeConfig`) when "remember" is checked, otherwise
  `chrome.storage.session` (`forgeSessionConfig`). The key is used only as an
  `Authorization` header to `api.deepseek.com`.
- **`src/web-forge.js` (WebForgeProvider)** — runs Forge through the logged-in
  DeepSeek web page, no API key, no extra permission. Its two pure jobs are
  rendering payloads into a page prompt (`renderForgePrompt`) and parsing the
  `RESPONSE` text back into JSON. The actual send / wait / observe is driven by a
  worker session in `src/background.js`, injected via `call`.

**Checkpoint / resume** applies to the web provider: a long rolling job can be
interrupted and resumed rather than restarted, driven by the background worker
session.

## Transport and outcome

- **`src/transport.js`** (isolated world, content script) writes the migration
  draft into the DeepSeek composer as ordinary text state — React's native value
  setter plus an `InputEvent` — then triggers the real send control. It does
  **not** use `navigator.clipboard`, paste events, `File`, `Blob` or
  `DataTransfer`. This is what keeps a long migration from being silently turned
  into a `.txt` attachment.
- **`src/outcome.js`** classifies the result with an evidence order:
  raw request → HTTP status → raw SSE → `history_messages`. It never guesses
  from on-screen Chinese wording. Every conclusion carries evidence, and
  `UNKNOWN` keeps the diagnostic instead of inventing a cause. Types:
  `SUCCESS`, `CONTENT_FILTER`, `TOO_LONG`, `RATE_LIMITED`, `NETWORK_ERROR`,
  `TRANSPORT_ERROR`, `UNKNOWN`. `summarizeRequestBody` reduces the captured
  request body to integrity evidence (ids, counts, lengths) and **never retains
  the body**.

When a send is declined, the draft is kept and the **user** edits and resends
from the side panel. Recovery is user-controlled; the extension never resends
silently and never retries with altered content.

## Side panel

`sidepanel/app.js` is the only UI code. The product display name is defined once
at the top (`PRODUCT_DISPLAY_NAME`) and derived for the header and title. The
panel is three pages — **迁移 / Migration**, **历史 / History**, **设置 /
Settings** — and loads its module graph as ES modules on `chrome-extension://`.
It reads and writes IndexedDB through `src/db.js` (never a content script).

## Packaging

`scripts/package.mjs` collects a fixed runtime whitelist
(`RUNTIME_FILES`), sorts entries, stamps a fixed timestamp (2026-01-01), stores
without compression, and computes CRC32, producing
`dist/bridge-v<manifest.version>-edge.zip`. The ZIP root is `manifest.json`
directly. The packager fails hard if any path referenced by `manifest.json` or
the side-panel HTML/CSS is missing. The package's version comes from
`manifest.json`.

The packager is **not** byte-for-byte reproducible across platforms unless line
endings are normalized; `.gitattributes` pins `* text=auto eol=lf` for this
reason.

## Frozen boundaries

- `src/forge.js` and `src/phase0.js` are pinned at tag `forge-core-v0`.
- Internal identifiers (`forge`, `rollupForge`, `forgeLineage`) are stable; the
  user-facing name for the feature is 滚动压缩 / Rolling compression.
- No runtime dependencies; every `import` resolves to a repository file or a
  `node:*` built-in.

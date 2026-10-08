# Changelog

All notable changes to 桥 · Session Bridge are recorded here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.4.1] — 2026-10-09

Licensing and attribution correction. No functional change to the extension.

### Changed

- **Relicensed.** The work **as a whole** is now distributed under **GNU
  GPL-3.0-only** — see [`LICENSE`](LICENSE). The project is developed and
  maintained by **kiloeee**, who retains copyright in the original code and
  artwork and in the original modifications made to upstream files. The GPL
  governs distribution terms only: it does not make all code exclusively
  kiloeee's.
- **Upstream attribution corrected.** Original code from
  [`Liuxd-1230/deepseek-archive`](https://github.com/Liuxd-1230/deepseek-archive)
  remains copyright (c) 2026 Liuxd-1230 under the upstream **MIT** license and is
  not relicensed; the modifications kiloeee later made to those files are
  kiloeee's. The exact file lists (separating upstream original contributions
  from downstream modifications) and the full MIT text are in
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### Fixed

- Earlier builds (v0.3.0, v0.4.0) shipped an incorrect `LICENSE` and
  `THIRD_PARTY_NOTICES.md` that attributed the entire project — including
  original work — to the upstream author, and used a retired product name in
  the notices. Those builds are superseded; do not redistribute them.

## [0.4.0] — 2026-10-07

The migration engine release. Migration no longer routes through the clipboard:
it is delivered as native text input into the new DeepSeek session, and every
migration now ends in a verified outcome.

### Added

- **Native text transport.** Migration text is sent through the DeepSeek page's
  own textarea and send control, not the clipboard. This avoids long pastes being
  silently converted into a `.txt` file attachment by the page — the failure mode
  the clipboard path could not avoid on very long migrations.
- **Migration outcome verification.** After sending, the run observes the real
  page state and classifies the result (`FINISHED`, content-filtered, too long,
  rate-limited, network error, transport error). The completion screen reports
  what actually happened instead of assuming success.
- **Manual recovery when a send is declined.** If DeepSeek declines the migrated
  text, the draft is kept and the user can edit and resend from the side panel.
  Recovery is user-controlled; nothing is sent silently and nothing is retried
  with altered content.
- **Rolling compression over the DeepSeek API.** The rolling path can now call
  `api.deepseek.com` directly with the user's own API key.
- **Web-based rolling compression.** As an alternative to the API, the same
  rolling path can run through the logged-in DeepSeek web page, with no API key
  and no additional permission.
- **Checkpoint / resume for web-based rolling compression.** A long rolling job
  can be interrupted and resumed instead of restarting from the beginning.
- **Source / Draft / Run separation.** A run is now a first-class record: the
  source (archived session), the draft (the exact text to migrate, versioned and
  immutable once sent), and the run (transport + outcome) are stored separately.

### Changed

- The migration screen offers both strategies inline (exact / rolling) instead of
  hiding one behind a dropdown, and the primary button reflects the choice.
- Rolling compression reports progress per chunk and can be cancelled without
  leaving partial state behind.
- Failure messages are translated to plain language; raw error text is confined
  to *Settings → Developer diagnostics*.

## [0.3.0] — 2026-10-06

- Reworked the migration flow into a single task on one page: read → prepare →
  copy → open a new window → done.
- Rolling compression calls the DeepSeek API directly; the local `forge-cli`
  helper is no longer required.
- Added `PRIVACY.md`.
- Renamed the user-facing product to 「桥 · Session Bridge」; internal identifiers
  (`forge`, `rollupForge`, `forgeLineage`) were intentionally left unchanged.

## [0.2.0] — 2026-10-05

- The migration page collapsed into a single primary task with a status line.
- Added deterministic packaging (`npm run package` →
  `dist/bridge-v<version>-edge.zip`).
- Froze the Generational Forge engine (tag `forge-core-v0`).

## [0.2.3] / [0.2.2] / [0.2.1] — 2026-09-24

- `0.2.1` — dual-path archiving: streamed capture plus authoritative snapshot;
  inline rebuild of filtered content; export / backup / restore.
- `0.2.2` — no field loss on tool fragments; unrecognized reference fields are
  surfaced verbatim.
- `0.2.3` — correct layout for web-search and page-open fragments; reference
  sources restored to clickable links in exports.

## [0.1.x]

Initial side-panel baseline and the Phase 0 archive/cleaning core.

---

**Note on `0.2.x`:** these releases were part of the upstream
[`deepseek-archive`](https://github.com/Liuxd-1230/deepseek-archive) lineage.
See [`NOTICE.md`](NOTICE.md).

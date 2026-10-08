# Open Source Provenance

This document records where each part of 桥 · Session Bridge comes from, so the
repository can be published without losing upstream attribution.

Baseline for comparison: this repository shares git ancestry with upstream
[`Liuxd-1230/deepseek-archive`](https://github.com/Liuxd-1230/deepseek-archive).
The merge base is commit `ab202db540f8e2070b6056d324931962e294af5f` ("docs: README
改写为正式书面风格"), which is an ancestor of `HEAD`. Every "verbatim / modified"
judgement below is a blob-hash comparison of the file at `ab202db` against the
same path at the frozen v0.4.1 `HEAD`.

## Classification legend

| Class | Meaning |
|---|---|
| **ORIGINAL** | Authored in this repository; no upstream source. |
| **DERIVED_FROM_UPSTREAM** | Traces to an upstream file or upstream logic, and is redistributed under the upstream MIT license. |
| **THIRD_PARTY** | Vendored third-party code with its own license. |
| **UNKNOWN** | Provenance not established. |

There are **no UNKNOWN** entries and **no THIRD_PARTY** entries: the extension
vendors no third-party code and has no runtime dependencies.

## License

- **Project authorship:** 桥 · Session Bridge is developed and maintained by
  **kiloeee**.
- **Whole work:** distributed under **GNU GPL-3.0-only** — full text in
  [`LICENSE`](../LICENSE). `LICENSE` is original to this repository; earlier
  builds shipped the upstream MIT file as `LICENSE`, which was incorrect and is
  superseded. The GPL governs **distribution terms only**; it does not reassign
  the copyrights below. In particular, "the whole work is distributed under
  GPL-3.0-only" does **not** mean that all code is exclusively copyrighted by
  kiloeee.
- **kiloeee's copyright:** kiloeee retains copyright in the original code and
  artwork, and in the original modifications made to upstream files kiloeee had
  the right to modify.
- **Upstream original code:** **MIT**, `Copyright (c) 2026 Liuxd-1230`,
  redistributed under the upstream MIT license and **not** relicensed by this
  project. The full MIT text and the exact file lists are in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). MIT is compatible with
  GPL-3.0, so the combination is distributed as GPL-3.0-only while those files
  keep their upstream MIT notice. Do not remove upstream attribution.

## File-by-file

### Verbatim from upstream (unmodified blobs)

| File | Class | Required attribution |
|---|---|---|
| `src/markdown.js` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |
| `src/rebuild.js` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |
| `src/recorder-main.js` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |
| `src/recorder-bridge.js` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |
| `test-rebuild.mjs` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |
| `tools/make-icons.mjs` | DERIVED_FROM_UPSTREAM (verbatim, Node-only) | MIT © 2026 Liuxd-1230 |
| `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` | DERIVED_FROM_UPSTREAM (verbatim) | MIT © 2026 Liuxd-1230 |

### Modified from upstream (upstream file, changed downstream)

| File | Class | What changed | Attribution (upstream code / kiloeee's modifications) |
|---|---|---|---|
| `src/background.js` | DERIVED_FROM_UPSTREAM | stream lifecycle extended: canonical snapshot, draft/run updates, outcome classification, worker-tab driving | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `src/content.js` | DERIVED_FROM_UPSTREAM | `history_messages` + self-check wiring extended | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `src/db.js` | DERIVED_FROM_UPSTREAM | IndexedDB archive extended with `drafts` / `runs` stores | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `src/normalize.js` | DERIVED_FROM_UPSTREAM | snapshot normalization extended | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `sidepanel/app.js` | DERIVED_FROM_UPSTREAM | rewritten for the three-page product flow | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `sidepanel/index.html` | DERIVED_FROM_UPSTREAM | reworked for the three-page flow | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `sidepanel/style.css` | DERIVED_FROM_UPSTREAM | reworked | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `manifest.json` | DERIVED_FROM_UPSTREAM | renamed, versioned 0.4.1, added recorder/transport content scripts, side-panel config | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `.gitignore` | DERIVED_FROM_UPSTREAM | expanded for the public tree | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |
| `README.md` | DERIVED_FROM_UPSTREAM | rewritten for the public project (see note below) | MIT © 2026 Liuxd-1230 / © 2026 kiloeee (GPL-3.0-only) |

These files combine two copyright holders: the **upstream original code** stays
under the upstream **MIT** license (© 2026 Liuxd-1230), and the **modifications
made downstream** are © 2026 **kiloeee** and are distributed as part of the
GPL-3.0-only work. Neither holder's contribution is absorbed into the other.

### Original to this repository (new files, no upstream source)

| File | Class |
|---|---|
| `src/archive.js` | ORIGINAL (logic extracted from upstream's archive handling; newly authored file) |
| `src/draft.js` | ORIGINAL |
| `src/forge.js` | ORIGINAL (frozen at tag `forge-core-v0`) |
| `src/phase0.js` | ORIGINAL (frozen at tag `forge-core-v0`) |
| `src/forge-lineage.js` | ORIGINAL |
| `src/forge-provider.js` | ORIGINAL |
| `src/outcome.js` | ORIGINAL |
| `src/transport.js` | ORIGINAL |
| `src/web-forge.js` | ORIGINAL |
| `test-archive.mjs`, `test-draft.mjs`, `test-forge.mjs`, `test-forge-provider.mjs`, `test-outcome.mjs`, `test-phase0.mjs`, `test-product-flow.mjs`, `test-scale.mjs`, `test-web-forge.mjs` | ORIGINAL |
| `scripts/package.mjs`, `scripts/generate-fixtures.mjs`, `scripts/forge-semantic-e2e/*` | ORIGINAL |
| `forge-cli.mjs` | ORIGINAL (legacy entry point; superseded, referenced by nothing) |
| `sidepanel/assets/*.png` (8 files) | ORIGINAL (artwork) |
| `CHANGELOG.md`, `CONTRIBUTING.md`, `NOTICE.md`, `PRIVACY.md`, `SECURITY.md`, `STORE_LISTING.md`, `THIRD_PARTY_NOTICES.md`, `.gitattributes`, `docs/*` | ORIGINAL |

## Note on `README.md`

`README.md` is a DERIVED_FROM_UPSTREAM path (the upstream shipped a README there),
but its **content has been rewritten** for the public project. In the public
tree it carries the current product description and the upstream attribution in
its "Upstream attribution" section. This is why the file is attributed upstream
*and* is not itself an upstream artifact.

## Note on `THIRD_PARTY_NOTICES.md`

[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) is the attribution file
that ships inside the install package. It states the whole-work distribution
license (GPL-3.0-only), credits the project author (kiloeee), and lists — in two
tiers — the upstream original code that remains under the upstream MIT license,
and the modifications kiloeee made to those files. It matches this table, with
one clarification: `src/archive.js` is ORIGINAL — added in this repository, its
*logic* extracted from upstream's archive handling — and is therefore **not**
listed as upstream-derived.

## Ideas and prior art (not code)

The continuity framing was informed by the references in
[`NOTICE.md`](../NOTICE.md). Neither is a code dependency and neither is
vendored.

## Deterministic claim

No file in this repository is a copy of third-party source outside the upstream
`deepseek-archive` lineage above. `npm ls`-style inspection is not applicable
because there is no `dependencies` set; every `import` resolves to a repository
file or a `node:*` built-in.

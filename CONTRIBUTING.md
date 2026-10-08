# Contributing

Thanks for taking a look. This is a small, single-purpose MV3 extension; the
guidance below keeps changes reviewable.

## Getting set up

There are no runtime dependencies and no build step for the extension itself.

```bash
git clone <your-fork-url>
cd bridge-session-bridge
```

Load the unpacked extension:

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository root (the folder that
   contains `manifest.json`).
4. Allow access to `https://chat.deepseek.com/`, open an existing DeepSeek
   conversation, and click the extension icon to open the side panel.

After editing source, click **Reload** on the extension card and refresh the
DeepSeek tab so the page scripts are re-injected.

## Tests

```bash
npm test          # runs every test-*.mjs
```

Individual suites:

```bash
node test-phase0.mjs
node test-archive.mjs
node test-forge.mjs
node test-forge-provider.mjs
node test-product-flow.mjs
node test-rebuild.mjs
node test-outcome.mjs
node test-web-forge.mjs
node test-draft.mjs
node test-scale.mjs
```

The tests use local stubs and **never call DeepSeek**. `test-product-flow.mjs`
exercises the side-panel flow end to end against stubs.

## Packaging

```bash
npm run package   # -> dist/bridge-v<manifest.version>-edge.zip
```

The packager (`scripts/package.mjs`) collects a fixed runtime whitelist, sorts
entries, stamps a fixed timestamp, stores without compression and computes CRC32,
so the ZIP is deterministic. It fails hard if anything referenced by
`manifest.json` or the side-panel HTML/CSS is missing from the package.

**Do not commit `dist/`.** The ZIP is a build artifact.

## Line endings

`.gitattributes` pins `* text=auto eol=lf`. Keep it that way — it is the reason
a fresh checkout builds the same bytes on every platform. Do not "fix" line
endings in a PR; if you see CRLF noise, check `core.autocrlf` in your local git
config instead.

## Conventions

- **Internal identifiers are frozen.** The source uses `forge`, `rollupForge`,
  `forgeLineage` for the rolling-compression engine. The user-facing name for
  that feature is **滚动压缩 / Rolling compression**. UI text may change; these
  code identifiers do not.
- **The Forge core is frozen.** `src/forge.js` and `src/phase0.js` are pinned at
  tag `forge-core-v0`. Behavioural changes to the rolling algorithm need a
  deliberate, reviewed reason — not an incidental refactor.
- **No new runtime dependencies.** The extension ships with zero third-party
  code; keep it that way.
- **IndexedDB is only touched from the background and the side panel.** Writing
  IndexedDB from a content script would place archive data under the
  `chat.deepseek.com` origin, where the site could clear it and the side panel
  could not read it. Content scripts fetch; the background stores.

## Pull requests

- Keep the change scoped; one concern per PR.
- Run `npm test` before opening a PR.
- Describe *why*, not just *what*.
- If you touch the migration transport or the outcome classifier, say so
  explicitly in the PR description — those are the load-bearing paths.

## Reporting security issues

See [`SECURITY.md`](SECURITY.md). Please do not open a public issue for a
security problem.

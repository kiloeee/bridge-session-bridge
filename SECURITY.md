# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately using GitHub's **Security → Report a vulnerability** tab on
this repository (GitHub Security Advisories). If that is not available to you,
contact the developer through the support contact listed on the extension's
Edge Add-ons store page.

Please include:

- what the issue is and why it matters,
- the smallest reproduction you can manage,
- the version (`manifest.json` → `version`) and browser build,
- whether the issue involves the DeepSeek API path, the web path, or the local
  archive.

We will acknowledge a report and follow up with an assessment. Please allow a
reasonable window for a fix before any public disclosure.

## What counts as in scope

This extension handles three kinds of sensitive material, and issues touching
any of them are security-relevant:

1. **The user's DeepSeek API key.**
2. **Archived conversation content** (IndexedDB, backup JSON).
3. **The migrated text**, which is injected into the DeepSeek page.

## Credential handling (how the code is supposed to behave)

These are invariants, not aspirations — a report that breaks one of them is a
valid security bug:

- The DeepSeek API key is stored **only** in `chrome.storage.local` (when
  "remember" is checked) or `chrome.storage.session` (when it is not). It is
  **never** written to IndexedDB, never included in `exportAll()`, never written
  to a log, and never included in diagnostics or error text.
- The key is used **only** as an `Authorization` header on requests to
  `https://api.deepseek.com/`. It is not sent anywhere else.
- The API host permission (`https://api.deepseek.com/*`) is **optional** and
  requested only when the user configures rolling compression using the API.
- **Exact (verbatim) migration performs no network request at all.**
- Diagnostic / "copy test report" output contains counts, sizes, ratios and
  status only — **no** conversation body, no continuity text, no migrated packet
  text, no message ids and no API key.
- The extension has no backend. There is no Session Bridge server, no account,
  and no telemetry.

## Out of scope

- DeepSeek's own service, API behaviour, or content policy.
- The security of a browser profile that has been tampered with locally.
- Anything requiring an attacker who already has code execution on the user's
  machine (they can already read the local archive directly).

## Supported versions

Only the latest released version receives security fixes.

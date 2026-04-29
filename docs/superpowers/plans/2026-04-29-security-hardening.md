# Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden ContextHelper against accidental data disclosure, stale DOM replacement, invalid configuration, and fragile runtime behavior.

**Architecture:** Keep the MV3 extension dependency-free and vanilla JS. Add a small Node built-in test harness for pure modules, centralize settings validation in `lib/storage.js`, and keep UI/runtime fixes minimal in existing files.

**Tech Stack:** Chrome MV3, vanilla JS ES modules, `node:test`, `node:assert/strict`.

---

### Task 1: Test Harness And Validation Tests

**Files:**
- Create: `package.json`
- Create: `tests/storage.test.js`
- Create: `tests/webhook.test.js`

- [ ] Add `package.json` with `type: "module"` and `test` script using `node --test`.
- [ ] Write failing tests for HTTPS webhook validation, model config validation, action reference validation, sync quota preflight, tooltip sanitizer, and webhook origin patterns preserving ports.
- [ ] Run `npm test` and confirm failures are from missing behavior.

### Task 2: Storage And Webhook Hardening

**Files:**
- Modify: `lib/storage.js`
- Modify: `lib/webhook.js`

- [ ] Implement validation helpers in `lib/storage.js`.
- [ ] Require non-empty API keys and effective model IDs.
- [ ] Require HTTPS webhook URLs except loopback/local development hosts.
- [ ] Validate action `modelConfigId` and `webhookId` references.
- [ ] Sanitize tooltip settings and dark mode values.
- [ ] Add sync storage quota preflight.
- [ ] Preserve URL ports in `originPatternForUrl()`.
- [ ] Run `npm test` and confirm pass.

### Task 3: Runtime Request And DOM Safety

**Files:**
- Modify: `background.js`
- Modify: `content.js`

- [ ] Make content script injection and `AI_PROCESSING_START` delivery explicit success gates before calling AI.
- [ ] Track abort controllers by tab instead of globally.
- [ ] Use stable action IDs for context menu mapping, with legacy fallback only for old actions lacking IDs.
- [ ] Capture selection snapshot at request start and insert only if focus/selection still match.
- [ ] Restrict read-only DOM replacement to simple single-text-node ranges.

### Task 4: Options Security And UI Cleanup

**Files:**
- Modify: `options.html`
- Modify: `options.js`
- Modify: `options.css`
- Modify: `manifest.json`

- [ ] Make webhook header values password inputs.
- [ ] Warn on webhook save when origin permission is missing.
- [ ] Clear stale save status timers.
- [ ] Remove external Google Fonts.
- [ ] Narrow provider host permissions.
- [ ] Add responsive rules for dense option forms.
- [ ] Remove dead provider-toggle CSS.

### Task 5: Verification

**Files:**
- No production edits.

- [ ] Run `npm test`.
- [ ] Run `node --check` for all JS files.
- [ ] Parse `manifest.json` with Node.
- [ ] Report exact changed files and verification output.

# ContextHelper 1.1.0 review fixes: plan (draft for Codex consultation)

**Context:** these fixes follow a `/code-review` of the 1.1.0 work on `main` (`f0d549a`). The architecture is described in CLAUDE.md:
- `runChat`, streaming, clientId protocol: "The `runChat` runner";
- messages: "Message protocol";
- templates and page context: "Action template syntax".

**Constraints:**
- No new dependencies.
- `content.js` stays an IIFE.
- Pure logic goes in `lib/` with `node --test` tests, and there are no test-only exports.
- UI strings are English.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Fixes

### 1. Stream idle timeout kills reasoning models (`lib/api-client.js` `readStream`)
**Problem:** reasoning models (gpt-5.4-mini, Gemini thinking) send nothing, or only a role chunk, for more than 30 s while they think. `readStream` then fails with "API stream stalled". Before, the non-streaming request had 90 s.

**Proposal:** two-phase idle timer.
- **Until the first non-empty text delta:** `firstTokenMs` (default 90 000, the same as `REQUEST_TIMEOUT_MS`), measured from the start of the stream. Keep-alive bytes (Anthropic `ping`, OpenRouter `:` comments, an empty role chunk) do **not** reset this phase.
- **After the first delta:** the existing `idleMs` 30 s, reset by any bytes.
- `totalMs` 240 s is unchanged.
- `streamTimeouts` gains `firstTokenMs`.

**Tests:**
- a stream that sends a role chunk, waits longer than `idleMs` but less than `firstTokenMs`, then sends deltas → resolves;
- no delta before `firstTokenMs` → rejects `/stalled/`;
- a pause longer than `idleMs` after the first delta → rejects.

### 2. Clicking the page while the spinner shows cancels the run (`content.js` `showLoading`)
**Problem:** the spinner registered `addOutsideClickHandler(cancelActiveRun)`. A click on the page, or into the textarea in insert mode, aborts the run, so the tokens are spent and no result arrives.

**Proposal:**
- Drop the outside-click cancellation for the spinner. Keep Esc and the ✕ button.
- The streaming tooltip keeps outside-click cancel? **Question for review.** Proposal: also drop it. Instead, an outside click while streaming just leaves the tooltip running; only ✕/Esc cancel. A finished result tooltip keeps closing on outside click.

### 3. Sensitive fields via the context menu (`background.js` `handleMenuClick`, Ask menu path)
**Problem:** the keyboard path blocks password and payment fields. The context-menu path sends `info.selectionText` from `autocomplete=cc-number` or password-like fields unchanged.

**Proposal:**
- When `info.editable` is true, run one probe in the clicked frame (`chrome.scripting.executeScript({ target: { tabId, frameIds: [info.frameId] } })`) that reports whether the focused field is sensitive.
- If it is, call `showTabNotice(tab.id, 'ContextHelper does not send password or payment fields', settings)` and stop.
- The probe failing (restricted frame) → proceed as today, since there is no value we could read anyway. **Question:** fail open or fail closed?

### 4. A non-text focused input hides the page selection (`getSelectionFromTab`)
**Problem:** focus on a checkbox, range or submit `<input>` now returns `{ text: '' }` without falling back to `window.getSelection()`.

**Proposal:**
- Only text-capable controls (textarea, and input `type ∈ {text, search, url, email, tel}`) with a non-empty selection take the control path.
- Sensitive controls (password, `autocomplete` contains `password`, a `cc-` token) with a selection → `{ text: '', sensitive: true }`. The caller shows the sensitive-field notice instead of "Select some text first".
- Anything else → fall through to `window.getSelection()`.

### 5. `isPrivateHost` rejects common LAN and VPN hosts (`lib/api-client.js`)
Accept these hosts as private:
- single-label hostnames (no dot, e.g. `gpu-box`);
- `100.64.0.0/10` (Tailscale/CGNAT);
- `169.254.0.0/16`;
- `*.internal`, `*.lan`, `*.home.arpa`.

Add a test for each, plus negatives `100.128.0.1` and `169.255.0.1`.

### 6. Flash of the streaming tooltip for fast answers (`runChat`)
**Problem:** `throttle.flush()` before `AI_RESULT` sends a last `AI_CHUNK`.

**Proposal:** `cancel()` only, never flush. `AI_RESULT` carries the full text.

**Check:** content's `AI_RESULT` handler must still read the streaming tooltip position when present. Without a streaming tooltip, it uses the selection anchor as today.

### 7. Quadratic `AI_CHUNK` volume
**Proposal:** `AI_CHUNK { requestId, offset, delta, tooltipSettings }`.
- **Background:**
  - keeps `sentLength`;
  - the throttled sender computes `delta = text.slice(sentLength)` and sends `offset = sentLength`;
  - empty deltas are skipped.
- **Content (`showStreamingTooltip` / `renderStreamDelta`):**
  - appends when `offset === shownLength`;
  - on a mismatch (should never happen; tabs messaging is ordered), ignores the chunk and waits for `AI_RESULT`.
- **Pure helper in `lib/chat.js`:** `nextChunk(sentLength, text)` → `{ offset, delta } | null`, unit-tested.

### 8. Early-spinner invariant is fragile
**Problem:** the spinner started by `requestRun` (refine, retry, Ask) clears only if every background path answers with START (`runChat`) or `showTabNotice(..., clientId)`. A forgotten early return leaves it forever.

**Proposal:** a content-side watchdog. `requestRun` arms a 20 s timer for its `clientId`.
- If no `AI_PROCESSING_START` with that `clientId` has arrived by then, and the id is still pending (not dismissed or superseded), show the error tooltip `'The request did not start — try again'` and mark the id dismissed, so a very late START is cancelled.
- The timer is cleared on START, on dismissal and by `hideOverlay` cleanups.

**Alternative:** an ack via `sendResponse` from the background handlers. **Question for review:** which is better?

### 9. Duplication cleanup (`background.js`)
- **`abortTabRun(tabId)`** replaces the copied abort-and-delete blocks in `showTabNotice` and `showAskPrompt` (and `runChat` uses it for the previous run).
- **One injected probe for field sensitivity:** `getSelectionFromTab`, `getPageContext` and the new item-3 probe currently copy the text-type and sensitive-field rule into self-contained injected functions.
  - **Proposal:** a single injected function `probeSelection({ withContext })`, used by all three. It returns `{ text, editable, sensitive, blockText, start, end, title, url }`.
  - The rule lives once, in that function.
  - The rule as data (`TEXT_INPUT_TYPES`, the sensitive `autocomplete` regex source) is passed as `args` from a `lib/` constant, so tests can pin the data. A pure `isSensitiveField({ tagName, type, autocomplete })` in `lib/prompt.js` is tested and documents the same rule.
  - **Question:** the injected function cannot import it. Is passing the rule as args plus a duplicate 5-line check acceptable, or should the probe return attributes and let the background decide? That would put a password value into the service worker's memory, so prefer not.
- **Config resolvers:** `resolveModelConfig` (background, falls back to the first config including DeepL) vs `pickLLMConfig` (first non-DeepL).
  - **Proposal:** a pure `resolveActionConfig(configs, action)` in `lib/chat.js`:
    - the config by `modelConfigId`;
    - if the id is set but not found → `null`, giving the error "This action's model was removed — pick another in settings";
    - empty id → `configs[0]`.
  - Used by `runAction` and by refine of an action. Ask keeps `pickLLMConfig`. Refine of a DeepL-backed action keeps its error.
  - Unit-test it.

## Execution
- **Branch:** `fix/review-1-1-0`, one implementer (Opus) in a worktree.
- **Commits:** items 1, 2+6, 3+4+9(probe), 5, 7, 8, 9(rest), separately.
- **Review:** Codex (scoped, plus a final pass).

---

## Revision 2: rulings after the Codex consultation (these override the drafts above)

**1. Two-phase inactivity, not a hard first-token deadline.**
- Before the first answer text: the inactivity limit is `preAnswerIdleMs` (default 90 000), reset by any transport bytes (pings, comments, reasoning or role chunks).
- After the first answer text: `idleMs` 30 000, as today.
- Both phases are bounded by `totalMs` 240 000.
- `streamTimeouts` gains `preAnswerIdleMs`.
- **Also fix:** Gemini parts with `thought: true` must be excluded from answer text in both `extractGeminiText` and `parseStreamEvent('google')`. Add tests.
- Anthropic `thinking_delta` / `signature_delta` / `ping` are already not answer text; add a test that pins this.
- Out of scope (note for the user): OpenAI reasoning-model parameters (`temperature`, the token budget).

**2. Cancellation UX.** Remove outside-click cancellation from **both** the spinner and the streaming tooltip; only Esc and ✕ cancel. Finished result tooltips still dismiss on an outside click. Insert safety already holds: `replaceSelectedText` / `forceReplaceInDOM` require `snapshotStillSelected` (offsets plus substring). Verify this, and do not weaken it.

**3. Fail closed, in the clicked frame.**
- When `info.editable` is true, both context-menu branches (Ask and actions) probe the focused field in `frameIds: [info.frameId ?? 0]` before using `info.selectionText`.
- Sensitive → notice `'ContextHelper does not send password or payment fields'`.
- A failed probe (no access to that frame) → the same notice, i.e. fail closed.
- Ruling: full frame propagation (iframe-targeted context, insertion and messaging) stays out of scope. It is a pre-existing limitation, recorded as a known issue.

**4. Sensitivity before value, everywhere.**
- The probe decides sensitivity from the element's attributes only (tag, `type` incl. `password`, `autocomplete` containing `password` or a `cc-` token) and never reads `.value` of a sensitive element.
- The focus walk descends into open shadow roots (`activeElement.shadowRoot?.activeElement` loop).
- Non-text, non-sensitive controls fall through to `window.getSelection()`.
- Keyboard callers (`handleCommand` and the Ask command path) show the sensitive notice when the probe reports `sensitive`.

**5.** As drafted, plus tests for:
- range boundaries (`100.63.255.255` no, `100.64.0.0` yes, `100.127.255.255` yes, `100.128.0.0` no; `169.254.x` yes);
- malformed IPv4 (`300.1.1.1` no);
- suffix spoofing (`evil.lan.example.com` no, `x.lan` yes);
- empty or invalid single labels;
- IPv6 still rejected.

**6.** As drafted: cancel only, no flush.

**7. Delta chunks, with ordering made explicit.**
- `AI_CHUNK { requestId, offset, delta, tooltipSettings }`.
- In `runChat`, all tab sends for a run go through a per-run promise chain, so a chunk and the terminal `AI_RESULT` / `AI_ERROR` are delivered in issue order. On completion: `throttle.cancel()`, await the chain, then send the terminal message.
- Content keeps a numeric `streamShownLength`. On `offset !== streamShownLength` it marks the stream desynced (ignores further chunks for that requestId) and waits for `AI_RESULT`.
- Pure helper `nextChunk(sentLength, text)` in `lib/chat.js`, tested.

**8. Watchdogs in content.js.**
- **(a)** After `requestRun`, a 20 s timer waits for START with that `clientId`. On timeout: error tooltip `'The request did not start — try again'`, and the id is marked dismissed. The timer is cleared on START, dismissal and supersession.
- **(b)** After any START, a completion watchdog of 300 s (> `totalMs` 240 s + margin) is reset by each chunk. On expiry: error tooltip `'No response — the request may have been interrupted'`, and `activeRequestId = null`.
- Never resend automatically.

**9. Cleanup.**
- `abortTabRun(tabId)` keeps the controller-identity check in `runChat`'s `finally`.
- **The probe** is ONE self-contained function exported from a new `lib/page-probe.js`, as `probeSelection(rules, withContext)`.
  - It has no outer references, so `chrome.scripting.executeScript({ func: probeSelection, args: [SELECTION_RULES, withContext] })` can serialize it.
  - `SELECTION_RULES` (text input types, the sensitive autocomplete pattern source) is exported next to it.
  - Tests import `probeSelection` and run it against a minimal stubbed `document`/`window` (activeElement, getSelection, range, closest, textContent) to cover:
    - a password input;
    - `cc-number`;
    - a text input with a selection;
    - a checkbox focused with a page selection (falls through);
    - a shadow-root focus;
    - context offsets for repeated text.
  - It replaces the injected functions in `getSelectionFromTab`, `getPageContext` and the item-3 probe.
- **`resolveActionConfig(configs, action)`** in `lib/chat.js`:
  - an id that is set but missing → `null`, giving the error `"This action's model was removed — pick another in settings"`;
  - an empty id → `configs[0]`.
  - Used by `runAction` and by refine of an action. DeepL rejection in refine stays. Tested.
- **Update CLAUDE.md** for the protocol and lifetime changes: `AI_CHUNK` shape, watchdogs, probe, cancellation.

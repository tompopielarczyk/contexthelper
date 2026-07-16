(() => {
  'use strict';

  if (window.__contexthelper_loaded) return;

  let overlayHost = null;
  let shadowRoot = null;
  let lastSelectionRect = null;
  let activeCleanups = [];
  let activeRequestId = 0;
  let activeSelectionSnapshot = null;

  function isTextControl(el) {
    if (!el) return false;
    return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  }

  function captureSelectionRect(event) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        lastSelectionRect = rect;
        return;
      }
    }

    // Selection inside input/textarea is not represented by window.getSelection().
    const target = event?.target;
    const control = isTextControl(target) ? target : null;
    if (control && control.selectionStart != null && control.selectionEnd != null && control.selectionEnd > control.selectionStart) {
      lastSelectionRect = control.getBoundingClientRect();
    }
  }

  // Capture selection position on mouseup (before context menu clears it)
  document.addEventListener('mouseup', captureSelectionRect);

  // Also capture on contextmenu for right-click
  document.addEventListener('contextmenu', captureSelectionRect);

  // Capture selection present at injection time (script loads after context menu click)
  function captureInitialSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        lastSelectionRect = rect;
        return;
      }
    }
    const activeEl = document.activeElement;
    if (isTextControl(activeEl) && activeEl.selectionStart != null && activeEl.selectionEnd != null && activeEl.selectionEnd > activeEl.selectionStart) {
      lastSelectionRect = activeEl.getBoundingClientRect();
    }
  }
  captureInitialSelection();

  chrome.runtime.onMessage.addListener((message) => {
    const ts = message.tooltipSettings;

    switch (message.type) {
      case 'AI_PROCESSING_START':
        if (message.requestId !== undefined) activeRequestId = message.requestId;
        activeSelectionSnapshot = captureInsertionSnapshot();
        showLoading(ts);
        break;
      case 'AI_RESULT': {
        if (message.requestId !== activeRequestId) return;
        hideOverlay();
        const mode = message.displayMode || 'auto';
        const sendContext = message.webhooks?.length && message.webhookData
          ? { webhooks: message.webhooks, webhookData: message.webhookData }
          : null;
        if (mode === 'tooltip') {
          showResultTooltip(message.text, ts, sendContext);
        } else if (mode === 'insert') {
          const replaced = replaceSelectedText(message.text, activeSelectionSnapshot) || forceReplaceInDOM(message.text, activeSelectionSnapshot);
          if (!replaced) showResultTooltip(message.text, ts, sendContext);
        } else {
          const replaced = message.editable ? replaceSelectedText(message.text, activeSelectionSnapshot) : false;
          if (!replaced) showResultTooltip(message.text, ts, sendContext);
        }
        activeSelectionSnapshot = null;
        break;
      }
      case 'AI_ERROR':
        if (message.requestId !== activeRequestId) return;
        hideOverlay();
        showErrorTooltip(message.message, ts);
        break;
    }
  });

  function ensureShadowHost() {
    const root = document.body || document.documentElement;
    if (overlayHost && root.contains(overlayHost)) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'contexthelper-overlay-host';
    overlayHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;';
    root.appendChild(overlayHost);
    shadowRoot = overlayHost.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = getShadowStyles();
    shadowRoot.appendChild(style);
  }

  function hideOverlay() {
    // Clean up event listeners from previous overlay
    for (const cleanup of activeCleanups) {
      try { cleanup(); } catch { /* keep cleaning up the rest */ }
    }
    activeCleanups = [];

    if (!shadowRoot) return;
    const existing = shadowRoot.querySelector('.cmn-overlay');
    if (existing) existing.remove();
  }

  function getViewport() {
    const vv = window.visualViewport;
    return {
      top: vv?.offsetTop || 0,
      left: vv?.offsetLeft || 0,
      width: vv?.width || window.innerWidth,
      height: vv?.height || window.innerHeight
    };
  }

  function getPosition(preferredPosition) {
    const rect = lastSelectionRect;
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return { top: 100, left: 100 };
    }

    const margin = 8;
    const viewport = getViewport();
    const tooltipMaxWidth = 420;
    const tooltipEstimatedHeight = 200;
    const pos = preferredPosition || 'below';

    let top, left;

    if (pos === 'above') {
      top = rect.top - margin - tooltipEstimatedHeight;
      left = rect.left;
    } else if (pos === 'left') {
      top = rect.top;
      left = rect.left - margin - tooltipMaxWidth;
    } else if (pos === 'right') {
      top = rect.top;
      left = rect.right + margin;
    } else {
      // 'below' (default)
      top = rect.bottom + margin;
      // Flip above if not enough space below
      if (rect.bottom + tooltipEstimatedHeight > viewport.top + viewport.height) {
        top = rect.top - margin - tooltipEstimatedHeight;
      }
      left = rect.left;
    }

    // Clamp to viewport
    const minTop = viewport.top + margin;
    const minLeft = viewport.left + margin;
    const maxTop = Math.max(minTop, viewport.top + viewport.height - tooltipEstimatedHeight - margin);
    top = Math.min(Math.max(top, minTop), maxTop);
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - tooltipMaxWidth - margin);
    left = Math.min(Math.max(left, minLeft), maxLeft);

    return { top, left };
  }

  function appendAndClampOverlay(el, pos) {
    const margin = 8;
    const viewport = getViewport();
    el.style.top = `${pos.top}px`;
    el.style.left = `${pos.left}px`;
    shadowRoot.appendChild(el);

    // Use real rendered size instead of rough estimate to keep overlay on screen.
    const rect = el.getBoundingClientRect();
    const minTop = viewport.top + margin;
    const minLeft = viewport.left + margin;
    const maxTop = Math.max(minTop, viewport.top + viewport.height - rect.height - margin);
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - rect.width - margin);
    const currentTop = Number.parseFloat(el.style.top) || margin;
    const currentLeft = Number.parseFloat(el.style.left) || margin;
    const clampedTop = Math.min(Math.max(currentTop, minTop), maxTop);
    const clampedLeft = Math.min(Math.max(currentLeft, minLeft), maxLeft);

    if (clampedTop !== currentTop || clampedLeft !== currentLeft) {
      el.style.top = `${clampedTop}px`;
      el.style.left = `${clampedLeft}px`;
    }
  }

  function applyTooltipStyles(el, ts) {
    if (!ts) return;
    const validColor = (value) => /^#[0-9a-fA-F]{6}$/.test(value || '');
    if (validColor(ts.bgColor) && ts.bgColor !== '#ffffff') {
      el.style.background = ts.bgColor;
    }
    if (validColor(ts.fontColor) && ts.fontColor !== '#1f2937') {
      el.style.color = ts.fontColor;
    }
    const fontSize = Number.parseInt(ts.fontSize, 10);
    if (Number.isFinite(fontSize) && fontSize !== 14) {
      el.style.fontSize = `${Math.min(Math.max(fontSize, 10), 24)}px`;
    }
  }

  function showLoading(ts) {
    ensureShadowHost();
    hideOverlay();

    const pos = getPosition(ts?.position);
    const el = document.createElement('div');
    el.className = 'cmn-overlay cmn-loading';
    applyTooltipStyles(el, ts);

    const spinner = document.createElement('div');
    spinner.className = 'cmn-spinner';

    const label = document.createElement('span');
    label.textContent = 'Processing...';

    el.appendChild(spinner);
    el.appendChild(label);
    appendAndClampOverlay(el, pos);
  }

  function showResultTooltip(text, ts, sendContext) {
    ensureShadowHost();
    hideOverlay();

    const pos = getPosition(ts?.position);
    const el = document.createElement('div');
    el.className = 'cmn-overlay cmn-tooltip';
    applyTooltipStyles(el, ts);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cmn-btn cmn-btn-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => hideOverlay());

    const content = document.createElement('div');
    content.className = 'cmn-content';
    content.appendChild(parseMarkdown(text));

    const actions = document.createElement('div');
    actions.className = 'cmn-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'cmn-btn cmn-btn-primary';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
      } catch {
        copyBtn.textContent = 'Error!';
      }
      const resetTimer = setTimeout(() => {
        if (copyBtn.isConnected) copyBtn.textContent = 'Copy';
      }, 1500);
      activeCleanups.push(() => clearTimeout(resetTimer));
    });

    if (sendContext) {
      actions.appendChild(createWebhookSendControl(sendContext));
    }
    actions.appendChild(copyBtn);
    el.appendChild(closeBtn);
    el.appendChild(content);
    el.appendChild(actions);
    appendAndClampOverlay(el, pos);

    // Dismiss on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') hideOverlay();
    };
    document.addEventListener('keydown', escHandler);
    activeCleanups.push(() => document.removeEventListener('keydown', escHandler));

    // Dismiss on click outside (delayed to avoid immediate trigger)
    const ignoreOutsideClickUntil = performance.now() + 400;
    const clickHandler = (e) => {
      if (performance.now() < ignoreOutsideClickUntil) return;
      if (!overlayHost.contains(e.target)) hideOverlay();
    };
    const clickTimer = setTimeout(() => {
      document.addEventListener('mousedown', clickHandler);
      activeCleanups.push(() => document.removeEventListener('mousedown', clickHandler));
    }, 100);
    activeCleanups.push(() => clearTimeout(clickTimer));
  }

  function showErrorTooltip(message, ts) {
    ensureShadowHost();
    hideOverlay();

    const pos = getPosition(ts?.position);
    const el = document.createElement('div');
    el.className = 'cmn-overlay cmn-tooltip cmn-error';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cmn-btn cmn-btn-close';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', () => hideOverlay());

    const content = document.createElement('div');
    content.className = 'cmn-content';
    content.textContent = message;

    el.appendChild(closeBtn);
    el.appendChild(content);
    appendAndClampOverlay(el, pos);

    // Auto-dismiss after 6s
    const dismissTimer = setTimeout(() => hideOverlay(), 6000);
    activeCleanups.push(() => clearTimeout(dismissTimer));

    const escHandler = (e) => {
      if (e.key === 'Escape') hideOverlay();
    };
    document.addEventListener('keydown', escHandler);
    activeCleanups.push(() => document.removeEventListener('keydown', escHandler));
  }

  // Send button (single webhook) or "Send ▾" menu (multiple) in the result
  // tooltip. Delivery goes through the background service worker (SEND_WEBHOOK),
  // which holds the webhook URL/headers — the page only sees id + name.
  function createWebhookSendControl({ webhooks, webhookData }) {
    const wrap = document.createElement('div');
    wrap.className = 'cmn-send-wrap';

    const btn = document.createElement('button');
    btn.className = 'cmn-btn cmn-btn-send';
    const multi = webhooks.length > 1;
    const idleLabel = multi ? 'Send ▾' : `Send to ${webhooks[0].name}`;
    btn.textContent = idleLabel;

    async function deliver(webhookId) {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      btn.title = '';
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: 'SEND_WEBHOOK', webhookId, webhookData });
      } catch {
        response = { ok: false, error: 'Extension unavailable — try reloading the page' };
      }
      if (!btn.isConnected) return;
      if (response?.ok) {
        btn.textContent = multi ? '✓ Sent ▾' : '✓ Sent';
        btn.disabled = !multi; // multi: keep enabled to send to another target
      } else {
        btn.disabled = false;
        btn.textContent = multi ? '⚠ Failed ▾' : '⚠ Failed — retry';
        btn.title = response?.error || 'Webhook delivery failed';
      }
    }

    if (!multi) {
      btn.addEventListener('click', () => deliver(webhooks[0].id));
      wrap.appendChild(btn);
      return wrap;
    }

    const menu = document.createElement('div');
    menu.className = 'cmn-send-menu';
    menu.hidden = true;
    for (const webhook of webhooks) {
      const item = document.createElement('button');
      item.className = 'cmn-send-item';
      item.textContent = webhook.name;
      item.addEventListener('click', () => {
        menu.hidden = true;
        deliver(webhook.id);
      });
      menu.appendChild(item);
    }
    btn.addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  function isWritableTextControl(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;

    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      return ['text', 'search', 'email', 'url', 'tel', 'password'].includes(el.type);
    }
    return false;
  }

  function getEditableAncestor(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
      if (el.isContentEditable) return el;
      el = el.parentElement;
    }
    return null;
  }

  function captureInsertionSnapshot() {
    const activeEl = document.activeElement;

    if (isWritableTextControl(activeEl)) {
      const start = activeEl.selectionStart;
      const end = activeEl.selectionEnd;
      if (start != null && end != null && end > start) {
        return {
          kind: 'text-control',
          element: activeEl,
          start,
          end,
          text: activeEl.value.substring(start, end)
        };
      }
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    const range = sel.getRangeAt(0).cloneRange();
    const text = sel.toString();
    const editableRoot = getEditableAncestor(range.commonAncestorContainer);
    return {
      kind: editableRoot ? 'contenteditable' : 'dom',
      range,
      editableRoot,
      text
    };
  }

  function snapshotStillSelected(snapshot) {
    if (!snapshot) return false;

    if (snapshot.kind === 'text-control') {
      const el = snapshot.element;
      return document.activeElement === el
        && el.isConnected
        && el.selectionStart === snapshot.start
        && el.selectionEnd === snapshot.end
        && el.value.substring(snapshot.start, snapshot.end) === snapshot.text;
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || sel.toString() !== snapshot.text) return false;
    const range = sel.getRangeAt(0);
    try {
      const sameRange = range.compareBoundaryPoints(Range.START_TO_START, snapshot.range) === 0
        && range.compareBoundaryPoints(Range.END_TO_END, snapshot.range) === 0;
      if (!sameRange) return false;
    } catch {
      return false;
    }

    if (snapshot.kind === 'contenteditable') {
      return getEditableAncestor(range.commonAncestorContainer) === snapshot.editableRoot;
    }

    return true;
  }

  function replaceSelectedText(newText, snapshot) {
    if (!snapshotStillSelected(snapshot)) return false;
    const activeEl = document.activeElement;

    // textarea / input (only writable controls)
    if (snapshot.kind === 'text-control' && isWritableTextControl(activeEl)) {
      const start = snapshot.start;
      const end = snapshot.end;
      if (start == null || end == null) return false;
      // Replace only an explicit selection; avoid writing into unrelated focused inputs.
      if (end <= start) return false;
      const before = activeEl.value.substring(0, start);
      const after = activeEl.value.substring(end);

      // Use native setter to bypass React's synthetic event system
      const proto = activeEl.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(activeEl, before + newText + after);

      // Dispatch InputEvent so frameworks detect the change
      activeEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      activeEl.dispatchEvent(new Event('change', { bubbles: true }));

      const newPos = start + newText.length;
      activeEl.setSelectionRange(newPos, newPos);
      return true;
    }

    // contenteditable — execCommand preserves undo stack
    if (snapshot.kind === 'contenteditable') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        if (sel.isCollapsed) return false;
        if (document.execCommand('insertText', false, newText)) {
          return true;
        }
        // Fallback: Selection API
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(newText));
        sel.collapseToEnd();
        return true;
      }
      return false;
    }

    // Not in an editable element
    return false;
  }

  // Replace selected text directly in the DOM (works on readonly page content)
  function forceReplaceInDOM(newText, snapshot) {
    if (snapshot?.kind !== 'dom' || !snapshotStillSelected(snapshot)) return false;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;

    try {
      const range = sel.getRangeAt(0);
      if (range.startContainer !== range.endContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
        return false;
      }
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      sel.collapseToEnd();
      return true;
    } catch {
      return false;
    }
  }

  // ── Lightweight Markdown Parser (DOM-based, XSS-safe) ──

  const INLINE_TOKEN_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^\s*][^*]*\*)/;

  function parseInline(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(INLINE_TOKEN_RE);

    for (const part of parts) {
      if (!part) continue;

      if (part.startsWith('`') && part.endsWith('`')) {
        const code = document.createElement('code');
        code.textContent = part.slice(1, -1);
        frag.appendChild(code);
      } else if (part.startsWith('**') && part.endsWith('**')) {
        const strong = document.createElement('strong');
        // Allow nested italic inside bold
        strong.appendChild(parseInline(part.slice(2, -2)));
        frag.appendChild(strong);
      } else if (part.startsWith('*') && part.endsWith('*')) {
        const em = document.createElement('em');
        em.textContent = part.slice(1, -1);
        frag.appendChild(em);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    }
    return frag;
  }

  function parseMarkdown(text) {
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    let i = 0;

    function flushParagraph(buf) {
      if (!buf.length) return;
      const p = document.createElement('p');
      p.appendChild(parseInline(buf.join('\n')));
      frag.appendChild(p);
    }

    let paragraphBuf = [];

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (line.startsWith('```')) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        const codeBuf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) {
          codeBuf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing fence
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeBuf.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      // Heading
      const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
      if (headingMatch) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        const level = headingMatch[1].length;
        const heading = document.createElement(`h${level}`);
        heading.appendChild(parseInline(headingMatch[2]));
        frag.appendChild(heading);
        i++;
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        const ul = document.createElement('ul');
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.appendChild(parseInline(lines[i].replace(/^[-*]\s+/, '')));
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        const ol = document.createElement('ol');
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          li.appendChild(parseInline(lines[i].replace(/^\d+\.\s+/, '')));
          ol.appendChild(li);
          i++;
        }
        frag.appendChild(ol);
        continue;
      }

      // Empty line — paragraph break
      if (line.trim() === '') {
        flushParagraph(paragraphBuf);
        paragraphBuf = [];
        i++;
        continue;
      }

      // Regular text — accumulate for paragraph
      paragraphBuf.push(line);
      i++;
    }

    flushParagraph(paragraphBuf);
    return frag;
  }

  function getShadowStyles() {
    return `
      :host {
        all: initial;
      }

      .cmn-overlay {
        position: fixed;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        color: #1f2937;
        z-index: 2147483647;
      }

      .cmn-loading {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 8px 14px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }

      .cmn-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid #e5e7eb;
        border-top-color: #f97316;
        border-radius: 50%;
        animation: cmn-spin 0.6s linear infinite;
      }

      @keyframes cmn-spin {
        to { transform: rotate(360deg); }
      }

      .cmn-tooltip {
        box-sizing: border-box;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 10px;
        padding: 14px;
        max-width: min(420px, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
        min-width: 200px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.18);
      }

      .cmn-tooltip.cmn-error {
        border-color: #fca5a5;
        background: #fef2f2;
      }

      .cmn-tooltip.cmn-error .cmn-content {
        color: #991b1b;
        white-space: pre-wrap;
      }

      .cmn-content {
        max-height: min(300px, calc(100vh - 120px));
        overflow-y: auto;
        white-space: normal;
        word-break: break-word;
        margin-bottom: 10px;
        padding-right: 24px;
      }

      .cmn-content p {
        margin: 0 0 0.5em 0;
      }

      .cmn-content p:last-child {
        margin-bottom: 0;
      }

      .cmn-content h1,
      .cmn-content h2,
      .cmn-content h3 {
        margin: 0.6em 0 0.3em 0;
        line-height: 1.3;
        font-weight: 600;
      }

      .cmn-content h1 { font-size: 1.3em; }
      .cmn-content h2 { font-size: 1.15em; }
      .cmn-content h3 { font-size: 1.05em; }

      .cmn-content :first-child {
        margin-top: 0;
      }

      .cmn-content code {
        background: rgba(0, 0, 0, 0.06);
        padding: 1px 4px;
        border-radius: 3px;
        font-family: 'Consolas', 'Liberation Mono', monospace;
        font-size: 0.9em;
      }

      .cmn-content pre {
        background: #1e1e2e;
        color: #cdd6f4;
        padding: 10px 12px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 0.5em 0;
        white-space: pre;
      }

      .cmn-content pre code {
        background: none;
        padding: 0;
        font-size: 0.85em;
        color: inherit;
      }

      .cmn-content ul,
      .cmn-content ol {
        margin: 0.4em 0;
        padding-left: 1.5em;
      }

      .cmn-content li {
        margin: 0.15em 0;
      }

      .cmn-content strong { font-weight: 600; }
      .cmn-content em { font-style: italic; }

      .cmn-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      .cmn-btn {
        border: none;
        border-radius: 6px;
        padding: 5px 12px;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
        transition: background-color 0.15s;
      }

      .cmn-btn-primary {
        background: #f97316;
        color: #fff;
      }

      .cmn-btn-primary:hover {
        background: #ea580c;
      }

      .cmn-btn-close {
        position: absolute;
        top: 8px;
        right: 8px;
        background: transparent;
        color: #9ca3af;
        font-size: 16px;
        padding: 2px 6px;
        line-height: 1;
      }

      .cmn-btn-close:hover {
        color: #4b5563;
      }

      .cmn-send-wrap {
        position: relative;
      }

      .cmn-btn-send {
        background: #f3f4f6;
        color: #374151;
        border: 1px solid #e5e7eb;
      }

      .cmn-btn-send:hover:not(:disabled) {
        background: #e5e7eb;
      }

      .cmn-btn-send:disabled {
        cursor: default;
        opacity: 0.7;
      }

      .cmn-send-menu {
        position: absolute;
        bottom: calc(100% + 4px);
        right: 0;
        display: flex;
        flex-direction: column;
        min-width: 140px;
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        overflow: hidden;
      }

      .cmn-send-item {
        border: none;
        background: transparent;
        padding: 6px 12px;
        text-align: left;
        cursor: pointer;
        font-size: 13px;
        font-family: inherit;
        color: #1f2937;
        white-space: nowrap;
      }

      .cmn-send-item:hover {
        background: #f3f4f6;
      }
    `;
  }

  window.__contexthelper_loaded = true;
})();

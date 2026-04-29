// Webhook delivery: POST AI results to user-configured external endpoints.
// Permissions are granted per-origin at runtime via chrome.permissions.request.

const WEBHOOK_TIMEOUT_MS = 15_000;
const TEST_RESPONSE_BODY_LIMIT = 500;
const VALID_WEBHOOK_METHODS = ['POST', 'PUT', 'PATCH'];
const LOCAL_HTTP_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function buildWebhookPayload({ action, result, sourceText, pageUrl, pageTitle, modelUsed }) {
  return {
    result,
    actionName: action?.name || '',
    sourceText: sourceText || '',
    pageUrl: pageUrl || '',
    pageTitle: pageTitle || '',
    timestamp: new Date().toISOString(),
    modelUsed: modelUsed || ''
  };
}

export function buildTestPayload(webhookConfig) {
  return {
    test: true,
    message: 'ContextHelper webhook test',
    webhookName: webhookConfig?.name || '',
    timestamp: new Date().toISOString()
  };
}

function buildHeaders(webhookConfig) {
  const headers = { 'Content-Type': 'application/json' };
  for (const h of webhookConfig.headers || []) {
    if (!h?.key?.trim()) continue;
    headers[h.key.trim()] = h.value ?? '';
  }
  return headers;
}

async function postJSON(url, method, headers, body, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  let abortHandler = null;
  if (signal) {
    if (signal.aborted) controller.abort();
    else {
      abortHandler = () => controller.abort();
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  try {
    return await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    clearTimeout(timeout);
  }
}

/**
 * Fire-and-forget delivery used during a real action.
 * Resolves with { ok, status } on response, throws WebhookError on network/timeout.
 */
export async function sendWebhook(webhookConfig, payload, signal) {
  if (!webhookConfig?.url) {
    throw new WebhookError('Webhook is not configured');
  }
  validateWebhookUrl(webhookConfig.url);
  if (!VALID_WEBHOOK_METHODS.includes(webhookConfig.method || 'POST')) {
    throw new WebhookError(`Webhook method is not supported: ${webhookConfig.method}`);
  }
  try {
    const response = await postJSON(
      webhookConfig.url,
      webhookConfig.method || 'POST',
      buildHeaders(webhookConfig),
      payload,
      signal
    );
    if (!response.ok) {
      const snippet = await safeReadBodySnippet(response);
      throw new WebhookError(`HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`, response.status);
    }
    return { ok: true, status: response.status };
  } catch (err) {
    if (err instanceof WebhookError) throw err;
    if (err.name === 'AbortError') throw new WebhookError('Webhook request timed out');
    if (err.name === 'TypeError') throw new WebhookError('Network error or endpoint unreachable');
    throw new WebhookError(err.message || 'Webhook request failed');
  }
}

/**
 * Test a webhook configuration by POSTing a dummy payload.
 * Never throws — always resolves with rich diagnostics.
 */
export async function testWebhook(webhookConfig) {
  const start = performance.now();
  try {
    const response = await postJSON(
      webhookConfig.url,
      webhookConfig.method || 'POST',
      buildHeaders(webhookConfig),
      buildTestPayload(webhookConfig)
    );
    const body = await safeReadBodySnippet(response);
    return {
      ok: response.ok,
      status: response.status,
      body,
      durationMs: Math.round(performance.now() - start)
    };
  } catch (err) {
    let message;
    if (err.name === 'AbortError') message = 'Request timed out';
    else if (err.name === 'TypeError') message = 'Network error or endpoint unreachable';
    else message = err.message || 'Test request failed';
    return {
      ok: false,
      status: 0,
      body: '',
      error: message,
      durationMs: Math.round(performance.now() - start)
    };
  }
}

async function safeReadBodySnippet(response) {
  try {
    const length = Number(response.headers.get('content-length') || 0);
    if (length > TEST_RESPONSE_BODY_LIMIT) return '[response body omitted: too large]';
    const text = await response.text();
    return text.length > TEST_RESPONSE_BODY_LIMIT ? text.slice(0, TEST_RESPONSE_BODY_LIMIT) + '…' : text;
  } catch {
    return '';
  }
}

/**
 * Convert a webhook URL into the origin match pattern used by chrome.permissions.
 * Returns null if the URL cannot be parsed or uses an unsupported scheme.
 */
export function originPatternForUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export function isLocalHttpUrl(url) {
  return url.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(url.hostname);
}

export function validateWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookError('Webhook URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebhookError('Webhook URL must be http or https');
  }
  if (parsed.protocol !== 'https:' && !isLocalHttpUrl(parsed)) {
    throw new WebhookError('Webhook URL must use HTTPS');
  }
  return parsed;
}

export async function hasWebhookPermission(url) {
  const origin = originPatternForUrl(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function requestWebhookPermission(url) {
  const origin = originPatternForUrl(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export class WebhookError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'WebhookError';
    this.status = status;
  }
}

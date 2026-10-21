const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEEPL_PRO_URL = 'https://api.deepl.com';
const DEEPL_FREE_URL = 'https://api-free.deepl.com';

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4-mini',
  openrouter: 'anthropic/claude-sonnet-4-6',
  google: 'gemini-3.1-flash-lite',
  deepl: '',
  custom: ''
};

const CUSTOM_PROVIDER_NAME = 'Custom endpoint';
const CUSTOM_403_MESSAGE = 'Endpoint refused the request (403). For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.';

/**
 * True for hosts that never leave the machine or the local network:
 * localhost, *.localhost, *.local (mDNS), 127.0.0.0/8, ::1 and the
 * RFC 1918 ranges 10/8, 172.16/12, 192.168/16.
 * @param {string} hostname  URL hostname (IPv6 in brackets, as URL gives it)
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '[::1]' || host === '::1') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some(part => Number(part) > 255)) return false;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Normalize a custom OpenAI-compatible base URL: trims, drops trailing
 * slashes and a trailing /chat/completions. Plain http is accepted only
 * for local or private-network hosts.
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    throw new Error('Invalid base URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid base URL');
  }
  // Chrome match patterns have no documented form for bracketed IPv6 hosts,
  // so the origin could never be granted
  if (parsed.hostname.startsWith('[')) {
    throw new Error('IPv6 addresses are not supported — use localhost or 127.0.0.1');
  }
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    throw new Error('Base URL must use HTTPS unless it points to a local or private-network host');
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    path = path.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  return `${parsed.origin}${path}`;
}

function customHeaders(apiKey) {
  const key = String(apiKey || '').trim();
  return key ? { 'Authorization': `Bearer ${key}` } : {};
}

// DeepL Free API keys end with ':fx' and must use the free endpoint
export function getDeepLBaseUrl(apiKey) {
  return apiKey.trim().endsWith(':fx') ? DEEPL_FREE_URL : DEEPL_PRO_URL;
}

// Plain 'EN'/'PT' are deprecated as target_lang — regional variants required
export const DEEPL_TARGET_LANGUAGES = [
  { id: 'PL', name: 'Polish' },
  { id: 'EN-US', name: 'English (American)' },
  { id: 'EN-GB', name: 'English (British)' },
  { id: 'DE', name: 'German' },
  { id: 'FR', name: 'French' },
  { id: 'ES', name: 'Spanish' },
  { id: 'IT', name: 'Italian' },
  { id: 'NL', name: 'Dutch' },
  { id: 'PT-PT', name: 'Portuguese' },
  { id: 'PT-BR', name: 'Portuguese (Brazilian)' },
  { id: 'UK', name: 'Ukrainian' },
  { id: 'RU', name: 'Russian' },
  { id: 'CS', name: 'Czech' },
  { id: 'SV', name: 'Swedish' },
  { id: 'DA', name: 'Danish' },
  { id: 'NB', name: 'Norwegian' },
  { id: 'JA', name: 'Japanese' },
  { id: 'ZH', name: 'Chinese (simplified)' },
  { id: 'KO', name: 'Korean' },
  { id: 'TR', name: 'Turkish' }
];

const MAX_TOKENS = 4096;
const TEMPERATURE = 0.3;

export function getDefaultModel(provider) {
  // Providers without a model (DeepL) keep their '' default
  return Object.hasOwn(DEFAULT_MODELS, provider) ? DEFAULT_MODELS[provider] : DEFAULT_MODELS.anthropic;
}

export function getAvailableModels(provider) {
  // A custom endpoint's models are only known from its live /models list
  if (provider === 'custom') return [];
  if (provider === 'anthropic') {
    return [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }
    ];
  }
  if (provider === 'google') {
    return [
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
      { id: 'gemini-3.1-flash-preview', name: 'Gemini 3.1 Flash (preview)' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' }
    ];
  }
  if (provider === 'openrouter') {
    return [
      // Commercial
      { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 mini' },
      { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      // Open source — large
      { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1' },
      { id: 'qwen/qwen3-235b-a22b-instruct-2507', name: 'Qwen 3 235B' },
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' },
      // Open source — medium/small
      { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout' },
      { id: 'nvidia/nemotron-3-super', name: 'Nemotron 3 Super 120B' },
      { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B' },
      { id: 'stepfun/step-3.5-flash', name: 'Step 3.5 Flash' }
    ];
  }
  return [
    { id: 'gpt-5.4', name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
    { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano' },
    { id: 'gpt-4.1', name: 'GPT-4.1' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini' }
  ];
}

// OpenAI's /v1/models mixes chat models with audio/image/embedding ones — keep chat-capable only
const OPENAI_CHAT_MODEL_RE = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NON_CHAT_RE = /(audio|realtime|tts|transcribe|embedding|image|dall-e|whisper|moderation|search)/;

/**
 * Fetch the live model list from the provider's API.
 * Returns [{ id, name }] or null when the provider has no model list (DeepL).
 * `baseUrl` is required for 'custom' (lists `${base}/models`).
 * Throws APIError on network/auth failure — callers fall back to getAvailableModels().
 */
export async function fetchAvailableModels(provider, apiKey, signal, baseUrl) {
  if (provider === 'anthropic') {
    const data = await fetchModelsJSON('https://api.anthropic.com/v1/models?limit=100', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    }, signal);
    return (data.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
  }
  if (provider === 'openai') {
    const data = await fetchModelsJSON('https://api.openai.com/v1/models', {
      'Authorization': `Bearer ${apiKey}`
    }, signal);
    return (data.data || [])
      .filter(m => OPENAI_CHAT_MODEL_RE.test(m.id) && !OPENAI_NON_CHAT_RE.test(m.id))
      .map(m => ({ id: m.id, name: m.id }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  if (provider === 'google') {
    const data = await fetchModelsJSON(`${GEMINI_BASE_URL}?pageSize=200`, { 'x-goog-api-key': apiKey }, signal);
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }));
  }
  if (provider === 'openrouter') {
    const data = await fetchModelsJSON('https://openrouter.ai/api/v1/models', {}, signal);
    return (data.data || [])
      .map(m => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (provider === 'custom') {
    const data = await fetchModelsJSON(`${normalizeBaseUrl(baseUrl)}/models`, customHeaders(apiKey), signal);
    return (Array.isArray(data?.data) ? data.data : [])
      .filter(m => typeof m?.id === 'string' && m.id)
      .map(m => ({ id: m.id, name: m.id }));
  }
  return null;
}

async function fetchModelsJSON(url, headers, signal) {
  const { response, data } = await fetchWithErrorHandling(url, { method: 'GET', headers }, signal);
  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || data?.message || 'Model list error');
  }
  return data;
}

const DEFAULT_STREAM_IDLE_MS = 30_000;
const DEFAULT_STREAM_TOTAL_MS = 240_000;

/**
 * @param {{
 *   provider: string, apiKey: string, model: string, baseUrl?: string,
 *   prompt?: string, messages?: Array<{ role: 'user' | 'assistant', content: string }>,
 *   systemPrompt?: string, targetLang?: string, signal?: AbortSignal,
 *   onDelta?: (fullTextSoFar: string) => void,
 *   streamTimeouts?: { idleMs?: number, totalMs?: number },
 *   requestTimeoutMs?: number
 * }} params
 * `messages` takes precedence over `prompt`. With `onDelta` (and a provider
 * other than DeepL) the request streams; without it the request body has no
 * `stream` field. `baseUrl` is the endpoint of the 'custom' provider; the
 * built-in providers ignore it. `requestTimeoutMs` (default 90 s) bounds
 * the request up to the headers, and for a non-streaming call the whole
 * body too.
 * @returns {Promise<string>}
 */
export async function callAI({ provider, apiKey, model, baseUrl, prompt, messages, systemPrompt, targetLang, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  if (provider === 'deepl') {
    // DeepL is not an LLM: no model, no system prompt, no history — raw text + target language
    return callDeepL(apiKey, prompt, targetLang, signal, requestTimeoutMs);
  }

  const effectiveModel = model || getDefaultModel(provider);
  const conversation = Array.isArray(messages) && messages.length
    ? messages.map(m => ({ role: m.role, content: m.content }))
    : [{ role: 'user', content: prompt }];
  const request = {
    // A lone user turn is the same request as a prompt (keeps Gemini's old body)
    singleUserTurn: conversation.length === 1 && conversation[0].role === 'user',
    signal,
    onDelta: typeof onDelta === 'function' ? onDelta : undefined,
    streamTimeouts,
    requestTimeoutMs
  };

  if (provider === 'anthropic') {
    return callAnthropic(apiKey, effectiveModel, conversation, systemPrompt, request);
  }
  if (provider === 'openai') {
    return callOpenAI(apiKey, effectiveModel, conversation, systemPrompt, request);
  }
  if (provider === 'openrouter') {
    return callOpenRouter(apiKey, effectiveModel, conversation, systemPrompt, request);
  }
  if (provider === 'google') {
    return callGemini(apiKey, effectiveModel, conversation, systemPrompt, request);
  }
  if (provider === 'custom') {
    return callCustom(apiKey, baseUrl, effectiveModel, conversation, systemPrompt, request);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function callAnthropic(apiKey, model, messages, systemPrompt, { signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    messages
  };
  if (systemPrompt) body.system = systemPrompt;
  if (onDelta) body.stream = true;

  const { response, data } = await fetchWithErrorHandling(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && !!onDelta });

  if (response.ok && onDelta) {
    return readStream(response, { provider: 'anthropic', providerName: 'Anthropic', signal, onDelta, ...streamTimeouts });
  }

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'Anthropic API error');
  }

  return extractAnthropicText(data);
}

/**
 * Shared caller for OpenAI-compatible chat completions endpoints.
 * @param {{
 *   url: string, headers: Record<string, string>, model: string,
 *   messages: Array<{ role: string, content: string }>, systemPrompt?: string,
 *   maxTokensField: 'max_completion_tokens' | 'max_tokens', providerName: string,
 *   signal?: AbortSignal, onDelta?: (fullTextSoFar: string) => void,
 *   streamTimeouts?: { idleMs?: number, totalMs?: number }, requestTimeoutMs?: number
 * }} params
 * @returns {Promise<string>}
 */
export async function callChatCompletions({ url, headers, model, messages, systemPrompt, maxTokensField, providerName, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  const chatMessages = [];
  if (systemPrompt) chatMessages.push({ role: 'system', content: systemPrompt });
  chatMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

  const streaming = typeof onDelta === 'function';
  const body = {
    model,
    [maxTokensField]: MAX_TOKENS,
    temperature: TEMPERATURE,
    messages: chatMessages
  };
  if (streaming) body.stream = true;

  const { response, data } = await fetchWithErrorHandling(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && streaming });

  if (response.ok && streaming) {
    // Every chat-completions provider shares the OpenAI chunk format
    return readStream(response, { provider: 'openai', providerName, signal, onDelta, ...streamTimeouts });
  }

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || `${providerName} API error`);
  }

  return extractChatCompletionText(data, providerName);
}

function callOpenAI(apiKey, model, messages, systemPrompt, { signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  return callChatCompletions({
    url: OPENAI_URL,
    headers: { 'Authorization': `Bearer ${apiKey}` },
    model,
    messages,
    systemPrompt,
    maxTokensField: 'max_completion_tokens',
    providerName: 'OpenAI',
    signal,
    onDelta,
    streamTimeouts,
    requestTimeoutMs
  });
}

function callOpenRouter(apiKey, model, messages, systemPrompt, { signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  return callChatCompletions({
    url: OPENROUTER_URL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/contexthelper',
      'X-Title': 'ContextHelper'
    },
    model,
    messages,
    systemPrompt,
    maxTokensField: 'max_tokens',
    providerName: 'OpenRouter',
    signal,
    onDelta,
    streamTimeouts,
    requestTimeoutMs
  });
}

async function callCustom(apiKey, baseUrl, model, messages, systemPrompt, { signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  try {
    return await callChatCompletions({
      url,
      headers: customHeaders(apiKey),
      model,
      messages,
      systemPrompt,
      maxTokensField: 'max_tokens',
      providerName: CUSTOM_PROVIDER_NAME,
      signal,
      onDelta,
      streamTimeouts,
      requestTimeoutMs
    });
  } catch (err) {
    // Ollama answers 403 to an extension origin missing from OLLAMA_ORIGINS
    if (err instanceof APIError && err.status === 403) throw new APIError(403, CUSTOM_403_MESSAGE);
    throw err;
  }
}

async function callGemini(apiKey, model, messages, systemPrompt, { signal, onDelta, streamTimeouts, requestTimeoutMs, singleUserTurn }) {
  const url = onDelta
    ? `${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse`
    : `${GEMINI_BASE_URL}/${model}:generateContent`;

  const body = {
    // A lone user turn keeps the original role-less body; anything else
    // (history, a lone assistant turn) needs explicit roles
    contents: singleUserTurn
      ? [{ parts: [{ text: messages[0].content }] }]
      : messages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      temperature: TEMPERATURE
    }
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const { response, data } = await fetchWithErrorHandling(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && !!onDelta });

  if (response.ok && onDelta) {
    return readStream(response, { provider: 'google', providerName: 'Google Gemini', signal, onDelta, ...streamTimeouts });
  }

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'Google Gemini API error');
  }

  return extractGeminiText(data);
}

async function callDeepL(apiKey, text, targetLang, signal, requestTimeoutMs) {
  if (!targetLang) {
    throw new APIError(0, 'No target language configured for this DeepL action');
  }

  const { response, data } = await fetchWithErrorHandling(`${getDeepLBaseUrl(apiKey)}/v2/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `DeepL-Auth-Key ${apiKey}`
    },
    body: JSON.stringify({ text: [text], target_lang: targetLang })
  }, signal, { timeoutMs: requestTimeoutMs });

  if (!response.ok) {
    // DeepL signals a bad key with 403 — remap to 401 for the shared friendly message
    throw new APIError(response.status === 403 ? 401 : response.status, data?.message || 'DeepL API error');
  }

  return extractDeepLText(data);
}

export async function getDeepLUsage(apiKey, signal) {
  const { response, data } = await fetchWithErrorHandling(`${getDeepLBaseUrl(apiKey)}/v2/usage`, {
    method: 'GET',
    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}` }
  }, signal);

  if (!response.ok) {
    throw new APIError(response.status === 403 ? 401 : response.status, data?.message || 'DeepL API error');
  }

  return {
    characterCount: data.character_count,
    characterLimit: data.character_limit
  };
}

export function extractDeepLText(data) {
  const text = data.translations?.[0]?.text || '';
  if (!text.trim()) throw new APIError(0, 'DeepL returned an empty response');
  return text;
}

export function extractAnthropicText(data) {
  const text = (data.content || [])
    .filter(part => part?.type === 'text' || part?.text)
    .map(part => part.text || '')
    .join('');
  if (!text.trim()) throw new APIError(0, 'Anthropic returned an empty response');
  return text;
}

export function extractChatCompletionText(data, providerName) {
  const choice = data.choices?.[0];
  const text = choice?.message?.content || '';
  if (!text.trim()) {
    const reason = choice?.finish_reason ? ` (${choice.finish_reason})` : '';
    throw new APIError(0, `${providerName} returned an empty response${reason}`);
  }
  return text;
}

export function extractGeminiText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(part => part?.text || '').join('');
  if (!text.trim()) {
    const blockReason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || '';
    throw new APIError(0, `Google Gemini returned an empty response${blockReason ? ` (${blockReason})` : ''}`);
  }
  return text;
}

// ── Streaming ──

/**
 * Incremental Server-Sent Events parser. Buffers partial lines across
 * pushes, accepts \n and \r\n, skips ':' comments and the '[DONE]' sentinel,
 * joins multi-line data with '\n' and dispatches on a blank line.
 * @param {(data: string, event: string | null) => void} onData
 * @param {() => void} [onDone]  called when a 'data: [DONE]' event is dispatched
 */
export function createSSEParser(onData, onDone) {
  let buffer = '';
  let dataLines = [];
  let eventName = null;

  function dispatch() {
    if (dataLines.length) {
      const data = dataLines.join('\n');
      if (data === '[DONE]') onDone?.();
      else onData(data, eventName);
    }
    dataLines = [];
    eventName = null;
  }

  function processLine(line) {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  }

  return {
    push(text) {
      buffer += text;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        processLine(line);
      }
    },
    end() {
      if (buffer) {
        processLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        buffer = '';
      }
      dispatch();
    }
  };
}

/**
 * Map one decoded stream event to { delta, done, error }.
 * 'openai' covers every chat-completions provider (openrouter, custom).
 * @returns {{ delta: string, done: boolean, error: string | null }}
 */
export function parseStreamEvent(provider, payload) {
  const result = { delta: '', done: false, error: null };
  if (!payload || typeof payload !== 'object') return result;

  if (provider === 'anthropic') {
    if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
      result.delta = payload.delta.text || '';
    } else if (payload.type === 'message_stop') {
      result.done = true;
    } else if (payload.type === 'error') {
      result.error = payload.error?.message || 'Stream error';
    }
    return result;
  }

  if (provider === 'google') {
    const candidate = payload.candidates?.[0];
    result.delta = (candidate?.content?.parts || []).map(part => part?.text || '').join('');
    if (candidate?.finishReason) result.done = true;
    if (payload.promptFeedback?.blockReason) {
      result.error = `Blocked (${payload.promptFeedback.blockReason})`;
    }
    return result;
  }

  // openai, openrouter, custom
  const choice = payload.choices?.[0];
  result.delta = choice?.delta?.content || '';
  if (payload.error) {
    result.error = payload.error.message || 'Stream error';
  } else if (choice?.finish_reason === 'error') {
    result.error = 'Stream error';
  } else if (choice?.finish_reason != null) {
    result.done = true;
  }
  return result;
}

/**
 * Read an SSE response body to completion, reporting the accumulated text
 * through onDelta. Rejects on a provider error event, malformed data, a
 * stall, the total time limit, an external abort, or EOF before the
 * provider's terminal event (a partial answer is never a success).
 */
async function readStream(response, {
  provider, providerName, signal, onDelta,
  idleMs = DEFAULT_STREAM_IDLE_MS, totalMs = DEFAULT_STREAM_TOTAL_MS
}) {
  if (!response.body) throw new APIError(0, `${providerName} stream ended unexpectedly`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  let failure = null;
  let emptyReason = ''; // suffix for the empty-response message, as in extract*Text

  // Stops the pending read: cancel() resolves it as { done: true }, so every
  // read result is checked against `failure` first.
  const fail = (err) => {
    if (failure) return;
    failure = err;
    reader.cancel().catch(() => {});
  };

  // Chat-completions servers may end with only 'data: [DONE]' (no finish_reason)
  const isChatCompletions = provider !== 'anthropic' && provider !== 'google';
  const onDone = isChatCompletions ? () => { if (!failure) done = true; } : undefined;

  const parser = createSSEParser((data) => {
    if (done || failure) return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      fail(new APIError(0, `${providerName} sent malformed stream data`));
      return;
    }
    const event = parseStreamEvent(provider, payload);
    if (provider === 'google') {
      emptyReason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || emptyReason;
    } else if (isChatCompletions) {
      emptyReason = payload.choices?.[0]?.finish_reason || emptyReason;
    }
    if (event.error) {
      fail(new APIError(0, event.error));
      return;
    }
    if (event.delta) {
      text += event.delta;
      onDelta(text);
    }
    if (event.done) done = true;
  }, onDone);

  // fetchWithErrorHandling drops its abort listener once headers arrive,
  // so the body read needs its own
  const onAbort = () => fail(new DOMException('Request cancelled', 'AbortError'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(new APIError(0, 'API stream stalled')), idleMs);
  };
  const totalTimer = setTimeout(() => fail(new APIError(0, 'API response took too long')), totalMs);

  try {
    if (signal?.aborted) onAbort();
    armIdle();
    while (!failure && !done) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        // The body errored after headers (network drop): normalise so it
        // reads as a retryable APIError, not a bare TypeError
        if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        if (failure) throw failure;
        throw new APIError(0, 'Connection lost while receiving the response');
      }
      const { value, done: eof } = chunk;
      if (failure) break;
      if (eof) {
        parser.push(decoder.decode());
        parser.end();
        break;
      }
      armIdle(); // any bytes (incl. keep-alive comments) count as progress
      parser.push(decoder.decode(value, { stream: true }));
    }

    if (failure) throw failure;
    if (!done) throw new APIError(0, `${providerName} stream ended unexpectedly`);
    if (!text.trim()) {
      throw new APIError(0, `${providerName} returned an empty response${emptyReason ? ` (${emptyReason})` : ''}`);
    }
    return text;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // Stops the network read when we finished before EOF; no-op after EOF
    reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

const REQUEST_TIMEOUT_MS = 90_000;

async function safeParseJSON(response) {
  try {
    return await response.json();
  } catch {
    throw new APIError(response.status, `API error (${response.status})`);
  }
}

/**
 * fetch with a request deadline and an external abort signal. Resolves to
 * { response, data }: the JSON body is read under the same deadline and
 * signal, so a server that sends headers and then stalls the body stays
 * cancellable and times out. When `skipBody(response)` is true (an OK
 * streaming response) `data` is undefined and readStream owns the body.
 */
async function fetchWithErrorHandling(url, options, externalSignal, { timeoutMs = REQUEST_TIMEOUT_MS, skipBody } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortHandler = null;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
      clearTimeout(timeout);
    } else {
      abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (skipBody?.(response)) return { response, data: undefined };
    const data = await readJSONUntilAbort(response, controller.signal);
    return { response, data };
  } catch (err) {
    if (externalSignal?.aborted) {
      throw new DOMException('Request cancelled', 'AbortError');
    }
    if (err.name === 'AbortError') {
      throw new APIError(0, 'API request timed out');
    }
    if (err.name === 'TypeError') {
      throw new APIError(0, 'No internet connection or server unavailable');
    }
    throw err;
  } finally {
    if (externalSignal && abortHandler) externalSignal.removeEventListener('abort', abortHandler);
    clearTimeout(timeout);
  }
}

// Races the JSON body against `signal`. A real fetch body also errors on
// abort; the race covers bodies that do not (and settles either way).
function readJSONUntilAbort(response, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      response.body?.cancel().catch(() => {}); // rejects while json() holds the lock
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    safeParseJSON(response)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

class APIError extends Error {
  constructor(status, message) {
    const userMessage = APIError.getUserMessage(status, message);
    super(userMessage);
    this.name = 'APIError';
    this.status = status;
    this.originalMessage = message;
  }

  static getUserMessage(status, message) {
    switch (status) {
      case 401:
        return 'Invalid API key. Please check your settings.';
      case 429:
        return 'Too many requests. Please try again shortly.';
      case 456:
        return 'DeepL character quota exceeded for this billing period.';
      case 500:
      case 502:
      case 503:
        return 'API server temporarily unavailable. Please try again.';
      case 0:
        return message;
      default:
        return message || `API error (${status})`;
    }
  }
}

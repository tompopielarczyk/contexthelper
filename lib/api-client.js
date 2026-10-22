const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEEPL_PRO_URL = 'https://api.deepl.com';
const DEEPL_FREE_URL = 'https://api-free.deepl.com';

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6-luna',
  openrouter: 'openai/gpt-6-luna',
  google: 'gemini-3.5-flash-lite',
  deepl: '',
  custom: ''
};

const CUSTOM_PROVIDER_NAME = 'Custom endpoint';
const CUSTOM_403_MESSAGE = 'Endpoint refused the request (403). For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.';

// One DNS label: letters, digits and inner hyphens
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/**
 * True for hosts that never leave the machine or the local network:
 * localhost, *.localhost, *.local (mDNS), *.internal, *.lan, *.home.arpa,
 * single-label names (e.g. `gpu-box`, resolved on the LAN), ::1,
 * 127.0.0.0/8, the RFC 1918 ranges 10/8, 172.16/12, 192.168/16, the
 * CGNAT/Tailscale range 100.64/10 and link-local 169.254/16.
 * @param {string} hostname  URL hostname (IPv6 in brackets, as URL gives it)
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === '[::1]' || host === '::1') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m.slice(1).some(part => Number(part) > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const labels = host.split('.');
  if (!labels.every(label => HOST_LABEL_RE.test(label))) return false;
  // A decimal or hex label is a number, not a name (URL turns it into IPv4)
  if (labels.length === 1) return !/^(?:\d+|0x[0-9a-f]*)$/.test(host);
  return PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix));
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
// Reasoning counts toward these budgets (thinking is on by default on Claude
// 5.x, Gemini 3.x and GPT-6) — 4096 can be spent on reasoning alone,
// leaving an empty answer
const ANTHROPIC_MAX_TOKENS = 16_000;
const GEMINI_MAX_OUTPUT_TOKENS = 16_000;
const OPENAI_MAX_COMPLETION_TOKENS = 25_000;
const OPENROUTER_MAX_TOKENS = 16_000;
// Sent only to OpenRouter and custom endpoints: anthropic-version 2026-10-21
// rejects it, Gemini 3.6+ ignores it, GPT-6 rejects it with reasoning on
const TEMPERATURE = 0.3;
const ANTHROPIC_VERSION = '2026-10-21';

/** Reasoning effort levels of a model config; '' (or anything else) sends none. */
export const EFFORT_LEVELS = ['low', 'medium', 'high'];

/** A valid effort level, or '' (provider default: no parameter sent). */
export function normalizeEffort(value) {
  return EFFORT_LEVELS.includes(value) ? value : '';
}

// `${endpoint}|${model}|${field}` of tuning fields a model rejected with a
// 400 (temperature on reasoning models, effort on older models or servers
// without it). Added only after the retry without the field succeeded.
// Lives as long as the worker.
const _rejectedTuning = new Set();

const TUNING_FIELD_RE = {
  temperature: /temperature/i,
  effort: /effort|reasoning|thinking[_ ]?level|thinking_?config|output_config/i,
  // An output budget above the model's own cap (OpenRouter routes to models
  // with caps as low as 4096–8192)
  maxTokens: /max_tokens|max_completion_tokens|maximum[^.]*tokens|output tokens|context length/i
};

/**
 * An optional tuning field of a request body that a model may reject.
 * "Removing" it may also mean lowering it to a safe value (maxTokens).
 * @param {'temperature' | 'effort' | 'maxTokens'} name
 * @param {(body: object) => boolean} present
 * @param {(body: object) => void} remove
 */
function tuningField(name, present, remove) {
  return { name, re: TUNING_FIELD_RE[name], present, remove };
}

/**
 * POST `body` through `send`, dropping tuning fields the model rejects.
 * Fields already known as rejected for `cacheKey` are dropped up front. A
 * 400 (it arrives with the headers, before any stream is read) whose
 * message names a field that is in the body is retried once without that
 * field — at most once per field, with the same signal. The rejection is
 * remembered only when the retry gets an OK response.
 * @returns {Promise<{ response: Response, data: any }>}
 */
async function postWithTuningFallback({ cacheKey, fields, body, send, signal }) {
  for (const field of fields) {
    if (_rejectedTuning.has(`${cacheKey}|${field.name}`)) field.remove(body);
  }
  let { response, data } = await send(body);
  const dropped = [];
  while (response.status === 400) {
    const message = String(data?.error?.message || '');
    const field = fields.find(f => !dropped.includes(f) && f.present(body) && f.re.test(message));
    if (!field) break;
    field.remove(body);
    dropped.push(field);
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    ({ response, data } = await send(body));
  }
  if (response.ok) {
    for (const field of dropped) _rejectedTuning.add(`${cacheKey}|${field.name}`);
  }
  return { response, data };
}

export function getDefaultModel(provider) {
  // Providers without a model (DeepL) keep their '' default
  return Object.hasOwn(DEFAULT_MODELS, provider) ? DEFAULT_MODELS[provider] : DEFAULT_MODELS.anthropic;
}

export function getAvailableModels(provider) {
  // A custom endpoint's models are only known from its live /models list
  if (provider === 'custom') return [];
  if (provider === 'anthropic') {
    return [
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }
    ];
  }
  if (provider === 'google') {
    return [
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon' }
    ];
  }
  if (provider === 'openrouter') {
    return [
      // Commercial
      { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
      { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
      { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna' },
      { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon' },
      // Open source — large
      { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' },
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen 3.5 397B' },
      { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' },
      // Open source — medium/small
      { id: 'meta-llama/llama-4-scout', name: 'Llama 4 Scout' },
      { id: 'nvidia/nemotron-3-super-120b-a12b', name: 'Nemotron 3 Super 120B' },
      { id: 'nvidia/nemotron-3-nano-30b-a3b', name: 'Nemotron 3 Nano 30B' },
      { id: 'stepfun/step-3.5-flash', name: 'Step 3.5 Flash' }
    ];
  }
  return [
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' }
  ];
}

// OpenAI's /v1/models mixes chat models with audio/image/embedding ones and
// with Responses-only models (-pro, codex, deep-research) — keep chat-completions only
const OPENAI_CHAT_MODEL_RE = /^(gpt-\d|o\d|chatgpt-|chat-latest)/;
const OPENAI_NON_CHAT_RE = /embedding|tts|whisper|transcribe|realtime|live|audio|image|dall-e|moderation|search|computer-use|codex|deep-research|-pro\b|cyber|daybreak|oss|instruct|babbage|davinci/;
// Gemini models that list generateContent but don't answer with plain text
const GEMINI_NON_TEXT_RE = /embedding|imagen|veo|tts|live|aqa|image|nano-banana|transcribe|translate|robotics|computer-use|lyria|omni/;
// Paginated model lists: plenty for any real account, bounded against a looping cursor
const MODEL_LIST_MAX_PAGES = 5;

// Array.filter predicate keeping the first model of each id (pages may overlap)
function uniqueModelId() {
  const seen = new Set();
  return (m) => !seen.has(m.id) && Boolean(seen.add(m.id));
}

/**
 * Fetch the live model list from the provider's API.
 * Returns [{ id, name }] or null when the provider has no model list (DeepL).
 * `baseUrl` is required for 'custom' (lists `${base}/models`).
 * Anthropic and Gemini are paginated (at most MODEL_LIST_MAX_PAGES pages);
 * every list is filtered to models that answer a chat request with text.
 * Throws APIError on network/auth failure — callers fall back to getAvailableModels().
 */
export async function fetchAvailableModels(provider, apiKey, signal, baseUrl) {
  if (provider === 'anthropic') {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    const items = [];
    let afterId = '';
    const seenCursors = new Set();
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const query = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
      const data = await fetchModelsJSON(`https://api.anthropic.com/v1/models?limit=1000${query}`, headers, signal);
      items.push(...(Array.isArray(data?.data) ? data.data : []));
      // A cursor seen before would only fetch the same pages again (A, B, A…)
      if (!data?.has_more || !data.last_id || seenCursors.has(data.last_id)) break;
      seenCursors.add(data.last_id);
      afterId = data.last_id;
    }
    // The default list holds active + deprecated models; `lifecycle` may be absent
    return items
      .filter(m => typeof m?.id === 'string' && m.lifecycle !== 'deprecated' && m.lifecycle !== 'retired')
      .map(m => ({ id: m.id, name: m.display_name || m.id }))
      .filter(uniqueModelId());
  }
  if (provider === 'openai') {
    const data = await fetchModelsJSON('https://api.openai.com/v1/models', {
      'Authorization': `Bearer ${apiKey}`
    }, signal);
    return (Array.isArray(data?.data) ? data.data : [])
      .filter(m => typeof m?.id === 'string' && OPENAI_CHAT_MODEL_RE.test(m.id) && !OPENAI_NON_CHAT_RE.test(m.id))
      .map(m => ({ id: m.id, name: m.id }))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  if (provider === 'google') {
    const items = [];
    let pageToken = '';
    const seenCursors = new Set();
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page++) {
      const query = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const data = await fetchModelsJSON(`${GEMINI_BASE_URL}?pageSize=1000${query}`, { 'x-goog-api-key': apiKey }, signal);
      items.push(...(Array.isArray(data?.models) ? data.models : []));
      if (!data?.nextPageToken || seenCursors.has(data.nextPageToken)) break;
      seenCursors.add(data.nextPageToken);
      pageToken = data.nextPageToken;
    }
    return items
      .filter(m => typeof m?.name === 'string' && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || m.name }))
      .filter(m => !GEMINI_NON_TEXT_RE.test(m.id.toLowerCase()))
      .filter(uniqueModelId());
  }
  if (provider === 'openrouter') {
    const data = await fetchModelsJSON('https://openrouter.ai/api/v1/models', {}, signal);
    return (Array.isArray(data?.data) ? data.data : [])
      .filter(m => typeof m?.id === 'string' && !m.id.endsWith(':batch'))
      // Text output only — when the model declares its output modalities
      .filter(m => !Array.isArray(m.architecture?.output_modalities) || m.architecture.output_modalities.includes('text'))
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

// Before the first answer text a reasoning model may think for a long time,
// sending only keep-alives (or nothing) — same budget as a non-streaming call
const DEFAULT_STREAM_PRE_ANSWER_IDLE_MS = 90_000;
const DEFAULT_STREAM_IDLE_MS = 30_000;
const DEFAULT_STREAM_TOTAL_MS = 240_000;
const NON_STREAM_TIMEOUT_MS = DEFAULT_STREAM_TOTAL_MS;

/**
 * @param {{
 *   provider: string, apiKey: string, model: string, baseUrl?: string,
 *   prompt?: string, messages?: Array<{ role: 'user' | 'assistant', content: string }>,
 *   systemPrompt?: string, targetLang?: string, effort?: string, signal?: AbortSignal,
 *   onDelta?: (fullTextSoFar: string) => void,
 *   streamTimeouts?: { preAnswerIdleMs?: number, idleMs?: number, totalMs?: number },
 *   requestTimeoutMs?: number
 * }} params
 * `messages` takes precedence over `prompt`. With `onDelta` (and a provider
 * other than DeepL) the request streams; without it the request body has no
 * `stream` field. `baseUrl` is the endpoint of the 'custom' provider; the
 * built-in providers ignore it. `requestTimeoutMs` bounds the request up to
 * the headers (default 90 s when streaming), and for a non-streaming call
 * the whole body too (default 240 s, like a stream's overall cap). `streamTimeouts` (see readStream): inactivity limit before the
 * first answer text (`preAnswerIdleMs`, 90 s) and after it (`idleMs`, 30 s),
 * plus an overall cap (`totalMs`, 240 s). `effort` ('low' | 'medium' |
 * 'high'; anything else = provider default) maps to each provider's
 * reasoning parameter; DeepL ignores it.
 * @returns {Promise<string>}
 */
export async function callAI({ provider, apiKey, model, baseUrl, prompt, messages, systemPrompt, targetLang, effort, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
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
    effort: normalizeEffort(effort),
    signal,
    onDelta: typeof onDelta === 'function' ? onDelta : undefined,
    streamTimeouts,
    // Non-streaming runs (insert, Test) get the same overall cap as a stream:
    // the raised output budgets can take longer than the 90 s header wait
    requestTimeoutMs: requestTimeoutMs ?? (typeof onDelta === 'function' ? undefined : NON_STREAM_TIMEOUT_MS)
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

async function callAnthropic(apiKey, model, messages, systemPrompt, { effort, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  // No temperature (rejected by this API version) and no `thinking`
  // (Claude 5.x thinks adaptively by default)
  const body = {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    messages
  };
  if (systemPrompt) body.system = systemPrompt;
  if (effort) body.output_config = { effort };
  if (onDelta) body.stream = true;

  const { response, data } = await postWithTuningFallback({
    cacheKey: `${ANTHROPIC_URL}|${model}`,
    fields: [tuningField('effort', b => 'output_config' in b, b => { delete b.output_config; })],
    body,
    signal,
    send: (b) => fetchWithErrorHandling(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(b)
    }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && !!onDelta })
  });

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
 *   maxTokensField: 'max_completion_tokens' | 'max_tokens', maxTokens?: number,
 *   temperature?: number, effort?: string, effortParam?: 'reasoning_effort' | 'reasoning',
 *   providerName: string,
 *   signal?: AbortSignal, onDelta?: (fullTextSoFar: string) => void,
 *   streamTimeouts?: { preAnswerIdleMs?: number, idleMs?: number, totalMs?: number }, requestTimeoutMs?: number
 * }} params
 * `temperature` is sent only when given. `effort` goes into
 * `reasoning_effort` (OpenAI, custom) or `reasoning: { effort }`
 * (OpenRouter, `effortParam: 'reasoning'`). A 400 naming one of them is
 * retried without it (see postWithTuningFallback).
 * @returns {Promise<string>}
 */
export async function callChatCompletions({ url, headers, model, messages, systemPrompt, maxTokensField, maxTokens = MAX_TOKENS, temperature, effort, effortParam = 'reasoning_effort', providerName, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  const chatMessages = [];
  if (systemPrompt) chatMessages.push({ role: 'system', content: systemPrompt });
  chatMessages.push(...messages.map(m => ({ role: m.role, content: m.content })));

  const streaming = typeof onDelta === 'function';
  const body = {
    model,
    [maxTokensField]: maxTokens,
    messages: chatMessages
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (effort) body[effortParam] = effortParam === 'reasoning' ? { effort } : effort;
  if (streaming) body.stream = true;

  const { response, data } = await postWithTuningFallback({
    cacheKey: `${url}|${model}`,
    fields: [
      tuningField('temperature', b => 'temperature' in b, b => { delete b.temperature; }),
      tuningField('maxTokens', b => b[maxTokensField] > MAX_TOKENS, b => { b[maxTokensField] = MAX_TOKENS; }),
      tuningField('effort', b => effortParam in b, b => { delete b[effortParam]; })
    ],
    body,
    signal,
    send: (b) => fetchWithErrorHandling(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(b)
    }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && streaming })
  });

  if (response.ok && streaming) {
    // Every chat-completions provider shares the OpenAI chunk format
    return readStream(response, { provider: 'openai', providerName, signal, onDelta, ...streamTimeouts });
  }

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || `${providerName} API error`);
  }

  return extractChatCompletionText(data, providerName);
}

function callOpenAI(apiKey, model, messages, systemPrompt, { effort, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  return callChatCompletions({
    url: OPENAI_URL,
    headers: { 'Authorization': `Bearer ${apiKey}` },
    model,
    messages,
    systemPrompt,
    maxTokensField: 'max_completion_tokens',
    maxTokens: OPENAI_MAX_COMPLETION_TOKENS,
    effort,
    providerName: 'OpenAI',
    signal,
    onDelta,
    streamTimeouts,
    requestTimeoutMs
  });
}

function callOpenRouter(apiKey, model, messages, systemPrompt, { effort, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  return callChatCompletions({
    url: OPENROUTER_URL,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/contexthelper',
      'X-OpenRouter-Title': 'ContextHelper'
    },
    model,
    messages,
    systemPrompt,
    maxTokensField: 'max_tokens',
    // Reasoning models (e.g. the default openai/gpt-6-luna) spend part of it
    // thinking; a model with a lower cap gets one retry at MAX_TOKENS
    maxTokens: OPENROUTER_MAX_TOKENS,
    temperature: TEMPERATURE,
    effort,
    effortParam: 'reasoning',
    providerName: 'OpenRouter',
    signal,
    onDelta,
    streamTimeouts,
    requestTimeoutMs
  });
}

async function callCustom(apiKey, baseUrl, model, messages, systemPrompt, { effort, signal, onDelta, streamTimeouts, requestTimeoutMs }) {
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  try {
    return await callChatCompletions({
      url,
      headers: customHeaders(apiKey),
      model,
      messages,
      systemPrompt,
      maxTokensField: 'max_tokens',
      temperature: TEMPERATURE,
      effort,
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

async function callGemini(apiKey, model, messages, systemPrompt, { effort, signal, onDelta, streamTimeouts, requestTimeoutMs, singleUserTurn }) {
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
    // No temperature: Gemini 3.6+ ignores it, and Google recommends the
    // default for Gemini 3
    generationConfig: {
      maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS
    }
  };
  // Gemini 2.5 models reject thinkingLevel with a 400 — the fallback drops it
  if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: effort.toUpperCase() };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const { response, data } = await postWithTuningFallback({
    // Not the URL: the streaming and the plain endpoint serve one model
    cacheKey: `${GEMINI_BASE_URL}|${model}`,
    fields: [tuningField('effort',
      b => 'thinkingConfig' in b.generationConfig,
      b => { delete b.generationConfig.thinkingConfig; })],
    body,
    signal,
    send: (b) => fetchWithErrorHandling(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(b)
    }, signal, { timeoutMs: requestTimeoutMs, skipBody: r => r.ok && !!onDelta })
  });

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

/**
 * DeepL's live target languages as [{ id, name }] (the shape of
 * DEEPL_TARGET_LANGUAGES), sorted by name. `GET /v3/languages` returns
 * BCP-47 casing (`en-US`, `zh-Hant`); ids are upper-cased to match the stored
 * `targetLang` values (`EN-US`). The deprecated `/v2/languages?type=target`
 * is used only when v3 answers 404. Throws APIError (403 → 401).
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function fetchDeepLTargetLanguages(apiKey, signal) {
  const base = getDeepLBaseUrl(apiKey);
  const headers = { 'Authorization': `DeepL-Auth-Key ${apiKey}` };
  const getJSON = async (url) => {
    const { response, data } = await fetchWithErrorHandling(url, { method: 'GET', headers }, signal);
    if (!response.ok) {
      throw new APIError(response.status === 403 ? 401 : response.status, data?.message || 'DeepL API error');
    }
    return Array.isArray(data) ? data : [];
  };

  let entries;
  try {
    entries = (await getJSON(`${base}/v3/languages?resource=translate_text`))
      .filter(l => l?.usable_as_target === true)
      .map(l => ({ code: l.lang, name: l.name }));
  } catch (err) {
    if (err?.status !== 404) throw err;
    entries = (await getJSON(`${base}/v2/languages?type=target`))
      .map(l => ({ code: l?.language, name: l?.name }));
  }

  const seen = new Set();
  const langs = [];
  for (const { code, name } of entries) {
    if (typeof code !== 'string' || !code.trim()) continue;
    const id = code.trim().toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    langs.push({ id, name: typeof name === 'string' && name.trim() ? name.trim() : id });
  }
  return langs.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function extractDeepLText(data) {
  const text = data.translations?.[0]?.text || '';
  if (!text.trim()) throw new APIError(0, 'DeepL returned an empty response');
  return text;
}

// ── Stop reasons ──

const BUDGET_EXHAUSTED_MESSAGE = 'The model used its whole token budget on reasoning — lower Reasoning effort';
const DECLINED_MESSAGE = 'The model declined to answer';

// Raw stop reasons of every provider (Anthropic stop_reason, chat-completions
// finish_reason, Gemini finishReason / promptFeedback.blockReason) — the
// names do not collide, so one table serves all of them
const LENGTH_STOP_REASONS = new Set(['max_tokens', 'length', 'MAX_TOKENS']);
const REFUSAL_STOP_REASONS = new Set(['refusal', 'content_filter', 'SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);
const NORMAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'stop', 'STOP']);

/**
 * Normalize a provider's raw stop reason: 'length' (token budget spent),
 * 'refusal' (declined or blocked), 'stop' (normal end), 'other' (anything
 * else, e.g. CONTINUATION, RECITATION, tool_calls) or '' (none given).
 * @returns {'length' | 'refusal' | 'stop' | 'other' | ''}
 */
export function normalizeStopReason(raw) {
  if (!raw) return '';
  if (LENGTH_STOP_REASONS.has(raw)) return 'length';
  if (REFUSAL_STOP_REASONS.has(raw)) return 'refusal';
  if (NORMAL_STOP_REASONS.has(raw)) return 'stop';
  return 'other';
}

/**
 * The error for an answer that ended with no text. A spent budget and a
 * refusal are deterministic (`retryable: false` — retrying gives the same);
 * anything else is the generic, retryable empty response with the raw reason.
 */
function emptyAnswerError(providerName, rawReason) {
  const stopReason = normalizeStopReason(rawReason);
  if (stopReason === 'length') return new APIError(0, BUDGET_EXHAUSTED_MESSAGE, { retryable: false, stopReason });
  if (stopReason === 'refusal') return new APIError(0, DECLINED_MESSAGE, { retryable: false, stopReason });
  return new APIError(0, `${providerName} returned an empty response${rawReason ? ` (${rawReason})` : ''}`);
}

export function extractAnthropicText(data) {
  const text = (data.content || [])
    .filter(part => part?.type === 'text' || part?.text)
    .map(part => part.text || '')
    .join('');
  if (!text.trim()) throw emptyAnswerError('Anthropic', data.stop_reason);
  return text;
}

export function extractChatCompletionText(data, providerName) {
  const choice = data.choices?.[0];
  const text = choice?.message?.content || '';
  if (!text.trim()) throw emptyAnswerError(providerName, choice?.finish_reason);
  return text;
}

// Gemini thinking models return their reasoning as parts with thought: true
function geminiAnswerText(parts) {
  return (parts || []).filter(part => part?.thought !== true).map(part => part?.text || '').join('');
}

export function extractGeminiText(data) {
  const text = geminiAnswerText(data.candidates?.[0]?.content?.parts);
  if (!text.trim()) {
    throw emptyAnswerError('Google Gemini', data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason);
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
    result.delta = geminiAnswerText(candidate?.content?.parts);
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
 *
 * Inactivity is measured in two phases, both reset by any bytes (keep-alive
 * comments, pings, role or reasoning chunks): `preAnswerIdleMs` until the
 * first answer text, `idleMs` after it. `totalMs` bounds the whole read.
 */
async function readStream(response, {
  provider, providerName, signal, onDelta,
  preAnswerIdleMs = DEFAULT_STREAM_PRE_ANSWER_IDLE_MS,
  idleMs = DEFAULT_STREAM_IDLE_MS, totalMs = DEFAULT_STREAM_TOTAL_MS
}) {
  if (!response.body) throw new APIError(0, `${providerName} stream ended unexpectedly`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let done = false;
  let failure = null;
  // The provider's raw stop reason, classified once the stream has ended
  // (Anthropic sends it in message_delta, before the terminal message_stop)
  let stopReason = '';

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
    if (provider === 'anthropic') {
      if (payload.type === 'message_delta') stopReason = payload.delta?.stop_reason || stopReason;
    } else if (provider === 'google') {
      stopReason = payload.promptFeedback?.blockReason || payload.candidates?.[0]?.finishReason || stopReason;
    } else {
      stopReason = payload.choices?.[0]?.finish_reason || stopReason;
    }
    if (event.error) {
      // A blocked Gemini prompt is a refusal, not a transient stream error
      const blocked = provider === 'google' && normalizeStopReason(payload.promptFeedback?.blockReason) === 'refusal';
      fail(blocked ? emptyAnswerError(providerName, stopReason) : new APIError(0, event.error));
      return;
    }
    if (event.delta) {
      const firstAnswerText = !text;
      text += event.delta;
      if (firstAnswerText) armIdle(); // switch to the shorter answer-phase limit
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
    const limit = text ? idleMs : preAnswerIdleMs;
    idleTimer = setTimeout(() => fail(new APIError(0, 'API stream stalled')), limit);
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
    if (!text.trim()) throw emptyAnswerError(providerName, stopReason);
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
  /**
   * @param {number} status  HTTP status, 0 for network/stream/empty-answer failures
   * @param {string} message
   * @param {{ retryable?: boolean, stopReason?: string }} [extra]  `retryable: false`
   *   marks a deterministic answer (see isRetryableError in lib/chat.js)
   */
  constructor(status, message, { retryable, stopReason } = {}) {
    const userMessage = APIError.getUserMessage(status, message);
    super(userMessage);
    this.name = 'APIError';
    this.status = status;
    this.originalMessage = message;
    if (retryable !== undefined) this.retryable = retryable;
    if (stopReason !== undefined) this.stopReason = stopReason;
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

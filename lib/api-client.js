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
  deepl: ''
};

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
  return DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
}

export function getAvailableModels(provider) {
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
 * Throws APIError on network/auth failure — callers fall back to getAvailableModels().
 */
export async function fetchAvailableModels(provider, apiKey, signal) {
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
  return null;
}

async function fetchModelsJSON(url, headers, signal) {
  const response = await fetchWithErrorHandling(url, { method: 'GET', headers }, signal);
  const data = await safeParseJSON(response);
  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || data?.message || 'Model list error');
  }
  return data;
}

/**
 * @param {{ provider: string, apiKey: string, model: string, prompt: string, systemPrompt?: string, targetLang?: string, signal?: AbortSignal }} params
 * @returns {Promise<string>}
 */
export async function callAI({ provider, apiKey, model, prompt, systemPrompt, targetLang, signal }) {
  if (provider === 'deepl') {
    // DeepL is not an LLM: no model, no system prompt — raw text + target language
    return callDeepL(apiKey, prompt, targetLang, signal);
  }

  const effectiveModel = model || getDefaultModel(provider);

  if (provider === 'anthropic') {
    return callAnthropic(apiKey, effectiveModel, prompt, systemPrompt, signal);
  }
  if (provider === 'openai') {
    return callOpenAI(apiKey, effectiveModel, prompt, systemPrompt, signal);
  }
  if (provider === 'openrouter') {
    return callOpenRouter(apiKey, effectiveModel, prompt, systemPrompt, signal);
  }
  if (provider === 'google') {
    return callGemini(apiKey, effectiveModel, prompt, systemPrompt, signal);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function callAnthropic(apiKey, model, prompt, systemPrompt, signal) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) body.system = systemPrompt;

  const response = await fetchWithErrorHandling(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  }, signal);

  const data = await safeParseJSON(response);

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'Anthropic API error');
  }

  return extractAnthropicText(data);
}

async function callOpenAI(apiKey, model, prompt, systemPrompt, signal) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetchWithErrorHandling(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages
    })
  }, signal);

  const data = await safeParseJSON(response);

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'OpenAI API error');
  }

  return extractChatCompletionText(data, 'OpenAI');
}

async function callOpenRouter(apiKey, model, prompt, systemPrompt, signal) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetchWithErrorHandling(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/contexthelper',
      'X-Title': 'ContextHelper'
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages
    })
  }, signal);

  const data = await safeParseJSON(response);

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'OpenRouter API error');
  }

  return extractChatCompletionText(data, 'OpenRouter');
}

async function callGemini(apiKey, model, prompt, systemPrompt, signal) {
  const url = `${GEMINI_BASE_URL}/${model}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: MAX_TOKENS,
      temperature: TEMPERATURE
    }
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  const response = await fetchWithErrorHandling(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(body)
  }, signal);

  const data = await safeParseJSON(response);

  if (!response.ok) {
    throw new APIError(response.status, data?.error?.message || 'Google Gemini API error');
  }

  return extractGeminiText(data);
}

async function callDeepL(apiKey, text, targetLang, signal) {
  if (!targetLang) {
    throw new APIError(0, 'No target language configured for this DeepL action');
  }

  const response = await fetchWithErrorHandling(`${getDeepLBaseUrl(apiKey)}/v2/translate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `DeepL-Auth-Key ${apiKey}`
    },
    body: JSON.stringify({ text: [text], target_lang: targetLang })
  }, signal);

  const data = await safeParseJSON(response);

  if (!response.ok) {
    // DeepL signals a bad key with 403 — remap to 401 for the shared friendly message
    throw new APIError(response.status === 403 ? 401 : response.status, data?.message || 'DeepL API error');
  }

  return extractDeepLText(data);
}

export async function getDeepLUsage(apiKey, signal) {
  const response = await fetchWithErrorHandling(`${getDeepLBaseUrl(apiKey)}/v2/usage`, {
    method: 'GET',
    headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}` }
  }, signal);

  const data = await safeParseJSON(response);

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

const REQUEST_TIMEOUT_MS = 90_000;

async function safeParseJSON(response) {
  try {
    return await response.json();
  } catch {
    throw new APIError(response.status, `API error (${response.status})`);
  }
}

async function fetchWithErrorHandling(url, options, externalSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    return await fetch(url, { ...options, signal: controller.signal });
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

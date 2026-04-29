const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.4-mini',
  openrouter: 'anthropic/claude-sonnet-4-6',
  google: 'gemini-2.5-flash'
};

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
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite-preview', name: 'Gemini 2.5 Flash Lite' },
      { id: 'gemini-3.1-flash-preview', name: 'Gemini 3.1 Flash (preview)' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (preview)' },
      { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite (preview)' }
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

/**
 * @param {{ provider: string, apiKey: string, model: string, prompt: string, systemPrompt?: string, signal?: AbortSignal }} params
 * @returns {Promise<string>}
 */
export async function callAI({ provider, apiKey, model, prompt, systemPrompt, signal }) {
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

# ContextHelper — Privacy Policy

_Last updated: 2026-07-20_

ContextHelper is a browser extension that runs AI-powered actions (translation, summarization, rewriting, etc.) on text you select on a web page, using AI providers **you** configure with **your own** API keys.

## What data the extension processes

- **Selected text** — the text you explicitly select and run an action on is sent directly from your browser to the AI provider you configured for that action (Anthropic, OpenAI, Google Gemini, OpenRouter, or DeepL). It is never sent anywhere else.
- **Page URL and title** — included in a webhook payload only if you configure a webhook and press its send button in the result tooltip.
- **API keys** — stored locally in your browser (`chrome.storage.local`). They are only ever sent to the corresponding provider's official API endpoint. They are **not** synced to your Google account and never leave your machine otherwise.
- **Settings** (actions, appearance, keyboard shortcut slots) — stored via `chrome.storage.sync` so they follow your Chrome profile. They contain no secrets.

## What the extension does NOT do

- No analytics, no telemetry, no tracking of any kind.
- No data is sent to the extension author or any third party other than the AI providers / webhook endpoints you explicitly configure.
- No browsing history is read or stored.
- Nothing runs on a page until you trigger an action (context menu, keyboard shortcut, or the optional floating button — which only works on domains you explicitly enable).

## Third-party services

When you run an action, the selected text is processed by the provider you chose, under that provider's own terms and privacy policy:

- Anthropic — https://www.anthropic.com/legal/privacy
- OpenAI — https://openai.com/policies/privacy-policy
- Google (Gemini API) — https://policies.google.com/privacy
- OpenRouter — https://openrouter.ai/privacy
- DeepL — https://www.deepl.com/privacy

If you configure webhooks, the rendered payload (AI result, source text, page URL/title, action name, timestamp, model name) is sent to the URL you configured, only when you press the send button.

## Permissions

- **Host access to AI provider APIs** — required to call the providers listed above.
- **Optional host access** (granted per-site by you) — used only for the optional floating selection button and for webhook endpoints you add.
- **contextMenus, storage, activeTab, scripting** — used to show the action menu, store your settings, and display the result overlay on the current tab.

## Contact

Questions: open an issue at https://github.com/tompopielarczyk/contexthelper/issues

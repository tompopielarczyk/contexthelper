# Chrome Web Store — ContextHelper 1.2.0

Paste-ready texts for the Developer Dashboard. Package: `contexthelper-1.2.0.zip`.

## Store listing → Description

ContextHelper runs AI actions on the text you select, right where you read and write. Right-click a selection (or press a shortcut) and translate, fix grammar, improve your writing, explain, summarize or quote it with its source. Results stream into a tooltip you can refine, or replace the selected text directly in input fields.

Bring your own AI provider:
• Anthropic (Claude), OpenAI (GPT), Google Gemini, OpenRouter (hundreds of models) and DeepL
• Local and self-hosted models through any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM)
• Live model lists from each provider and a per-model Reasoning effort setting

Built for daily use:
• Your own actions with custom prompts, reorderable by drag and drop
• Streaming answers with Refine: Shorter, Longer, Simpler, or a follow-up question
• Ask about selection: type any question about the selected text
• Page context: let an action see the paragraphs around your selection, the page title and URL
• Up to four keyboard shortcuts, an optional floating button on chosen sites, webhooks to send results to Notion, n8n or any API
• Light and dark theme, resizable result tooltip

Private by design: your API keys stay in your browser, text goes only to the provider you chose, and nothing is collected by the extension author. No analytics, no tracking.

## What's new in 1.2.0 (optional, for the description or release notes)

• Streaming answers, Retry after errors, and Refine (Shorter / Longer / Simpler / follow-up) in the result tooltip
• Ask about selection
• Custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM)
• Live, always-current model lists for every provider; Reasoning effort per model
• Page context checkbox for actions; copyable template placeholders
• Requests updated to the latest Anthropic, Gemini and OpenAI APIs
• New default actions that follow your browser language
• Never sends password or payment-card fields

## Privacy practices → Single purpose

ContextHelper runs user-defined AI actions (translate, rewrite, explain, summarize, ask) on text the user selects in the browser, using AI providers the user configures with their own API keys.

## Privacy practices → Permission justifications

- **contextMenus**: Shows the ContextHelper submenu with the user's actions and "Ask about selection" when text is selected, and the per-domain floating-button toggle.
- **storage**: Stores the user's settings (actions, appearance, shortcuts) and, locally only, API keys, webhooks and cached model lists.
- **activeTab**: Reads the user's selection and shows the result in the tab where the user triggered an action from the context menu or a keyboard shortcut.
- **scripting**: Injects the result overlay and reads the current selection (and, only for actions with Page context or page placeholders, the surrounding text) in the active tab when the user runs an action. Never reads password or payment-card fields.
- **Host permissions** (api.anthropic.com, api.openai.com, openrouter.ai/api, generativelanguage.googleapis.com, api.deepl.com, api-free.deepl.com): Sends the selected text to the AI provider the user configured and loads that provider's model list.
- **Optional host permissions** (http://*/*, https://*/*): Requested at runtime only for origins the user adds: domains where the user enables the floating selection button, webhook endpoints the user configures, and custom OpenAI-compatible model endpoints (e.g. a local Ollama or LM Studio server). Nothing is requested at install.
- **Remote code**: No, the extension does not use remote code.

## Privacy practices → Data usage

Tick:
- **Website content** — the text the user selects, and for actions where the user enables Page context, the surrounding paragraphs, page title and URL. Sent only to the AI provider (or webhook) the user configured, when the user runs an action.
- **Authentication information** — the user's own API keys, stored locally and sent only to the matching provider's API.

Leave unticked: personally identifiable information, health, financial and payment, personal communications, location, web history, user activity.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: link to the published PRIVACY.md (needs the latest version pushed).

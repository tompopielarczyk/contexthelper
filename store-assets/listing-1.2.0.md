# Chrome Web Store — ContextHelper 1.2.0

Paste-ready texts for the Developer Dashboard. Package: `contexthelper-1.2.0.zip`.

## Store listing → Description

Keep brand names to one short sentence: the first 1.2.0 submission was rejected as keyword spam ("Yellow Argon") for a long provider list with parenthetical extras.

ContextHelper turns any text you select into an AI action: translate it, summarize it, fix the grammar, improve your writing, explain it, or anything else you define yourself with a custom prompt.

Bring your own key. ContextHelper works with the AI service you already use, such as Claude, ChatGPT, Gemini or DeepL, and with models running on your own computer. Your API keys stay in your browser, and the text goes directly from your browser to the provider you chose. No middleman server, no account, no tracking.

Three ways to trigger an action:
- Right-click a selection and pick an action from the ContextHelper menu
- Keyboard shortcuts (up to 4 configurable slots)
- An optional floating button next to your selection, only on the sites you enable it for

Or choose "Ask about selection" and type any question about the selected text.

Results your way. Each action can replace the selected text in place (great in editors and text fields) or stream the answer into a clean tooltip with a copy button. Not quite right? Refine it with one click (Shorter, Longer, Simpler) or a follow-up question. The tooltip is resizable and remembers its size.

Page context. Tick it on an action and the model also sees the paragraphs around your selection, the page title and URL, so translations and explanations fit the page.

Webhooks. Send any result to your own automations with a fully customizable JSON payload, with one click from the result tooltip.

Privacy-first by design:
- No analytics, no telemetry, no ads
- API keys stored locally, never synced, sent only to the provider you configured
- Page content is sent only for actions where you enable Page context; password and payment fields are never read
- Site access is opt-in: per domain for the floating button, all sites only if you turn that on
- Open source: https://github.com/tompopielarczyk/contexthelper

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
- **Personal communications** — the selected text can be an email or chat message the user is reading or writing (e.g. "Improve writing" on a draft). Over-disclosing is safer than a reviewer deciding it was missing.

Leave unticked: personally identifiable information, health, financial and payment, location, web history, user activity.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: link to the published PRIVACY.md (needs the latest version pushed).

# Chrome Web Store — listing drafts

Copy-paste material for the Developer Dashboard. Keep in repo for future updates.

## Short description (max 132 chars)

> Run AI actions on selected text: translate, summarize, rewrite. Your own API keys — Anthropic, OpenAI, Gemini, OpenRouter, DeepL.

## Detailed description

ContextHelper turns any text you select into an AI action: translate it, summarize it, fix the grammar, rewrite the tone — or anything else you define yourself with a custom prompt.

**Bring your own key.** ContextHelper is a thin client for the AI providers you already use: Anthropic (Claude), OpenAI (GPT), Google Gemini, OpenRouter (300+ models incl. open-source), and DeepL. Your API keys stay in your browser; the selected text goes directly from your browser to the provider — no middleman server, no account, no tracking.

**Three ways to trigger an action:**
- Right-click a selection → ContextHelper menu
- Keyboard shortcuts (up to 4 configurable slots)
- Optional floating button that appears next to your selection — only on the sites you enable it for

**Results your way.** Each action can replace the selected text in place (great in editors and text fields) or show the result in a clean tooltip with copy button. The tooltip is resizable and remembers its size. Dark mode included.

**Webhooks.** Send any result to your own automation (n8n, Make, Zapier, Notion…) with a fully customizable JSON payload template — manually, with one click from the result tooltip.

**Privacy-first by design:**
- No analytics, no telemetry, no ads
- API keys stored locally, never synced or transmitted anywhere except the provider's official API
- Site access is opt-in per domain — the extension does not request access to all websites
- Open source: https://github.com/tompopielarczyk/contexthelper

## Category / language

- Category: Productivity → Tools
- Language: English

## Privacy practices tab

**Single purpose description:**
> Runs user-configured AI actions (translate, summarize, rewrite, custom prompts) on text the user selects, via AI provider APIs configured with the user's own keys.

**Permission justifications:**

- `contextMenus` — Adds the "ContextHelper" submenu to the right-click menu on text selections; this is the primary way users trigger actions.
- `storage` — Stores user-defined actions, appearance settings and (locally only) the user's API keys and webhook configuration.
- `activeTab` — Shows the loading spinner / result tooltip overlay and reads the selected text in the tab where the user invoked an action.
- `scripting` — Injects the overlay content script on demand into the page where the user triggered an action, and registers it for domains where the user enabled the optional floating button.
- Host permissions (`api.anthropic.com`, `api.openai.com`, `openrouter.ai`, `generativelanguage.googleapis.com`, `api.deepl.com`, `api-free.deepl.com`) — Required to call the AI/translation APIs the user configures with their own API keys. These are the only hosts contacted by default.
- Optional host permissions (`http://*/*`, `https://*/*`) — Requested at runtime, per origin, only when the user (a) enables the floating selection button on a specific domain (or explicitly opts into all sites), or (b) adds a webhook endpoint. Nothing is requested at install time.
- Remote code: **No** — the extension executes no remotely hosted code; all code ships in the package. API responses are treated as data (text) only.

**Data usage disclosures (check exactly these):**
- "Website content" (selected text) — collected: yes; sold: no; transferred for unrelated purposes: no. Transferred only to the user-chosen AI provider to fulfill the extension's single purpose.
- "Authentication information" (user's own API keys) — stored locally; not transmitted except to the corresponding provider's API.
- Everything else (location, history, activity, personal communications…): not collected.

**Privacy policy URL:**
> https://github.com/tompopielarczyk/contexthelper/blob/main/PRIVACY.md

## Assets needed (not in repo)

- Screenshots: 1280×800 (or 640×400), 1–5 items. Suggested shots:
  1. Context menu with actions on a selected paragraph
  2. Result tooltip with Copy + webhook send button
  3. Options → Actions tab (custom prompt editing)
  4. Options → Models tab (provider + live model combobox)
  5. Floating button next to a selection
- Small promo tile (optional): 440×280
- Store icon: reuse `icons/icon128.png`

## Submission checklist

1. https://chrome.google.com/webstore/devconsole — one-time 5 USD developer fee
2. New item → upload `contexthelper-1.0.0.zip`
3. Fill Store listing (texts above) + screenshots
4. Privacy practices tab: single purpose, justifications, data disclosures, privacy policy URL (all above)
5. Distribution: Public, all regions (or as preferred)
6. Submit for review — first review of an extension with broad optional host permissions typically takes a few days

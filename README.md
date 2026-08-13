<div align="center">
  <img src="icons/icon128.png" width="96" alt="ContextHelper logo">

  # ContextHelper

  **AI actions on selected text — with your own API keys.**

  [![Chrome Web Store](https://img.shields.io/chrome-web-store/v/mneooipcabjdchjkcokpinhipbpdlfdg?label=Chrome%20Web%20Store&color=4285F4)](https://chromewebstore.google.com/detail/contexthelper/mneooipcabjdchjkcokpinhipbpdlfdg)
  [![Users](https://img.shields.io/chrome-web-store/users/mneooipcabjdchjkcokpinhipbpdlfdg?color=4285F4)](https://chromewebstore.google.com/detail/contexthelper/mneooipcabjdchjkcokpinhipbpdlfdg)
  [![Rating](https://img.shields.io/chrome-web-store/rating/mneooipcabjdchjkcokpinhipbpdlfdg?color=4285F4)](https://chromewebstore.google.com/detail/contexthelper/mneooipcabjdchjkcokpinhipbpdlfdg/reviews)
  ![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

  Select text on any page → translate, summarize, rewrite, or run any custom prompt.
  No middleman server, no account, no tracking.
</div>

---

## Features

- **Bring your own key** — works directly with Anthropic (Claude), OpenAI (GPT), Google Gemini, OpenRouter (300+ models incl. open-source), and DeepL
- **Custom actions** — define any prompt with a `{{text}}` placeholder; reorder, assign models per action
- **Three ways to trigger:**
  - right-click → **ContextHelper** menu
  - keyboard shortcuts (4 configurable slots)
  - optional floating button next to your selection — opt-in per site
- **Results your way** — replace the selection in place (inputs, editors, contenteditable) or show a resizable tooltip with a copy button
- **Webhooks** — send any result to n8n / Make / Zapier / Notion with a fully customizable JSON payload template, one click from the tooltip
- **Live model lists** — model pickers load current models from each provider's API, with offline fallback
- **Dark mode** — follows your system, or force light/dark

## Privacy

- Selected text goes **directly from your browser to the provider you chose** — nowhere else
- API keys are stored locally (`chrome.storage.local`), never synced, never transmitted except to the provider's official API
- No analytics, no telemetry
- Site access is **opt-in per domain** — the extension does not request access to all websites

Full policy: [PRIVACY.md](PRIVACY.md)

## Installation

**Chrome Web Store:** [Install ContextHelper](https://chromewebstore.google.com/detail/contexthelper/mneooipcabjdchjkcokpinhipbpdlfdg)

**From source:**

1. Clone this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repository folder

No build step — plain JavaScript, zero dependencies.

## Getting started

1. Open the extension options (it opens automatically on first install)
2. **Models** tab → add a model config: pick a provider, model, and paste your API key (the **Test** button verifies it)
3. **Actions** tab → assign the model config to the built-in actions, or create your own
4. Select text on any page → right-click → **ContextHelper** → pick an action

### Keyboard shortcuts

Assign an action to one of 4 slots in the options; change the key combos at `chrome://extensions/shortcuts` (defaults: `Ctrl+Shift+1..4`).

### Floating button

Right-click on a page → **ContextHelper** → *Floating button: enable on this domain*. The permission is requested for that single domain only. Configure the pinned action, emoji, color, and delay in the options — or enable it for all sites if you prefer.

### Webhooks

**Webhooks** tab → add a URL and a JSON payload template with placeholders like `{{result}}`, `{{sourceText}}`, `{{pageUrl}}`. Every result tooltip then offers a send button. HTTPS is required (plain HTTP is allowed only for localhost).

## Architecture

Chrome Manifest V3, vanilla JS, no bundler, no dependencies.

```
background.js   service worker — context menu, shortcuts, AI calls
content.js      page overlay — tooltip, spinner, floating button (Shadow DOM)
options.*       settings page
lib/            API clients, storage, webhook delivery
```

Run the tests with:

```
npm test
```

## License

[MIT](LICENSE)

# WebNav - Local AI Browser Agent

A Chrome extension (Manifest V3) that drives the browser with open-source AI models via direct OpenAI-compatible API endpoints (Ollama, LM Studio, vLLM, llama.cpp server, text-generation-webui).

## What's new in this build

- All UI pages (popup, sidebar, options) are **self-contained classic scripts** with no ES module imports. They will load reliably without depending on Chrome's ES module resolution for `chrome-extension://` pages.
- The service worker is the only ES module consumer. It uses standard `import` syntax with `type: "module"`.
- Every UI page shows a **red error banner at the top** if any JS error or unhandled promise rejection occurs, with a console hint.
- The popup and sidebar **poll** the service worker every 1.5s for the current task. This survives service-worker restarts cleanly - no more "frozen UI after a long task".
- A default **Ollama profile** is auto-created on first install so the popup and sidebar have something to show immediately.
- Navigation tools (`navigate`, `open_tab`, `back`, `refresh`, `switch_tab`) now **wait for the tab to finish loading** and take a fresh snapshot before continuing - this is what makes the agent actually work on real pages.
- The agent gracefully **resumes from `chrome.storage.session`** after a service-worker restart (resume if the previous instance died mid-task).
- Each tool result that's larger than 8 KB is **truncated in message history** but the full result is kept in the snapshot.
- A "looks like a final answer" heuristic lets a free-text response terminate the task without requiring the model to emit `finish()` (some smaller models don't reliably call it).

## Install

1. Install **Ollama** (you already have `OllamaSetup.exe` in your Downloads). After install, start it: it runs as a background service on Windows.
2. Pull a tool-capable model:
   ```
   ollama pull qwen2.5
   ```
   Other good choices: `llama3.1`, `mistral-nemo`, `functionary`, `hermes-3`.
3. Open `chrome://extensions`, enable **Developer mode** (top right), click **Load unpacked**, and select the `BrowserExt` folder.
4. The **Options page** opens automatically on first install. The default Ollama profile is pre-seeded. Click **Test connection** in the Profiles tab to confirm.
5. Pick an allowlist mode. **Allow all non-blocked** is the most permissive starting point.
6. Pin the extension, click the icon, type a task. Open the side panel (toolbar side-panel icon) to watch the agent work and approve R2/R3 actions.

## Architecture

```
BrowserExt/
├── manifest.json
├── background/
│   └── service-worker.js     # Agent loop, snapshot cache, ports, resume
├── content/                  # Injected into pages
│   ├── element-id.js         # Per-snapshot stable IDs
│   ├── dom-utils.js          # Click/type/scroll/extract
│   └── content.js            # Message router
├── popup/                    # Task entry, self-contained
├── sidebar/                  # Live activity, approvals, self-contained
├── options/                  # 5-tab settings, self-contained
├── lib/                      # ES modules, used by service worker only
│   ├── ai-client.js          # OpenAI-compatible chat
│   ├── agent.js              # ReAct loop with abort()
│   ├── parser.js             # Strict text-tool parser
│   ├── risk.js               # R0..R4 classifier
│   ├── allowlist.js          # URL checks + builtin categories
│   ├── psl.js                # Public Suffix List loader
│   ├── secret-redact.js      # Per-rule secret redaction
│   ├── prompt-defense.js     # Sanitization + injection patterns
│   ├── tools.js              # 14 tool schemas + validator
│   ├── storage.js            # chrome.storage wrappers
│   └── usage.js              # Cost accounting
└── data/
    ├── psl.txt               # Bundled PSL (minimal)
    └── deny-categories.json  # Built-in protected domains
```

## The 14 tools

1. `navigate(url, risk_reason?)` - Go to a URL in the current tab
2. `open_tab(url, risk_reason?)` - Open a new tab
3. `switch_tab(tabId)` - Make a different tab active
4. `read_page(max?, offset?)` - Get the current page's interactive elements
5. `click(id, risk_reason?)` - Click the element with the given ID
6. `type_text(id, text, pressEnter?, risk_reason?)` - Type into a field
7. `press_key(key, risk_reason?)` - Press a keyboard key
8. `scroll(direction, amount)` - Scroll the page
9. `extract_text(id?, max?, offset?)` - Read text content
10. `wait_for(selector|id|text, timeout)` - Wait for an element
11. `back()` - Go back in browser history
12. `refresh(bypassCache?)` - Reload the current page
13. `ask_user(question, options?)` - Pause and ask the user
14. `finish(answer)` - Mark the task complete

## Safety model

- **Built-in deny list**: 7 categories (banking, payment, crypto, government, medical, identity, cloud-console). Override requires typing the category name.
- **R0/R1 auto-execute**, **R2** configurable, **R3 always requires approval**, **R4 blocked outright**.
- **R3 timeouts abort the task** (no retry in a different way).
- **Secret redaction**: off by default, per-rule opt-in in Safety tab.
- **Prompt-injection defense**: invisible-character stripping, pattern filter, untrusted-page wrapper, accumulated-hit warning.
- **Loop detection**: same action 3+ times, or a 4-action sequence repeated 2+ times. Configurable.

## Troubleshooting

- **"Failed to fetch" / connection fails**: this is a network-level error, not an auth error — the server couldn't be reached.
  - **Local Ollama**: confirm Ollama is running. In a terminal run `curl http://localhost:11434/v1/models`. The Base URL must be `http://localhost:11434/v1` and **needs no API key**.
  - **Ollama Cloud** (key shaped like `3db37b…​.cPJ40…`): the Base URL must be **`https://ollama.com/v1`** (OpenAI-compatible). Paste your key into the API key field. Do **not** use `https://ollama.com/api/v1` — that path does not exist.
- **HTTP 401/403 from cloud**: the Base URL is right but the API key is wrong, expired, or has no cloud-model access. Regenerate the key on ollama.com.
- **Test connection fails**: confirm Ollama is running. Open a terminal and run `curl http://localhost:11434/v1/models` - it should return a list of models.
- **Model emits invalid actions**: 3 parse errors abort the task. Try a tool-capable model (qwen2.5, llama3.1, mistral-nemo).
- **Side panel won't open**: Chrome 114+ has the side panel; click the side-panel icon in the toolbar (not the WebNav extension icon).
- **"another_task_running" error**: stop the previous task with the Stop button in the popup.
- **Service worker restarts frequently**: this is normal in MV3. Agent state is persisted to `chrome.storage.session` and resumes automatically. The popup/sidebar poll every 1.5s for updates.
- **A red error banner appears at the top of a UI page**: open DevTools (F12 or right-click > Inspect) for that page; the JS error is logged to console with a stack trace.

## License

MIT.

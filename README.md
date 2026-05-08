# tickle

Local AI agent that drives a real browser to complete tasks. Uses **LM Studio** (default — qwen3.6-27b-uncensored-hauhaucs-balanced, vision + native tool calling) + **Playwright** (headed) + **React/Tailwind** UI.

You write a task in plain English ("go to google.com, search foobar, click the 4th result, return the 3rd and 9th sentences"). The agent breaks it into steps, calls tools (navigate/click/type/screenshot/read), and the model sees screenshots directly to decide what to do next.

This is a **single-user local tool**. It is not designed to be exposed to the internet — it has no auth, the persistent browser profile holds your real cookies, and the LLM runs on the same machine. Run it on your own box and keep it there.

## Supported platforms

Tickle is OS-agnostic. The repo is developed on Windows but targeted to also run on a Mac mini (primary deployment) and any modern Linux. Anything OS-specific is called out where it appears.

| Platform | Status                | Notes                                                                 |
|----------|-----------------------|-----------------------------------------------------------------------|
| macOS    | first-class (Apple Silicon target) | Mac mini M-series. Unified memory governs how big a model fits.       |
| Linux    | first-class           | Tested on recent Ubuntu/Fedora with NVIDIA or AMD GPUs.               |
| Windows  | first-class (current dev box) | RTX 4080 (16 GB VRAM) tested. Use PowerShell or any POSIX shell (Git Bash, WSL). |

Avoid baking absolute paths into specs, scripts, or commits — use repo-relative paths so the same instructions work on every host.

## Prereqs

- **Node 22.5+** (uses the built-in `node:sqlite`; on Node 24+ the `ExperimentalWarning` goes away).
- **An OpenAI-compatible LLM server, running locally.** Default config points at LM Studio.
  - **LM Studio** *(default)* — load `qwen3.6-27b-uncensored-hauhaucs-balanced` (or any vision + tool-call capable model), enable the local server on port 1234, that's it. Defaults match.
  - **Ollama** — `ollama pull qwen3.6:27b` (or your preferred model), then set `LLM_BASE_URL=http://127.0.0.1:11434/v1` and `LLM_MODEL=<name>` in `server/.env`.
  - **vLLM, SGLang, llama.cpp server, etc.** — point `LLM_BASE_URL` at their `/v1` endpoint.
- **Playwright Chromium** — installs on first server boot, or run `npx playwright install chromium` once up front.

### Hardware notes

The agent sends a screenshot on every tool result, so the LLM needs vision. The model also needs native tool-calling. A 27B-class model (e.g. qwen3.6-27b in 4-bit) is the sweet spot for both quality and latency on prosumer hardware.

| Machine                          | What fits comfortably                                |
|----------------------------------|------------------------------------------------------|
| RTX 4080 (16 GB VRAM)            | qwen3.6-27b at Q3_K_M / Q4_K_S; partial offload at Q4_K_M. Watch context — large windows eat VRAM fast. |
| **Mac mini M-series, 16 GB unified (baseline)** | **Don't run inference here.** macOS + Chromium leave ~6–8 GB free; a 27B at any quant won't fit. Use remote inference (below) instead. |
| Mac mini M-series, 24 GB unified | qwen3.6-27b at Q4_K_M is fine; leave headroom for the OS and Chromium. |
| Mac mini M-series, 36 GB+        | Q5/Q6 quants of 27B work; don't push higher unless you have benchmarks saying it helps. |
| Linux box with 24 GB+ VRAM       | Same as above; vLLM is faster than Ollama if you can set it up. |

If the model is unloading layers to RAM the agent feels sluggish but still works. If you're swapping to disk, drop a quant.

### Remote inference (recommended for 16 GB Mac mini)

When the host running tickle can't fit the model, point `LLM_BASE_URL` at another machine on the LAN. The agent + UI + persistent Chromium profile stay on the mini; the model runs on whichever box has the GPU.

**On the inference host** (the box with the GPU — e.g. your Windows / Linux desktop):

1. Open LM Studio → Developer tab → Settings → tick **"Serve on local network"**. (Ollama: set `OLLAMA_HOST=0.0.0.0:11434` before starting `ollama serve`.)
2. Note the host's LAN IP (`ipconfig` on Windows, `ifconfig` / `ip a` on macOS / Linux). Static-leases the address in your router if you don't want it changing.
3. Allow the port through the firewall (1234 for LM Studio, 11434 for Ollama). Restrict to LAN — never expose to the internet.

**On the tickle host** (the Mac mini, in this case), set in `server/.env`:

```bash
LLM_BASE_URL=http://192.168.x.y:1234/v1   # or :11434/v1 for Ollama
LLM_MODEL=qwen3.6-27b-uncensored-hauhaucs-balanced
```

That's it. The agent is screenshot-heavy, so latency-per-token matters more than absolute throughput; Gigabit LAN is plenty.

A few practical notes:

- **Wake / sleep:** if the inference host sleeps, the agent will hang on the next LLM call until you wake it. Prevent sleep on the inference host (`caffeinate -d` on macOS, or the Power Options "high performance" profile on Windows).
- **The persistent browser profile lives on the mini**, not the inference host. Login state, cookies, passkeys are all stored in `server/data/profile/` on the machine running tickle. The model has no opinions about the browser session — it just sees screenshots and labelled element lists.
- **`LLM_PROVIDER=anthropic`** is also a valid escape hatch if you don't want to keep a second box on. See `server/.env.example` for the keys.

## Run

First-time install (root + server + web in one shot):

```bash
npm run install:all
npx playwright install chromium
```

Then start both processes in one terminal:

```bash
npm run dev
```

Output is interleaved with `[server]` (blue) and `[web]` (magenta) prefixes; Ctrl+C kills both. If one crashes, the other gets shut down too.

Open <http://localhost:5173>, create a task, hit Run.

Need just one of them?

```bash
npm run dev:server   # only the Fastify backend
npm run dev:web      # only Vite
```

## Configuration

Copy `server/.env.example` to `server/.env` and edit. The defaults match LM Studio at `http://127.0.0.1:1234/v1`. The full list of variables is documented inline in `server/.env.example`.

## Persistent browser profile

The agent uses one Chromium profile under `server/data/profile/`. Cookies, localStorage, IndexedDB, and saved-credential state survive between runs and across server restarts. To start fresh: stop the server, delete that folder, restart.

`server/data/` is **gitignored**. Do not commit it. Do not ship it. It contains your real session state.

## Pause / Resume / Stop

While a run is active you can:

- **Pause** — agent finishes its current tool, then waits. The browser is still open and yours; click around, log in, fix something. The agent doesn't fight you.
- **Resume** — agent continues from where it stopped. It'll see the post-intervention page on its next screenshot/read.
- **Stop** — aborts the in-flight LLM request and ends the run.

Pause is the right move for "I need to log in once" — pause, log in manually in the headed window, resume.

**Auto-pause on login**: after every tool call, the agent checks the page for login indicators (visible password input, passkey/webauthn fields, "Use your passkey" text, or known SSO hosts: Google, Microsoft, Okta, Auth0, Apple, GitHub, LinkedIn, X, Facebook). If detected, the run pauses on its own and the UI shows an amber banner explaining why. This fires once per run — if you Resume and it triggers again later, it won't re-pause; you can still pause manually.

## Tracing

Every run writes a structured JSONL trace to `server/data/tickle.log` (rotated to `tickle.log.1` at 5 MB). Events: `run.start`, `llm.request`, `llm.response`, `tool.call`, `tool.result`, `run.cancel_requested`, `run.cancelled`, `run.done`, `run.error`, `run.end`.

Tail it live:

```bash
# macOS / Linux / Git Bash / WSL
tail -f server/data/tickle.log
```

```powershell
# Windows PowerShell
Get-Content -Wait .\server\data\tickle.log
```

The same lines also stream to the dev terminal in compact form.

## How the agent decides what to click

The agent uses a **snapshot → act** loop, not hand-written CSS selectors:

1. `snapshot()` walks the DOM, finds every visible interactive element (buttons, links, tabs, inputs, anything with a clickable role), tags each with `data-tickle-id`, and returns a labeled list to the model:
    ```
    [0] tab "Projects" (selected)
    [1] tab "Qualifications"
    [3] textbox "Search"
    [12] link "Buy now"
    ```
   Plus a screenshot taken at the same moment.
2. `act(id, action, value?)` performs the action on the element with that id. Actions: `click`, `fill`, `press`, `check`, `uncheck`, `hover`, `select_option`.

After every `navigate` or `act`, a fresh snapshot is automatically attached to the tool result, so the model always sees the post-action page structure without asking. IDs change between snapshots — the model is told to always use the latest list.

This avoids hard-coding "tabs are role=tab" / "this site uses h2 for headings" / etc. in the prompt — the model sees what's actually there and picks. If page structure changes, the snapshot reflects it.

## Layout

- `server/` — Fastify + Playwright + OpenAI-compatible LLM client + SQLite (tasks/runs/steps persist)
- `web/` — Vite + React + Tailwind UI
- `docs/specs/` — module-by-module contracts. Source of truth for what each part does and how it's tested. See [`docs/specs/README.md`](docs/specs/README.md).
- `.claude/` — workflow assets (slash commands, subagents, skills) for spec-driven + TDD work in Claude Code.

## Working on the code

This project follows **spec-driven + test-driven development**. The short version:

1. Find or write the spec at `docs/specs/<module>.md` for what you're changing.
2. Write a failing test that maps to a claim in the spec.
3. Make the smallest change that turns it green.
4. Refactor with the safety net.

Useful slash commands inside Claude Code: `/spec <module>` (author/update a spec), `/tdd <module>` (drive a red→green→refactor cycle), `/refactor-module <path>` (break up a god file once it has a spec and tests).

Architecture target — server is layered N-tier (`domain → application → infrastructure → interface`), web is feature-folder (`domain → state → ui → features`). Full rules in [`docs/specs/_LAYERS.md`](docs/specs/_LAYERS.md).

## Why no Docker

Playwright's browser layers are ~2 GB, the LLM server runs on the host (often with the GPU), and a single-user local tool gets nothing from a containerized backend except a `host.docker.internal` hop. Tickle is meant to live on the same machine as your browser and your model — that's the whole point. If a future use case wants Docker, add it then.

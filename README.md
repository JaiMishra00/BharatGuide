# Guided Government-Services Assistant

A desktop browser assistant that helps first-time users navigate **Election Commission of India (ECI) voter-registration** procedures on the real government portals.

It answers **only from official documents**, shows its **sources**, and points at the right button with a **ghost cursor**. The user always does the clicking and typing themselves.

> Status: working prototype (English only, text only, desktop only). See [Challenges faced](#9-challenges-faced) and [Limitations](#10-limitations-and-roadmap) for what is not built yet.

---

## Contents

1. [The problem](#1-the-problem)
2. [Our solution](#2-our-solution)
3. [Architecture](#3-architecture)
4. [Tech stack](#4-tech-stack)
5. [Repository layout](#5-repository-layout)
6. [Setup](#6-setup)
7. [Testing](#7-testing)
8. [How Cline was used in the build](#8-how-cline-was-used-in-the-build)
9. [Challenges faced](#9-challenges-faced)
10. [Limitations and roadmap](#10-limitations-and-roadmap)

---

## 1. The problem

Many first-time applicants need to register as a voter or correct a voter-registration record but do not know the process:

- **They do not know which form to use.** Voter services alone involve Form 6 (new voter), 6A (overseas), 6B (Aadhaar linking), 7 (objection or deletion) and 8 (shifting, correction, replacement EPIC).
- **They do not know what to bring.** Forms such as Form 6 specify age-proof and address-proof requirements.
- **The portals are hard to navigate.** Multi-step flows can make the right button difficult to find.
- **Generic chatbots are unsafe here.** A model that invents a form number, a fee or a document list can get an application rejected. Answers must come from official text and be traceable to it.
- **Text advice alone is not enough.** Knowing "use Form 6" does not help someone who cannot find where to start on the portal.
- **The data is sensitive.** These flows involve Aadhaar and EPIC numbers, OTPs, phone numbers and dates of birth. An AI helper must never ask for, store or type them.

## 2. Our solution

A small Electron browser with three parts working together:

| Pillar | What it does |
| --- | --- |
| **Grounded answers** | A RAG service searches the currently indexed official ECI voter-registration documents in Qdrant. Every factual reply carries source ids and a citation chip: organisation, document title, section, pages, publication date and a link. If nothing relevant is found, it **abstains** and shows the official helpline instead of guessing. |
| **Guidance, not automation** | A transparent **ghost cursor** flies to the right element and shows a one-line hint, then waits for the user. Clicks and scrolls happen only when the user asks for them. |
| **Safety enforced in code** | Guardrails run in the program, not in the prompt, so the model cannot talk its way past them (see [3.4](#34-safety-guarantees-enforced-in-code)). |

**What it will do**

- Explain which form to use and what documents are needed, citing the official source.
- Open the official portal (from an allowlist) and point at the next element to use.
- Wait for the user to act, then guide the next step.
- Run a user-requested search (`search for <title>`) in the page's search box.

**What it will never do**

- Move or capture the user's real mouse or keyboard.
- Ask for, repeat or type Aadhaar/EPIC numbers, OTPs, passwords, phone numbers or dates of birth.
- Click login, OTP, payment, Aadhaar or EPIC fields. It points and asks the user to act.
- Answer about parties, candidates, election predictions or legal disputes.
- Open a site outside the allowlist.

**Example: "I just turned 18. Help me register as a new voter."**
The agent looks up the official text, answers that new voters apply with **Form 6**, lists the relevant requirements from the form, shows the source chip, opens the ECI voters portal and points at where to start. It then waits for the user, who does the clicking and typing. Type `/demo-register` in the chat to run a scripted version of this flow, which goes through the same guarded executor as the live model.

---

## 3. Architecture

### 3.1 System overview

Two processes talk over local HTTP. The Electron **shell** holds the UI, the agent and the browser control. The Python **RAG service** holds the embedding model and the vector store client. Secrets stay on the server side.

```text
                       ┌──────────────────────── Electron shell (shell/) ────────────────────────┐
                       │                                                                         │
  user ── chat ──────► │  Chat panel (React)      Toolbar view (tabs, address bar)               │
                       │        │ IPC                     │ IPC                                  │
                       │        ▼                         ▼                                      │
                       │  ┌─────────────────────────  Agent core  ───────────────────────────┐  │
                       │  │ redact → classify intent (code) → Planner → guarded tool executor │  │
                       │  │ state machine · typing grant · run caps · kill switch (Esc Esc)   │  │
                       │  └──────┬───────────────┬──────────────────────┬─────────────────────┘  │
                       │         │               │                      │                        │
                       │   Cline SDK        Ghost overlay          CDP bridge                    │
                       │   planner          (transparent,          (webContents.debugger,        │
                       │   (LLM tool        click-through,         snapshot / click /            │
                       │   calling)         always on top)         scroll / guarded type)        │
                       └─────────┼───────────────────────────────────────┼───────────────────────┘
                                 │ search_docs                           ▼
                                 │ (Bearer token)                  Government portal tabs
                                 ▼                                 (voters.eci.gov.in, uidai.gov.in …)
                       ┌──────── RAG service (rag/, FastAPI, 127.0.0.1:8008) ────────┐
                       │ redact → form-id hint → embed (BGE-M3) → hybrid RRF →       │
                       │ abstain check → citations                                    │
                       └───────────────────────────────┬──────────────────────────────┘
                                                       ▼
                                             Qdrant (dense + sparse vectors,
                                             payload: org, source_url, section_path …)
```

### 3.2 Request flow

1. The user types a message in the chat panel.
2. **Redaction.** Aadhaar-like, EPIC-like, mobile and email patterns become `[REDACTED]` before display, logs, the planner or RAG ever see them.
3. **Intent check in code.** A message such as `search for <title>` creates a single-use **TypingGrant**. Anything else is guidance. The planner can never create a grant.
4. The **planner** (Cline SDK `Agent`) receives the message plus a fresh context block (current page, open tabs, grant, short history) and may call only the registered tools.
5. Every tool call goes through one guarded executor: call-cap check, state check, schema validation, then the tool's own guardrails.
6. **`search_docs`** calls the RAG service. The reply comes back as `<source id="S1" …>` blocks that are treated as data, never as instructions.
7. **Fact check.** Any reply that mentions a form id, an amount, a duration or a quoted name must cite source ids, and each of those items must literally appear in the cited text. Otherwise the reply is rejected and the model retries.
8. For guidance steps, the ghost cursor **telegraphs**: it flies to the element, pulses, shows a hint and pauses about 400 ms. Then the agent waits for the user to act (`wait_for_user`).
9. The run ends with `finish`, or is halted by a cap, the kill switch, or loss of the overlay.

### 3.3 Components

| Component | Location | Role |
| --- | --- | --- |
| Main process | `shell/src/main/` | Boot, windows, tabs, config, logging. Holds the RAG service token. |
| Agent core | `shell/src/agent/core.ts` | Owns the state machine, TypingGrant, kill switch, run caps and halted card. |
| Planner | `shell/src/agent/clinePlanner.ts` | Cline SDK agent loop. A plain tool-calling loop (`fallbackPlanner.ts`) sits behind the same `Planner` interface. |
| Tools | `shell/src/agent/tools/` | The only actions a planner can take (table below). |
| Executor | `shell/src/agent/executor.ts` | Single choke point for every tool call. |
| Grounding | `shell/src/agent/grounding.ts` | Checks that facts in a reply appear in the cited sources. |
| Allowlist | `shell/src/agent/allowlist.ts` | https-only host allowlist for navigation. |
| CDP bridge | `shell/src/bridge/` | Page snapshot, click, scroll and guarded typing through `webContents.debugger`. |
| Ghost overlay | `shell/src/main/overlayWindow.ts`, `shell/src/renderer/ghost/` | Transparent click-through always-on-top window with a heartbeat. |
| Chat panel | `shell/src/renderer/chat/` | React UI: messages, source chips, abstain and halted cards, "Last verified" date. |
| RAG service | `rag/service/app.py` | `POST /v1/search` (token + rate limit) and `GET /healthz`. |
| Retrieval | `rag/retrieval.py` | Redact, out-of-scope check, form hint, dense search, abstain and citation building. |
| Ingestion | `rag/ingest.py` and friends | Inventory, parse, chunk, embed, upsert (idempotent). |

**Planner tools** (`shell/src/agent/tools/index.ts`):

| Tool | Purpose | Restriction |
| --- | --- | --- |
| `search_docs` | Look up official ECI/UIDAI text | At most 3 calls per user message |
| `reply` | The only way to show text to the user | Passes the grounding and personal-data checks |
| `point_at` | Ghost flies to an element and shows a hint | Overlay only |
| `click` | Click one element through CDP | Only if the user asked; refused on sensitive fields |
| `scroll` | Scroll the page | Only if the user asked |
| `open_tab`, `switch_tab`, `navigate` | Move between pages | `open_tab` is capped at 6 tabs; `switch_tab` does no URL check; navigation is https-only and host-allowlisted |
| `type_in_search`, `press_enter` | Fill and submit a search box | Only in `RunningCommand`, with a matching TypingGrant |
| `wait_for_user` | Pause until the user acts | Times out, then asks the user |
| `finish` | End the task | Drops any unused grant |

**Agent states** (`stateMachine.ts`): `Idle`, `Guiding`, `AwaitingUser`, `RunningCommand`, `Halted`.

### 3.4 Safety guarantees enforced in code

| Guarantee | Where |
| --- | --- |
| The user's real cursor and keyboard are never driven. Input goes through CDP inside the app, with no OS-level input and no remote-debugging port. | `shell/src/bridge/cdp.ts` |
| The ghost is always visible during a task. A heartbeat pings the overlay every 2 s and the task halts if it stops answering. If the user simply switches to another app, the agent **pauses** rather than halts. | `overlayWindow.ts`, `guardrails.ts` |
| Typing needs a single-use grant created only from the user's own `search for <title>` message. The text must equal the granted title, and the grant expires. | `intent.ts`, `typingGrant.ts` |
| Every click is telegraphed: move, pulse, hint, then about 400 ms before the action. | `guardrails.ts` |
| Esc pressed twice within 800 ms cancels the task and drops the grant. A Stop button does the same. | `core.ts` |
| Hard caps: 14 planner iterations, 12 tool calls, 90 s run time, and a halt after 3 consecutive rejected calls. | `planner.ts`, `executor.ts` |
| Sensitive fields (password, OTP, Aadhaar, EPIC, card, PIN) are refused for click and type; the agent points and asks the user to do it. | `shell/src/bridge/sensitive.ts` |
| Navigation is https-only and limited to ECI, UIDAI, Google and YouTube hosts, plus hosts of source URLs returned during the session. | `allowlist.ts` |
| Text that asks the user for personal identifiers is blocked before it is shown. | `guardrails.ts` |
| In retrieved text, only `<source` and `<page` are neutralised. Page and tab text is redacted, not escaped. | `searchDocs.ts`, `planner.ts` |
| Renderers are sandboxed and context-isolated with their own minimal preload. Secrets live only in the main process and the RAG service. | `views.ts`, `config.ts` |

### 3.5 RAG pipeline

**Ingestion** (`python -m rag.ingest`):

1. `sources.yaml` lists the files included by the `rag.ingest` path, with `doc_id`, `org`, `title`, `doc_type`, `source_url`, `publication_date`, `version` and `status`. It does not describe every file in the repository or the live Qdrant index. Files not listed are **excluded from that ingestion path**.
2. PDFs are parsed with PyMuPDF and cleaned.
3. **Structure-aware chunking**: split at headings, numbered clauses and FAQ questions. Tables stay in one piece and lettered sub-clauses stay with their clause. Target about 350 tokens, hard maximum 512 tokens, with about 50 tokens of overlap only when a long unit has to be cut.
4. Each chunk carries payload fields including `org`, `doc_title`, `doc_type`, `section_path`, `pages`, `form_ids`, `topic_tags`, `ui_labels`, `publication_date`, `version`, `status`, `source_url`, `retrieved_at`, `doc_sha256`, `doc_id`, `page_start`, `page_end`, `chunk_index` and `token_count`.
5. An embedding header (organisation, title, section path) is prepended **for embedding only**.
6. The live index uses `bge-small-en-v1.5` dense embeddings (384 dimensions) plus a BM25 sparse vector. The service currently searches dense-only and ignores the sparse vector. BGE-M3 remains the code's configurable default, not the model used by the live index.
7. **Idempotent**: point ids derive from `doc_id`, file hash and chunk index. An unchanged file is skipped and a changed file replaces its old points.

**Retrieval** (`rag/retrieval.py`):

1. Redact the query, then normalise it.
2. Check the query against the **out-of-scope list** (parties, candidates, predictions, legal advice); abstain with reason `out_of_scope` if it matches.
3. Detect a form hint such as "Form 6B" and, if found, search with a `form_ids` filter first.
4. Embed the query with the configured model and search the dense vector. The live service currently ignores the collection's BM25 sparse vector; it does not perform hybrid RRF search.
5. **Abstain** if the best dense cosine score is below `ABSTAIN_THRESHOLD` (default 0.45), with reason `no_relevant_source`. The reply then carries the relevant official helpline.
6. Drop documents with unknown provenance, then build a citation for each hit.

**Service**: `POST /v1/search` needs a Bearer token and is rate limited per IP; `GET /healthz` reports model load state and point count. Logs record latency, abstain flag and document ids, **never the raw query**.

---

## 4. Tech stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Desktop shell | **Electron 38** (Node 22), `electron-vite` 5, **TypeScript** 5.9 | Three sandboxed renderers (chat, toolbar, ghost overlay) with one minimal preload each |
| UI | **React 19**, `react-markdown` | Chat panel with source chips, abstain and halted cards |
| Agent loop | **Cline SDK** (`@cline/sdk` 0.0.92) | Tool-calling runtime. Only our own tools are registered |
| LLM (planner) | **Gemma 4, 12B parameters** (`gemma4:12b`), run locally through **Ollama**. Any OpenAI-compatible endpoint can be swapped in, for example the hosted Cline API (`https://api.cline.bot/api/v1`) | `PLANNER=ollama` (default) or `hosted` in `.env` |
| Tool schemas | **Zod** 4 | Every tool call is validated before it runs |
| Browser control | **Chrome DevTools Protocol** through Electron's `webContents.debugger` | No OS-level input, no remote-debugging port |
| RAG service | **Python**, **FastAPI**, **uvicorn**, **Pydantic** | `POST /v1/search`, `GET /healthz` |
| Embeddings | Live index: **`bge-small-en-v1.5`** (384-d dense) plus a BM25 sparse vector | The service currently searches dense-only and ignores the sparse vector. **BGE-M3** is the code's configurable default, not the live model. |
| Vector database | **Qdrant** (Docker or Qdrant Cloud), `qdrant-client` | Live collection: `eci_docs_small` (189 points) |
| Document parsing | **PyMuPDF**, **PyYAML** | Provenance is declared in `sources.yaml` |
| Tests | **Vitest** (shell), **pytest** (RAG), Node test runner (Cline SDK sandbox) | See [Testing](#7-testing) |

**Live indexed corpus (`eci_docs_small`, 189 points):**

| Organisation | Documents actually indexed |
| --- | --- |
| ECI | Forms 6, 6A, 7 and 8 (guidelines and application forms); Declaration Form; Representation of the People Act, 1950; Registration of Electors Rules; Voter Guide |

No UIDAI documents are in the live index. `sources.yaml` and the 12-PDF corpus belong to the `rag.ingest` path; that ingestion path has not been run against the live index. The Aadhaar Handbook is superseded and is filtered out by default.

---

## 5. Repository layout

```text
shell/                 The product: Electron app (TypeScript, React)
  src/main/              Boot, windows, tab manager, overlay window, config, logger
  src/agent/             Agent core, planners, executor, guardrails, grounding, allowlist
  src/agent/tools/       The 12 tools a planner may call
  src/bridge/            CDP bridge, page snapshot and listener scripts, sensitive-field rules
  src/rag/               RAG client and the redaction mirror (kept in sync with Python)
  src/renderer/          chat/, toolbar/ and ghost/ renderer pages
  src/shared/            Typed IPC contract and page types
  tests/                 Vitest suites
rag/                   Python RAG pipeline and service
  service/               FastAPI app (python -m rag.service)
  ingest.py chunk.py parse.py clean.py metadata.py embed.py store.py retrieval.py
  redact.py doc_meta.py doc_meta.yaml eval.py inventory.py
sources/               The 12 source PDFs (plus one duplicate)
sources.yaml           Hand-written provenance for every source file
tests/                 Python tests and gold.jsonl (20 evaluation queries)
cline-sdk-sandbox/     Isolated harness for testing Cline SDK tool calling
docs/cline-spike.md    Result of the Cline SDK feasibility spike
docker-compose.yml     Local Qdrant
.env.example           All configuration, documented
legacy/, src/, package.json, dist/   The earlier "ghost cursor v0" prototype (see note)
```

> **Note on the root `package.json`, `src/` and `dist/`:** these belong to the first prototype (ghost cursor v0), which launched its own Chrome and drove it through puppeteer. It is superseded by `shell/`. Documentation for it is kept in `legacy/ghost-cursor-v0/`.

---

## 6. Setup

You need **Docker** (or a Qdrant Cloud cluster), **Node.js 22 or newer**, a compatible Python environment and a **planner model**. Python 3.12 is an assumption, not a verified repository requirement. The first run downloads the configured embedding model, and `pip install` pulls PyTorch.

> These steps come from the repository's manifests, scripts and `.env.example`. The shell was developed on Windows; macOS and Linux should work but have not been verified.

### 6.1 Get the code

```bash
git clone git@github.com:JaiMishra00/BharatGuide.git
cd BharatGuide
git switch master
```

### 6.2 Configure

```bash
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
```

One `.env` at the repository root is read by both the shell and the RAG service. `.env.example` is not a complete inventory of runtime configuration: variables used by the code but missing from it include `PAYLOAD_FILTERS`, `FILTER_ACTIVE_ONLY`, `FORM_ID_FILTER`, `PLANNER_REASONING` and `PLANNER_PROVIDER_ID`, among others. The settings relevant to the live index include:

| Variable | Meaning |
| --- | --- |
| `QDRANT_URL`, `QDRANT_API_KEY` | `http://localhost:6333` with no key for local Docker, or your Qdrant Cloud URL and key |
| `QDRANT_COLLECTION` | Live index: `eci_docs_small` |
| `EMBED_MODEL` | Live index: `BAAI/bge-small-en-v1.5`; code's configurable default is BGE-M3 | 
| `PAYLOAD_FILTERS` | Set to `0` for the live index |
| `FILTER_ACTIVE_ONLY` | Set to `0` for the live index |
| `FORM_ID_FILTER` | Runtime form-ID filtering configuration; not listed in `.env.example` |
| `PLANNER_REASONING` | Planner reasoning configuration; not listed in `.env.example` |
| `PLANNER_PROVIDER_ID` | Planner provider configuration; not listed in `.env.example` |
| `ABSTAIN_THRESHOLD` | Minimum dense cosine score to answer (default `0.45`) |
| `SERVICE_TOKEN` | Shared secret between the shell and the RAG service. **Change it** from `change-me-dev-token` |
| `PLANNER` | `ollama` (local) or `hosted` |
| `PLANNER_URL`, `PLANNER_MODEL`, `PLANNER_API_KEY` | Model endpoint, model name and key for `hosted` |
| `ALLOWED_HOSTS` | Comma-separated hosts the agent may open |
| `START_URL` | First page opened (default `https://voters.eci.gov.in/`) |
| `HOTKEY` | Focus the chat input (default `Ctrl+Shift+Space`) |

Never commit `.env`; it is gitignored. The helpline numbers in `.env.example` should be checked against the official sites before a public demo.

### 6.3 Start Qdrant

```bash
docker compose up -d          # Qdrant 1.15.4 on http://localhost:6333, data in ./qdrant_data
```

To use Qdrant Cloud instead, set `QDRANT_URL` and `QDRANT_API_KEY` in `.env` and skip this step.

### 6.4 Start the RAG service

```bash
python -m venv .venv
source .venv/bin/activate                  # Windows: .venv\Scripts\activate
pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt

python -m rag.ingest                       # parse, chunk, embed and upsert the 12 PDFs (idempotent)
python -m rag.service                      # http://127.0.0.1:8008
```

`python -m rag.ingest --dry-run` stops after chunking and writes to `./work/` without touching Qdrant. Check the service:

```bash
curl http://127.0.0.1:8008/healthz
```

`ok` is `true` once the model is loaded, Qdrant is reachable and the collection has points. While the model loads, `warming_up` is `true` and searches return 503.

**Live index configuration.** Set `QDRANT_COLLECTION=eci_docs_small`, `PAYLOAD_FILTERS=0` and `FILTER_ACTIVE_ONLY=0`. The live collection has 189 points and uses 384-dimensional `bge-small-en-v1.5` dense vectors plus a BM25 sparse vector; the current service search is dense-only and ignores the sparse vector. `rag/doc_meta.yaml` can supply `org`, `title`, `source_url` and `publication_date` for collections whose payload lacks them. For a collection with no `org`, `doc_type` or `status` fields, set `PAYLOAD_FILTERS=0` and `FILTER_ACTIVE_ONLY=0` (Qdrant returns `400 Index required` when filtering on an unindexed field). The embedding model **must match** the one that built the collection, including its dimension (1024 for BGE-M3, 384 for bge-small). A mismatch returns poor results or an error.

### 6.5 Choose a planner model

**Local (default): Gemma 4, 12B parameters.** The project runs **Gemma 4 12B** (`PLANNER_MODEL=gemma4:12b`) locally through [Ollama](https://ollama.com). Install Ollama, pull the model (`ollama pull gemma4:12b`) and leave `PLANNER=ollama`. The shell talks to `http://127.0.0.1:11434/v1` with the model's thinking pass turned off, which cuts a step from about 20 s to about 1 s. A 12B-parameter model needs a reasonably capable machine (plenty of RAM, ideally a GPU).

**Hosted.**

```ini
PLANNER=hosted
PLANNER_URL=https://api.cline.bot/api/v1
PLANNER_MODEL=anthropic/claude-sonnet-4-6
PLANNER_API_KEY=<your Cline API key>
```

Any OpenAI-compatible endpoint that supports tool calling works. Setting `PLANNER_IMPL=fallback` swaps the Cline SDK loop for a plain tool-calling loop behind the same interface.

### 6.6 Run the app

```bash
cd shell
npm install
npm run dev
```

The window opens on the ECI voters portal with a toolbar on top, the page below, and a floating assistant panel at the top right.

| Action | How |
| --- | --- |
| Ask a question | Type in the panel, for example `Which documents do I need for Form 6?` |
| Focus the chat input | `Ctrl+Shift+Space` |
| Stop the agent | `Esc` twice quickly, or the Stop button |
| Run the scripted register-a-new-voter demo | Type `/demo-register` in the chat. The app also accepts a `--demo=register` launch flag; passing it through `electron-vite dev` has not been verified |
| Run the ghost-cursor showcase | Type `/demo` |
| Build a production bundle | `npm run build`, then `npm start` |

---

## 7. Testing

Run each command block from the repository root. Each `cd` below applies only within its own command block; do not assume a directory change carries across separate shells.

```bash
# Shell: guardrails, grounding, tools, flows (Vitest, no network needed)
cd shell && npm test
cd shell && npm run typecheck
```

```bash
# RAG: chunking and redaction run offline; live retrieval tests skip themselves
# when Qdrant is unreachable
pytest tests
```

```bash
# Retrieval quality against the 20-query gold set (needs Qdrant and an ingested corpus)
python -m rag.eval --sweep
```

```bash
# Cline SDK tool-calling harness (offline layers; live layer needs CLINE_SDK_LIVE=1)
cd cline-sdk-sandbox && npm install && npm run test:offline
```

| Suite | Covers |
| --- | --- |
| `shell/tests/safety.test.ts` | Injection handling, redaction, the three-rejection cap, Esc-Esc kill switch and overlay rule; it does not cover every cap |
| `shell/tests/grounding.test.ts` | Facts in a reply must appear in the cited sources |
| `shell/tests/tools.test.ts` | Each tool's checks and refusals |
| `shell/tests/flows.test.ts`, `voterId*.test.ts`, `registerDemo.test.ts` | End-to-end task flows against a fake browser and portal |
| `tests/test_chunking.py` | Structure-aware chunking, 512-token limit, stable point ids |
| `tests/test_redaction.py` | Aadhaar, EPIC, mobile and email redaction |
| `tests/test_retrieval.py` | Form hints, out-of-scope abstain, helpline routing, idempotent re-ingest, token required |
| `tests/gold.jsonl` | 20 queries (5 must abstain) used by `rag.eval`. Targets: recall@5 of at least 0.85, at least 4 of 5 abstains correct, retrieval p95 under 1.5 s |

---

## 8. How Cline was used in the build

Cline appears in this project in three ways: as the **runtime** of the product's agent, as a **test harness** for that runtime, and as the **coding agent** that helped build it.

### 8.1 Cline SDK as the agent runtime (in the product)

The planner that decides which tool to call is the **Cline SDK** (`@cline/sdk` 0.0.92), in `shell/src/agent/clinePlanner.ts`.

- **Only our tools are registered.** The SDK `Agent` has no shell, file, browser or MCP tools of its own, so it can call nothing we did not pass in. Each of our 12 tools is registered with `createTool`, its Zod schema converted to JSON Schema, and `finish` is marked `completesRun` so a run ends cleanly.
- **The SDK owns the loop, not the safety.** Every `execute()` hands off to the guarded executor (state check, caps, schema validation, tool guardrails). The SDK's events (`tool-started`, `run-failed`, `assistant-text-delta`) are used for logging, and free model text is shown only if it passes the same grounding and personal-data checks.
- **Abort wiring.** `agent.abort()` is connected to Esc-Esc, the Stop button, loss of the overlay, the run caps and a tool's `stop` result.
- **One interface, two implementations.** `Planner` has a Cline SDK implementation and a plain OpenAI-compatible tool-calling loop (`fallbackPlanner.ts`). `PLANNER_IMPL=fallback` switches between them without touching any tool.
- **Gemma 4 12B by default, any OpenAI-compatible model if needed.** The SDK is pointed at local Ollama serving `gemma4:12b`, or at a hosted endpoint such as the Cline API (`PLANNER=hosted`). For Ollama the shell hands the SDK a pre-built model that disables the thinking pass (`fastModel.ts`). The measurements recorded in that file's header comment are about 0.8 s for a short reply with thinking off, against 17 to 23 s per step by default.

### 8.2 A feasibility spike and a test sandbox

Before building on the SDK the team checked it against six requirements. The result is in [`docs/cline-spike.md`](docs/cline-spike.md): the SDK runs from Node (not only the CLI), calls custom tools and returns results, exposes no built-in tools, emits the events we need, loads inside the Electron main process (Electron 38 provides Node 22) and can be aborted. The decision recorded there is **Cline SDK kept as the planner**, with the fallback loop behind the same interface.

[`cline-sdk-sandbox/`](cline-sdk-sandbox/README.md) is an isolated harness that tests tool calling in five layers so that failures can be told apart:

| Layer | Needs a model? | Question it answers |
| --- | --- | --- |
| Tool isolation | no | Does `execute()` do the right thing and is the schema right? |
| Cline wiring | no (stub server) | Do URL, key and model id produce the documented Cline request? |
| Agent loop, offline | no (stub server) | Does the SDK advertise a tool, parse the call, run it and feed the result back? |
| Real model | yes (opt-in) | Does the model choose the right tool with valid arguments? |
| Event discovery | yes | Which event type strings does this SDK version emit? |

The sandbox also records why the SDK cannot be `require()`d from the older CommonJS prototype: the package is ESM-only and declares Node 22 or newer. That finding is why the shell bundles the SDK as an external and loads it with a native dynamic `import()`.

### 8.3 Cline as the coding agent (how the code was written)

- **Spec-driven development (not verifiable from this branch).** The claim that the project followed a written technical spec with numbered milestones and exit checks cannot be verified from this branch; the spec itself is not stored in this repository.
- **Commit history (not verifiable from this branch).** The claimed `master`/`argo_rag` development history cannot be verified from this branch.
- **Tests alongside the code.** The Vitest suites, the Python tests and the 20-query gold set are present in the repository.
- **Live index configuration.** The service can be configured to read `eci_docs_small` through `rag/doc_meta.yaml` and `PAYLOAD_FILTERS=0`; this describes configuration, not proof that `rag.ingest` populated the live index.

> **Team note:** the points above are what the repository itself shows. Add anything only the team knows, such as which Cline surface or model was used, how tasks were prompted, and where the agent's output needed correcting.

---

## 9. Challenges faced

### 9.1 Implementing the ghost cursor and pointing at the right button

The hardest part of the product was making the ghost land on **exactly the element the user needs**, on a real government site, every time. A cursor that is a few pixels off, or points at the wrong button, is worse than no cursor at all. The difficulty came from several places:

- **Three coordinate spaces.** The ghost is drawn in its own overlay window, the page lives in a separate web view with its own origin, and the model only ever sees element ids and names. The shell has to turn "element `e12` on the page" into a position in the overlay. It does this by taking the element's rectangle from the page, adding the page view's origin, and using overlay-local CSS pixels throughout (`pageOrigin()` in `tabManager.ts`). The overlay window's bounds are kept equal to the main window's content bounds, so the two stay aligned when the window moves or resizes (`syncBounds()` in `overlayWindow.ts`).
- **The model does not see pixels.** To avoid asking a language model to guess coordinates, a script in the page collects the interactive elements (links, buttons, inputs, tabs, menu items and headings), each with a stable id, a role, an accessible name and a bounding box. The model picks an **id**, and the code computes the position. Hidden elements (`display: none`, `visibility: hidden`, near-zero opacity) are filtered out.
- **Elements that are not on screen.** If the target is below or above the visible area, the ghost does not guess. It points to the edge of the page with a "Scroll down" or "Scroll up" hint and never clicks (`point_at` in `shell/src/agent/tools/pointAt.ts`).
- **Targets outside the page.** The address bar, tabs and back button belong to the app's own toolbar, not to the page. The toolbar reports the rectangle of each of its controls so that the ghost can point at them too (`toolbarRect()`).
- **Sensitive fields.** Login, OTP, Aadhaar, EPIC, card and PIN fields must never be clicked or typed into. The ghost still points at them, adds "please do this yourself", and the click tool refuses them in code (`shell/src/bridge/sensitive.ts`).
- **Telegraphing every action.** Before any click the ghost flies to the target (300 to 900 ms depending on distance), pulses, shows the hint and pauses about 400 ms, so the user always sees what is about to happen.
- **Staying visible and in control.** The overlay has to stay on top and click-through, so that the user's real mouse is never touched. A heartbeat checks it every 2 seconds. If the overlay stops answering, the task halts. If the user simply switches to another app, the agent pauses instead.

The tests for this part use a fake browser and a fake portal, so they check the logic (off-screen handling, sensitive-field refusal, scroll limits and the click guards) but **not pixel accuracy on every real portal page**.

**Still hard:** pages with iframes, shadow DOM or canvas content expose few or no elements to the snapshot script, so the ghost cannot point precisely there. Portal redesigns can also change what an element is called. The bridge keys on role and accessible name rather than CSS classes to limit this, but it remains a risk.

### 9.2 Multi-language support

The platform is aimed at users who are more comfortable in their own language, but it **currently supports English only**. Regional languages such as **Hindi and Assamese** could not be added in the time available, and are planned as future scope.

What makes this a real piece of work, not a setting to switch on:

- **The corpus is English.** Every source PDF is in English, so a Hindi or Assamese question has to be matched against English text. Better results would need documents (or translations) in each language.
- **The vector index is tied to its embedding model.** An English-only embedding model cannot reliably retrieve from Hindi or Assamese text. A multilingual model could be explored, and any change of model means re-embedding the whole corpus. BGE-M3 is a configurable code default, not the model used by the live index.
- **Some regional-language source documents are hard to read automatically.** The UIDAI handbooks exist in several Indian languages, but many of them extract poorly, for example text that comes out garbled because of legacy font encodings. Using them would need OCR or cleaner sources.
- **The checks are written for English.** The grounding check that matches form ids, amounts, durations and quoted names against the cited text, and the keyword lists for out-of-scope questions and personal-data patterns, were built for English wording and would need equivalents for each language.
- **Assamese is a low-resource case.** It has far less ready-made tooling and data than Hindi.

### 9.3 Voice agent (not built)

We originally planned a **voice agent** to make the platform conversational, so that a user could speak a question and hear the answer. Given the short time span, **it was not implemented**. The planned options were:

| Option | Why it was considered |
| --- | --- |
| **LiveKit** | Real-time voice and agent infrastructure for streaming audio between the user and an AI agent. |
| **Sarvam.ai** | A provider focused on Indian languages, a good fit for the regional-language goal above. |

No voice code exists in this repository, and no LiveKit or Sarvam.ai dependency is installed. Voice and regional-language support are closely linked, which is why they sit side by side in the roadmap. `speak.ts` is the single path for model-written text only. A voice layer could be explored around the chat input and reply text without changing the tools or guardrails. That is a design direction, not something tested.

---

## 10. Limitations and roadmap

**Known limitations**

- **English only.** The assistant reads and answers in English. Hindi, Assamese and other regional languages are not supported yet (see [Challenges faced](#9-challenges-faced)).
- **Text only.** There is no voice input or output.
- **Limited live corpus.** The live collection `eci_docs_small` contains 189 points for Forms 6, 6A, 7 and 8 (guidelines and application forms), the Declaration Form, the Representation of the People Act, 1950, the Registration of Electors Rules and the Voter Guide. No UIDAI documents are in the live index. `sources.yaml` and the 12-PDF corpus belong to the `rag.ingest` path, which has not been run against the live index. Anything outside the indexed corpus should produce an abstention with the helpline, not an answer.
- **Retrieval quality is not recorded.** `rag.eval` and the 20-query gold set exist, but no results are stored in the repository. Run it (see [Testing](#7-testing)) before quoting numbers. The abstain threshold of 0.45 is a starting value.
- **Provenance needs checking.** `sources.yaml` takes publication dates from the document text where printed and otherwise from PDF metadata, and says to verify them before a public demo. Helpline numbers in `.env.example` carry the same warning.
- **Similar forms can be confused.** Related form text can be similar, which may retrieve the wrong chunk. Form-ID filtering can help when the user names a form.
- **Procedural scope only.** The agent declines questions about parties, candidates and legal disputes by keyword matching, which is a blunt check.
- **The user does the sensitive steps.** Login, OTP, CAPTCHA and every Aadhaar or EPIC field are left to the user by design.
- **Latency.** A local planner model depends on the machine. Hosted models are faster but need an API key and network access.
- **Desktop only.** This is a standalone Electron app, not a browser extension and not a mobile app.
- **Platform.** The setup notes in this repository use Windows paths and PowerShell; other platforms are untested.

**Roadmap**

- **Regional-language support**, starting with Hindi and Assamese (see [9.2](#92-multi-language-support)).
- **Conversational voice agent**, using LiveKit or Sarvam.ai (see [9.3](#93-voice-agent-not-built)).
- Larger corpus: more UIDAI documents, scanned circulars through OCR, and the remaining ECI forms.
- Record evaluation results and tune the abstain threshold against them.
- Per-document provenance review before any public release.

---

## Safety and privacy at a glance

- Personal identifiers are redacted before they reach the screen, the logs, the planner or the RAG service.
- The RAG service logs latency, abstain flag and document ids, not the query text.
- Only the Python RAG service reads the Qdrant key. The service token and planner configuration are handled separately; secrets must not be exposed to renderers.
- Every answer is tied to official sources the user can open; if there is no source, the assistant says so and gives the helpline.

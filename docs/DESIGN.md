# Design

Citeweave is a local-first desktop app. A small Python server runs on the researcher's own computer, serves the interface to a native window, and talks to open scholarly databases and to an optional AI provider. There is no Citeweave cloud, no account and no usage limit of our own.

## Goals

1. **Free forever.** Works with no keys and no payment. Optional free keys only raise limits.
2. **Light.** Idle CPU near zero. No bundled browser engine (the window uses Windows' built-in WebView2). No build step for the interface.
3. **Capable.** Search, citation maps, sourced answers, paper tables, library, researcher profiles, browser capture.
4. **Your choice of every service.** Each data source and AI provider is a plugin that can be turned on, off or reordered.
5. **Private.** Everything stays in `%APPDATA%\Citeweave`. Keys are sent only to their own service.
6. **Honest AI.** The AI only works from real paper text, cites what it uses, and anything it suggests is verified against a database before it is shown.

## Architecture

```
 Browser extension ──HTTP──┐
 (Chrome, Edge, Firefox)   │
                           ▼
 App window ───────► Local server (FastAPI on 127.0.0.1:23120)
 (pywebview,               │
  WebView2)                ├── aggregator ──► sources/*  ──► OpenAlex, Semantic Scholar, Crossref,
                           │                                  OpenCitations, Europe PMC, arXiv, PubMed,
                           │                                  Unpaywall, ORCID, CORE, Scopus
                           ├── graph        (citation map scoring)
                           ├── rank         (BM25 ranking, key sentences)
                           ├── ai/providers ──► Ollama, OpenAI, Anthropic, Gemini, DeepSeek, Groq,
                           │                     Mistral, OpenRouter, any OpenAI-compatible server
                           ├── ai/tasks     (answers, tables, summaries, verified suggestions)
                           ├── library, formats, zotero
                           ├── jobs         (long tasks with progress)
                           └── net + db     (HTTP cache, rate limits, SQLite)
```

### Why this stack

| Choice | Reason |
|---|---|
| Python + FastAPI | Easy for researchers to read and extend. Async HTTP keeps many API calls cheap |
| pywebview on WebView2 | A real Windows window without shipping Chromium. Falls back to an Edge app window, then the default browser |
| Vanilla JavaScript modules | No Node, no bundler, no build. Contributors edit a file and refresh |
| SQLite | One file, no server, fast, safe for concurrent reads |
| PyInstaller | A standalone `.exe` so users do not need Python |

## Folder structure

```
Citeweave/
├── Start Citeweave.bat        first run sets up a private Python environment, then starts the app
├── build_windows.bat          builds dist/Citeweave/Citeweave.exe and the extension zips
├── citeweave/
│   ├── cli.py                 starts the server and opens the window (python -m citeweave)
│   ├── mcp_server.py          tool server for the Claude desktop app
│   ├── sync.py                sync file export, import, folder and GitHub
│   ├── server.py              all HTTP endpoints and the request guard
│   ├── config.py              settings.json in the data folder, secrets masked for the UI
│   ├── db.py                  SQLite schema and queries
│   ├── net.py                 shared HTTP client, cache, per-host rate limits, retries, offline breaker
│   ├── models.py              the common paper record, identifiers, merging and de-duplication
│   ├── aggregator.py          search, lookup, references, citations and recommendations across sources
│   ├── graph.py               citation map building and scoring
│   ├── rank.py                BM25 ranking and key sentence extraction
│   ├── library.py             collections, status, notes, tags
│   ├── formats.py             BibTeX, RIS, CSV, APA; import parsing
│   ├── fulltext.py            open access PDF download and text extraction
│   ├── zotero.py              Zotero desktop connector and local API
│   ├── jobs.py                background jobs with progress for long tasks
│   ├── sources/               one file per data source (see "Adding a source")
│   ├── ai/providers.py        AI provider presets and the two wire formats
│   ├── ai/tasks.py            ask, summarize, extract, suggest
│   └── static/                the interface: index.html, app.css, js/ and js/views/
├── extension/                 Manifest V3 extension shared by Chromium browsers and Firefox
├── scripts/                   build_exe.py, build_extension.py, make_icons.py, launcher.py
├── tests/                     pytest suite with mocked HTTP (no network needed)
├── docs/                      DESIGN.md (this file), RESEARCH.md
└── .github/workflows/         ci.yml (tests on Windows and Linux), release.yml (builds on tag)
```

## The paper record

Every source is converted into one shape (`models.make_paper`):

```
id               stable key: doi:..., then arxiv:, pmid:, openalex:, s2:, or a title fingerprint
doi, title, abstract, year, venue, type, url, oa_url, tldr
authors          [{name, orcid?, openalex?, s2?}]
cited_by_count, reference_count, topics
ids              {openalex, s2, arxiv, pmid, pmcid, mag, ...}
references       OpenAlex ids of cited works (when known)
sources          which services contributed
```

`merge_papers` combines records for the same work, keeping the longest abstract, the highest counts and the union of ids. `dedupe` merges by DOI, then by any shared id, then by title fingerprint plus year.

## Data model (SQLite)

| Table | Holds |
|---|---|
| `papers` | cached paper records (JSON) with DOI and title for lookup |
| `collections`, `collection_papers` | the library, with reading status per paper |
| `notes`, `tags` | per paper |
| `maps` | saved citation maps: seeds, settings, last result, last check time |
| `tables` | saved paper tables: columns, rows, supporting quotes |
| `history` | saved questions and answers |
| `tags_updated`, `sync_tombstones` | change times for tags, and deletion markers for sync |
| `fulltext` | text extracted from open access PDFs |
| `http_cache` | API responses with expiry (search 12 hours, works 7 days) |

## Sources

Each source subclasses `sources/base.Source` and declares capabilities: `search`, `paper`, `references`, `citations`, `related`, `recommend`, `author`.

The aggregator walks the user's order in Settings and moves on when a source is turned off, lacks a required key, answers with an error, runs out of daily allowance or cannot be reached. Search has two modes: **first that answers** (light, the default) and **merge** (queries up to four sources at once and de-duplicates).

Lookup chains by identifier type:

| Identifier | Tried in order |
|---|---|
| DOI | OpenAlex, Semantic Scholar, Crossref, Europe PMC |
| arXiv | Semantic Scholar, OpenAlex, arXiv |
| PMID | OpenAlex, Semantic Scholar, Europe PMC, PubMed |
| PMCID | OpenAlex, Semantic Scholar, Europe PMC |

References fall back from OpenAlex to Semantic Scholar to OpenCitations. Citations fall back from OpenAlex to Semantic Scholar to OpenCitations.

### Being a good guest

The free services that make Citeweave possible must not be strained. `net.py` enforces a minimum gap between requests per host (for example 3 seconds for arXiv, about 1 second for Semantic Scholar), honours `Retry-After`, caches every successful response, and sends a clear User-Agent with the user's email when given. When a host cannot be reached at all, it is skipped for 60 seconds so the app stays quick offline.

## AI providers

Two wire formats cover every provider:

- **OpenAI-compatible chat completions:** OpenAI, Gemini (its OpenAI endpoint), DeepSeek, Groq, Mistral, OpenRouter, Ollama, LM Studio and any custom server.
- **Anthropic Messages API:** Claude.

A preset holds the base URL, default model and key help text. Users can load the model list from their key, set a custom model name, and test the connection. With no provider set, every feature still works in a non-AI form.

| Task | With AI | Without AI |
|---|---|---|
| Ask a question | short answer citing each claim as [n] with links | ranked papers with the key sentence of each abstract |
| Tables | each cell filled from abstract or open full text, with a supporting quote | not available, explains how to turn on AI |
| Summary | two sentence plain summary | Semantic Scholar TLDR or the abstract's key sentence |
| Search | optional query rewrite and "AI suggestions (verified)" source | normal search |

AI suggestions are checked one by one: a suggested DOI must resolve to a paper whose title matches, otherwise Crossref is searched by title and author and the match must pass a title-overlap and year check. Anything that fails is dropped and listed as "could not be found".

## Citation maps

1. Resolve each seed to an OpenAlex work (needed for its reference list).
2. Fetch the seed's references and up to 150 citing works. OpenAlex returns each citing work's own references in the same response, so co-citation needs no extra calls.
3. Score each candidate C against the seed set S:
   - direct: share of seeds that C cites or is cited by
   - coupling: shared references, cosine normalised `|refs(C) ∩ refs(S)| / sqrt(|refs(C)| · |refs(S)|)`
   - co-citation: citing papers of S that also cite C, cosine normalised
   - score = `0.4 · direct + 0.3 · coupling + 0.3 · co-citation`, each scaled to 0..1 across candidates
4. Keep the top N (20 to 100). Compute PageRank inside the map.
5. List **foundations** (works cited by two or more map papers, not on the map) and **newer work** (papers citing two or more map papers).

Views: **timeline** (year across, citations up on a log scale, threads for citation links) and **network** (force layout run once, then static, so there is no constant CPU use). Saved maps can be checked later: Citeweave fetches works citing the seeds since the last check and flags new ones.

## Browser extension

One Manifest V3 codebase. `build_extension.py` writes a Chromium zip and a Firefox zip (the Firefox one adds `browser_specific_settings`). There is no background script, so nothing runs until the user clicks the button.

1. The popup injects `detect.js` into the current tab (activeTab permission only). It reads standard citation meta tags (`citation_doi`, `dc.identifier`, `prism.doi` and others), the canonical link, the URL (doi.org, arXiv, PubMed, PMC) or a selected DOI.
2. It sends the identifier and the page's citation tags to `http://127.0.0.1:23120/api/ext/lookup`.
3. The app resolves it through the source chain. Title-only matches must pass a title-overlap check. If the databases cannot be reached, the paper is built from the page's own tags so saving still works.
4. The user saves it to a collection, opens it in the app, or adds it to the map.

## Security

The server binds to 127.0.0.1 only. A middleware guard:

- rejects any `Host` header that is not local (blocks DNS rebinding)
- rejects requests whose `Origin` is a web page, unless it is the app's own page on the same host and port
- allows browser extension origins and adds CORS headers only for them
- sends `Cache-Control: no-store`

Settings returned to the interface never include full keys, only a masked hint. API keys are added per request only to their own service's host, and are stripped from cache keys and logs.

## Performance budget

| Item | Target |
|---|---|
| Idle CPU | about 0% (no timers or polling except a light inbox check every few seconds while the window is open) |
| Memory | about 80 to 120 MB for Python plus the WebView2 window |
| Start time | under 2 seconds from the .exe |
| Map of 40 papers | 5 to 20 seconds on first build, instant from cache |

## Sync

The sync file format is defined in [web/SPEC.md](../web/SPEC.md). In the PC app:

- Collections, maps and tables keep their integer ids for the interface and also have a `uid` used in the sync file, so devices never clash. Question history lives in a `history` table.
- Every change stores `updated_at`, and every deletion writes a row to `sync_tombstones` (kept 180 days), so a deletion on one device removes the item on the others.
- `sync.py` exports the whole library as one document and imports a document by applying each record only when it is newer than the local copy. Paper records travel with the file, and the paper upsert never deletes the existing row.
- Merging two documents and the optional passphrase encryption (AES-GCM) happen in the shared interface, so the PC app and the web version behave the same. The PC app only moves files: to a chosen folder (`/api/sync/folder`) or to a GitHub repository through the contents API (`/api/sync/github`). The GitHub token stays in the PC app's settings and is never sent to the interface.

## Claude tool server

`citeweave/mcp_server.py` speaks the Model Context Protocol over standard input and output (newline-delimited JSON-RPC 2.0). The Claude desktop app starts it as `citeweave-mcp.exe` or `python -m citeweave.mcp_server`. It opens the same SQLite library as the window, so the two stay in step.

| Tool | Does |
|---|---|
| `search_papers` | aggregator search with the usual fallback |
| `get_paper`, `get_references`, `get_citations` | lookup through the identifier chains |
| `list_collections`, `get_collection`, `add_to_collection` | the library |
| `build_citation_map` | the same scoring as the map page, returned as a ranked list |
| `save_table` | stores a table in the Tables page format, with Claude marked as the source of each cell |
| `save_answer` | adds to question history with mode `claude` |
| `export_bibtex` | BibTeX for a collection |

Errors are returned to Claude as tool results with `isError: true`, so it can explain or retry. Nothing but protocol messages is written to standard output; logs go to standard error.

## Adding a source

1. Create `citeweave/sources/mysource.py` with a `Source` subclass. Set `name`, `label`, `homepage`, `capabilities` and, if needed, `key_required` and `key_help`.
2. Implement the methods you declared, returning `make_paper(...)` records.
3. Register it in `sources/__init__.py` and, if it has a host, add a polite interval to `HOST_INTERVAL` in `net.py`.
4. Add a test with mocked responses.

## Adding an AI provider

If it speaks the OpenAI chat format, add a `Preset` in `ai/providers.py` with its base URL and default model. Otherwise add a new `kind` and its request and response mapping next to the Anthropic one.

## Roadmap

See the "Ideas for later versions" list in [RESEARCH.md](RESEARCH.md).

## Web version

The web version is a static site (GitHub Pages or any static host) built by `scripts/build_web.py`. It reuses the interface in `citeweave/static` unchanged. When `window.CITEWEAVE_WEB` is set, `static/js/api.js` sends every `/api/...` call to `web/engine/router.js` instead of the local server. The engine is a set of plain ES modules with no build step and no dependencies:

- `models`, `net`, `sources/*`, `aggregator`, `graph`, `rank`, `formats` mirror the Python modules of the same names.
- `db.js` stores everything in IndexedDB. Each saved item is a sync record, so syncing is an exchange of records.
- `ai.js` calls the same providers from the browser with the user's own key, plus Chrome's built-in model when present.
- `jobs.js` runs long tasks with progress, polled the same way as on the PC.

Browser limits: Semantic Scholar, arXiv and CORE refuse cross-origin requests (checked from a real browser in October 2026), so their sources report Not ready in the web version and are skipped, and an optional relay (`web/relay/worker.js`, a free Cloudflare Worker) can forward them. Publisher PDFs are usually not readable from a web page, so web tables read abstracts. Zotero needs the PC app.

Contracts and the sync file format are in `web/SPEC.md`. Tests: `node --test web/tests/*.test.mjs`.

## Chatbot bridge

For researchers with a chatbot subscription but no API key. `static/js/bridge.js` builds a prompt holding only the selected papers' excerpts and a strict reply format. The researcher pastes it into their chatbot and pastes the reply back. Citeweave then checks:

- answers: every [n] must match one of the papers sent; others are struck through
- tables: every quote must appear in that paper's abstract (after normalising case and punctuation, or 85 percent of its words for long quotes); values without a confirmed quote are marked
- suggested papers: each is looked up in Crossref or OpenAlex (`/api/ai/verify`); anything not found is dropped

Nothing is automated inside the chatbot's website, so this stays within each service's terms.

## Smart ranking

`static/js/smart.js` loads a small sentence embedding model (all-MiniLM-L6-v2, quantised, about 25 MB) through transformers.js from a public CDN, only when the researcher turns it on. Search results and answer papers are reordered by cosine similarity to the query, blended with their original order. It runs on the CPU in the page and is cached by the browser after the first download.

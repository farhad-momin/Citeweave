# Web version: contracts

The web version is the same interface as the PC app (`citeweave/static`) running on a static site. Instead of calling a local server, `static/js/api.js` hands every `/api/...` request to an in-browser engine (`web/engine/router.js`). Views do not know which one they talk to.

```
site/                     built by scripts/build_web.py, deployed to GitHub Pages
  index.html              web/index.html (sets window.CITEWEAVE_WEB = true)
  config.js               web/config.js (optional Google and Microsoft app ids)
  static/                 copy of citeweave/static (shared interface)
  static/engine/          copy of web/engine
```

## Engine modules (ES modules, no build step, no dependencies)

| Module | Mirrors | Notes |
|---|---|---|
| `db.js` | `db.py` | IndexedDB stores kv, cache, papers, records |
| `settings.js` | `config.py` | same shape plus `relay`, `sync`, `smart` |
| `models.js` | `models.py` | `makePaper`, `normalizeDoi`, `parseIdentifier`, `paperKey`, `titleFingerprint`, `mergePapers`, `dedupe`, `titleSimilarity`, `abstractFromInvertedIndex`, `cleanText` |
| `net.js` | `net.py` | `request(method, url, {params, headers, json, ttl, parse, retries, timeout})`, `get`, `post`, `SourceError`, per-host spacing, cache in `db.cache`, offline breaker, optional relay |
| `sources/*.js` | `sources/*.py` | same class shape: `name, label, homepage, capabilities (Set), keyRequired, keyHelp, ready(), info(), search(), paper(kind, value), references(p), citations(p)` |
| `sources/index.js` | `sources/__init__.py` | `ALL`, `SEARCHABLE`, named exports |
| `aggregator.js` | `aggregator.py` | `search, resolve, lookup, enrich, references, citations, recommend, searchOrder` |
| `graph.js` | `graph.py` | `buildMap(seeds, {maxNodes, perSeed, progress, signal})`, `scoreCandidates` |
| `rank.js` | `rank.py` | BM25 `rankPapers(query, papers)`, `keySentence(query, text)` |
| `formats.js` | `formats.py` | `toBibtex, toRis, toCsv, rowsToCsv, apa, parseBibtex, parseRis, detectAndParse, findDois` |
| `library.js` | `library.py` | collections, members, notes, tags, maps, tables, history on top of `db.records` |
| `ai.js` | `ai/providers.py` + `ai/tasks.py` | presets, chat, ask, summarize, extract, suggest; adds the browser's built-in model |
| `jobs.js` | `jobs.py` | `start(kind, fn(progress, signal))`, `get(id)`, `cancel(id)` |
| `router.js` | `server.py` | `handle(method, url, body)` returns data or throws `Error(detail)` |
| `sync.js` | shared | merge logic and providers; also used by the PC app's interface |

Paper records use exactly the Python shape (`models.make_paper`), so saved data moves between the PC app and the web version unchanged.

### Browser access to data services

Every service is called straight from the browser. If one refuses browser requests (CORS), `net.js` raises `SourceError("<host> does not allow requests from web pages. Add a relay in Settings or use the PC app.")`, and the aggregator moves on. When `settings.relay.url` is set, requests to hosts in `RELAY_HOSTS` go to `${relay}/?url=<encoded target>` instead.

## Sync file (shared by PC app and web)

One JSON document, optionally encrypted.

```json
{
  "format": "citeweave-sync",
  "version": 1,
  "updated_at": 1793000000000,
  "device": "web-3f2a",
  "records": {
    "collection:3c1e...": {"kind": "collection", "id": "3c1e...", "updated_at": 1793000000000, "deleted": false,
                           "data": {"name": "RCA review", "description": ""}},
    "member:3c1e...|doi:10.1/x": {"kind": "member", "id": "3c1e...|doi:10.1/x", "updated_at": 0, "deleted": false,
                           "data": {"collection": "3c1e...", "paper_id": "doi:10.1/x", "status": "to-read", "added_at": 0}},
    "note:doi:10.1/x":    {"kind": "note", "data": {"paper_id": "doi:10.1/x", "body": "..."}},
    "tags:doi:10.1/x":    {"kind": "tags", "data": {"paper_id": "doi:10.1/x", "tags": ["method"]}},
    "map:9a...":          {"kind": "map", "data": {"name": "", "seeds": [], "options": {}, "last_checked": 0, "created_at": 0}},
    "table:7b...":        {"kind": "table", "data": {"name": "", "columns": [], "rows": [], "paper_ids": [], "created_at": 0}},
    "history:5d...":      {"kind": "history", "data": {"question": "", "answer": "", "papers": [], "mode": "ai|extractive|chatbot", "created_at": 0}}
  },
  "papers": {"doi:10.1/x": {"...paper record...": true}}
}
```

- Times are milliseconds since 1970.
- `id` values are random strings (UUID) so devices never clash. The PC app keeps its integer ids for its own pages and stores a `uid` for sync.
- Merge: for each record key, keep the one with the larger `updated_at`. Deleted records stay as tombstones (`deleted: true`, `data: {}`) for 180 days.
- `papers` holds the paper record for every paper any member, map seed or table references. On merge, papers are combined with `mergePapers`.
- Encrypted form: `{"format": "citeweave-sync-encrypted", "version": 1, "salt": b64, "iv": b64, "data": b64}`. AES-GCM 256 with a key from PBKDF2-SHA256 (250,000 iterations) over the researcher's passphrase. The passphrase never leaves the device.
- API keys and sync credentials are never part of the file.

### Endpoints both back ends provide

| Method | Path | Body or result |
|---|---|---|
| GET | `/api/sync/export` | the sync document (unencrypted, built from local data) |
| POST | `/api/sync/import` | body: a sync document. Applies every record newer than the local one, including deletions. Returns `{applied, skipped}` |
| GET | `/api/history` | `[{id, question, answer, papers, mode, created_at}]` newest first |
| POST | `/api/history` | `{question, answer, papers, mode}` returns the saved item |
| DELETE | `/api/history/{id}` | `{ok: true}` |

PC app only (desktop folder sync, since a desktop window cannot open a browser folder picker):

| Method | Path | |
|---|---|---|
| GET | `/api/sync/folder` | `{path, exists, document?}` reads `citeweave-sync.json` from `settings.sync.folder` |
| PUT | `/api/sync/folder` | body: a sync document (already merged, possibly encrypted). Writes it atomically |
| POST | `/api/sync/folder/pick` | opens a native folder dialog when available, returns `{path}` |

`/api/status` returns `"platform": "desktop"` or `"web"` so the interface can offer the right sync options.

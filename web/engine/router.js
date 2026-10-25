// The web version's back end. Every /api/... call the interface makes is answered here,
// inside the browser, with the same shapes as the PC app's server (citeweave/server.py).
import * as aggregator from "./aggregator.js";
import * as ai from "./ai.js";
import { cache, kv, papers as paperStore } from "./db.js";
import { apa, detectAndParse, findDois, rowsToCsv, toBibtex, toCsv, toRis } from "./formats.js";
import * as graph from "./graph.js";
import * as jobs from "./jobs.js";
import * as L from "./library.js";
import { dedupe, mergePapers, parseIdentifier } from "./models.js";
import { isLoaded, loadSettings, settings, updateSettings } from "./settings.js";
import * as S from "./sources/index.js";

export const VERSION = "0.2.0";
const _inbox = [];
let ready = null;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

async function init() {
  ready ??= (async () => {
    if (!isLoaded()) await loadSettings();
    await L.ensureDefault();
    cache.prune().catch(() => {});
    takeInboxFromUrl();
  })();
  return ready;
}

// The browser extension opens the web version with #/inbox?action=save&paper=<json> (or doi=).
function takeInboxFromUrl() {
  if (typeof location === "undefined") return;
  const m = location.hash.match(/^#\/?inbox\?(.*)$/);
  if (!m) return;
  const p = new URLSearchParams(m[1]);
  let paper = null;
  try { paper = p.get("paper") ? JSON.parse(p.get("paper")) : null; } catch { paper = null; }
  _inbox.push({ action: p.get("action") || "open", identifier: p.get("id") || p.get("doi") || "", page: paper });
  history.replaceState(null, "", location.pathname + location.search + "#/search");
}

async function deviceId() {
  let id = await kv.get("device");
  if (!id) { id = `web-${L.uid().slice(0, 8)}`; await kv.set("device", id); }
  return id;
}

async function paperFrom(ref) {
  if (ref && typeof ref === "object" && ref.id) return ref;
  ref = String(ref || "");
  const stored = await paperStore.get(ref);
  if (stored) return stored;
  const [head, ...rest] = ref.split(":");
  if (["doi", "arxiv", "pmid", "pmcid", "openalex", "s2"].includes(head) && rest.length) {
    const p = await aggregator.lookup(head, rest.join(":"));
    if (p) return p;
  }
  const p = await aggregator.resolve(ref);
  if (!p) fail(404, `Could not find a paper for '${ref}'`);
  return p;
}

async function details(p) {
  p = await aggregator.enrich(p);
  await L.savePaper(p);
  return { ...p, collections: await L.paperMemberships(p.id), note: await L.getNote(p.id),
    tags: (await L.tagMap()).get(p.id) || [], apa: apa(p) };
}

function hIndex(counts) {
  const c = counts.map((x) => x || 0).sort((a, b) => b - a);
  return c.filter((x, i) => x >= i + 1).length;
}

async function collectionOr(body) {
  if (body.collection_id) return L.collectionPapers(body.collection_id);
  return Promise.all((body.papers || []).map(paperFrom));
}

// routes ---------------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn) => {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, re, keys, fn });
};

route("GET", "/api/status", async () => {
  const cfg = ai.activeConfig();
  return {
    version: VERSION, platform: "web", data_dir: "this browser",
    ai: { enabled: ai.isEnabled(), provider: cfg.provider, model: cfg.model || null, label: cfg.label || null },
    sources: Object.values(S.ALL).map((s) => s.info()),
    search_order: aggregator.searchOrder(),
  };
});
route("GET", "/api/settings", async () => settings().public());
route("PUT", "/api/settings", async (_, b) => updateSettings(b || {}));

route("GET", "/api/ai/presets", async () => ai.PRESETS.map(({ name, label, base_url, default_model, needs_key, key_help, local }) =>
  ({ name, label, base_url, default_model, needs_key, key_help, local })));
route("POST", "/api/ai/test", async () => {
  if (ai.activeConfig().provider === "none") fail(400, "Choose an AI provider first.");
  const reply = await ai.chat("Reply with exactly: OK", "Say OK.", { maxTokens: 10 });
  return { ok: true, reply: reply.trim().slice(0, 100), model: ai.activeConfig().model };
});
route("POST", "/api/ai/models", async () => ({ models: await ai.listModels() }));
route("GET", "/api/ai/builtin", async () => ({ available: await ai.builtinAvailability() }));
route("POST", "/api/ai/verify", async (_, b) => {
  const items = (b.items || []).filter((x) => x && typeof x === "object").slice(0, 25);
  if (!items.length) fail(400, "No suggestions to check.");
  const out = await ai.verifySuggestions(items);
  const saved = await L.savedIds();
  for (const p of out.results) p.saved = saved.has(p.id);
  return out;
});
route("POST", "/api/cache/clear", async () => { await cache.clear(); return { removed: "all" }; });

route("GET", "/api/search", async (q) => {
  const query = (q.get("q") || "").trim();
  if (!query) fail(400, "Type something to search for.");
  const limit = Math.min(Number(q.get("limit") || 25), 100);
  const parsed = parseIdentifier(query);
  if (parsed && parsed[0] !== "orcid" && query.split(/\s+/).length === 1) {
    const p = await aggregator.lookup(...parsed);
    return { results: p ? [p] : [], used: ["lookup"], errors: p ? {} : { lookup: "Not found" } };
  }
  if (q.get("source") === "ai") {
    const out = await ai.suggest(query, Math.min(limit, 15));
    return { results: out.results, used: ["ai"], errors: {}, rejected: out.rejected };
  }
  const filters = { year_from: q.get("year_from") || null, year_to: q.get("year_to") || null,
    oa_only: q.get("oa_only") === "true", sort: q.get("sort") || "relevance" };
  const out = await aggregator.search(query, q.get("source") || "auto", limit, filters);
  const saved = await L.savedIds();
  for (const p of out.results) p.saved = saved.has(p.id);
  return out;
});
route("GET", "/api/autocomplete", async (q) => {
  const text = q.get("q") || "";
  if (text.length < 3 || !S.openalex.ready()[0]) return [];
  try { return await S.openalex.autocomplete(text); } catch { return []; }
});

route("GET", "/api/paper", async (q) => details(await paperFrom(q.get("id"))));
route("POST", "/api/paper/details", async (_, b) => details(await paperFrom(b.paper || b.id)));
route("POST", "/api/paper/references", async (_, b) => aggregator.references(await paperFrom(b.paper || b.id), Number(b.limit || 200)));
route("POST", "/api/paper/citations", async (_, b) => aggregator.citations(await paperFrom(b.paper || b.id), Number(b.limit || 200)));
route("POST", "/api/paper/summarize", async (_, b) => ai.summarize(await paperFrom(b.paper || b.id), b.use_ai !== false));
route("POST", "/api/cite", async (_, b) => {
  const ps = await Promise.all((b.papers || []).map(paperFrom));
  const f = b.format || "apa";
  return { text: f === "bibtex" ? toBibtex(ps) : f === "ris" ? toRis(ps) : ps.map(apa).join("\n\n") };
});
route("POST", "/api/recommend", async (_, b) => {
  const ps = await collectionOr(b);
  if (!ps.length) fail(400, "Add some papers first.");
  return aggregator.recommend(ps.slice(0, 50), Number(b.limit || 30));
});

route("GET", "/api/jobs/:id", async (_, __, p) => jobs.get(p.id) || fail(404, "Job not found"));
route("DELETE", "/api/jobs/:id", async (_, __, p) => ({ cancelled: jobs.cancel(p.id) }));

route("POST", "/api/map", async (_, b) => {
  const refs = b.seeds || [];
  if (!refs.length) fail(400, "Add at least one seed paper.");
  const maxNodes = Math.max(10, Math.min(Number(b.max_nodes || 40), 120));
  return { job: jobs.start("map", async (progress, signal) => {
    progress("Looking up seed papers", 0.05);
    const seeds = [];
    for (const r of refs.slice(0, 20)) {
      let p = await paperFrom(r);
      if (!p.ids?.openalex && p.doi) p = (await aggregator.lookup("doi", p.doi)) || p;
      seeds.push(p);
    }
    return graph.buildMap(seeds, { maxNodes, progress, signal });
  }) };
});

route("POST", "/api/ask", async (_, b) => {
  const question = (b.question || "").trim();
  if (!question) fail(400, "Type a research question.");
  return { job: jobs.start("ask", (progress, signal) => ai.ask(question, { limit: Number(b.limit || 8), source: b.source || "auto",
    filters: b.filters || {}, useAi: b.use_ai !== false, progress, signal })) };
});

route("GET", "/api/extract/presets", async () => ai.PRESET_COLUMNS);
route("POST", "/api/extract", async (_, b) => {
  const columns = (b.columns || []).filter((c) => (c.name || "").trim());
  if (!columns.length) fail(400, "Add at least one column.");
  if (!ai.isEnabled()) fail(400, "Automatic tables need an AI provider (Settings, AI). Or use Fill with my chatbot.");
  const refs = b.collection_id ? await L.collectionPapers(b.collection_id) : b.papers || [];
  if (!refs.length) fail(400, "Choose papers for the table.");
  const name = (b.name || "").trim() || `Table ${new Date().toISOString().slice(0, 10)}`;
  return { job: jobs.start("extract", async (progress, signal) => {
    const ps = [];
    for (const r of refs.slice(0, 200)) ps.push(await paperFrom(r));
    const rows = await ai.extract(ps, columns, progress, signal);
    rows.forEach((r, i) => {
      const p = ps[i];
      r.paper = { id: p.id, title: p.title, year: p.year, doi: p.doi, authors: p.authors, venue: p.venue, oa_url: p.oa_url };
    });
    const id = await L.saveTable(name, columns, rows);
    return { id, name, columns, rows };
  }) };
});

route("GET", "/api/collections", async () => L.listCollections());
route("POST", "/api/collections", async (_, b) => L.createCollection(b.name, b.description || ""));
route("PATCH", "/api/collections/:id", async (_, b, p) => { await L.renameCollection(p.id, b.name || "", b.description); return { ok: true }; });
route("DELETE", "/api/collections/:id", async (_, __, p) => { await L.deleteCollection(p.id); return { ok: true }; });
route("GET", "/api/collections/:id/papers", async (_, __, p) => L.collectionPapers(p.id));
route("POST", "/api/collections/:id/papers", async (_, b, p) => {
  const ps = await Promise.all((b.papers || []).map(paperFrom));
  return { added: await L.addPapers(p.id, ps) };
});
route("POST", "/api/collections/:id/remove", async (_, b, p) => { await L.removePaper(p.id, b.paper_id); return { ok: true }; });
route("POST", "/api/collections/:id/status", async (_, b, p) => {
  try { await L.setStatus(p.id, b.paper_id, b.status); } catch (e) { fail(400, e.message); }
  return { ok: true };
});
route("PUT", "/api/notes", async (_, b) => {
  try { await L.setNote(b.paper_id, b.body || ""); } catch (e) { fail(400, e.message); }
  return { ok: true };
});
route("PUT", "/api/tags", async (_, b) => { await L.setTags(b.paper_id, b.tags || []); return { ok: true }; });

route("GET", "/api/maps", async () => L.listMaps());
route("POST", "/api/maps", async (_, b) => ({ id: await L.saveMap(b.name || "Untitled map", b.seeds || [], b.options || {}, b.known || [], b.id) }));
route("GET", "/api/maps/:id", async (_, __, p) => (await L.getMap(p.id)) || fail(404, "Map not found"));
route("DELETE", "/api/maps/:id", async (_, __, p) => { await L.deleteMap(p.id); return { ok: true }; });
route("POST", "/api/maps/:id/check", async (_, __, p) => {
  const m = await L.getMap(p.id);
  if (!m) fail(404, "Map not found");
  if (!S.openalex.ready()[0]) fail(400, "Checking for new papers uses OpenAlex. Turn it on in Settings.");
  const since = new Date(((m.last_checked || m.created_at) - 7 * 86400) * 1000).toISOString().slice(0, 10);
  const ids = [];
  for (const s of m.seeds) {
    let paper = await paperFrom(s);
    if (!paper.ids?.openalex && paper.doi) paper = (await aggregator.lookup("doi", paper.doi)) || paper;
    if (paper.ids?.openalex) ids.push(paper.ids.openalex);
  }
  const found = await S.openalex.citedByAny(ids, since);
  const known = new Set(m.known || []);
  const fresh = dedupe(found).filter((x) => !known.has(graph.nodeKey(x)));
  await L.touchMap(p.id, [...known, ...fresh.map(graph.nodeKey)]);
  return { since, results: fresh };
});

route("GET", "/api/tables", async () => L.listTables());
route("POST", "/api/tables", async (_, b) => {
  const columns = (b.columns || []).filter((c) => (c.name || "").trim());
  if (!columns.length) fail(400, "Add at least one column.");
  const name = (b.name || "").trim() || `Table ${new Date().toISOString().slice(0, 10)}`;
  // keep the papers of a table filled elsewhere, as the PC app does, so sync can carry them
  for (const r of b.rows || []) {
    const p = r?.paper;
    if (p && typeof p === "object" && p.id && !(await paperStore.get(p.id))) await L.savePaper(p);
  }
  return { id: await L.saveTable(name, columns, b.rows || [], b.id), name };
});
route("DELETE", "/api/tables/:id", async (_, __, p) => { await L.deleteTable(p.id); return { ok: true }; });
route("GET", "/api/tables/:id/csv", async (_, __, p) => {
  const t = (await L.listTables()).find((x) => x.id === p.id);
  if (!t) fail(404, "Table not found");
  const papers = Object.fromEntries(t.rows.map((r) => [r.paper_id, r.paper || {}]));
  return "﻿" + rowsToCsv(ai.tableToCsvRows(t.columns, t.rows, papers));
});

route("POST", "/api/export", async (_, b) => {
  const ps = await collectionOr(b);
  const f = b.format || "bibtex";
  if (f === "bibtex") return toBibtex(ps);
  if (f === "ris") return toRis(ps);
  if (f === "csv") return "﻿" + toCsv(ps);
  fail(400, "format must be bibtex, ris or csv");
});

route("POST", "/api/import", async (_, b) => {
  const text = b.text || "";
  const cid = b.collection_id || (await L.ensureDefault());
  const [kind, parsed] = detectAndParse(text);
  return { job: jobs.start("import", async (progress) => {
    let items = parsed;
    if (kind === "dois") {
      const dois = findDois(text);
      const idents = dois.length ? dois : text.split(/\r?\n/).map((l) => l.trim()).filter((l) => parseIdentifier(l));
      items = [];
      for (let i = 0; i < Math.min(idents.length, 500); i++) {
        progress(`Looking up ${i + 1} of ${idents.length}`, i / Math.max(idents.length, 1));
        try { const p = await aggregator.resolve(idents[i]); if (p) items.push(p); } catch { /* skip */ }
      }
    } else {
      for (let i = 0; i < items.length; i++) {
        progress(`Checking ${i + 1} of ${items.length}`, i / Math.max(items.length, 1));
        if (items[i].doi && !items[i].abstract) {
          try { const full = await aggregator.lookup("doi", items[i].doi); if (full) items[i] = full; } catch { /* keep */ }
        }
      }
    }
    return { format: kind, found: items.length, added: await L.addPapers(cid, items), collection_id: cid };
  }) };
});

const ZOTERO_MSG = "Zotero works with the Citeweave PC app. In the web version, export RIS or BibTeX and import it in Zotero.";
route("GET", "/api/zotero/status", async () => ({ running: false, local_api: false, web: true, message: ZOTERO_MSG }));
route("POST", "/api/zotero/send", async () => fail(400, ZOTERO_MSG));
route("GET", "/api/zotero/collections", async () => fail(400, ZOTERO_MSG));
route("POST", "/api/zotero/import", async () => fail(400, ZOTERO_MSG));

route("POST", "/api/profile/load", async (_, b) => {
  const kind = b.kind;
  const value = String(b.value || "").trim();
  if (!value) fail(400, "Enter an identifier.");
  return { job: jobs.start("profile", async (progress) => {
    progress("Loading works", 0.2);
    let info = null, works = [];
    if (kind === "orcid") {
      const m = value.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i);
      if (!m) throw new Error("That does not look like an ORCID iD (0000-0000-0000-0000).");
      const oid = m[0].toUpperCase();
      if (S.openalex.ready()[0]) {
        try { [info, works] = await S.openalex.authorWorks({ orcid: oid }); } catch { info = null; works = []; }
      }
      const [oInfo, oWorks] = await S.orcid.works(oid);
      if (oInfo) { info = { ...oInfo, ...(info || {}) }; if (oInfo.name) info.name = oInfo.name; }
      const have = new Set(works.map((w) => w.doi).filter(Boolean));
      let missing = oWorks.filter((w) => !w.doi || !have.has(w.doi));
      const dois = missing.map((w) => w.doi).filter(Boolean);
      if (dois.length && S.openalex.ready()[0]) {
        progress("Filling in details", 0.6);
        try {
          const found = await S.openalex.batchDois(dois);
          const got = new Set(found.map((f) => f.doi));
          missing = missing.filter((w) => !got.has(w.doi)).concat(found);
        } catch { /* keep ORCID records */ }
      }
      works = dedupe(works.concat(missing));
    } else if (kind === "openalex") {
      [info, works] = await S.openalex.authorWorks({ authorId: value.replace(/\/+$/, "").split("/").pop() });
    } else if (kind === "s2") {
      [info, works] = await S.semanticscholar.authorWorks(value.replace(/\/+$/, "").split("/").pop());
    } else if (kind === "scopus") {
      const [ok, reason] = S.scopus.ready();
      if (!ok) throw new Error(reason);
      [info, works] = await S.scopus.authorWorks(value.replace(/\D/g, ""));
    } else throw new Error("Unknown identifier type");
    if (!info && !works.length) throw new Error("No public record found for that identifier.");
    info = info || {};
    const cites = works.map((w) => w.cited_by_count || 0);
    info.computed = { works: works.length, citations: cites.reduce((a, c) => a + c, 0), h_index: hIndex(cites), i10_index: cites.filter((c) => c >= 10).length };
    works.sort((a, c) => (c.year || 0) - (a.year || 0) || (c.cited_by_count || 0) - (a.cited_by_count || 0));
    const field = { orcid: "orcid", openalex: "openalex_author", s2: "s2_author", scopus: "scopus_author" }[kind];
    await updateSettings({ profile: { [field]: value } });
    return { info, works };
  }) };
});

// browser extension handoff
route("GET", "/api/inbox", async () => {
  const out = [];
  while (_inbox.length) {
    const it = _inbox.shift();
    try {
      let paper = null;
      if (it.identifier) paper = await aggregator.resolve(it.identifier).catch(() => null);
      if (!paper && it.page?.title) {
        const { makePaper } = await import("./models.js");
        const pid = parseIdentifier(it.identifier || it.page.identifier || "");
        paper = makePaper({ source: "page", title: it.page.title, doi: pid?.[0] === "doi" ? pid[1] : null, year: it.page.year,
          venue: it.page.journal, authors: (it.page.authors || []).map((n) => ({ name: n })), url: it.page.url, oa_url: it.page.pdf || null });
      }
      if (!paper) continue;
      if (it.action === "save") {
        const cid = await L.ensureDefault();
        await L.addPapers(cid, [paper]);
        out.push({ action: "saved", paper, collection_id: cid });
      } else out.push({ action: it.action, paper });
    } catch { /* skip */ }
  }
  return out;
});

// sync and history
route("GET", "/api/sync/export", async () => {
  const records = {};
  for (const r of await L.allRecords()) {
    const { key, ...rest } = r;
    records[key] = rest;
  }
  const papers = {};
  for (const id of await L.referencedPaperIds()) {
    const p = await paperStore.get(id);
    if (p) papers[id] = p;
  }
  return { format: "citeweave-sync", version: 1, updated_at: Date.now(), device: await deviceId(), records, papers };
});
route("POST", "/api/sync/import", async (_, b) => {
  if (b?.format === "citeweave-sync-encrypted") fail(400, "This sync file is locked. Unlock it with the passphrase first.");
  if (b?.format !== "citeweave-sync") fail(400, "That is not a Citeweave sync file.");
  if (Number(b.version || 0) > 1) fail(400, "This sync file was made by a newer Citeweave. Please update the app.");
  for (const [id, p] of Object.entries(b.papers || {})) {
    if (!p || typeof p !== "object" || p.title === undefined || p.title === null) continue;
    const old = await paperStore.get(id);
    // keep the record's key as the id: mergePapers may switch it to doi:..., and the members
    // that point at this paper would then lose it
    await paperStore.put(L.cleanPaper({ ...(old ? mergePapers(old, p) : p), id }));
  }
  const recs = Object.entries(b.records || {}).map(([key, r]) => ({ ...r, key }));
  return L.applyRecords(recs);
});
route("POST", "/api/sync/github", async (_, b) => githubSync(b.action, b.document, b.sha));

route("GET", "/api/history", async () => L.listHistory());
route("POST", "/api/history", async (_, b) => {
  try { return await L.addHistory(b || {}); } catch (e) { fail(400, e.message); }
});
route("DELETE", "/api/history/:id", async (_, __, p) => { await L.deleteHistory(p.id); return { ok: true }; });

// GitHub contents API, with the token kept here rather than in the interface. Mirrors
// citeweave/sync.py github().
const GITHUB = "https://api.github.com";
const _ghSha = new Map(); // repo|branch|path -> sha seen by the last read (null: no file yet)

function githubCfg() {
  const g = settings().get("sync", "github") || {};
  const token = String(g.token || "").trim();
  const repo = String(g.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
  const path = String(g.path || "citeweave-sync.json").trim().replace(/^\/+/, "");
  const branch = String(g.branch || "main").trim() || "main";
  if (!token || !repo) fail(400, "Add your GitHub repository and access token in Settings, Sync.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(400, "Enter the repository as owner/name, for example farhad/citeweave-data.");
  if (!path || path.split("/").includes("..")) fail(400, "The file path in the repository is not valid.");
  return { token, repo, path, branch };
}

function githubError(status, cfg) {
  if (status === 401) return new HttpError(400, "GitHub did not accept the token. Create a new one and paste it in Settings, Sync.");
  if (status === 403) return new HttpError(400, "The GitHub token cannot write to this repository. Give it Contents: read and write.");
  if (status === 404) return new HttpError(400, `Repository ${cfg.repo} or branch ${cfg.branch} was not found, or the token cannot see it.`);
  if (status === 409 || status === 422) return new HttpError(400, "The synced file changed on another device at the same moment. Click Sync now again.");
  return new HttpError(400, `GitHub answered ${status}.`);
}

function b64ToText(b64) {
  const bin = atob(String(b64 || "").replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function githubSync(action, doc, sha) {
  const cfg = githubCfg();
  const url = `${GITHUB}/repos/${cfg.repo}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const memo = `${cfg.repo}|${cfg.branch}|${cfg.path}`;
  const gh = async (u, opts = {}) => {
    try { return await fetch(u, { cache: "no-store", ...opts, headers: { ...headers, ...(opts.headers || {}) } }); }
    catch { fail(400, "Could not reach GitHub. Check your connection."); }
  };
  const read = async () => {
    const r = await gh(`${url}?ref=${encodeURIComponent(cfg.branch)}`);
    if (r.status === 404) {
      // tell "no file yet" apart from "no repository"
      const repo = await gh(`${GITHUB}/repos/${cfg.repo}`);
      if (repo.status !== 200) throw githubError(repo.status, cfg);
      _ghSha.set(memo, null);
      return { document: null, sha: null };
    }
    if (r.status !== 200) throw githubError(r.status, cfg);
    const meta = await r.json();
    let content = meta.content || "";
    if (!content && meta.size) {
      // files over 1 MB come without content; the blob of this exact sha has it (raw links can be stale)
      const blob = await gh(`${GITHUB}/repos/${cfg.repo}/git/blobs/${meta.sha}`);
      if (blob.status !== 200) throw githubError(blob.status, cfg);
      content = (await blob.json()).content || "";
    }
    let document = null;
    try {
      const text = content ? b64ToText(content) : "";
      document = text.trim() ? JSON.parse(text) : null;
    } catch { fail(400, "The sync file on GitHub is damaged."); }
    _ghSha.set(memo, meta.sha || null);
    return { document, sha: meta.sha || null };
  };
  if (action === "read") return read();
  if (action !== "write") fail(400, "action must be read or write");
  if (!doc || typeof doc !== "object" || !["citeweave-sync", "citeweave-sync-encrypted"].includes(doc.format)) {
    fail(400, "Nothing to write: the document is not a Citeweave sync file.");
  }
  // Write over the version the merge was based on, so a change saved by another device in the
  // meantime makes GitHub answer 409 instead of being overwritten.
  let current = sha;
  if (current === undefined || current === null) current = _ghSha.has(memo) ? _ghSha.get(memo) : (await read()).sha;
  const body = { message: "Citeweave sync", content: textToB64(JSON.stringify(doc)), branch: cfg.branch, ...(current ? { sha: current } : {}) };
  const r = await gh(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status !== 200 && r.status !== 201) {
    _ghSha.delete(memo);
    throw githubError(r.status, cfg);
  }
  const newSha = (await r.json()).content?.sha || null;
  _ghSha.set(memo, newSha);
  return { sha: newSha };
}

// entry point --------------------------------------------------------------------------------
export async function handle(method, url, body) {
  await init();
  const u = new URL(url, "http://citeweave.local");
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = u.pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      return await r.fn(u.searchParams, body || {}, params);
    } catch (e) {
      if (e instanceof HttpError) throw new Error(e.message);
      if (e?.name === "AbortError") throw new Error("Stopped");
      throw e;
    }
  }
  throw new Error(`Not available in the web version: ${method} ${u.pathname}`);
}

export function _resetForTests() { ready = null; _inbox.length = 0; _ghSha.clear(); }

// The researcher's library in the browser: collections, reading status, notes, tags,
// saved maps, tables and question history. Every item is a sync record (web/SPEC.md),
// so syncing is just exchanging records.
import { papers as paperStore, records } from "./db.js";

export const STATUSES = ["to-read", "reading", "read", "skip"];
const TOMBSTONE_DAYS = 180;
const KINDS = new Set(["collection", "member", "note", "tags", "map", "table", "history"]);

let _all = null; // Promise of Map key -> record, loaded once
const now = () => Date.now();

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

// Keep the promise, so callers arriving while the first read runs wait for it instead of
// seeing an empty library.
function load() {
  _all ??= records.all().then((rows) => new Map(rows.map((r) => [r.key, r])))
    .catch((e) => { _all = null; throw e; });
  return _all;
}

export function resetLibraryForTests() { _all = null; }

async function live(kind) {
  const m = await load();
  return [...m.values()].filter((r) => r.kind === kind && !r.deleted);
}

async function getRec(key) {
  const r = (await load()).get(key);
  return r && !r.deleted ? r : null;
}

async function putRec(kind, id, data, updatedAt = now()) {
  const rec = { key: `${kind}:${id}`, kind, id, updated_at: updatedAt, deleted: false, data };
  (await load()).set(rec.key, rec);
  await records.put(rec);
  return rec;
}

async function delRec(key) {
  const m = await load();
  const old = m.get(key);
  if (!old || old.deleted) return;
  const rec = { key, kind: old.kind, id: old.id, updated_at: now(), deleted: true, data: {} };
  m.set(key, rec);
  await records.put(rec);
}

// sync support ------------------------------------------------------------------------
export async function allRecords() {
  const cutoff = now() - TOMBSTONE_DAYS * 86400e3;
  return [...(await load()).values()].filter((r) => !r.deleted || r.updated_at > cutoff);
}

// Apply records from another device. Newer wins. Returns {applied, skipped}.
export async function applyRecords(incoming) {
  const m = await load();
  let applied = 0, skipped = 0;
  const batch = [];
  for (let r of incoming) {
    if (r && r.key && !r.kind && String(r.key).includes(":")) r = { ...r, kind: String(r.key).split(":")[0] };
    if (!r || !r.key || !KINDS.has(r.kind)) { skipped++; continue; }
    const cur = m.get(r.key);
    if (cur && (cur.updated_at || 0) >= (r.updated_at || 0)) { skipped++; continue; }
    const rec = { key: r.key, kind: r.kind, id: r.id ?? r.key.slice(r.kind.length + 1), updated_at: r.updated_at || 0,
      deleted: !!r.deleted, data: r.deleted ? {} : (r.data || {}) };
    m.set(rec.key, rec);
    batch.push(rec);
    applied++;
  }
  await records.putMany(batch);
  return { applied, skipped };
}

// papers ---------------------------------------------------------------------------------
export async function getPaper(id) { return paperStore.get(id); }

// Fields the interface adds to a paper for display. They belong to records (notes, tags,
// members) or to one screen, never to the stored paper.
export const UI_FIELDS = ["saved", "status", "note", "tags", "added_at", "collections", "apa", "key_sentence",
  "smart_score", "verified", "from_page", "bad_citations"];

export function cleanPaper(p) {
  const out = { ...p };
  for (const k of UI_FIELDS) delete out[k];
  return out;
}

export async function savePaper(p) {
  if (!p?.id) return;
  const old = await paperStore.get(p.id);
  const clean = cleanPaper(p);
  await paperStore.put(old ? cleanPaper({ ...old, ...dropEmpty(clean) }) : clean);
}

function dropEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== "") out[k] = v;
  return out;
}

// collections ----------------------------------------------------------------------------
export async function listCollections() {
  const cols = await live("collection");
  const members = await live("member");
  const counts = new Map();
  for (const m of members) counts.set(m.data.collection, (counts.get(m.data.collection) || 0) + 1);
  return cols
    .map((c) => ({ id: c.id, name: c.data.name, description: c.data.description || "", created_at: (c.data.created_at || 0) / 1000,
      count: counts.get(c.id) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export const DEFAULT_COLLECTION = "reading-list"; // same id on every device, so syncing never makes two

export async function createCollection(name, description = "", id = uid()) {
  name = (name || "").trim() || "Untitled collection";
  await putRec("collection", id, { name, description, created_at: now() });
  return { id, name, description, count: 0 };
}

export async function ensureDefault() {
  const cols = await live("collection");
  if (cols.length) return cols.sort((a, b) => (a.data.created_at || 0) - (b.data.created_at || 0))[0].id;
  return (await createCollection("My reading list", "", DEFAULT_COLLECTION)).id;
}

export async function renameCollection(id, name, description) {
  const r = await getRec(`collection:${id}`);
  if (!r) throw new Error("Collection not found");
  await putRec("collection", id, { ...r.data, name: (name || "").trim() || r.data.name,
    ...(description !== undefined && description !== null ? { description } : {}) });
}

export async function deleteCollection(id) {
  for (const m of await live("member")) if (m.data.collection === id) await delRec(m.key);
  await delRec(`collection:${id}`);
}

export async function addPapers(cid, list) {
  if (!(await getRec(`collection:${cid}`))) throw new Error("Collection not found");
  let n = 0;
  for (const p of list) {
    if (!p?.id) continue;
    await savePaper(p);
    const key = `member:${cid}|${p.id}`;
    if (await getRec(key)) continue;
    await putRec("member", `${cid}|${p.id}`, { collection: cid, paper_id: p.id, status: "to-read", added_at: now() });
    n++;
  }
  return n;
}

export async function removePaper(cid, pid) { await delRec(`member:${cid}|${pid}`); }

export async function setStatus(cid, pid, status) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  const r = await getRec(`member:${cid}|${pid}`);
  if (r) await putRec("member", r.id, { ...r.data, status });
}

export async function collectionPapers(cid) {
  const members = (await live("member")).filter((m) => m.data.collection === cid)
    .sort((a, b) => (b.data.added_at || 0) - (a.data.added_at || 0));
  const tags = await tagMap();
  const out = [];
  for (const m of members) {
    const p = await paperStore.get(m.data.paper_id);
    if (!p) continue;
    const note = await getRec(`note:${p.id}`);
    out.push({ ...p, status: m.data.status || "to-read", added_at: (m.data.added_at || 0) / 1000,
      note: note?.data.body || "", tags: tags.get(p.id) || [] });
  }
  return out;
}

export async function paperMemberships(pid) {
  return (await live("member")).filter((m) => m.data.paper_id === pid).map((m) => m.data.collection);
}

export async function savedIds() {
  return new Set((await live("member")).map((m) => m.data.paper_id));
}

export async function getNote(pid) { return (await getRec(`note:${pid}`))?.data.body || ""; }

export async function setNote(pid, body) {
  if (!(await paperStore.get(pid))) throw new Error("Save the paper to a collection before adding notes");
  await putRec("note", pid, { paper_id: pid, body: body || "" });
}

export async function tagMap() {
  const m = new Map();
  for (const r of await live("tags")) if (r.data.tags?.length) m.set(r.data.paper_id, r.data.tags);
  return m;
}

export async function setTags(pid, tags) {
  const clean = [...new Set((tags || []).map((t) => String(t).trim().slice(0, 60)).filter(Boolean))].sort();
  await putRec("tags", pid, { paper_id: pid, tags: clean });
}

// maps -------------------------------------------------------------------------------------
const mapOut = (r) => ({ id: r.id, name: r.data.name, seeds: r.data.seeds || [], options: r.data.options || {},
  known: r.data.known || [], created_at: (r.data.created_at || 0) / 1000, last_checked: (r.data.last_checked || 0) / 1000 });

export async function listMaps() {
  return (await live("map")).map(mapOut).sort((a, b) => b.created_at - a.created_at);
}

export async function saveMap(name, seeds, options, known, id) {
  const existing = id ? await getRec(`map:${id}`) : null;
  const mid = existing ? id : uid();
  await putRec("map", mid, { ...(existing?.data || { created_at: now(), last_checked: now() }), name, seeds, options, known });
  for (const s of seeds || []) if (s?.id) await savePaper(s);
  return mid;
}

export async function getMap(id) {
  const r = await getRec(`map:${id}`);
  return r ? mapOut(r) : null;
}

export async function touchMap(id, known) {
  const r = await getRec(`map:${id}`);
  if (r) await putRec("map", id, { ...r.data, known, last_checked: now() });
}

export async function deleteMap(id) { await delRec(`map:${id}`); }

// tables -----------------------------------------------------------------------------------
export async function listTables() {
  return (await live("table")).map((r) => ({ id: r.id, name: r.data.name, columns: r.data.columns || [],
    rows: r.data.rows || [], created_at: (r.data.created_at || 0) / 1000 })).sort((a, b) => b.created_at - a.created_at);
}

export async function saveTable(name, columns, rows, id) {
  const existing = id ? await getRec(`table:${id}`) : null;
  const tid = existing ? id : uid();
  const paperIds = (rows || []).filter((r) => r && r.paper_id).map((r) => String(r.paper_id));
  await putRec("table", tid, { ...(existing?.data || { created_at: now() }), name, columns, rows, paper_ids: paperIds });
  return tid;
}

export async function deleteTable(id) { await delRec(`table:${id}`); }

// question history ---------------------------------------------------------------------------
export async function listHistory() {
  return (await live("history")).map((r) => ({ id: r.id, ...r.data, created_at: (r.data.created_at || 0) / 1000 }))
    .sort((a, b) => b.created_at - a.created_at);
}

export async function addHistory({ question, answer, papers = [], mode = "extractive" }) {
  question = String(question || "").trim();
  if (!question) throw new Error("A question is required");
  const id = uid();
  const slim = (papers || []).slice(0, 20).map((p) => ({ id: p.id, title: p.title, year: p.year, doi: p.doi,
    authors: (p.authors || []).slice(0, 3), venue: p.venue, key_sentence: p.key_sentence }));
  for (const p of papers || []) if (p?.id && p.title) await savePaper(p);
  const data = { question: question || "", answer: answer || "", papers: slim, mode, created_at: now() };
  await putRec("history", id, data);
  return { id, ...data, created_at: data.created_at / 1000 };
}

export async function deleteHistory(id) { await delRec(`history:${id}`); }

// every paper a synced record refers to, so another device can show it
export async function referencedPaperIds() {
  const ids = new Set();
  for (const r of (await load()).values()) {
    if (r.deleted) continue;
    const d = r.data || {};
    // notes and tags too: the PC app only applies them when it has the paper
    if (["member", "note", "tags"].includes(r.kind) && d.paper_id) ids.add(d.paper_id);
    if (r.kind === "map") for (const s of d.seeds || []) if (s?.id) ids.add(s.id); else if (typeof s === "string") ids.add(s);
    if (r.kind === "table") {
      for (const row of d.rows || []) if (row?.paper_id) ids.add(row.paper_id);
      for (const pid of d.paper_ids || []) ids.add(pid);
    }
    if (r.kind === "history") for (const p of d.papers || []) if (p?.id) ids.add(p.id);
  }
  return ids;
}

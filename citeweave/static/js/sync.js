// Sync the library between devices through the researcher's own storage.
// Shared by the web version and the PC app. The back end only exports and imports
// records (/api/sync/export, /api/sync/import); this file merges them and talks to the storage.
//
// Providers
//   github    a private GitHub repo (token kept by the back end, never shown here)
//   folder    a folder on this computer, for example a Google Drive or OneDrive folder
//   gdrive    Google Drive sign-in (web version, only when an app id is set in config.js)
//   onedrive  OneDrive sign-in (web version, only when an app id is set in config.js)
import { api } from "./api.js";

const FILE = "citeweave-sync.json";
const LS = "citeweave.sync";
const isWeb = () => !!globalThis.CITEWEAVE_WEB;
const config = () => globalThis.CITEWEAVE_CONFIG || {};

// small per-device state: last sync, remembered passphrase, folder name ---------------------------
function local() {
  try { return JSON.parse(localStorage.getItem(LS) || "{}"); } catch { return {}; }
}
function saveLocal(patch) {
  try { localStorage.setItem(LS, JSON.stringify({ ...local(), ...patch })); } catch { /* storage blocked */ }
}
export function lastSync() { return local().last || null; }
export function forgetPassphrase() { saveLocal({ pass: "" }); }

// merge ----------------------------------------------------------------------------------------
function mergePaper(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined || v === "") continue;
    const cur = out[k];
    if (cur === null || cur === undefined || cur === "") out[k] = v;
    else if (typeof v === "string" && typeof cur === "string" && v.length > cur.length && k === "abstract") out[k] = v;
    else if (typeof v === "number" && typeof cur === "number" && k.endsWith("_count")) out[k] = Math.max(v, cur);
    else if (k === "ids" && typeof v === "object") out[k] = { ...v, ...cur };
  }
  return out;
}

export function merge(localDoc, remoteDoc) {
  const records = { ...(remoteDoc?.records || {}) };
  for (const [key, r] of Object.entries(localDoc?.records || {})) {
    const other = records[key];
    if (!other || (r.updated_at || 0) >= (other.updated_at || 0)) records[key] = r;
  }
  const papers = { ...(remoteDoc?.papers || {}) };
  for (const [id, p] of Object.entries(localDoc?.papers || {})) papers[id] = mergePaper(p, papers[id]);
  return {
    format: "citeweave-sync", version: 1,
    updated_at: Math.max(localDoc?.updated_at || 0, remoteDoc?.updated_at || 0, Date.now()),
    device: localDoc?.device || "",
    records, papers,
  };
}

function sameRecords(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a.records || {}), kb = Object.keys(b.records || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => b.records[k] && b.records[k].updated_at === a.records[k].updated_at) &&
    Object.keys(a.papers || {}).length === Object.keys(b.papers || {}).length;
}

// encryption -----------------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();
// in chunks: spreading a large library's bytes into one call overflows the argument limit
const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const unb64 = (s) => {
  const bin = atob(String(s || "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(doc, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFrom(pass, salt), enc.encode(JSON.stringify(doc)));
  return { format: "citeweave-sync-encrypted", version: 1, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function decrypt(doc, pass) {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(doc.iv) }, await keyFrom(pass, unb64(doc.salt)), unb64(doc.data));
    return JSON.parse(dec.decode(plain));
  } catch {
    throw new Error("Wrong passphrase. The synced file could not be unlocked.");
  }
}

// providers ------------------------------------------------------------------------------------
const providers = {};

providers.github = {
  label: "GitHub (private repo)",
  available: () => true,
  async read() { return (await api.post("/api/sync/github", { action: "read" })).document || null; },
  async write(doc) { await api.post("/api/sync/github", { action: "write", document: doc }); },
};

// a folder on this computer --------------------------------------------------------------------
const HANDLE_DB = "citeweave-ui";
function handleStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const t = req.result.transaction("handles", mode);
      const r = fn(t.objectStore("handles"));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
    };
  });
}

async function folderHandle(interactive) {
  let h = await handleStore("readonly", (s) => s.get("folder")).catch(() => null);
  if (!h) return null;
  let perm = await h.queryPermission?.({ mode: "readwrite" });
  if (perm !== "granted" && interactive) perm = await h.requestPermission?.({ mode: "readwrite" });
  if (perm !== "granted") throw new NeedsUser("Citeweave needs your permission to use the sync folder again.");
  return h;
}

export class NeedsUser extends Error {}

providers.folder = {
  label: "A folder on this computer",
  available: () => (isWeb() ? typeof globalThis.showDirectoryPicker === "function" : true),
  async pick() {
    if (!isWeb()) {
      const r = await api.post("/api/sync/folder/pick");
      return r.path;
    }
    const h = await showDirectoryPicker({ id: "citeweave-sync", mode: "readwrite" });
    await handleStore("readwrite", (s) => s.put(h, "folder"));
    saveLocal({ folderName: h.name });
    return h.name;
  },
  folderName() { return local().folderName || ""; },
  async read(interactive) {
    if (!isWeb()) return (await api.get("/api/sync/folder")).document || null;
    const dir = await folderHandle(interactive);
    if (!dir) throw new NeedsUser("Choose a sync folder first.");
    try {
      const fh = await dir.getFileHandle(FILE);
      const text = await (await fh.getFile()).text();
      return text.trim() ? JSON.parse(text) : null;
    } catch (e) {
      if (e?.name === "NotFoundError") return null;
      throw e;
    }
  },
  async write(doc, interactive) {
    if (!isWeb()) { await api.put("/api/sync/folder", doc); return; }
    const dir = await folderHandle(interactive);
    const fh = await dir.getFileHandle(FILE, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(doc));
    await w.close();
  },
};

// Google Drive (web only). Uses Google's sign-in script and the drive.file permission, which only
// lets Citeweave see the files it creates.
let gToken = null, gExpiry = 0;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

async function googleToken(interactive) {
  if (gToken && Date.now() < gExpiry - 60000) return gToken;
  if (!interactive) throw new NeedsUser("Google Drive sign-in has expired. Click Sync now to reconnect.");
  await loadScript("https://accounts.google.com/gsi/client");
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: config().googleClientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (r) => {
        if (r.error) { reject(new Error(`Google sign-in failed: ${r.error}`)); return; }
        gToken = r.access_token; gExpiry = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        saveLocal({ gdriveLinked: true });
        resolve(gToken);
      },
      error_callback: (e) => reject(new Error(e?.message || "Google sign-in was closed.")),
    });
    client.requestAccessToken({ prompt: local().gdriveLinked ? "" : "consent" });
  });
}

async function gfetch(url, opts, interactive) {
  const token = await googleToken(interactive);
  const r = await fetch(url, { ...opts, headers: { ...(opts?.headers || {}), Authorization: `Bearer ${token}` } });
  if (r.status === 401) { gToken = null; throw new NeedsUser("Google Drive sign-in has expired. Click Sync now to reconnect."); }
  if (!r.ok) throw new Error(`Google Drive answered ${r.status}`);
  return r;
}

async function gFileId(interactive) {
  const q = encodeURIComponent(`name='${FILE}' and trashed=false`);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`, {}, interactive);
  return (await r.json()).files?.[0]?.id || null;
}

providers.gdrive = {
  label: "Google Drive",
  available: () => isWeb() && !!config().googleClientId,
  async read(interactive) {
    const id = await gFileId(interactive);
    if (!id) return null;
    const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, {}, interactive);
    const text = await r.text();
    return text.trim() ? JSON.parse(text) : null;
  },
  async write(doc, interactive) {
    const id = await gFileId(interactive);
    const body = JSON.stringify(doc);
    if (id) {
      await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body }, interactive);
      return;
    }
    const boundary = "citeweave" + Math.random().toString(16).slice(2);
    const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE, mimeType: "application/json" })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body: multipart }, interactive);
  },
};

// OneDrive (web only). Microsoft sign-in with PKCE in a popup; the file lives in the app's own folder.
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const MS_SCOPE = "Files.ReadWrite.AppFolder offline_access";
function msTokens() { return local().ms || null; }

function randomString(n = 64) {
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (x) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"[x % 66]).join("");
}
async function challenge(verifier) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(verifier));
  return b64(d).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const redirectUri = () => new URL("auth.html", location.href.split("#")[0]).href;

async function msTokenRequest(params) {
  const r = await fetch(`${MS_AUTH}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config().microsoftClientId, scope: MS_SCOPE, ...params }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description?.split("\n")[0] || "Microsoft sign-in failed");
  // a refresh reply may leave out the refresh token; keep the one we have then
  const t = { access: data.access_token, refresh: data.refresh_token || params.refresh_token || null,
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  saveLocal({ ms: t });
  return t;
}

async function msSignIn() {
  const verifier = randomString(), stateStr = randomString(16);
  const url = `${MS_AUTH}/authorize?` + new URLSearchParams({
    client_id: config().microsoftClientId, response_type: "code", redirect_uri: redirectUri(), scope: MS_SCOPE,
    code_challenge: await challenge(verifier), code_challenge_method: "S256", state: stateStr, prompt: "select_account",
  });
  const popup = window.open(url, "citeweave-signin", "width=520,height=680");
  if (!popup) throw new Error("Allow pop-ups for this site to sign in with Microsoft.");
  const code = await new Promise((resolve, reject) => {
    // if the sign-in window is closed without finishing, stop waiting (otherwise sync stays stuck)
    const watch = setInterval(() => {
      if (!popup.closed) return;
      setTimeout(() => { done(); reject(new NeedsUser("The Microsoft sign-in window was closed. Click Sync now to try again.")); }, 800);
      clearInterval(watch);
    }, 700);
    const done = () => { clearInterval(watch); window.removeEventListener("message", onMsg); };
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.data?.type !== "citeweave-auth") return;
      done();
      const p = new URLSearchParams(e.data.search);
      if (p.get("state") !== stateStr) reject(new Error("Sign-in did not match. Try again."));
      else if (p.get("error")) reject(new Error(p.get("error_description") || p.get("error")));
      else resolve(p.get("code"));
    };
    window.addEventListener("message", onMsg);
  });
  return msTokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
}

async function msAccess(interactive) {
  let t = msTokens();
  if (t?.access && Date.now() < t.expires - 60000) return t.access;
  if (t?.refresh) {
    try { return (await msTokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh })).access; } catch { /* sign in again */ }
  }
  if (!interactive) throw new NeedsUser("OneDrive sign-in has expired. Click Sync now to reconnect.");
  return (await msSignIn()).access;
}

async function msFetch(path, opts, interactive) {
  const token = await msAccess(interactive);
  return fetch(`https://graph.microsoft.com/v1.0/me/drive/special/approot:/${FILE}${path}`, {
    ...opts, headers: { ...(opts?.headers || {}), Authorization: `Bearer ${token}` } });
}

providers.onedrive = {
  label: "OneDrive",
  available: () => isWeb() && !!config().microsoftClientId,
  async read(interactive) {
    const r = await msFetch(":/content", {}, interactive);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`OneDrive answered ${r.status}`);
    const text = await r.text();
    return text.trim() ? JSON.parse(text) : null;
  },
  async write(doc, interactive) {
    const r = await msFetch(":/content", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }, interactive);
    if (!r.ok) throw new Error(`OneDrive answered ${r.status}`);
  },
  signOut() { saveLocal({ ms: null }); },
};

export function availableProviders() {
  return Object.entries(providers).filter(([, p]) => p.available()).map(([name, p]) => ({ name, label: p.label }));
}
export function provider(name) { return providers[name]; }

// sync -----------------------------------------------------------------------------------------
let running = null;
const listeners = new Set();
export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitSync(info) { listeners.forEach((fn) => { try { fn(info); } catch { /* ignore */ } }); }

// isNew: no locked file exists yet, so this passphrase will be set now (ask for it twice)
async function passphrase(cfg, askPass, needed, isNew) {
  if (!needed) return "";
  const saved = local().pass;
  if (saved) return saved;
  const p = askPass ? await askPass({ confirm: isNew }) : "";
  if (!p) throw new NeedsUser("Enter your sync passphrase to unlock the synced data.");
  if (p.remember) saveLocal({ pass: p.value });
  return p.value || p;
}

// options: interactive (may open sign-in or folder permission), askPass() => {value, remember}
export async function syncNow({ interactive = false, askPass } = {}) {
  if (running) return running;
  let knownPass = null;
  const attempt = async () => {
    const cfg = (await api.get("/api/settings")).sync || {};
    const p = providers[cfg.provider];
    if (!p || !p.available()) throw new Error("Choose where to sync in Settings first.");
    emitSync({ state: "running" });
    const remoteRaw = await p.read(interactive);
    const encrypted = remoteRaw?.format === "citeweave-sync-encrypted";
    const pass = knownPass ?? await passphrase(cfg, askPass, encrypted || cfg.encrypt, !encrypted);
    if (pass) knownPass = pass; // a retry does not ask again
    let remote = remoteRaw;
    if (encrypted) {
      try { remote = await decrypt(remoteRaw, pass); } catch (e) {
        if (local().pass === pass) forgetPassphrase(); // a remembered passphrase that no longer works is asked for again
        throw e;
      }
    }
    if (remote && remote.format !== "citeweave-sync") remote = null;
    const localDoc = await api.get("/api/sync/export");
    const merged = merge(localDoc, remote);
    const applied = remote ? await api.post("/api/sync/import", merged) : { applied: 0, skipped: 0 };
    const changedRemote = !sameRecords(merged, remote) || encrypted !== !!cfg.encrypt;
    if (changedRemote) await p.write(cfg.encrypt ? await encrypt(merged, pass) : merged, interactive);
    const info = { state: "done", at: Date.now(), applied: applied.applied || 0, uploaded: changedRemote,
      records: Object.keys(merged.records).length };
    saveLocal({ last: info });
    emitSync(info);
    return info;
  };
  running = (async () => {
    try {
      return await attempt();
    } catch (e) {
      // another device saved between our read and write: read, merge and write once more
      if (!/changed on (another device|GitHub)/i.test(e?.message || "")) throw e;
      return attempt();
    }
  })();
  try {
    return await running;
  } catch (e) {
    emitSync({ state: e instanceof NeedsUser ? "needs-user" : "error", message: e.message });
    throw e;
  } finally {
    running = null;
  }
}

// Sync a few seconds after changes, and when the app opens.
let timer = null;
export function scheduleSync(delay = 8000) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const cfg = (await api.get("/api/settings")).sync || {};
      if (cfg.provider && cfg.provider !== "none" && cfg.auto !== false) await syncNow({ interactive: false });
    } catch { /* shown in Settings; never interrupts work */ }
  }, delay);
}

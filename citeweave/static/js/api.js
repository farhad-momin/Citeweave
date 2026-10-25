// Small wrapper around the Citeweave back end.
// PC app: the local server on this computer.
// Web version (window.CITEWEAVE_WEB): the engine that runs inside the browser (static/engine).

let engine = null;
async function webHandle(method, url, body) {
  engine ??= import("../engine/router.js");
  const { handle } = await engine;
  return handle(method, url, body);
}

const afterWrite = new Set();
// Called after any request that changes saved data (used to schedule sync).
export function onWrite(fn) { afterWrite.add(fn); return () => afterWrite.delete(fn); }
const QUIET = /^\/api\/(jobs|sync|inbox|ai\/(test|models)|cache|search|autocomplete|paper|cite|export|recommend|ask|map$|extract$|profile)/;

async function request(method, url, body) {
  let data;
  if (globalThis.CITEWEAVE_WEB) {
    data = await webHandle(method, url, body === undefined ? undefined : JSON.parse(JSON.stringify(body)));
  } else {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const type = res.headers.get("content-type") || "";
    data = type.includes("application/json") ? await res.json() : await res.text();
    if (!res.ok) {
      let msg = typeof data === "string" ? data : data.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => d.msg).join("; ");
      throw new Error(msg || `Request failed (${res.status})`);
    }
  }
  const path = url.split("?")[0];
  if (method !== "GET" && !QUIET.test(path)) notifyWrite(path);
  // these jobs save data only when they finish, so sync is scheduled then (see runJob)
  if (method === "POST" && /^\/api\/(import|extract)$/.test(path) && data?.job) writeJobs.add(String(data.job));
  return data;
}

const writeJobs = new Set();
function notifyWrite(path) { afterWrite.forEach((fn) => { try { fn(path); } catch { /* ignore */ } }); }

export const api = {
  get: (url) => request("GET", url),
  post: (url, body = {}) => request("POST", url, body),
  put: (url, body = {}) => request("PUT", url, body),
  patch: (url, body = {}) => request("PATCH", url, body),
  del: (url) => request("DELETE", url),
};

// A file download from the back end (CSV of a table). Returns text.
export async function fetchText(url) {
  if (globalThis.CITEWEAVE_WEB) return webHandle("GET", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.text();
}

export function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "" && v !== false) p.set(k, v);
  }
  return p.toString();
}

// Start a background job and poll it. onProgress(message, fraction).
export async function runJob(startPromise, onProgress, signal) {
  const { job } = await startPromise;
  while (true) {
    if (signal?.aborted) {
      api.del(`/api/jobs/${job}`).catch(() => {});
      throw new Error("Stopped");
    }
    const j = await api.get(`/api/jobs/${job}`);
    onProgress?.(j.message, j.progress);
    if (j.status !== "running" && writeJobs.delete(String(job)) && j.status === "done") notifyWrite(`/api/jobs/${job}`);
    if (j.status === "done") return j.result;
    if (j.status === "error") throw new Error(j.error);
    if (j.status === "cancelled") throw new Error("Stopped");
    await new Promise((r) => setTimeout(r, globalThis.CITEWEAVE_WEB ? 250 : 400));
  }
}

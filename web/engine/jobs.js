// Long tasks with progress, same shape as the PC app's jobs.py so the interface can poll them.
const JOBS = new Map();
let seq = 0;

export function start(kind, fn) {
  const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const controller = new AbortController();
  const job = {
    id, kind, status: "running", message: "Starting", progress: 0, result: null, error: null,
    started: Date.now() / 1000, controller,
  };
  JOBS.set(id, job);
  const progress = (message, fraction) => {
    if (message) job.message = message;
    if (typeof fraction === "number") job.progress = Math.max(0, Math.min(1, fraction));
  };
  // forget a job ten minutes after it finishes (never while it runs: long tables can take longer)
  const forget = () => {
    const t = setTimeout(() => JOBS.delete(id), 10 * 60 * 1000);
    t?.unref?.(); // never keep a test process alive
  };
  Promise.resolve()
    .then(() => fn(progress, controller.signal))
    .then((result) => {
      if (job.status === "cancelled") return;
      job.status = "done"; job.progress = 1; job.result = result;
    })
    .catch((e) => {
      if (job.status === "cancelled") return;
      job.status = "error"; job.error = e?.message || String(e);
      console.error(e);
    })
    .finally(forget);
  return id;
}

export function get(id) {
  const j = JOBS.get(id);
  if (!j) return null;
  const { controller, ...rest } = j;
  return rest;
}

export function cancel(id) {
  const j = JOBS.get(id);
  if (!j || j.status !== "running") return false;
  j.status = "cancelled";
  j.controller.abort();
  return true;
}

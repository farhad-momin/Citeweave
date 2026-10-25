/* global citeweaveDetect, citeweaveDetectUrl */
// Popup: find the paper on the current tab and send it to the Citeweave app on this computer.
const ext = globalThis.browser ?? globalThis.chrome;
const mainEl = document.getElementById("main");
const main = { replaceChildren: (...kids) => mainEl.replaceChildren(...kids.filter((k) => k != null)) };

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.filter((k) => k != null));
  return e;
};

async function base() {
  const { port } = await ext.storage.local.get({ port: 23120 });
  return `http://127.0.0.1:${port}`;
}

async function call(path, body) {
  const url = (await base()) + path;
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Citeweave answered ${res.status}`);
  return data;
}

function notRunning() {
  main.replaceChildren(
    el("p", { class: "title" }, "Citeweave is not open"),
    el("p", { class: "muted" }, "Start the Citeweave app on this computer, then try again."),
    el("div", { class: "row" }, el("button", { class: "primary", onclick: run }, "Try again")),
    el("p", { class: "small muted" }, "Using a different port? Change it in the extension options."));
}

async function detect() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:|^file:/.test(tab.url || "")) return { tab, info: null };
  try {
    const [res] = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: citeweaveDetect });
    return { tab, info: res?.result || citeweaveDetectUrl(tab.url, tab.title) };
  } catch {
    // the page does not allow scripts (for example a built-in PDF viewer): use its address
    return { tab, info: citeweaveDetectUrl(tab.url, tab.title) };
  }
}

// Web version: open it with the paper in the address; it saves or shows the paper itself.
async function runWeb(webUrl) {
  const { info } = await detect();
  if (!info || (!info.identifier && !info.title)) {
    main.replaceChildren(el("p", { class: "muted" }, "Open a journal article, preprint or database page, then click Citeweave again."));
    return;
  }
  const page = { ...info, selection: undefined };
  const go = (action) => async () => {
    const q = new URLSearchParams({ action, id: info.identifier || "", paper: JSON.stringify(page) });
    await ext.tabs.create({ url: `${webUrl}#/inbox?${q}` });
    window.close();
  };
  main.replaceChildren(
    el("p", { class: "title" }, info.title || info.identifier),
    el("div", { class: "muted small" }, [info.authors?.slice(0, 3).join(", "), [info.journal, info.year].filter(Boolean).join(", ")].filter(Boolean).join(". ")),
    info.identifier ? el("div", { class: "small muted" }, info.identifier) : el("p", { class: "small muted" }, "No DOI found on this page. Citeweave will search by title."),
    el("div", { class: "row" },
      el("button", { class: "primary", onclick: go("save") }, "Save"),
      el("button", { onclick: go("open") }, "Show in Citeweave"),
      el("button", { onclick: go("map") }, "Add to map")),
    el("p", { class: "small muted" }, "Opens the Citeweave web version in a new tab."));
}

async function run() {
  main.replaceChildren(el("p", { class: "muted" }, "Looking for the paper on this page..."));
  const settings = await ext.storage.local.get({ mode: "desktop", webUrl: "" });
  if (settings.mode === "web") {
    if (!settings.webUrl) {
      main.replaceChildren(el("p", { class: "muted" }, "Add the web version's address in the extension options first."),
        el("div", { class: "row" }, el("button", { class: "primary", onclick: () => ext.runtime.openOptionsPage() }, "Open options")));
      return;
    }
    await runWeb(settings.webUrl);
    return;
  }
  let ping;
  try { ping = await call("/api/ext/ping"); } catch { notRunning(); return; }
  const { info } = await detect();
  if (!info) {
    main.replaceChildren(el("p", { class: "muted" }, "Open a journal article, preprint or database page, then click Citeweave again."));
    return;
  }
  let paper;
  try {
    paper = await call("/api/ext/lookup", { identifier: info.identifier, title: info.identifier ? "" : info.title, page: info });
  } catch (e) {
    main.replaceChildren(
      el("p", { class: "title" }, "No paper found"),
      el("p", { class: "muted" }, e.message),
      el("p", { class: "small muted" }, "Tip: select the DOI on the page and click Citeweave again."));
    return;
  }
  const cols = ping.collections || [];
  const { lastCollection } = await ext.storage.local.get({ lastCollection: cols[0]?.id });
  const select = el("select", { id: "col" }, ...cols.map((c) => {
    const o = el("option", { value: c.id }, `${c.name} (${c.count})`);
    if (String(c.id) === String(lastCollection)) o.selected = true;
    return o;
  }));
  const status = el("div");
  const authors = (paper.authors || []).slice(0, 3).map((a) => a.name).join(", ") + ((paper.authors || []).length > 3 ? " et al." : "");
  const saveBtn = el("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      await call("/api/ext/save", { paper, collection_id: Number(select.value) });
      await ext.storage.local.set({ lastCollection: select.value });
      status.replaceChildren(el("div", { class: "done" }, `Saved to ${select.selectedOptions[0].textContent.replace(/\s*\(\d+\)$/, "")}.`));
      saveBtn.textContent = "Saved";
    } catch (e) { status.replaceChildren(el("p", { class: "err" }, e.message)); saveBtn.disabled = false; }
  } }, "Save");
  const send = (action, label) => el("button", { onclick: async () => {
    try { await call("/api/ext/open", { paper, action }); status.replaceChildren(el("div", { class: "done" }, label)); }
    catch (e) { status.replaceChildren(el("p", { class: "err" }, e.message)); }
  } }, action === "map" ? "Add to map" : "Show in app");

  main.replaceChildren(
    el("p", { class: "title" }, paper.title),
    el("div", { class: "muted small" }, [authors, [paper.venue, paper.year].filter(Boolean).join(", ")].filter(Boolean).join(". ")),
    paper.collections?.length ? el("span", { class: "badge" }, "Already in your library") : null,
    info.confidence === "low" ? el("p", { class: "small muted" }, "Found from a DOI on the page. Check it is the right paper.") : null,
    paper.from_page ? el("p", { class: "small muted" }, "Details taken from this page because the databases could not be reached.") : null,
    el("label", { for: "col" }, "Collection"), select,
    el("div", { class: "row" }, saveBtn, send("open", "Opened in Citeweave."), send("map", "Added to the citation map.")),
    status);
}

document.getElementById("open-app").addEventListener("click", async (e) => {
  e.preventDefault();
  const s = await ext.storage.local.get({ mode: "desktop", webUrl: "" });
  ext.tabs.create({ url: s.mode === "web" && s.webUrl ? s.webUrl : `${await base()}/` });
});

run();

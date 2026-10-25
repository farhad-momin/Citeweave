import { api, runJob } from "../api.js";
import { citeDialog, paperList } from "../paper.js";
import { addSeed, addTablePick, refreshCollections, state } from "../state.js";
import { btn, download, h, icon, modal, progressBox, prompt, showError, toast } from "../ui.js";

const STATUS_LABELS = { "to-read": "To read", reading: "Reading", read: "Read", skip: "Not relevant" };

export function render(root) {
  const left = h("div", { class: "colls" });
  const right = h("div");
  let filter = "all";
  let query = "";
  let drawToken = 0;

  async function drawCollections() {
    const cols = await refreshCollections();
    if (!state.currentCollection || !cols.find((c) => c.id === state.currentCollection)) state.currentCollection = cols[0]?.id || null;
    left.replaceChildren(
      ...cols.map((c) => h("button", { class: c.id === state.currentCollection ? "on" : "", onclick: () => { state.currentCollection = c.id; drawCollections().catch(showError); } },
        h("span", {}, c.name), h("span", { class: "muted small" }, c.count))),
      h("button", { onclick: async () => {
        const name = await prompt("New collection", "Name");
        if (!name) return;
        try {
          const c = await api.post("/api/collections", { name });
          state.currentCollection = c.id;
        } catch (e) { showError(e); }
        drawCollections().catch(showError);
      } }, h("span", { class: "muted" }, "+ New collection")),
      h("hr"),
      btn("Import", importDialog, { cls: "small ghost", ico: "upload" }),
      globalThis.CITEWEAVE_WEB ? null : btn("Zotero", zoteroDialog, { cls: "small ghost", ico: "download" }));
    drawPapers();
  }

  async function drawPapers() {
    const token = ++drawToken;
    const cid = state.currentCollection;
    if (!cid) { right.replaceChildren(h("div", { class: "empty" }, h("h3", {}, "No collections yet"))); return; }
    const col = state.collections.find((c) => c.id === cid);
    // keep the filter box focused (and the caret in place) when the list is redrawn while typing
    const oldFind = right.querySelector("input.find");
    const refocus = oldFind && document.activeElement === oldFind ? [oldFind.selectionStart, oldFind.selectionEnd] : null;
    if (!refocus) right.replaceChildren(h("p", { class: "muted" }, "Loading..."));
    let papers;
    try { papers = await api.get(`/api/collections/${encodeURIComponent(cid)}/papers`); } catch (e) { if (token === drawToken) right.replaceChildren(h("p", { class: "err" }, e.message)); return; }
    if (token !== drawToken) return; // a newer draw (another collection or filter) has started
    const shown = papers.filter((p) => (filter === "all" || p.status === filter) &&
      (!query || `${p.title} ${p.abstract} ${(p.authors || []).map((a) => a.name).join(" ")} ${(p.tags || []).join(" ")} ${p.note}`.toLowerCase().includes(query)));

    const filterSel = h("select", { class: "input", style: { height: "30px", fontSize: "13px" } },
      h("option", { value: "all" }, "All papers"), Object.entries(STATUS_LABELS).map(([k, v]) => h("option", { value: k }, v)));
    filterSel.value = filter;
    filterSel.addEventListener("change", () => { filter = filterSel.value; drawPapers(); });
    const find = h("input", { class: "input find", placeholder: "Filter this collection", "aria-label": "Filter this collection", value: query, style: { height: "30px", fontSize: "13px", width: "200px" } });
    find.addEventListener("input", () => { query = find.value.toLowerCase(); clearTimeout(find._t); find._t = setTimeout(() => drawPapers().catch(showError), 250); });

    const exportMenu = async () => {
      const fmtSel = h("select", { class: "input", style: { width: "100%" } },
        h("option", { value: "bibtex" }, "BibTeX (.bib) for LaTeX and most reference managers"),
        h("option", { value: "ris" }, "RIS (.ris) for Zotero, Mendeley, EndNote"),
        h("option", { value: "csv" }, "CSV (.csv) for Excel"));
      const f = await modal("Export collection", h("label", { class: "field" }, h("span", {}, "Format"), fmtSel),
        [{ label: "Cancel", value: null }, { label: "Export", cls: "primary", value: () => fmtSel.value }]);
      if (!f) return;
      try {
        const text = await api.post("/api/export", { collection_id: cid, format: f });
        const ext = { bibtex: "bib", ris: "ris", csv: "csv" }[f];
        download(`${col.name.replace(/[^\w-]+/g, "_")}.${ext}`, text);
      } catch (e) { showError(e); }
    };

    const head = h("div", { class: "row", style: { marginBottom: "6px" } },
      h("h1", { class: "grow", style: { margin: 0 } }, col.name),
      btn("Rename", async () => {
        const n = await prompt("Rename collection", "Name", col.name);
        if (!n) return;
        try { await api.patch(`/api/collections/${encodeURIComponent(cid)}`, { name: n }); } catch (e) { showError(e); }
        drawCollections().catch(showError);
      }, { cls: "small ghost" }),
      btn("Delete", async () => {
        const ok = await modal("Delete collection?", h("p", {}, `"${col.name}" will be removed. Papers in other collections stay.`),
          [{ label: "Cancel", value: null }, { label: "Delete", cls: "danger", value: true }]);
        if (!ok) return;
        try { await api.del(`/api/collections/${encodeURIComponent(cid)}`); state.currentCollection = null; } catch (e) { showError(e); }
        drawCollections().catch(showError);
      }, { cls: "small ghost danger", ico: "trash" }));
    const tools = h("div", { class: "row", style: { margin: "6px 0 14px" } },
      filterSel, find, h("span", { class: "spacer" }),
      btn("Similar papers", () => recommend(cid), { cls: "small", ico: "spark", disabled: !papers.length }),
      btn("Map", () => { papers.slice(0, 15).forEach(addSeed); location.hash = "#/map"; }, { cls: "small", ico: "map", disabled: !papers.length }),
      btn("Table", () => { papers.forEach(addTablePick); location.hash = "#/tables"; }, { cls: "small", ico: "plus", disabled: !papers.length }),
      btn("Cite", () => citeDialog(papers), { cls: "small", ico: "cite", disabled: !papers.length }),
      btn("Export", exportMenu, { cls: "small", ico: "download", disabled: !papers.length }),
      globalThis.CITEWEAVE_WEB ? null : btn("Send to Zotero", async () => {
        try { const r = await api.post("/api/zotero/send", { collection_id: cid }); toast(`Sent ${r.sent} papers to Zotero`); } catch (e) { showError(e); }
      }, { cls: "small", disabled: !papers.length }));

    right.replaceChildren(head, h("p", { class: "note-line" }, `${papers.length} papers`), tools);
    if (refocus) { find.focus(); find.setSelectionRange(...refocus); }
    if (!papers.length) {
      right.append(h("div", { class: "empty" }, h("h3", {}, "This collection is empty"),
        h("p", {}, "Save papers from Search, Ask or the citation map, import a BibTeX or RIS file, paste a list of DOIs, or bring in a Zotero collection.")));
      return;
    }
    const list = paperList(shown);
    // add a status picker and remove button to each row
    [...list.children].forEach((row, i) => {
      const p = shown[i];
      const sel = h("select", { class: "status-sel", title: "Reading status", onclick: (e) => e.stopPropagation() },
        Object.entries(STATUS_LABELS).map(([k, v]) => h("option", { value: k, selected: p.status === k }, v)));
      sel.addEventListener("change", () => api.post(`/api/collections/${encodeURIComponent(cid)}/status`, { paper_id: p.id, status: sel.value })
        .then(() => { p.status = sel.value; }).catch(showError));
      sel.addEventListener("keydown", (e) => e.stopPropagation());
      const rm = h("button", { class: "btn ghost small", title: "Remove from collection", "aria-label": "Remove from collection", onclick: async (e) => {
        e.stopPropagation();
        try { await api.post(`/api/collections/${encodeURIComponent(cid)}/remove`, { paper_id: p.id }); } catch (err) { showError(err); }
        drawCollections().catch(showError);
      } }, icon("trash"));
      row.querySelector(".side").prepend(sel);
      row.querySelector(".acts").append(rm);
      if (p.note) row.firstChild.append(h("div", { class: "small muted", style: { marginTop: "4px" } }, `Note: ${p.note.slice(0, 160)}`));
    });
    right.append(list);
  }

  async function recommend(cid) {
    const body = h("div", {}, h("p", { class: "muted" }, "Finding papers similar to this collection..."));
    const p = modal("Similar papers", body, [{ label: "Close", value: null }]);
    try {
      const r = await api.post("/api/recommend", { collection_id: cid, limit: 30 });
      body.replaceChildren(r.results.length ? paperList(r.results) : h("p", { class: "muted" }, "No suggestions found. Semantic Scholar and OpenAlex provide these; check they are on in Settings."));
    } catch (e) { body.replaceChildren(h("p", { class: "err" }, e.message)); }
    await p;
  }

  async function importDialog() {
    const ta = h("textarea", { class: "input", rows: 9, style: { width: "100%", fontFamily: "var(--mono)", fontSize: "12.5px" },
      placeholder: "Paste BibTeX, RIS, or a list of DOIs, arXiv ids or links (one per line)" });
    const file = h("input", { type: "file", accept: ".bib,.ris,.txt,.csv,.nbib" });
    file.addEventListener("change", async () => { if (file.files[0]) ta.value = await file.files[0].text(); });
    const target = h("select", { class: "input" }, state.collections.map((c) => h("option", { value: c.id, selected: c.id === state.currentCollection }, c.name)));
    const ok = await modal("Import papers", h("div", {}, ta, h("div", { class: "row", style: { marginTop: "10px" } }, file, h("span", { class: "spacer" }), h("label", { class: "field" }, h("span", {}, "Into"), target))),
      [{ label: "Cancel", value: null }, { label: "Import", cls: "primary", value: true }]);
    if (!ok || !ta.value.trim()) return;
    const pb = progressBox();
    right.prepend(pb.el);
    try {
      const r = await runJob(api.post("/api/import", { text: ta.value, collection_id: /^\d+$/.test(target.value) ? Number(target.value) : target.value }), pb.update);
      toast(`Imported ${r.added} new papers (${r.found} found)`);
      state.currentCollection = r.collection_id;
    } catch (e) { showError(e); }
    drawCollections().catch(showError);
  }

  async function zoteroDialog() {
    let st;
    try { st = await api.get("/api/zotero/status"); } catch (e) { showError(e); return; }
    if (!st.running) {
      await modal("Zotero", h("p", {}, "Open the Zotero desktop app, then try again. Citeweave talks to Zotero on this computer only."), [{ label: "Close", value: null }]);
      return;
    }
    if (!st.local_api) {
      await modal("Zotero", h("div", {},
        h("p", {}, "Zotero is running. Sending papers to Zotero works now (use “Send to Zotero” on a collection)."),
        h("p", {}, "To import from Zotero, turn on its local API: in Zotero open Settings, Advanced, and tick “Allow other applications on this computer to communicate with Zotero”.")),
      [{ label: "Close", value: null }]);
      return;
    }
    const cols = await api.get("/api/zotero/collections").catch((e) => { showError(e); return null; });
    if (!cols) return;
    const sel = h("select", { class: "input", style: { width: "100%" } }, h("option", { value: "" }, "Whole library"),
      cols.map((c) => h("option", { value: c.key }, `${c.name}${c.count != null ? ` (${c.count})` : ""}`)));
    const key = await modal("Import from Zotero", h("label", { class: "field" }, h("span", {}, "Zotero collection"), sel),
      [{ label: "Cancel", value: null }, { label: "Import", cls: "primary", value: () => sel.value || "__all" }]);
    if (!key) return;
    try {
      const name = key === "__all" ? "Zotero library" : cols.find((c) => c.key === key)?.name;
      const r = await api.post("/api/zotero/import", { collection_key: key === "__all" ? null : key, name });
      toast(`Imported ${r.added} papers from Zotero`);
      state.currentCollection = r.collection_id;
      drawCollections().catch(showError);
    } catch (e) { showError(e); }
  }

  root.append(h("div", { class: "page", style: { maxWidth: "1180px" } }, h("div", { class: "lib" }, h("div", {}, h("h3", { style: { marginTop: "6px" } }, "Collections"), left), right)));
  drawCollections().catch(showError);
}

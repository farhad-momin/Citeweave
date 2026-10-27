// Extraction tables: pick papers, describe columns, let the AI fill each cell from the paper's text.
import { api, fetchText, runJob } from "../api.js";
import { batches, bridgeDialog, noAbstractWarning, parseJsonReply, rowsFromReply, tablePrompt } from "../bridge.js";
import { openDrawer } from "../paper.js";
import { state } from "../state.js";
import { btn, download, h, icon, modal, progressBox, showError, toast } from "../ui.js";

export function render(root) {
  const aiOn = state.status?.ai?.enabled;
  let presets = [];
  let columns = state.tableColumns || [
    { name: "Method", instruction: "Key methods, models, tests or analysis used." },
    { name: "Key findings", instruction: "The main results, with numbers where given." },
  ];
  let current = null;

  const picksBox = h("div");
  const colsBox = h("div", { class: "cols" });
  const out = h("div");
  const nameInput = h("input", { class: "input", placeholder: "Table name", style: { width: "260px" } });
  const savedBox = h("div");

  function drawPicks() {
    const picks = state.tablePicks;
    picksBox.replaceChildren(
      h("div", { class: "row" }, h("h3", { class: "grow", style: { margin: "0" } }, `Papers (${picks.length})`),
        btn("Add from a collection", pickFromCollection, { cls: "small ghost", ico: "plus" }),
        picks.length ? btn("Clear", () => { state.tablePicks = []; drawPicks(); }, { cls: "small ghost" }) : null),
      picks.length
        ? h("div", { class: "picker", style: { marginTop: "8px" } }, picks.map((p) => h("div", { class: "pick" },
          h("span", { class: "grow" }, p.title, h("span", { class: "muted" }, p.year ? `, ${p.year}` : "")),
          h("button", { class: "btn ghost small", title: "Remove", "aria-label": `Remove ${p.title || "paper"}`, onclick: (e) => { e.preventDefault(); state.tablePicks = state.tablePicks.filter((x) => x.id !== p.id); drawPicks(); } }, icon("close")))))
        : h("p", { class: "muted small" }, "Use “Add to table” on any paper, “Make a table” on an answer, or add a whole collection."));
  }

  function drawCols() {
    state.tableColumns = columns;
    colsBox.replaceChildren(...columns.map((c, i) => {
      const n = h("input", { class: "input", value: c.name, placeholder: "Column name" });
      const ins = h("input", { class: "input", value: c.instruction || "", placeholder: "What to extract (helps the AI)" });
      n.addEventListener("input", () => (c.name = n.value));
      ins.addEventListener("input", () => (c.instruction = ins.value));
      return h("div", { class: "col-row" }, n, ins, h("button", { class: "btn ghost small", title: "Remove column", onclick: () => { columns.splice(i, 1); drawCols(); } }, icon("close")));
    }), h("div", {}, btn("Add column", () => { columns.push({ name: "", instruction: "" }); drawCols(); }, { cls: "small ghost", ico: "plus" })));
  }

  async function pickFromCollection() {
    const cols = state.collections;
    if (!cols.length) { toast("Your library has no collections yet"); return; }
    const sel = h("select", { class: "input", style: { width: "100%" } }, cols.map((c) => h("option", { value: c.id }, `${c.name} (${c.count})`)));
    const cid = await modal("Add a collection", sel, [{ label: "Cancel", value: null }, { label: "Add", cls: "primary", value: () => sel.value }]);
    if (!cid) return;
    let papers;
    try { papers = await api.get(`/api/collections/${encodeURIComponent(cid)}/papers`); } catch (e) { showError(e); return; }
    for (const p of papers) if (!state.tablePicks.find((x) => x.id === p.id)) state.tablePicks.push(p);
    drawPicks();
  }

  async function run(useAi = false) {
    const cols = columns.filter((c) => c.name.trim());
    if (!state.tablePicks.length) { toast("Add some papers first"); return; }
    if (!cols.length) { toast("Add at least one column"); return; }
    const pb = progressBox();
    out.replaceChildren(pb.el);
    try {
      current = await runJob(api.post("/api/extract", { papers: state.tablePicks, columns: cols, name: nameInput.value, use_ai: useAi }), pb.update);
      showTable(current);
      loadSaved();
    } catch (e) { out.replaceChildren(h("p", { class: "err" }, e.message)); }
  }

  // Fill the table with the researcher's own chatbot, a few papers at a time.
  async function runChatbot() {
    const cols = columns.filter((c) => c.name.trim());
    if (!state.tablePicks.length) { toast("Add some papers first"); return; }
    if (!cols.length) { toast("Add at least one column"); return; }
    const papers = state.tablePicks.slice(0, 200);
    noAbstractWarning(papers);
    const groups = batches(papers, 8);
    const rows = [];
    for (let i = 0; i < groups.length; i++) {
      const offset = i * 8;
      const got = await bridgeDialog({
        title: "Fill the table with your chatbot",
        intro: i === 0 ? "Use ChatGPT, Claude, Gemini or any chatbot you already have. No API key needed. Citeweave checks every quote against the paper's abstract and marks values it cannot confirm." : null,
        step: groups.length > 1 ? `Batch ${i + 1} of ${groups.length} (papers ${offset + 1} to ${offset + groups[i].length}). Start a new chat for each batch if replies get cut off.` : null,
        prompt: tablePrompt(cols, groups[i], offset),
        read: (text) => rowsFromReply(parseJsonReply(text), cols, groups[i], offset),
      });
      if (!got) {
        if (!rows.length) return;
        toast(`Stopped after ${rows.length} papers. Saving what is done so far.`);
        break;
      }
      rows.push(...got);
    }
    try {
      const name = nameInput.value.trim() || `Table ${new Date().toISOString().slice(0, 10)}`;
      const saved = await api.post("/api/tables", { name, columns: cols, rows });
      current = { id: saved.id, name, columns: cols, rows };
      showTable(current);
      loadSaved();
      const flagged = rows.filter((r) => r.error).length;
      toast(flagged ? `Table saved. ${flagged} row(s) need a check, see the notes in red.` : "Table saved");
    } catch (e) { showError(e); }
  }

  function showTable(t) {
    const table = h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, h("th", {}, "Paper"), t.columns.map((c) => h("th", {}, c.name)))),
      h("tbody", {}, t.rows.map((r) => h("tr", {},
        h("td", {}, h("a", { href: "#", onclick: (e) => { e.preventDefault(); openDrawer(r.paper?.id || r.paper_id); } }, r.paper?.title || r.paper_id),
          h("div", { class: "small muted", style: { fontFamily: "var(--ui)", fontWeight: 400 } },
            [r.paper?.year, r.based_on ? `read from the ${r.based_on}` : null].filter(Boolean).join(", ")),
          r.error ? h("div", { class: "err small" }, r.error) : null),
        t.columns.map((c) => {
          const v = r.values?.[c.name];
          return h("td", { class: "cell" }, v?.value || "", v?.quote && v.quote !== v.value ? h("span", { class: "q" }, `“${v.quote}”`) : null,
            v?.unverified ? h("span", { class: "unverified" }, v.quote ? "Quote not found in the source text" : "No supporting quote given") : null,
            v?.needs_review ? h("span", { class: "small muted", style: { display: "block", marginTop: "6px" } }, "Candidate excerpt. Review for relevance.") : null);
        })))));
    out.replaceChildren(
      h("div", { class: "row", style: { margin: "18px 0 10px" } }, h("h2", { class: "grow", style: { margin: 0 } }, t.name),
        btn("Download CSV", async () => {
          try { download(`${(t.name || "table").replace(/[^\w-]+/g, "_")}.csv`, await fetchText(`/api/tables/${encodeURIComponent(t.id)}/csv`), "text/csv"); }
          catch (e) { showError(e); }
        }, { cls: "small", ico: "download" })),
      t.rows.some((r) => r.mode === "extractive") ? h("p", { class: "callout" },
        "Free evidence mode retrieves candidate sentences using English keywords. It does not interpret findings. A missing match does not mean the paper omits the information. Review each excerpt in context.") : null,
      h("p", { class: "small muted" }, t.rows.some((r) => r.based_on === "full text")
        ? "Values come from each paper's abstract, or its full text when an open access PDF was available. Quotes show the supporting text. Check important values in the paper."
        : "Values come from each paper's abstract. Quotes show the supporting text. Check important values in the paper."),
      h("div", { class: "grid-wrap" }, table));
  }

  async function loadSaved() {
    const tables = await api.get("/api/tables").catch(() => []);
    savedBox.replaceChildren(tables.length ? h("h3", {}, "Saved tables") : "",
      ...tables.map((t) => h("div", { class: "row", style: { padding: "6px 0", borderBottom: "1px solid var(--line)" } },
        h("a", { href: "#", class: "grow", onclick: (e) => { e.preventDefault(); showTable(t); } }, t.name),
        h("span", { class: "small muted" }, `${t.rows.length} papers, ${t.columns.length} columns`),
        h("button", { class: "btn ghost small", title: "Delete table", "aria-label": "Delete table", onclick: async () => {
          try { await api.del(`/api/tables/${encodeURIComponent(t.id)}`); } catch (e) { showError(e); }
          loadSaved();
        } }, icon("trash")))));
  }

  const presetsBox = h("div", { class: "presets" });
  api.get("/api/extract/presets").then((p) => {
    presets = p;
    presetsBox.replaceChildren(h("span", { class: "small muted" }, "Quick add:"), ...presets.map((c) => btn(c.name, () => {
      if (!columns.find((x) => x.name === c.name)) { columns.push({ ...c }); drawCols(); }
    }, { cls: "small ghost" })));
  }).catch(showError);

  root.append(h("div", { class: "page", style: { maxWidth: "1180px" } },
    h("h1", {}, "Tables"),
    h("p", { class: "lede" }, "Pull the same details from many papers into one table: methods, samples, findings, anything you describe."),
    aiOn ? null : h("div", { class: "callout" },
      "Start with free evidence excerpts: no account, API key or model download required. ",
      "For interpreted answers, optionally configure a local model or your own API provider. ",
      h("a", { href: "#/settings" }, "Set up AI")),
    picksBox,
    h("h3", {}, "Columns"), presetsBox, colsBox,
    h("div", { class: "row", style: { marginTop: "12px" } }, nameInput,
      btn("Find evidence (free)", () => run(false), { cls: "primary" }),
      aiOn ? btn("Fill with AI", () => run(true)) : null,
      btn("Fill with my chatbot", runChatbot, { ico: "spark" })),
    out, h("hr"), savedBox));
  drawPicks(); drawCols(); loadSaved();
}

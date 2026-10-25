// Paper rows, the details drawer and the "save to collection" flow.
import { api } from "./api.js";
import { addSeed, addTablePick, refreshCollections, state } from "./state.js";
import { SOURCE_LABELS, authorsShort, btn, byline, copyText, fmt, h, icon, modal, pressable, showError, toast } from "./ui.js";

export function paperRow(p, { onOpen, extra, keySentence, number, selected } = {}) {
  const tags = h("div", { class: "tags" });
  if (p.verified) tags.append(h("span", { class: "tag ok", title: "Suggested by AI and confirmed in Crossref or OpenAlex" }, "Verified"));
  if (p.oa_url) tags.append(h("span", { class: "tag oa" }, "Open access"));
  if (p.type && !["article", "journal-article"].includes(p.type)) tags.append(h("span", { class: "tag" }, p.type.replace(/-/g, " ")));
  for (const t of p.tags || []) tags.append(h("span", { class: "tag" }, t));

  const saveBtn = h("button", {
    class: "btn ghost small", type: "button", title: p.saved ? "Saved in your library" : "Save to library",
    onclick: async (e) => { e.stopPropagation(); if (await saveToCollection([p])) { p.saved = true; saveBtn.replaceChildren(icon("saved")); } },
  }, icon(p.saved ? "saved" : "save"));

  const acts = h("div", { class: "acts" },
    saveBtn,
    h("button", { class: "btn ghost small", type: "button", title: "Add to citation map",
      onclick: (e) => { e.stopPropagation(); addSeed(p); toast("Added to the citation map", { action: () => (location.hash = "#/map"), actionLabel: "Open map" }); } }, icon("map")),
    p.oa_url ? h("a", { class: "btn ghost small", href: p.oa_url, target: "_blank", rel: "noopener", title: "Open the PDF",
      onclick: (e) => e.stopPropagation() }, icon("pdf")) : null,
  );

  const row = h("div", { class: `paper${selected ? " selected" : ""}`, tabindex: "0", role: "button",
    onclick: () => onOpen?.(p, row), onkeydown: (e) => { if (e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen?.(p, row); } } },
    h("div", {},
      h("div", { class: "t" }, number ? `${number}. ` : "", p.title),
      h("div", { class: "by" }, byline(p)),
      keySentence ? h("div", { class: "ks" }, keySentence) : (p.abstract ? h("div", { class: "ab" }, p.abstract) : null),
      tags.childElementCount ? tags : null,
      extra || null),
    h("div", { class: "side" },
      p.cited_by_count != null ? h("div", { class: "cites" }, h("b", {}, fmt(p.cited_by_count)), " citations") : null,
      acts));
  return row;
}

export function paperList(papers, opts = {}) {
  const wrap = h("div", { class: "papers" });
  papers.forEach((p, i) => {
    const row = paperRow(p, {
      ...opts,
      number: opts.numbered ? i + 1 : null,
      keySentence: opts.keySentences ? p.key_sentence : null,
      onOpen: (paper, el) => {
        wrap.querySelectorAll(".paper.selected").forEach((x) => x.classList.remove("selected"));
        el.classList.add("selected");
        openDrawer(paper);
      },
    });
    wrap.append(row);
  });
  return wrap;
}

// save flow ------------------------------------------------------------------------------
export async function saveToCollection(papers) {
  const cols = state.collections.length ? state.collections : await refreshCollections();
  let chosen = state.currentCollection || cols[0]?.id;
  const select = h("select", { class: "input", style: { width: "100%" } },
    cols.map((c) => h("option", { value: c.id, selected: c.id === chosen }, `${c.name} (${c.count})`)),
    h("option", { value: "__new" }, "New collection..."));
  const nameInput = h("input", { class: "input", placeholder: "Collection name", style: { width: "100%", display: "none", marginTop: "8px" } });
  select.addEventListener("change", () => { nameInput.style.display = select.value === "__new" ? "block" : "none"; if (select.value === "__new") nameInput.focus(); });
  const body = h("div", {},
    h("p", { class: "muted" }, papers.length === 1 ? papers[0].title : `${papers.length} papers`),
    h("label", { class: "field" }, h("span", {}, "Collection"), select), nameInput);
  const ok = await modal("Save to library", body, [{ label: "Cancel", value: null }, { label: "Save", cls: "primary", value: true }]);
  if (!ok) return false;
  try {
    let cid = select.value;
    if (cid === "__new") {
      const c = await api.post("/api/collections", { name: nameInput.value || "New collection" });
      cid = c.id;
    }
    const r = await api.post(`/api/collections/${cid}/papers`, { papers });
    await refreshCollections();
    const name = state.collections.find((c) => String(c.id) === String(cid))?.name || "collection";
    toast(r.added ? `Saved to ${name}` : `Already in ${name}`);
    return true;
  } catch (e) { showError(e); return false; }
}

// drawer ---------------------------------------------------------------------------------------
let drawerToken = 0;

export function closeDrawer() {
  const d = document.getElementById("drawer");
  d.hidden = true;
  d.replaceChildren();
}

export async function openDrawer(paperOrId) {
  const token = ++drawerToken;
  const d = document.getElementById("drawer");
  d.hidden = false;
  const base = typeof paperOrId === "string" ? { id: paperOrId, title: "Loading..." } : paperOrId;
  renderDrawer(d, base, true);
  try {
    const full = typeof paperOrId === "string"
      ? await api.get(`/api/paper?id=${encodeURIComponent(paperOrId)}`)
      : await api.post("/api/paper/details", { paper: paperOrId });
    if (token === drawerToken) renderDrawer(d, { ...base, ...full }, false);
  } catch (e) {
    if (token === drawerToken) renderDrawer(d, base, false, e.message);
  }
}

function renderDrawer(d, p, loading, error) {
  const inner = h("div", { class: "inner" });
  d.replaceChildren(h("button", { class: "btn ghost small close", type: "button", title: "Close", "aria-label": "Close paper details", onclick: closeDrawer }, icon("close")), inner);
  inner.append(h("h2", {}, p.title));
  if (p.authors?.length) inner.append(h("div", { class: "authors" }, authorsShort(p, 12)));
  inner.append(h("div", { class: "venue" }, [p.venue, p.year].filter(Boolean).join(", "),
    p.cited_by_count != null ? h("span", { class: "muted" }, `  ${fmt(p.cited_by_count)} citations`) : null));
  if (error) inner.append(h("p", { class: "err" }, error));

  const summaryBox = h("div");
  if (p.tldr) summaryBox.append(h("div", { class: "tldr" }, p.tldr));

  const actions = h("div", { class: "actions" },
    btn("Save", async () => { if (await saveToCollection([p])) openDrawer(p); }, { cls: "primary small", ico: p.collections?.length ? "saved" : "save" }),
    btn("Map", () => { addSeed(p); toast("Added to the citation map", { action: () => (location.hash = "#/map"), actionLabel: "Open map" }); }, { cls: "small", ico: "map" }),
    btn("Summarize", async (e) => {
      const b = e.currentTarget; b.disabled = true; b.lastChild.textContent = "Summarizing";
      try {
        const s = await api.post("/api/paper/summarize", { paper: p });
        summaryBox.replaceChildren(s.summary ? h("div", { class: "tldr" }, s.summary,
          h("div", { class: "small muted", style: { marginTop: "6px" } },
            s.kind === "ai" ? `AI summary from the ${s.based_on}` : s.kind === "source" ? "Short summary from Semantic Scholar" : "Key sentences from the abstract"))
          : h("p", { class: "muted" }, "No text available to summarize."));
      } catch (err) { showError(err); }
      b.disabled = false; b.lastChild.textContent = "Summarize";
    }, { cls: "small", ico: "spark" }),
    btn("Add to table", () => { addTablePick(p); toast("Added to the next table", { action: () => (location.hash = "#/tables"), actionLabel: "Open tables" }); }, { cls: "small", ico: "plus" }),
    btn("Cite", () => citeDialog([p]), { cls: "small", ico: "cite" }),
    p.oa_url ? h("a", { class: "btn small", href: p.oa_url, target: "_blank", rel: "noopener" }, icon("pdf"), "PDF") : null,
    p.url ? h("a", { class: "btn small", href: p.url, target: "_blank", rel: "noopener" }, icon("link"), "Source") : null,
  );
  inner.append(actions, summaryBox);

  if (loading) inner.append(h("p", { class: "muted" }, "Loading details..."));
  if (p.abstract) inner.append(h("div", { class: "abstract" }, p.abstract));
  else if (!loading) inner.append(h("p", { class: "muted" }, "No abstract available from the connected sources."));

  const ids = h("div", { class: "ids" });
  const addId = (k, v, href) => { if (v) ids.append(h("span", {}, k), href ? h("a", { href, target: "_blank", rel: "noopener" }, h("code", {}, v)) : h("code", {}, v)); };
  addId("DOI", p.doi, p.doi && `https://doi.org/${p.doi}`);
  addId("arXiv", p.ids?.arxiv, p.ids?.arxiv && `https://arxiv.org/abs/${p.ids.arxiv}`);
  addId("PubMed", p.ids?.pmid, p.ids?.pmid && `https://pubmed.ncbi.nlm.nih.gov/${p.ids.pmid}/`);
  addId("OpenAlex", p.ids?.openalex, p.ids?.openalex && `https://openalex.org/${p.ids.openalex}`);
  if (p.sources?.length) { ids.append(h("span", {}, "Data from"), h("span", {}, p.sources.map((s) => SOURCE_LABELS[s] || s).join(", "))); }
  inner.append(ids);
  if (p.topics?.length) inner.append(h("div", { class: "tags" }, p.topics.map((t) => h("span", { class: "tag" }, t))));

  // notes when saved
  if (p.collections?.length) {
    const ta = h("textarea", { class: "input", rows: 4, style: { width: "100%" }, placeholder: "Your notes on this paper" }, p.note || "");
    let timer;
    ta.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => api.put("/api/notes", { paper_id: p.id, body: ta.value }).catch(showError), 600); });
    const tagInput = h("input", { class: "input", style: { width: "100%" }, placeholder: "Tags, separated by commas", value: (p.tags || []).join(", ") });
    tagInput.addEventListener("change", () => api.put("/api/tags", { paper_id: p.id, tags: tagInput.value.split(",") }).catch(showError));
    inner.append(h("h3", {}, "Notes"), ta, h("div", { style: { height: "8px" } }), tagInput);
  }

  // references and citations
  if (!loading) {
    const list = h("div");
    const tabs = h("div", { class: "tabs" });
    let seq = 0;
    const load = async (kind, b) => {
      const mine = ++seq;
      tabs.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      list.replaceChildren(h("p", { class: "muted" }, "Loading..."));
      try {
        const r = await api.post(`/api/paper/${kind}`, { paper: p, limit: 100 });
        if (mine !== seq) return; // the other tab was picked meanwhile
        list.replaceChildren();
        if (!r.results.length) list.append(h("p", { class: "muted" }, kind === "references" ? "No reference list available." : "No citing papers found yet."));
        const sorted = [...r.results].sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0));
        for (const x of sorted) {
          list.append(h("div", { ...pressable(() => openDrawer(x)), class: "mini" },
            h("div", { class: "t" }, x.title), h("div", { class: "by" }, `${byline(x)}${x.cited_by_count != null ? `. ${fmt(x.cited_by_count)} citations` : ""}`)));
        }
        if (r.used) list.append(h("p", { class: "small muted" }, `From ${SOURCE_LABELS[r.used] || r.used}`));
      } catch (e) { if (mine === seq) list.replaceChildren(h("p", { class: "err" }, e.message)); }
    };
    const refB = h("button", { type: "button", onclick: (e) => load("references", e.currentTarget) }, `References${p.reference_count ? ` (${fmt(p.reference_count)})` : ""}`);
    const citB = h("button", { type: "button", onclick: (e) => load("citations", e.currentTarget) }, `Cited by${p.cited_by_count ? ` (${fmt(p.cited_by_count)})` : ""}`);
    tabs.append(refB, citB);
    inner.append(tabs, list);
  }
}

export async function citeDialog(papers) {
  const out = h("textarea", { class: "input", rows: 10, style: { width: "100%", fontFamily: "var(--mono)", fontSize: "12.5px" }, readonly: true });
  const seg = h("div", { class: "seg" });
  const show = async (fmtName, b) => {
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    try { out.value = (await api.post("/api/cite", { papers, format: fmtName })).text; } catch (e) { out.value = e.message; }
  };
  for (const [k, label] of [["apa", "APA"], ["bibtex", "BibTeX"], ["ris", "RIS"]]) {
    const b = h("button", { type: "button", onclick: (e) => show(k, e.currentTarget) }, label);
    seg.append(b);
  }
  const body = h("div", {}, seg, h("div", { style: { height: "10px" } }), out);
  setTimeout(() => seg.firstChild.click(), 0);
  const r = await modal("Cite", body, [{ label: "Close", value: null }, { label: "Copy", cls: "primary", value: "copy" }]);
  if (r === "copy") copyText(out.value, "Citation copied");
}

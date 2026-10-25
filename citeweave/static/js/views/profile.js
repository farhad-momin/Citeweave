// Researcher profile: load works by ORCID, OpenAlex author, Semantic Scholar author or Scopus author id.
import { api, runJob } from "../api.js";
import { paperList, saveToCollection } from "../paper.js";
import { state } from "../state.js";
import { btn, fmt, h, progressBox } from "../ui.js";

const KINDS = [
  { kind: "orcid", label: "ORCID iD", placeholder: "0000-0002-1825-0097", help: "Public ORCID record, no key needed", field: "orcid" },
  { kind: "openalex", label: "OpenAlex author", placeholder: "A5023888391", help: "From an openalex.org/authors link", field: "openalex_author" },
  { kind: "s2", label: "Semantic Scholar author", placeholder: "1741101", help: "From a semanticscholar.org/author link", field: "s2_author" },
  { kind: "scopus", label: "Scopus author id", placeholder: "57190000000", help: "Needs your Scopus key in Settings", field: "scopus_author" },
];

export function render(root) {
  const out = h("div");
  const saved = state.settings?.profile || {};

  async function load(kind, value) {
    if (!value.trim()) return;
    const pb = progressBox();
    out.replaceChildren(pb.el);
    try {
      const r = await runJob(api.post("/api/profile/load", { kind, value }), pb.update);
      state.lastProfile = r;
      // the back end remembers the identifier; keep the in-memory settings in step for the next visit
      const field = KINDS.find((k) => k.kind === kind)?.field;
      if (state.settings && field) state.settings.profile = { ...(state.settings.profile || {}), [field]: value };
      show(r);
    } catch (e) { out.replaceChildren(h("p", { class: "err" }, e.message)); }
  }

  function show(r) {
    const i = r.info || {};
    const c = i.computed || {};
    out.replaceChildren(
      h("h2", {}, i.name || "Researcher"),
      i.institution ? h("p", { class: "muted", style: { marginTop: "-6px" } }, i.institution) : null,
      h("div", { class: "stats" },
        h("div", { class: "stat" }, h("b", {}, fmt(c.works)), h("span", {}, "works found")),
        h("div", { class: "stat" }, h("b", {}, fmt(c.citations)), h("span", {}, "citations")),
        h("div", { class: "stat" }, h("b", {}, c.h_index), h("span", {}, "h-index")),
        h("div", { class: "stat" }, h("b", {}, c.i10_index), h("span", {}, "i10-index"))),
      h("p", { class: "small muted" }, "Counts come from open data and may differ from other databases."),
      h("div", { class: "row", style: { margin: "10px 0" } },
        btn("Save all to a collection", () => saveToCollection(r.works), { cls: "small", ico: "save", disabled: !r.works.length })),
      paperList(r.works));
  }

  const grid = h("div", { class: "id-grid" });
  for (const k of KINDS) {
    const input = h("input", { class: "input", placeholder: k.placeholder, value: saved[k.field] || "" });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") load(k.kind, input.value); });
    grid.append(h("div", {}, h("div", { style: { fontWeight: 600 } }, k.label), h("div", { class: "small muted" }, k.help)), input,
      btn("Load", () => load(k.kind, input.value), { cls: "small" }));
  }

  root.append(h("div", { class: "page" },
    h("h1", {}, "Researcher"),
    h("p", { class: "lede" }, "Connect a researcher identifier to see the publication list and citation counts, and save the works to your library. Google Scholar has no public API, so use ORCID or OpenAlex instead."),
    grid, out));
  if (state.lastProfile) show(state.lastProfile);
}

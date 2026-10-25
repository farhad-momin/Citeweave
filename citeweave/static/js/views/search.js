import { api, qs } from "../api.js";
import { bridgeDialog, parseJsonReply, suggestPrompt } from "../bridge.js";
import { paperList, saveToCollection } from "../paper.js";
import { smartRank } from "../smart.js";
import { addSeed, state } from "../state.js";
import { SOURCE_LABELS, btn, h } from "../ui.js";

export function render(root) {
  const s = state.lastSearch || { q: "", source: "auto", year_from: "", year_to: "", oa_only: false, sort: "relevance", data: null };
  const sources = (state.status?.sources || []).filter((x) => x.capabilities.includes("search"));
  const aiOn = state.status?.ai?.enabled;

  const input = h("input", { class: "input big", placeholder: "Search topics, titles, or paste a DOI, arXiv id or link", value: s.q, "aria-label": "Search" });
  const sourceSel = h("select", { class: "input", "aria-label": "Source" },
    h("option", { value: "auto" }, "All sources (automatic)"),
    sources.map((x) => h("option", { value: x.name, disabled: !x.ready, title: x.reason }, `${x.label}${x.ready ? "" : " (needs setup)"}`)),
    h("option", { value: "ai", disabled: !aiOn }, aiOn ? "AI suggestions (verified)" : "AI suggestions (set up AI first)"),
    h("option", { value: "chatbot" }, "Ask my chatbot for papers (verified)"));
  sourceSel.value = s.source;
  const yf = h("input", { class: "input", type: "number", placeholder: "From year", value: s.year_from, min: 1800, max: 2100 });
  const yt = h("input", { class: "input", type: "number", placeholder: "To year", value: s.year_to, min: 1800, max: 2100 });
  const oa = h("input", { type: "checkbox", checked: s.oa_only });
  const sort = h("select", { class: "input" },
    h("option", { value: "relevance" }, "Most relevant"), h("option", { value: "citations" }, "Most cited"), h("option", { value: "newest" }, "Newest"));
  sort.value = s.sort;
  const results = h("div");
  const suggest = h("div", { class: "suggest", hidden: true });
  let seq = 0;

  async function go() {
    const q = input.value.trim();
    if (!q) return;
    const mine = ++seq;
    clearTimeout(acTimer);
    suggest.hidden = true;
    Object.assign(s, { q, source: sourceSel.value, year_from: yf.value, year_to: yt.value, oa_only: oa.checked, sort: sort.value });
    state.lastSearch = s;
    if (s.source === "chatbot") { await fromChatbot(q, mine); return; }
    results.replaceChildren(h("p", { class: "muted" }, sourceSel.value === "ai" ? "Asking the AI and checking every suggestion..." : "Searching..."));
    try {
      const d = await api.get(`/api/search?${qs({ q, source: s.source, year_from: s.year_from, year_to: s.year_to, oa_only: s.oa_only, sort: s.sort })}`);
      if (s.sort === "relevance" && s.source !== "ai" && !d.used?.includes("lookup") && d.results.length > 2) {
        d.results = await smartRank(q, d.results).catch(() => d.results);
      }
      if (mine !== seq) return; // a newer search has started
      s.data = d;
      show();
    } catch (e) {
      if (mine === seq) results.replaceChildren(h("p", { class: "err" }, e.message));
    }
  }

  async function fromChatbot(q, mine) {
    const items = await bridgeDialog({
      title: "Ask your chatbot for papers",
      intro: "Your chatbot suggests papers, then Citeweave looks up every one in Crossref and OpenAlex. Anything that cannot be found is left out, so invented references never reach your library.",
      prompt: suggestPrompt(q, 12),
      read: (text) => {
        const data = parseJsonReply(text);
        const list = (Array.isArray(data) ? data : data.papers || []).filter((x) => x && x.title);
        if (!list.length) throw new Error("No paper titles found in the reply.");
        return list;
      },
    });
    if (!items) { results.replaceChildren(); show(); return; }
    results.replaceChildren(h("p", { class: "muted" }, `Checking ${items.length} suggestions against the databases...`));
    try {
      const r = await api.post("/api/ai/verify", { items: items.slice(0, 25) });
      if (mine !== seq) return;
      s.data = { results: r.results, used: ["chatbot"], errors: {}, rejected: r.rejected };
      show();
    } catch (e) {
      if (mine === seq) results.replaceChildren(h("p", { class: "err" }, e.message));
    }
  }

  function show() {
    const d = s.data;
    results.replaceChildren();
    if (!d) {
      results.append(h("div", { class: "empty" },
        h("h3", {}, "Find papers across open scholarly databases"),
        h("p", {}, "Type a topic, or paste a DOI, arXiv id, PubMed id or article link to open that paper directly. ",
          "Save papers to your library, add them to a citation map, or pull them into a table.")));
      return;
    }
    const used = d.used.map((u) => SOURCE_LABELS[u] || u).join(", ");
    const errs = Object.entries(d.errors || {});
    const head = h("div", { class: "row" },
      h("div", { class: "note-line grow" }, d.results.length ? `${d.results.length} results${used ? ` from ${used}` : ""}` : "No results",
        d.rejected?.length ? `. ${d.rejected.length} suggestions could not be found in any database and were left out.` : ""),
      d.results.length ? btn("Save all", () => saveToCollection(d.results), { cls: "small ghost", ico: "save" }) : null,
      d.results.length ? btn("Map top 5", () => { d.results.slice(0, 5).forEach(addSeed); location.hash = "#/map"; }, { cls: "small ghost", ico: "map" }) : null);
    results.append(head);
    if (errs.length) results.append(h("div", { class: "errors" }, errs.map(([k, v]) => h("div", {}, `${SOURCE_LABELS[k] || k}: ${v}`))));
    if (!d.results.length) {
      results.append(h("div", { class: "empty" }, h("p", {}, "Try fewer or broader words, remove the year limits, or pick another source.")));
      return;
    }
    results.append(paperList(d.results));
  }

  // autocomplete (cheap OpenAlex endpoint)
  let acTimer;
  input.addEventListener("input", () => {
    clearTimeout(acTimer);
    const q = input.value.trim();
    if (q.length < 4 || /^10\.|https?:/.test(q)) { suggest.hidden = true; return; }
    acTimer = setTimeout(async () => {
      try {
        const items = await api.get(`/api/autocomplete?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return; // the text changed while waiting
        suggest.replaceChildren(...items.slice(0, 6).map((it) => h("div", {
          onmousedown: (e) => e.preventDefault(), // keep focus in the box so blur does not hide the list first
          onclick: () => { input.value = it.title; suggest.hidden = true; go(); },
        }, it.title, it.hint ? h("small", {}, it.hint) : null)));
        suggest.hidden = !items.length || document.activeElement !== input;
      } catch { suggest.hidden = true; }
    }, 350);
  });
  input.addEventListener("keydown", (e) => {
    const items = [...suggest.children];
    const cur = items.findIndex((x) => x.classList.contains("on"));
    if (!suggest.hidden && items.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      // -1 means back in the text box
      let next = cur + (e.key === "ArrowDown" ? 1 : -1);
      if (next < -1) next = items.length - 1;
      if (next >= items.length) next = -1;
      items.forEach((x, i) => x.classList.toggle("on", i === next));
      return;
    }
    if (e.key === "Enter") { if (!suggest.hidden && cur >= 0) items[cur].click(); else go(); }
    if (e.key === "Escape" && !suggest.hidden) { e.stopPropagation(); suggest.hidden = true; }
  });
  input.addEventListener("blur", () => setTimeout(() => (suggest.hidden = true), 200));

  root.append(h("div", { class: "page" },
    h("h1", {}, "Search"),
    h("p", { class: "lede" }, "Open data from OpenAlex, Semantic Scholar, Crossref, Europe PMC, arXiv and PubMed. No account and no credits."),
    h("div", { class: "searchbar" }, input, btn("Search", go, { cls: "primary" }), suggest),
    h("div", { class: "filters" }, sourceSel, sort, yf, yt, h("label", { class: "check" }, oa, "Open access only")),
    results));
  show();
  if (!s.data) input.focus();

  // allow "search for" from other views
  if (state.pendingSearch) { input.value = state.pendingSearch; state.pendingSearch = null; go(); }
}

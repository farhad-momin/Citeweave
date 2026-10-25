import { api } from "../api.js";
import { refreshStatus, state } from "../state.js";
import { btn, h, showError, toast } from "../ui.js";
import { smartSection, syncSection } from "./settings-sync.js";

const isWeb = () => !!globalThis.CITEWEAVE_WEB;

export async function render(root) {
  const page = h("div", { class: "page settings" }, h("h1", {}, "Settings"), h("p", { class: "lede" }, isWeb()
    ? "Everything is stored in this browser on this computer. Keys are only sent to the service they belong to."
    : "Everything is stored on this computer. Keys are only sent to the service they belong to."));
  root.append(page);
  let cfg, presets;
  try {
    [cfg, presets] = await Promise.all([api.get("/api/settings"), api.get("/api/ai/presets")]);
  } catch (e) { page.append(h("p", { class: "err" }, e.message)); return; }
  state.settings = cfg;
  const status = state.status || (await refreshStatus());

  async function save(patch, msg = "Saved") {
    try {
      cfg = await api.put("/api/settings", patch);
      state.settings = cfg;
      await refreshStatus();
      if (msg) toast(msg);
      return cfg;
    } catch (e) { showError(e); return null; }
  }

  // general -------------------------------------------------------------------------------
  const email = h("input", { class: "input", type: "email", value: cfg.email || "", placeholder: "you@university.edu" });
  email.addEventListener("change", () => save({ email: email.value.trim() }));
  const theme = h("select", { class: "input" }, ["system", "light", "dark"].map((t) => h("option", { value: t, selected: cfg.theme === t }, t[0].toUpperCase() + t.slice(1))));
  theme.addEventListener("change", () => { save({ theme: theme.value }, null); applyTheme(theme.value); });
  page.append(h("section", {},
    h("h2", {}, "General"),
    h("div", { class: "form-grid" },
      h("label", { class: "field" }, h("span", {}, "Your email (optional)"), email,
        h("small", {}, "Shared only with Crossref, OpenAlex, PubMed and Unpaywall, who ask for a contact address and give faster, more reliable access in return. Unpaywall needs it to find open access PDFs.")),
      h("label", { class: "field" }, h("span", {}, "Appearance"), theme))));

  // sources ----------------------------------------------------------------------------------
  const srcBox = h("div");
  function drawSources() {
    // read the status fresh: save() refreshes it, so "Ready" follows a newly entered key
    const live = state.status || status;
    const infos = Object.fromEntries(live.sources.map((s) => [s.name, s]));
    const order = cfg.search.order.filter((n) => infos[n]);
    const others = ["opencitations", "unpaywall"].filter((n) => infos[n]);
    srcBox.replaceChildren(...[...order, ...others].map((name, i) => {
      const info = infos[name];
      const sc = cfg.sources[name] || {};
      const enabled = h("input", { type: "checkbox", checked: sc.enabled !== false, title: "Use this source" });
      enabled.addEventListener("change", () => save({ sources: { [name]: { enabled: enabled.checked } } }).then(drawSources));
      const hasKeyField = "key" in sc;
      const key = hasKeyField ? h("input", { class: "input", type: "password", value: sc.key || "", placeholder: info.key_required ? "API key (required)" : "API key (optional)", autocomplete: "off" }) : null;
      key?.addEventListener("change", () => save({ sources: { [name]: { key: key.value } } }, "Key saved").then(drawSources));
      const extra = name === "scopus" ? h("input", { class: "input", type: "password", value: sc.insttoken || "", placeholder: "Institution token (optional)", style: { marginTop: "6px" } }) : null;
      extra?.addEventListener("change", () => save({ sources: { scopus: { insttoken: extra.value } } }, "Saved"));
      const isSearch = i < order.length;
      const move = (dir) => {
        const o = [...order];
        const j = i + dir;
        if (j < 0 || j >= o.length) return;
        [o[i], o[j]] = [o[j], o[i]];
        save({ search: { order: o } }, null).then(drawSources);
      };
      const ready = !!info.ready;
      return h("div", { class: "src-row" },
        isSearch ? h("div", { class: "order-btns" }, h("button", { type: "button", title: "Move up", "aria-label": `Move ${info.label} up`, onclick: () => move(-1) }, "▲"), h("button", { type: "button", title: "Move down", "aria-label": `Move ${info.label} down`, onclick: () => move(1) }, "▼")) : h("span"),
        h("div", {}, h("label", { class: "check" }, enabled, h("span", { class: "name" }, info.label)),
          h("div", { class: "small muted", style: { marginTop: "2px" } }, h("span", { class: `dot ${ready ? "ok" : "no"}` }), ready ? " Ready" : " Not ready")),
        h("div", { class: "help" }, describe(name), info.key_help ? h("div", {}, info.key_help) : null, !ready && info.reason ? h("div", { class: "err" }, info.reason) : null),
        h("div", {}, key, extra));
    }));
  }
  const mode = h("select", { class: "input" },
    h("option", { value: "fallback", selected: cfg.search.mode === "fallback" }, "Use the first source that answers (fast, light)"),
    h("option", { value: "merge", selected: cfg.search.mode === "merge" }, "Combine the top sources (more complete)"));
  mode.addEventListener("change", () => save({ search: { mode: mode.value } }));
  page.append(h("section", {},
    h("h2", {}, "Data sources"),
    h("p", { class: "muted small" }, "All sources below work for free. Searches try them in this order and move to the next one if a source is off, busy or out of its daily allowance. Optional keys raise the limits."),
    h("label", { class: "field", style: { maxWidth: "460px", marginBottom: "8px" } }, h("span", {}, "Search mode"), mode),
    srcBox, isWeb() ? relayField() : null));
  drawSources();
  page.append(smartSection(cfg, save));

  function relayField() {
    const relay = h("input", { class: "input", value: cfg.relay?.url || "", placeholder: "https://citeweave-relay.your-name.workers.dev" });
    relay.addEventListener("change", () => save({ relay: { url: relay.value.trim().replace(/\/+$/, "") } }));
    return h("label", { class: "field", style: { maxWidth: "620px", marginTop: "14px" } }, h("span", {}, "Relay (optional)"), relay,
      h("small", {}, "Semantic Scholar, arXiv and CORE refuse requests from web pages, so the web version skips them. A free relay you run yourself brings them back; see web/relay in the project. Everything else works without it."));
  }

  // AI -------------------------------------------------------------------------------------------
  const aiBox = h("div");
  function drawAI() {
    const ai = cfg.ai;
    const preset = presets.find((p) => p.name === ai.provider);
    const provider = h("select", { class: "input" }, h("option", { value: "none" }, "Off (no AI, everything still works)"),
      presets.map((p) => h("option", { value: p.name, selected: ai.provider === p.name }, p.label)));
    provider.addEventListener("change", () => save({ ai: { provider: provider.value, model: "", base_url: "" } }, null).then(drawAI));
    aiBox.replaceChildren(h("div", { class: "form-grid" }, h("label", { class: "field" }, h("span", {}, "Provider"), provider)));
    if (!preset) {
      aiBox.append(h("p", { class: "muted small" }, "Without AI: search, maps, library, export, profiles, and ranked answers built from key sentences all work. AI adds written answers, summaries and tables."));
      return;
    }
    const fields = aiBox.firstChild;
    if (preset.needs_key || preset.name === "custom") {
      const key = h("input", { class: "input", type: "password", autocomplete: "off", value: ai.keys[preset.name] || "", placeholder: preset.needs_key ? "API key" : "API key (if the server needs one)" });
      key.addEventListener("change", () => save({ ai: { keys: { [preset.name]: key.value } } }, "Key saved"));
      fields.append(h("label", { class: "field" }, h("span", {}, "API key"), key, h("small", {}, preset.key_help)));
    } else {
      const note = h("small", {}, preset.key_help);
      fields.append(h("div", { class: "field" }, h("span", {}, "Setup"), note));
      if (preset.name === "browser") {
        api.get("/api/ai/builtin").then((r) => {
          note.textContent = r.available === "available" ? "Ready on this computer." : r.available === "downloadable" || r.available === "downloading"
            ? "Available. The browser downloads the model the first time you use it (it is large, so use a good connection)."
            : "Not available in this browser. It needs a recent desktop version of Chrome on a computer with enough memory. Choose another provider, or use your chatbot from the Ask and Tables pages.";
        }).catch(() => {});
      }
    }
    if (preset.local && preset.name !== "browser") {
      const base = h("input", { class: "input", value: ai.base_url || "", placeholder: preset.base_url });
      base.addEventListener("change", () => save({ ai: { base_url: base.value.trim() } }));
      fields.append(h("label", { class: "field" }, h("span", {}, "Server address"), base));
    }
    const list = h("datalist", { id: "model-list" });
    const model = h("input", { class: "input", value: ai.model || "", placeholder: preset.default_model || "model name", list: "model-list" });
    model.addEventListener("change", () => save({ ai: { model: model.value.trim() } }));
    const loadModels = btn("Load models", async () => {
      try {
        const r = await api.post("/api/ai/models");
        list.replaceChildren(...r.models.map((m) => h("option", { value: m })));
        toast(r.models.length ? `${r.models.length} models found. Click the model box to choose.` : "No models found");
      } catch (e) { showError(e); }
    }, { cls: "small ghost" });
    fields.append(h("label", { class: "field" }, h("span", {}, "Model"), model, list, h("div", {}, loadModels)));
    const temp = h("input", { class: "input", type: "number", min: 0, max: 1, step: 0.1, value: ai.temperature ?? 0.2 });
    temp.addEventListener("change", () => save({ ai: { temperature: Number(temp.value) } }));
    fields.append(h("label", { class: "field" }, h("span", {}, "Creativity (0 to 1)"), temp, h("small", {}, "Keep it low for factual work.")));
    const result = h("span", { class: "small" });
    aiBox.append(h("div", { class: "row", style: { marginTop: "14px" } }, btn("Test connection", async () => {
      result.textContent = "Testing...";
      try { const r = await api.post("/api/ai/test"); result.textContent = `Working. ${r.model} replied "${r.reply}".`; result.style.color = "var(--ok)"; }
      catch (e) { result.textContent = e.message; result.style.color = "var(--danger)"; }
    }, { cls: "small" }), result));
  }
  page.append(h("section", {}, h("h2", {}, "AI (optional)"),
    h("p", { class: "muted small" }, "Pick any provider, or none. Ollama runs models on your own computer for free. Cloud providers use your own key and bill you directly."),
    aiBox));
  drawAI();

  // full text ----------------------------------------------------------------------------------
  const pdf = h("input", { type: "checkbox", checked: cfg.fulltext.allow_pdf_download });
  pdf.addEventListener("change", () => save({ fulltext: { allow_pdf_download: pdf.checked } }));
  const maxChars = h("input", { class: "input", type: "number", min: 4000, max: 200000, step: 1000, value: cfg.fulltext.max_chars });
  maxChars.addEventListener("change", () => save({ fulltext: { max_chars: Number(maxChars.value) } }));
  if (!isWeb()) page.append(h("section", {}, h("h2", {}, "Full text"),
    h("label", { class: "check" }, pdf, "Read open access PDFs when filling tables and writing summaries"),
    h("p", { class: "muted small" }, "Only legal open access copies are used, and each is read once and kept on this computer. Turn this off to work from abstracts only."),
    h("label", { class: "field", style: { maxWidth: "300px" } }, h("span", {}, "Maximum characters sent to the AI per paper"), maxChars,
      h("small", {}, "Lower this for small local models."))));

  // extension -----------------------------------------------------------------------------------
  page.append(h("section", {}, h("h2", {}, "Browser extension"),
    h("p", {}, "The Citeweave extension for Chrome, Edge, Brave and Firefox finds the paper on any journal page and saves it here, or opens it on the citation map."),
    isWeb()
      ? h("p", { class: "muted small" }, "In the extension's options, choose Web version and enter this page's address: ", h("code", { class: "inline" }, location.href.split("#")[0]),
        ". The extension then opens papers here. See the README for installation steps.")
      : h("p", { class: "muted small" }, "The app must be open for the extension to work. It talks to ", h("code", { class: "inline" }, `http://127.0.0.1:${cfg.port}`),
        " and nothing else. See the README for installation steps.")));
  page.append(syncSection(cfg, save));

  // data ---------------------------------------------------------------------------------------------
  page.append(h("section", {}, h("h2", {}, "Your data"),
    isWeb()
      ? h("p", {}, "Library, notes, maps, tables and settings are stored in this browser. Clearing the browser's site data removes them, so turn on sync or download a backup now and then.")
      : h("p", {}, "Library, notes, maps, tables and settings are stored in ", h("code", { class: "inline" }, status.data_dir), "."),
    h("p", { class: "muted small" }, "Responses from the data sources are cached so repeat lookups cost nothing and work faster."),
    btn("Clear cached responses", async () => {
      try {
        const r = await api.post("/api/cache/clear");
        toast(r.removed === "all" ? "Cleared cached responses" : `Cleared ${r.removed} cached responses`);
      } catch (e) { showError(e); }
    }, { cls: "small" })));

  page.append(h("section", {}, h("h2", {}, "About"),
    h("p", {}, `Citeweave ${status.version}. Free and open source, made for the research community.`),
    h("p", { class: "muted small" }, "Paper data comes from OpenAlex (CC0), Crossref, OpenCitations (CC0), Semantic Scholar (Allen Institute for AI), Europe PMC, PubMed (NCBI), arXiv, Unpaywall, ORCID, CORE and Scopus. Thank you to arXiv for use of its open access interoperability. Please respect each provider's terms of use.")));
}

function describe(name) {
  return {
    openalex: "Open catalogue of over 250 million works. Powers citation maps.",
    semanticscholar: "Large academic graph with short summaries and recommendations.",
    crossref: "Official DOI metadata from publishers.",
    europepmc: "Life sciences and biomedicine, with open full text.",
    arxiv: "Preprints in physics, mathematics, computer science and more.",
    pubmed: "Biomedical literature from the US National Library of Medicine.",
    core: "Open access papers from repositories worldwide.",
    scopus: "Elsevier's citation database. Needs your own access.",
    opencitations: "Open citation links. Used as a backup for references and citations.",
    unpaywall: "Finds legal open access PDFs. Needs your email above.",
  }[name] || "";
}

export function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

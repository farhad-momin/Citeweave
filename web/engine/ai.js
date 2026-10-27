// AI for the web version: the same providers as the PC app, called straight from the browser
// with the researcher's own key, plus the free model some browsers ship (Chrome's built-in AI).
// Every task still works without AI, as in the PC app.
import * as aggregator from "./aggregator.js";
import { checkValues, evidenceRow } from "./evidence.js";
import { dedupe, titleSimilarity } from "./models.js";
import { keySentence, rankPapers, splitSentences } from "./rank.js";
import { settings } from "./settings.js";
import * as S from "./sources/index.js";

export class AIError extends Error {}

export const PRESETS = [
  { name: "browser", label: "Built-in browser AI (free, on this computer)", base_url: "", default_model: "built-in",
    kind: "browser", needs_key: false, local: true,
    key_help: "Uses the AI model built into recent versions of Chrome. Needs a fairly strong computer; Citeweave checks if it is available." },
  { name: "ollama", label: "Ollama (local, free)", base_url: "http://127.0.0.1:11434/v1", default_model: "llama3.2", needs_key: false, local: true,
    key_help: "Install Ollama from ollama.com and run: ollama pull llama3.2. For the web version, also allow this site: set OLLAMA_ORIGINS to this page's address and restart Ollama." },
  { name: "openai", label: "OpenAI (ChatGPT)", base_url: "https://api.openai.com/v1", default_model: "gpt-4o-mini", key_help: "Create a key at platform.openai.com/api-keys" },
  { name: "anthropic", label: "Anthropic (Claude)", base_url: "https://api.anthropic.com/v1", default_model: "claude-haiku-5-5", kind: "anthropic", key_help: "Create a key at console.anthropic.com" },
  { name: "gemini", label: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", default_model: "gemini-2.5-flash", key_help: "Create a free key at aistudio.google.com/apikey" },
  { name: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", default_model: "deepseek-chat", key_help: "Create a key at platform.deepseek.com" },
  { name: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1", default_model: "llama-3.3-70b-versatile", key_help: "Create a free key at console.groq.com/keys" },
  { name: "openrouter", label: "OpenRouter (many models)", base_url: "https://openrouter.ai/api/v1", default_model: "openrouter/auto", key_help: "Create a key at openrouter.ai/keys. Models ending in :free cost nothing." },
  { name: "mistral", label: "Mistral", base_url: "https://api.mistral.ai/v1", default_model: "mistral-small-latest", key_help: "Create a key at console.mistral.ai" },
  { name: "custom", label: "Custom (any OpenAI compatible server, e.g. LM Studio)", base_url: "http://127.0.0.1:1234/v1", default_model: "", needs_key: false, local: true,
    key_help: "Enter the server address and model name. The server must allow requests from this page (CORS)." },
].map((p) => ({ kind: "openai", needs_key: true, local: false, ...p }));

const PRESET = Object.fromEntries(PRESETS.map((p) => [p.name, p]));

// 0 is a valid temperature; only a missing or unreadable value falls back to 0.2
function temperatureOf(v) {
  if (v === null || v === undefined || v === "") return 0.2;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0.2;
}

export function activeConfig() {
  const ai = settings().get("ai") || {};
  const provider = ai.provider || "none";
  if (provider === "none" || !PRESET[provider]) return { provider: "none" };
  const p = PRESET[provider];
  const base = ["ollama", "custom"].includes(provider) ? (ai.base_url || "").trim() : "";
  return {
    provider, kind: p.kind, label: p.label, needs_key: p.needs_key,
    base_url: (base || p.base_url).replace(/\/+$/, ""),
    model: (ai.model || "").trim() || p.default_model,
    key: ((ai.keys || {})[provider] || "").trim(),
    temperature: temperatureOf(ai.temperature),
  };
}

export function isEnabled() {
  const c = activeConfig();
  if (c.provider === "none") return false;
  if (c.needs_key && !c.key) return false;
  return !!c.model;
}

// Chrome's built-in model (Prompt API). Feature-detected; absent in most browsers.
function builtin() { return globalThis.LanguageModel || globalThis.ai?.languageModel || null; }

export async function builtinAvailability() {
  const LM = builtin();
  if (!LM) return "unavailable";
  try {
    return (await (LM.availability?.() ?? LM.capabilities?.().then((c) => c.available))) || "unavailable";
  } catch { return "unavailable"; }
}

async function chatBuiltin(system, user, signal) {
  const LM = builtin();
  if (!LM) throw new AIError("This browser has no built-in AI. It is available in recent desktop versions of Chrome on capable computers. Pick another provider in Settings, AI.");
  const avail = await builtinAvailability();
  if (avail === "unavailable" || avail === "no") throw new AIError("The built-in AI is not available on this computer. Pick another provider in Settings, AI.");
  const session = await LM.create({ initialPrompts: [{ role: "system", content: system }], signal });
  try {
    return await session.prompt(user, { signal });
  } finally {
    session.destroy?.();
  }
}

async function readError(r, cfg) {
  let msg = "";
  try {
    const err = await r.json();
    msg = (typeof err.error === "object" ? err.error?.message : err.error) || err.message || "";
  } catch {
    try { msg = (await r.text()).slice(0, 200); } catch { /* ignore */ }
  }
  if (r.status === 401 || r.status === 403) return new AIError(`${cfg.label} rejected the API key (${r.status}). Check it in Settings, AI.`);
  if (r.status === 404) return new AIError(`${cfg.label}: model '${cfg.model}' was not found. ${msg}`);
  if (r.status === 429) return new AIError(`${cfg.label}: rate limit or quota reached. ${msg}`);
  return new AIError(`${cfg.label} error ${r.status}: ${msg}`);
}

async function post(url, body, headers, cfg, signal) {
  try {
    return await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    const hint = cfg.provider === "ollama"
      ? " Is Ollama running, and is this page allowed in OLLAMA_ORIGINS?"
      : cfg.local ? " Is the server running and allowing requests from this page?" : " Check your connection.";
    throw new AIError(`Could not reach ${cfg.label}.${hint}`);
  }
}

export async function chat(system, user, { maxTokens = 1200, jsonMode = false, cfg = null, signal } = {}) {
  cfg = cfg || activeConfig();
  if (cfg.provider === "none") throw new AIError("No AI provider is selected. Choose one in Settings, AI.");
  if (cfg.needs_key && !cfg.key) throw new AIError(`${cfg.label} needs an API key. Add it in Settings, AI.`);
  if (cfg.kind === "browser") {
    const extra = jsonMode ? "\n\nReply with JSON only." : "";
    return chatBuiltin(system, user + extra, signal);
  }
  if (cfg.kind === "anthropic") {
    const r = await post(`${cfg.base_url}/messages`, {
      model: cfg.model, max_tokens: maxTokens, system, temperature: cfg.temperature,
      messages: [{ role: "user", content: user }],
    }, { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, cfg, signal);
    if (!r.ok) throw await readError(r, cfg);
    const data = await r.json();
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const body = {
    model: cfg.model, temperature: cfg.temperature, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (jsonMode && ["openai", "deepseek", "groq", "mistral", "ollama", "gemini"].includes(cfg.provider)) body.response_format = { type: "json_object" };
  const headers = {};
  if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
  if (cfg.provider === "openrouter") headers["X-Title"] = "Citeweave";
  let r = await post(`${cfg.base_url}/chat/completions`, body, headers, cfg, signal);
  if (r.status === 400 && body.response_format) {
    delete body.response_format;
    r = await post(`${cfg.base_url}/chat/completions`, body, headers, cfg, signal);
  }
  if (!r.ok) throw await readError(r, cfg);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "";
}

export async function listModels(cfg = null) {
  cfg = cfg || activeConfig();
  if (cfg.provider === "none") return [];
  if (cfg.kind === "browser") return ["built-in"];
  try {
    if (cfg.provider === "ollama") {
      const root = cfg.base_url.replace(/\/v1\/?$/, "");
      const r = await fetch(`${root}/api/tags`);
      if (!r.ok) throw await readError(r, cfg);
      return ((await r.json()).models || []).map((m) => m.name).sort();
    }
    if (cfg.kind === "anthropic") {
      const r = await fetch(`${cfg.base_url}/models`, { headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } });
      if (!r.ok) throw await readError(r, cfg);
      return ((await r.json()).data || []).map((m) => m.id);
    }
    const r = await fetch(`${cfg.base_url}/models`, { headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} });
    if (!r.ok) throw await readError(r, cfg);
    const data = await r.json();
    const rows = Array.isArray(data) ? data : data.data || [];
    return rows.map((m) => String(m.id || "").replace(/^models\//, "")).filter(Boolean).sort();
  } catch (e) {
    if (e instanceof AIError) throw e;
    throw new AIError(`Could not reach ${cfg.label} to list models.`);
  }
}

export function parseJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/s, "").replace(/\s*```$/s, "");
  try { return JSON.parse(t); } catch { /* try harder */ }
  for (const [o, c] of [["{", "}"], ["[", "]"]]) {
    const s = t.indexOf(o), e = t.lastIndexOf(c);
    if (s !== -1 && e > s) {
      try { return JSON.parse(t.slice(s, e + 1)); } catch { /* next */ }
    }
  }
  throw new AIError("The model did not return valid JSON. Try again or use a stronger model.");
}

// tasks ---------------------------------------------------------------------------------------
export const GROUNDING = "You are a careful research assistant. Use only the paper excerpts provided. " +
  "Do not invent findings, numbers or references. If the excerpts do not answer the question, say so plainly.";

export const PRESET_COLUMNS = [
  { name: "Aim", instruction: "The main research question or objective." },
  { name: "Study type", instruction: "Experimental, numerical, field study, review, survey, case study, etc." },
  { name: "Method", instruction: "Key methods, models, tests or analysis used." },
  { name: "Sample / data", instruction: "Sample size, specimens, dataset or participants." },
  { name: "Location", instruction: "Country or region where the study was done, if stated." },
  { name: "Key findings", instruction: "The main results, with numbers where given." },
  { name: "Limitations", instruction: "Limitations stated by the authors." },
  { name: "Future work", instruction: "Future research the authors suggest." },
];

export function excerpt(p, n, max = 1800) {
  const authors = (p.authors || []).slice(0, 3).map((a) => a.name).join(", ");
  return `[${n}] ${p.title} (${authors}${authors ? ", " : ""}${p.year || "n.d."}). ${p.venue || ""}\n${(p.abstract || p.tldr || "").slice(0, max)}`;
}

export function askPrompt(question, papers) {
  const context = papers.map((p, i) => excerpt(p, i + 1)).join("\n\n");
  return `Question: ${question}\n\nPaper excerpts:\n${context}\n\n` +
    "Write a concise answer (120 to 220 words) in plain language. Cite papers inline as [1], [2]. " +
    "Point out where findings agree or disagree, and note important limits of the evidence.";
}

async function rewriteQuery(question, signal) {
  if (!isEnabled()) return question;
  try {
    const out = await chat("Turn a research question into a short keyword search query for a scholarly database. " +
      "Reply with the query only, 3 to 10 words, no quotes, no boolean operators.", question, { maxTokens: 40, signal });
    const first = String(out || "").trim().replace(/^"+|"+$/g, "").split(/\r?\n/)[0] || "";
    return first.trim().slice(0, 200) || question;
  } catch { return question; }
}

export async function ask(question, { limit = 8, source = "auto", filters = {}, useAi = true, progress = () => {}, signal } = {}) {
  const aiOn = useAi && isEnabled();
  progress("Preparing search", 0.05);
  const query = aiOn ? await rewriteQuery(question, signal) : question;
  progress("Searching", 0.2);
  const found = await aggregator.search(query, source, 30, filters);
  let papers = found.results.filter((p) => p.abstract || p.tldr);
  if (papers.length < 5 && query !== question) {
    const more = await aggregator.search(question, source, 30, filters);
    papers = dedupe(papers.concat(more.results.filter((p) => p.abstract)));
  }
  const ranked = rankPapers(question, papers).slice(0, Math.max(limit, 3));
  for (const p of ranked) p.key_sentence = keySentence(question, p.abstract || p.tldr || "");
  let answer = "", answerKind = "none", aiError = null;
  if (ranked.length && aiOn) {
    progress("Writing an answer from the abstracts", 0.6);
    try {
      answer = (await chat(GROUNDING, askPrompt(question, ranked), { maxTokens: 700, signal })).trim();
      answerKind = "ai";
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      aiError = e.message;
    }
  }
  if (!answer && ranked.length) {
    const seen = new Set(), lines = [];
    ranked.slice(0, 6).forEach((p, i) => {
      if (p.key_sentence && !seen.has(p.key_sentence)) { seen.add(p.key_sentence); lines.push(`${p.key_sentence} [${i + 1}]`); }
    });
    answer = lines.join(" ");
    answerKind = "extractive";
  }
  progress("Done", 1);
  return { question, query, answer, answer_kind: answerKind, papers: ranked, used: found.used, errors: found.errors, ai_error: aiError };
}

// The web version reads abstracts (most publisher PDFs cannot be fetched from a web page).
export function getText(p) {
  if (p.abstract) return [p.abstract, "abstract"];
  if (p.tldr) return [p.tldr, "summary"];
  return ["", null];
}

export async function summarize(paper, useAi = true, signal) {
  if (useAi && isEnabled() && paper.abstract) {
    const [text, kind] = getText(paper);
    const out = await chat(GROUNDING, `Paper: ${paper.title}\nText (${kind}):\n${text.slice(0, 12000)}\n\n` +
      "Summarize in 3 short bullet points: aim, method, main finding. Plain language, max 70 words total.", { maxTokens: 300, signal });
    return { summary: out.trim(), kind: "ai", based_on: kind };
  }
  if (paper.tldr) return { summary: paper.tldr, kind: "source", based_on: "abstract" };
  const sents = splitSentences(paper.abstract || "");
  if (sents.length) return { summary: [sents[0], ...(sents.length > 1 ? [sents[sents.length - 1]] : [])].join(" "), kind: "extractive", based_on: "abstract" };
  return { summary: "", kind: "none", based_on: null };
}

export function extractPrompt(paper, columns, text, kind) {
  const spec = columns.map((c) => `- ${c.name}: ${c.instruction || c.name}`).join("\n");
  return `Paper: ${paper.title} (${paper.year || "n.d."})\nText (${kind}):\n${text}\n\nExtract these fields:\n${spec}\n\n` +
    'Reply with JSON only, shaped as {"<field name>": {"value": "<short answer>", "quote": "<exact supporting quote from the text, max 25 words>"}}. ' +
    'Use "Not reported" when the text does not say.';
}

export function valuesFrom(data, columns) {
  const values = Object.create(null);
  for (const c of columns) {
    const v = data && typeof data === "object" ? data[c.name] : undefined;
    if (v && typeof v === "object") values[c.name] = { value: String(v.value ?? "").trim(), quote: String(v.quote ?? "").trim() };
    else if (v !== undefined && v !== null) values[c.name] = { value: String(v).trim(), quote: "" };
    else values[c.name] = { value: "Not reported", quote: "" };
  }
  return values;
}

export async function extractOne(paper, columns, signal, useAi = true) {
  const [text, kind] = getText(paper);
  if (!useAi || !isEnabled()) return evidenceRow(paper, columns, text, kind);
  if (!text) return { paper_id: paper.id, based_on: null, values: {}, error: "No abstract available" };
  const raw = await chat(GROUNDING, extractPrompt(paper, columns, text, kind), { maxTokens: 1400, jsonMode: true, signal });
  const values = checkValues(valuesFrom(parseJson(raw), columns), text);
  const flagged = Object.values(values).filter((v) => v.unverified).length;
  return { paper_id: paper.id, based_on: kind, mode: "ai", values,
    error: flagged ? `${flagged} value(s) lack a matching source quote. Review these values.` : null };
}

export async function extract(papers, columns, progress = () => {}, signal, useAi = true) {
  const rows = [];
  for (let i = 0; i < papers.length; i++) {
    if (signal?.aborted) throw new Error("Stopped");
    progress(`Reading paper ${i + 1} of ${papers.length}`, i / Math.max(papers.length, 1));
    try {
      rows.push(await extractOne(papers[i], columns, signal, useAi));
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) throw e;
      const row = await extractOne(papers[i], columns, signal, false);
      row.error = `AI unavailable; showing free evidence excerpts. ${e.message}`;
      rows.push(row);
    }
  }
  progress("Done", 1);
  return rows;
}

export async function suggest(question, limit = 10) {
  if (!isEnabled()) throw new AIError("AI suggestions need an AI provider. Pick one in Settings, AI.");
  const raw = await chat("You know the scholarly literature well. Suggest real, published papers only. " +
    "If unsure of a detail, leave it empty rather than guessing.",
  `Topic: ${question}\n\nList up to ${limit} highly relevant papers. Reply with JSON only: ` +
    '{"papers": [{"title": "", "first_author": "", "year": 0, "doi": ""}]}', { maxTokens: 1500, jsonMode: true });
  const data = parseJson(raw);
  const items = (Array.isArray(data) ? data : data.papers || []).slice(0, limit).filter((x) => x && typeof x === "object");
  return verifySuggestions(items);
}

// Best OpenAlex title match (similarity at least 0.7, year within 1 when given), or null.
async function openalexTitleMatch(title, year) {
  if (!S.openalex.ready()[0]) return null;
  const want = parseInt(year, 10);
  let best = null, bestScore = 0;
  for (const p of await S.openalex.search(title, 5)) {
    if (want && p.year && Math.abs(p.year - want) > 1) continue;
    const score = titleSimilarity(title, p.title);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= 0.7 ? best : null;
}

// Keep only suggestions that exist in a database. Used for AI and pasted chatbot suggestions.
export async function verifySuggestions(items) {
  const verified = [], rejected = [];
  await Promise.all(items.map(async (item) => {
    const title = String(item.title || "").trim();
    if (!title) return;
    let p = null;
    const doi = String(item.doi || "").trim();
    if (doi) {
      try { p = await aggregator.resolve(doi); } catch { p = null; }
      if (p) {
        const a = new Set(title.toLowerCase().split(/\s+/)), b = new Set(String(p.title || "").toLowerCase().split(/\s+/));
        if ([...a].filter((w) => b.has(w)).length < 3) p = null;
      }
    }
    if (!p) {
      try { p = await S.crossref.verify(title, item.first_author || "", item.year || null); } catch { p = null; }
    }
    if (!p) {
      try { p = await openalexTitleMatch(title, item.year || null); } catch { p = null; }
    }
    if (p) { p.verified = true; verified.push(p); } else rejected.push(title);
  }));
  return { results: verified, rejected };
}

export function tableToCsvRows(columns, rows, papers) {
  const out = [["Title", "Year", "DOI", "Based on", "Mode", "Row note",
    ...columns.flatMap((c) => [c.name, `${c.name} (quote)`, `${c.name} (evidence status)`])]];
  for (const r of rows) {
    const p = papers[r.paper_id] || r.paper || {};
    out.push([p.title || "", String(p.year || ""), p.doi || "", r.based_on || "", r.mode || "", r.error || "",
      ...columns.flatMap((c) => {
        const cell = r.values?.[c.name] || {};
        return [cell.value || "", cell.quote || "", cell.evidence_status || (cell.unverified ? "unverified" : "not checked")];
      })]);
  }
  return out;
}

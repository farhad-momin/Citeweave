// Chatbot bridge: use the chatbot you already have (ChatGPT, Claude, Gemini, DeepSeek, Copilot)
// without an API key. Citeweave writes the prompt with the paper excerpts, you paste it into
// your chatbot, then paste the reply back. Citeweave checks the reply against the papers it sent.
import { btn, copyText, h, modal, toast } from "./ui.js";

export const CHATBOTS = [
  { name: "ChatGPT", url: "https://chatgpt.com/" },
  { name: "Claude", url: "https://claude.ai/new" },
  { name: "Gemini", url: "https://gemini.google.com/app" },
  { name: "DeepSeek", url: "https://chat.deepseek.com/" },
  { name: "Copilot", url: "https://copilot.microsoft.com/" },
];

const RULES = "Use only the paper excerpts below. Do not add outside knowledge, numbers or references. " +
  "If the excerpts do not answer, say so plainly.";

function excerpt(p, n, max = 1500) {
  const authors = (p.authors || []).slice(0, 3).map((a) => a.name).join(", ");
  return `[${n}] ${p.title} (${authors}${authors ? ", " : ""}${p.year || "n.d."}). ${p.venue || ""}\n${(p.abstract || p.tldr || "No abstract available.").slice(0, max)}`;
}

// prompts -------------------------------------------------------------------------------------
export function askPrompt(question, papers) {
  return `${RULES}\n\nQuestion: ${question}\n\nPaper excerpts:\n\n${papers.map((p, i) => excerpt(p, i + 1)).join("\n\n")}\n\n` +
    "Write a concise answer (120 to 220 words) in plain language. Cite the papers inline as [1], [2] using the numbers above. " +
    "Point out where findings agree or disagree, and note important limits of the evidence. Reply with the answer only.";
}

export function tablePrompt(columns, papers, offset = 0) {
  const spec = columns.map((c) => `- ${c.name}: ${c.instruction || c.name}`).join("\n");
  const shape = `{"papers": [{"n": ${offset + 1}, "values": {${columns.map((c) => `"${c.name}": {"value": "...", "quote": "..."}`).join(", ")}}}]}`;
  return `${RULES}\n\nFor each paper below, extract these fields:\n${spec}\n\n` +
    "Each value is a short answer. Each quote is the exact supporting text copied from that paper's excerpt (max 25 words). " +
    'Write "Not reported" when the excerpt does not say.\n\n' +
    `Reply with JSON only, in one code block, shaped exactly like this:\n${shape}\n\n` +
    `Paper excerpts:\n\n${papers.map((p, i) => excerpt(p, offset + i + 1, 2200)).join("\n\n")}`;
}

export function suggestPrompt(topic, limit = 10) {
  return `Suggest up to ${limit} real, published research papers on this topic: ${topic}\n\n` +
    "Only list papers you are confident exist. If unsure of a detail, leave it empty rather than guessing.\n" +
    'Reply with JSON only, in one code block: {"papers": [{"title": "", "first_author": "", "year": 0, "doi": ""}]}';
}

// reading replies -----------------------------------------------------------------------------
export function parseJsonReply(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* try the outermost braces */ }
  for (const [o, c] of [["{", "}"], ["[", "]"]]) {
    const s = t.indexOf(o), e = t.lastIndexOf(c);
    if (s !== -1 && e > s) {
      try { return JSON.parse(t.slice(s, e + 1).replace(/,\s*([}\]])/g, "$1")); } catch { /* next */ }
    }
  }
  throw new Error("The reply is not in the expected format. Copy the chatbot's whole reply, including the code block, and try again.");
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Does the quote really appear in the paper's text? Allows small differences in punctuation.
export function quoteFound(quote, text) {
  const q = norm(quote), t = norm(text);
  if (!q) return true;
  if (` ${t} `.includes(` ${q} `)) return true;
  const words = q.split(" ");
  if (words.length < 6) return false;
  // whole words only: "a" or "in" must not count as found inside other words
  const have = new Set(t.split(" "));
  const hits = words.filter((w) => have.has(w)).length;
  return hits / words.length >= 0.85;
}

// Cleans an answer and lists citation numbers that do not match a paper.
export function checkAnswer(text, nPapers) {
  const answer = String(text || "").trim().replace(/^answer:\s*/i, "");
  const bad = new Set();
  for (const m of answer.matchAll(/\[(\d+(?:\s*[,\-\u2013]\s*\d+)*)\]/g)) {
    for (const part of m[1].split(/\s*,\s*/)) {
      const [a, b] = part.split(/\s*[-\u2013]\s*/).map((x) => parseInt(x, 10));
      const last = b || a;
      if (last < a) { bad.add(a); continue; }
      // check the ends of a long range without walking every number in it
      for (let i = a; i <= Math.min(last, a + 200); i++) if (!(i >= 1 && i <= nPapers)) bad.add(i);
      if (last > a + 200 && last > nPapers) bad.add(last);
    }
  }
  return { answer, badCitations: [...bad] };
}

export function rowsFromReply(data, columns, papers, offset = 0) {
  const items = Array.isArray(data) ? data : data?.papers || [];
  const rows = [];
  papers.forEach((p, i) => {
    const n = offset + i + 1;
    const item = items.find((x) => Number(x?.n) === n) || (items.length === papers.length ? items[i] : null);
    const values = {};
    let unverified = 0;
    for (const c of columns) {
      const v = item?.values?.[c.name] ?? item?.[c.name];
      let value = "Not reported", quote = "";
      if (v && typeof v === "object") { value = String(v.value ?? "").trim() || "Not reported"; quote = String(v.quote ?? "").trim(); }
      else if (v !== undefined && v !== null) value = String(v).trim();
      // a value with no supporting quote cannot be checked, so it is marked like a quote that was not found
      const reported = value && !/^not reported\.?$/i.test(value);
      const ok = reported && !quote ? false : quoteFound(quote, `${p.abstract || ""} ${p.tldr || ""} ${p.title || ""}`);
      if (!ok) unverified++;
      values[c.name] = { value, quote, ...(ok ? {} : { unverified: true }) };
    }
    rows.push({
      paper_id: p.id, based_on: "abstract", values,
      error: !item ? "The chatbot reply did not include this paper." : unverified ? `${unverified} value(s) could not be confirmed in the abstract. Check these values.` : null,
      paper: { id: p.id, title: p.title, year: p.year, doi: p.doi, authors: p.authors, venue: p.venue, oa_url: p.oa_url },
    });
  });
  return rows;
}

// the dialog ----------------------------------------------------------------------------------
// Shows the prompt, quick links to chatbots, and a box for the reply.
// read(replyText) should return a result or throw an Error with a helpful message.
export async function bridgeDialog({ title, intro, prompt, read, step }) {
  const reply = h("textarea", { class: "input", rows: 7, style: { width: "100%" }, placeholder: "Paste the chatbot's whole reply here" });
  const err = h("p", { class: "err small" });
  const promptBox = h("textarea", { class: "input mono", rows: 6, readonly: true, style: { width: "100%", fontSize: "12.5px" } }, prompt);
  const body = h("div", { class: "bridge" },
    intro ? h("p", { class: "muted" }, intro) : null,
    step ? h("p", { class: "small" }, step) : null,
    h("div", { class: "bridge-step" },
      h("b", {}, "1. Copy the prompt"),
      h("div", { class: "row", style: { margin: "6px 0" } },
        btn("Copy prompt", () => copyText(prompt, "Prompt copied. Paste it into your chatbot."), { cls: "primary small", ico: "copy" }),
        h("span", { class: "small muted" }, `${prompt.length.toLocaleString()} characters`)),
      promptBox),
    h("div", { class: "bridge-step" },
      h("b", {}, "2. Paste it into your chatbot"),
      h("div", { class: "row wrap", style: { margin: "6px 0" } },
        CHATBOTS.map((c) => h("a", { class: "btn small ghost", href: c.url, target: "_blank", rel: "noopener noreferrer" }, c.name)))),
    h("div", { class: "bridge-step" }, h("b", {}, "3. Paste the reply back"), reply, err));
  return modal(title, body, [
    { label: "Cancel", value: null },
    { label: "Use this reply", cls: "primary", value: async () => {
      if (!reply.value.trim()) { err.textContent = "Paste the chatbot's reply first."; return undefined; }
      try { return await read(reply.value); } catch (e) { err.textContent = e.message; return undefined; }
    } },
  ], { wide: true });
}

export function batches(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function noAbstractWarning(papers) {
  const missing = papers.filter((p) => !p.abstract && !p.tldr).length;
  if (missing) toast(`${missing} paper(s) have no abstract, so the chatbot can only use their titles.`);
}

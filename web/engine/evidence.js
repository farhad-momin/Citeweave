// Conservative local retrieval. Keep behavior aligned with citeweave/ai/evidence.py.
import { bm25, tokens } from "./rank.js";

const CUES = {
  aim: /\b(aim\w*|objective\w*|purpose|investigat\w*|examin\w*)\b/i,
  "study type": /\b(trial|survey|review|meta-analysis|cohort|case.control|experiment\w*|simulation\w*)\b/i,
  method: /\b(method\w*|measur\w*|analys\w*|analyz\w*|regression|random\w*|interview\w*|simulat\w*|tested)\b/i,
  "sample / data": /\b(sample\w*|participant\w*|patient\w*|specimen\w*|dataset\w*|respondent\w*|recruit\w*)\b/i,
  location: /\b(conducted in|carried out in|located in|recruited from|study site\w*)\b/i,
  "key findings": /\b(found|show\w*|result\w*|increas\w*|decreas\w*|reduc\w*|improv\w*|associat\w*|conclud\w*)\b/i,
  limitations: /\b(limit\w*|caveat\w*|shortcoming\w*)\b/i,
  "future work": /\b(future|further research|further studies|remain\w* to be)\b/i,
};

// Curly quotes and the different dashes are typography only; words, numbers and signs stay exact.
const normalizeQuote = (s) => String(s || "").normalize("NFKC")
  .replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c\u201d\u201e]/g, '"')
  .replace(/[\u2010-\u2014\u2212]/g, "-").replace(/\s+/g, " ").trim();

export function checkValues(values, text) {
  const source = normalizeQuote(text);
  for (const cell of Object.values(values)) {
    const quote = normalizeQuote(cell.quote);
    const absent = ["", "not reported", "not found in available text"].includes((cell.value || "").toLowerCase());
    cell.evidence_status = quote && source.includes(quote) ? "quote matched" : absent && !quote ? "not reported" : "unverified";
    cell.unverified = cell.evidence_status === "unverified";
  }
  return values;
}

export function evidenceRow(paper, columns, text, kind) {
  const sentences = String(text || "").split(/(?<=[.!?])\s+|[\r\n]+/).map((s) => s.trim()).filter(Boolean);
  const values = Object.create(null);
  for (const col of columns) {
    const query = `${col.name} ${col.instruction || ""}`;
    const name = col.name.trim().toLowerCase();
    const cue = Object.hasOwn(CUES, name) ? CUES[name] : null;
    const words = new Set(tokens(query));
    const candidates = sentences.filter((s) => cue ? cue.test(s) : tokens(s).some((w) => words.has(w)));
    if (candidates.length) {
      const scores = bm25(query, candidates);
      const excerpt = candidates[scores.indexOf(Math.max(...scores))];
      values[col.name] = { value: excerpt, quote: excerpt, evidence_status: "source excerpt", unverified: false, needs_review: true };
    } else {
      values[col.name] = { value: "Not found in available text", quote: "", evidence_status: "not found", unverified: false, needs_review: true };
    }
  }
  return { paper_id: paper.id, based_on: text ? kind : null, mode: "extractive", values,
    error: text ? null : "No abstract or text available" };
}

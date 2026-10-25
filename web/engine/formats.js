// Citation formats: BibTeX, RIS and CSV export; BibTeX, RIS and DOI list import; APA text.
// Mirrors citeweave/formats.py.
import { makePaper, normalizeDoi } from "./models.js";

const ascii = (s) => String(s || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");

function splitName(name) {
  name = String(name || "").trim();
  if (name.includes(",")) {
    const i = name.indexOf(",");
    return [name.slice(i + 1).trim(), name.slice(0, i).trim()];
  }
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return ["", parts[0]];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1] || ""];
}

const SKIP_WORDS = new Set(["with", "from", "that", "this", "using", "their", "into", "study"]);

export function bibtexKey(p, used) {
  const first = ((p.authors && p.authors.length ? p.authors : [{ name: "anon" }])[0]).name;
  const last = ascii(splitName(first)[1]).replace(/[^A-Za-z]/g, "") || "anon";
  const words = ascii(p.title || "").match(/[A-Za-z]{4,}/g) || [];
  const word = words.find((w) => !SKIP_WORDS.has(w.toLowerCase())) || "paper";
  const base = `${last.toLowerCase()}${p.year || ""}${word.toLowerCase()}`;
  let key = base;
  let i = 1;
  while (used.has(key)) {
    i += 1;
    key = i < 27 ? `${base}${String.fromCharCode(96 + i)}` : `${base}${i}`;
  }
  used.add(key);
  return key;
}

const bibEscape = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
  .replace(/&/g, "\\&").replace(/%/g, "\\%");

export function toBibtex(papers) {
  const used = new Set();
  const out = [];
  for (const p of papers) {
    const kind = { preprint: "misc", "book-chapter": "incollection", book: "book", "proceedings-article": "inproceedings" }[p.type || ""] || "article";
    const venueField = kind === "article" ? "journal" : ["inproceedings", "incollection"].includes(kind) ? "booktitle" : "howpublished";
    const fields = [
      ["title", "{" + bibEscape(p.title) + "}"],
      ["author", (p.authors || []).map((a) => bibEscape(a.name)).join(" and ")],
      ["year", String(p.year || "")],
      [venueField, bibEscape(p.venue || "")],
      ["doi", p.doi || ""],
      ["url", p.url || ""],
      ["abstract", bibEscape(p.abstract || "")],
    ];
    if ((p.ids || {}).arxiv) {
      fields.push(["eprint", p.ids.arxiv]);
      fields.push(["archiveprefix", "arXiv"]);
    }
    const body = fields.filter(([, v]) => v && v !== "{}")
      .map(([k, v]) => (v.startsWith("{") ? `  ${k} = ${v}` : `  ${k} = {${v}}`)).join(",\n");
    out.push(`@${kind}{${bibtexKey(p, used)},\n${body}\n}`);
  }
  return out.join("\n\n") + "\n";
}

const rstripChars = (s, chars) => {
  let e = s.length;
  while (e > 0 && chars.includes(s[e - 1])) e--;
  return s.slice(0, e);
};
const stripChars = (s, chars) => {
  let b = 0;
  while (b < s.length && chars.includes(s[b])) b++;
  return rstripChars(s.slice(b), chars);
};

export function toRis(papers) {
  const out = [];
  for (const p of papers) {
    const ty = { preprint: "UNPB", book: "BOOK", "book-chapter": "CHAP", "proceedings-article": "CPAPER" }[p.type || ""] || "JOUR";
    const lines = [`TY  - ${ty}`, `TI  - ${p.title || ""}`];
    for (const a of p.authors || []) {
      const [first, last] = splitName(a.name);
      lines.push(rstripChars(`AU  - ${last}, ${first}`, ", "));
    }
    if (p.year) lines.push(`PY  - ${p.year}`);
    if (p.venue) lines.push(`T2  - ${p.venue}`);
    if (p.doi) lines.push(`DO  - ${p.doi}`);
    if (p.url) lines.push(`UR  - ${p.url}`);
    if (p.abstract) lines.push(`AB  - ${p.abstract}`);
    if (p.note) lines.push(`N1  - ${p.note}`);
    for (const t of p.tags || []) lines.push(`KW  - ${t}`);
    lines.push("ER  - ");
    out.push(lines.join("\n"));
  }
  return out.join("\n\n") + "\n";
}

// CSV the same way Python's csv module writes it (minimal quoting, CRLF line ends).
function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",") + "\r\n").join("");
}

export function toCsv(papers) {
  const rows = [["Title", "Authors", "Year", "Venue", "DOI", "Cited by", "Open access link", "Status", "Tags", "Notes", "Abstract"]];
  for (const p of papers) {
    rows.push([p.title, (p.authors || []).map((a) => a.name).join("; "), p.year || "", p.venue || "", p.doi || "",
      p.cited_by_count || "", p.oa_url || "", p.status || "", (p.tags || []).join("; "), p.note || "", p.abstract || ""]);
  }
  return rowsToCsv(rows);
}

export function apa(p) {
  const names = [];
  for (const a of (p.authors || []).slice(0, 20)) {
    const [first, last] = splitName(a.name);
    const initials = first.split(/[\s-]+/).filter(Boolean).map((x) => `${x[0]}.`).join(" ");
    names.push(stripChars(`${last}, ${initials}`, ", "));
  }
  let authors;
  if (names.length > 1) authors = names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
  else authors = names[0] || "";
  const year = p.year || "n.d.";
  let s = `${authors} (${year}). ${p.title || ""}.`;
  if (p.venue) s += ` ${p.venue}.`;
  if (p.doi) s += ` https://doi.org/${p.doi}`;
  return s.trim();
}

// import -------------------------------------------------------------------------------
// [type, body] for each @type{...} entry, matching braces properly.
function* bibEntries(text) {
  let i = 0;
  const n = text.length;
  const re = /@(\w+)\s*([{(])/g;
  while (true) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return;
    const kind = m[1].toLowerCase();
    const openCh = m[2];
    const closeCh = openCh === "{" ? "}" : ")";
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < n && depth) {
      const c = text[j];
      if (c === "{" || (c === openCh && openCh === "(")) depth += 1;
      else if (c === "}" || (c === closeCh && closeCh === ")")) depth -= 1;
      j += 1;
    }
    if (!["comment", "preamble", "string"].includes(kind)) yield [kind, text.slice(m.index + m[0].length, j - 1)];
    i = j;
  }
}

const delta = (ch) => (ch === "{" ? 1 : ch === "}" ? -1 : 0);

// Parse 'key, field = {value}, field = "value", field = 2020' into an object.
function bibFields(body) {
  const fields = {};
  const comma = body.indexOf(",");
  if (comma < 0) return fields;
  const s = body;
  const n = s.length;
  let i = comma + 1;
  const reName = /\s*([\w\-:.]+)\s*=\s*/y;
  const reBare = /[^,#\s}]+/y;
  const reCat = /\s*#\s*/y;
  const reComma = /\s*,/y;
  while (i < n) {
    reName.lastIndex = i;
    const m = reName.exec(s);
    if (!m) {
      const nxt = s.indexOf(",", i);
      if (nxt < 0) break;
      i = nxt + 1;
      continue;
    }
    const name = m[1].toLowerCase();
    i = reName.lastIndex;
    const parts = [];
    while (i < n) {
      const c = s[i];
      if (c === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < n && depth) { depth += delta(s[j]); j += 1; }
        parts.push(s.slice(i + 1, j - 1));
        i = j;
      } else if (c === '"') {
        let j = i + 1;
        let depth = 0;
        while (j < n && !(s[j] === '"' && depth === 0)) { depth += delta(s[j]); j += 1; }
        parts.push(s.slice(i + 1, j));
        i = j + 1;
      } else {
        reBare.lastIndex = i;
        const m2 = reBare.exec(s);
        if (m2) {
          parts.push(m2[0]);
          i = reBare.lastIndex;
        }
      }
      reCat.lastIndex = i;
      const m3 = reCat.exec(s);
      if (m3) {
        i = reCat.lastIndex;
        continue;
      }
      break;
    }
    const val = parts.join("");
    fields[name] = val.replace(/[{}]/g, "").split(/\s+/).filter(Boolean).join(" ");
    reComma.lastIndex = i;
    const nxt = reComma.exec(s);
    i = nxt ? reComma.lastIndex : i + 1;
  }
  return fields;
}

export function parseBibtex(text) {
  const out = [];
  for (const [, body] of bibEntries(String(text || ""))) {
    const f = bibFields(body);
    if (!f.title) continue;
    const authors = String(f.author || "").split(/\s+and\s+/).map((a) => a.trim()).filter(Boolean).map((name) => ({ name }));
    out.push(makePaper({
      source: "import", title: f.title, doi: f.doi, abstract: f.abstract,
      year: f.year, venue: f.journal || f.booktitle, authors, url: f.url,
      ids: String(f.archiveprefix || "").toLowerCase() === "arxiv" ? { arxiv: f.eprint } : {},
    }));
  }
  return out;
}

export function parseRis(text) {
  const out = [];
  let cur = {};
  for (const line of String(text || "").split(/\r\n|\r|\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/);
    if (!m) continue;
    const tag = m[1];
    const val = m[2].trim();
    if (tag === "TY") {
      cur = { AU: [] };
    } else if (tag === "ER") {
      if (cur.TI || cur.T1) {
        out.push(makePaper({
          source: "import", title: cur.TI || cur.T1, doi: cur.DO, abstract: cur.AB,
          year: String(cur.PY || cur.Y1 || cur.DA || "").slice(0, 4),
          venue: cur.T2 || cur.JO || cur.JF,
          authors: (cur.AU || []).map((name) => ({ name })), url: cur.UR,
        }));
      }
      cur = {};
    } else if (tag === "AU" || tag === "A1") {
      (cur.AU ||= []).push(val);
    } else if (!(tag in cur)) {
      cur[tag] = val;
    }
  }
  return out;
}

export function findDois(text) {
  const found = String(text || "").match(/10\.\d{4,9}\/[^\s"<>]+/gi) || [];
  return [...new Set(found.map(normalizeDoi).filter(Boolean))];
}

// Returns [kind, papers]: kind is "bibtex", "ris" or "dois" (papers empty for "dois").
export function detectAndParse(text) {
  const t = String(text || "").replace(/^\s+/, "");
  if (t.startsWith("@") || /@\w+\s*\{/.test(t.slice(0, 2000))) return ["bibtex", parseBibtex(text)];
  if (/^TY\s{2}-/m.test(t)) return ["ris", parseRis(text)];
  return ["dois", []];
}

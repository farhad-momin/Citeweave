import assert from "node:assert/strict";
import { test } from "node:test";
import { checkValues, evidenceRow } from "../engine/evidence.js";
import { extract, tableToCsvRows } from "../engine/ai.js";
import { rowsToCsv, toCsv } from "../engine/formats.js";
import { search } from "../engine/aggregator.js";
import { quoteFound, rowsFromReply } from "../../citeweave/static/js/bridge.js";
import { fresh, host, json, mockFetch, work } from "./helpers.mjs";

const text = "We tested 120 specimens using compression tests. Strength increased by 12%. Limitations: Small sample.";
const paper = { id: "doi:10.1000/free", title: "Concrete study", abstract: text };
const columns = ["Method", "Key findings", "Limitations", "Location", "Unknown dimension"].map((name) => ({ name }));

test("free extraction keeps exact short evidence and labels missing matches", async () => {
  fresh();
  globalThis.fetch = () => { throw new Error("Unexpected network request"); };
  const [row, empty] = await extract([paper, { id: "empty" }], columns);
  assert.equal(row.mode, "extractive");
  assert.equal(row.values["Key findings"].value, "Strength increased by 12%.");
  assert.equal(row.values.Limitations.quote, "Limitations: Small sample.");
  assert.equal(row.values.Location.value, "Not found in available text");
  assert.equal(row.values["Unknown dimension"].quote, "");
  assert.ok(Object.values(row.values).every((v) => v.needs_review));
  assert.equal(empty.based_on, null);
  assert.ok(empty.error);
});

test("explicit free mode ignores a configured provider", async () => {
  fresh({ ai: { provider: "ollama" } });
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Unexpected network request"); };
  const rows = await extract([paper], columns, undefined, undefined, false);
  assert.equal(rows[0].mode, "extractive");
  assert.equal(calls, 0);
});

test("AI outage falls back to labelled evidence, while cancellation stops", async () => {
  fresh({ ai: { provider: "ollama" } });
  mockFetch([[host("127.0.0.1:11434"), () => json({ error: "Unavailable" }, 503)]]);
  const [row] = await extract([paper], columns);
  assert.equal(row.mode, "extractive");
  assert.match(row.error, /AI unavailable/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extract([paper], columns, undefined, controller.signal), /Stopped/);
});

test("quote checks reject changed numbers, negation and reordered words", () => {
  for (const quote of ["Strength increased by 21%.", "Strength did not increase by 12%.", "12% increased by Strength.", ""]) {
    const cell = checkValues({ x: { value: "Finding", quote } }, text).x;
    assert.equal(cell.unverified, true);
    if (quote) assert.equal(quoteFound(quote, text), false);
  }
  assert.equal(quoteFound("Strength\nincreased by 12%.", text), true);
  assert.equal(checkValues({ x: { value: "Not reported", quote: "" } }, text).x.evidence_status, "not reported");
});

test("AI extraction flags fabricated supporting quotes", async () => {
  fresh({ ai: { provider: "ollama" } });
  mockFetch([[host("127.0.0.1:11434"), () => json({ choices: [{ message: { content: JSON.stringify({
    Method: { value: "Tests", quote: "We tested 120 specimens using compression tests." },
    "Key findings": { value: "21% improvement", quote: "Strength increased by 21%." },
  }) } }] })]]);
  const [row] = await extract([paper], columns);
  assert.equal(row.mode, "ai");
  assert.equal(row.values.Method.unverified, false);
  assert.equal(row.values["Key findings"].unverified, true);
  assert.match(row.error, /1 value/);
});

test("chatbot rows cannot be reassigned by position or duplicate paper numbers", () => {
  const item = { n: 2, values: { Method: { value: "Tests", quote: text } } };
  const [missing] = rowsFromReply([item], columns, [paper]);
  assert.match(missing.error, /did not include/);
  const [duplicate] = rowsFromReply([{ ...item, n: 1 }, { ...item, n: 1 }], columns, [paper]);
  assert.match(duplicate.error, /did not include/);
  const [titleOnly] = rowsFromReply([{ n: 1, values: { Method: { value: "Study", quote: paper.title } } }], columns, [paper]);
  assert.equal(titleOnly.values.Method.unverified, true);
});

test("CSV retains evidence, source metadata and safe text cells", () => {
  const row = evidenceRow(paper, columns, text, "abstract");
  row.paper = paper;
  const rows = tableToCsvRows(columns, [row], {});
  assert.equal(rows[1][0], paper.title);
  const pos = rows[0].indexOf("Method (quote)");
  assert.ok(text.includes(rows[1][pos]));
  assert.equal(rows[1][pos + 1], "source excerpt");
  assert.equal(rowsToCsv([["=1+1", " +SUM(A1)", "-1+2", "@SUM(A1)", "\tcmd", "ordinary, text", "বাংলা"]]),
    "'=1+1,' +SUM(A1),'-1+2,'@SUM(A1),'\tcmd,\"ordinary, text\",বাংলা\r\n");
  assert.match(toCsv([{ ...paper, title: "=1+1" }]), /'=1\+1/);
});

test("open access filter rejects closed results and continues the fallback", async () => {
  fresh({ search: { order: ["openalex", "crossref"] } });
  mockFetch([
    [host("api.openalex.org"), () => json({ results: [work("W1", "Closed study", 2024)] })],
    [host("api.crossref.org"), () => json({ message: { items: [{ DOI: "10.1000/open", title: ["Open study"],
      link: [{ URL: "https://example.org/open.pdf", "content-type": "application/pdf" }] }] } })],
  ]);
  assert.deepEqual((await search("study", "openalex", 25, { oa_only: true })).results, []);
  // Limit the configured sources so this regression never calls a live service.
  const result = await search("study", "auto", 25, { oa_only: true });
  assert.ok(result.results.every((p) => p.oa_url));
  assert.ok(result.used.includes("crossref"));
});

test("quote checks ignore curly quotes and dash style but nothing else", () => {
  const abstract = "We didn’t find an effect – only a trend (p = 0.07).";
  const status = (quote) => checkValues({ a: { value: "x", quote } }, abstract).a.evidence_status;
  assert.equal(status("We didn't find an effect - only a trend (p = 0.07)."), "quote matched");
  assert.equal(status("We did find an effect - only a trend (p = 0.07)."), "unverified");
  assert.equal(status("We didn't find an effect - only a trend (p = 0.7)."), "unverified");
  assert.equal(quoteFound("We didn't find an effect - only a trend (p = 0.07).", abstract), true);
  assert.equal(quoteFound("We didn't find an effect only a trend (p = 0.07).", abstract), false);
});

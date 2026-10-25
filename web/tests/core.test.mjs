import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { apa, detectAndParse, findDois, parseBibtex, parseRis, toBibtex, toCsv, toRis } from "../engine/formats.js";
import * as graph from "../engine/graph.js";
import { abstractFromInvertedIndex, dedupe, makePaper, normalizeDoi, parseIdentifier, titleSimilarity } from "../engine/models.js";
import { bm25, keySentence, rankPapers } from "../engine/rank.js";
import { parseFeed } from "../engine/sources/arxiv.js";
import { toPaper } from "../engine/sources/openalex.js";
import { parseEfetch } from "../engine/sources/pubmed.js";
import { fresh, work } from "./helpers.mjs";

beforeEach(() => fresh());

test("identifiers", () => {
  assert.deepEqual(parseIdentifier("https://doi.org/10.1016/J.CEMCONRES.2020.106000"), ["doi", "10.1016/j.cemconres.2020.106000"]);
  assert.deepEqual(parseIdentifier("doi: 10.1038/nature12373."), ["doi", "10.1038/nature12373"]);
  assert.deepEqual(parseIdentifier("https://arxiv.org/abs/2101.00001v2"), ["arxiv", "2101.00001"]);
  assert.deepEqual(parseIdentifier("10.48550/arXiv.2101.00001"), ["arxiv", "2101.00001"]);
  assert.deepEqual(parseIdentifier("PMC1234567"), ["pmcid", "PMC1234567"]);
  assert.deepEqual(parseIdentifier("https://pubmed.ncbi.nlm.nih.gov/31234567/"), ["pmid", "31234567"]);
  assert.deepEqual(parseIdentifier("0000-0002-1825-009X"), ["orcid", "0000-0002-1825-009X"]);
  assert.deepEqual(parseIdentifier("https://openalex.org/W2741809807"), ["openalex", "W2741809807"]);
  assert.equal(parseIdentifier("concrete strength"), null);
  assert.equal(normalizeDoi("https://doi.org/10.1000/xyz/abstract"), "10.1000/xyz");
});

test("openalex parse", () => {
  const p = toPaper(work("W1", "Strength of <i>recycled</i> concrete", 2021, { refs: ["W2", "W3"], doi: "10.1000/abc" }));
  assert.equal(p.id, "doi:10.1000/abc");
  assert.equal(p.title, "Strength of recycled concrete");
  assert.equal(p.abstract, "A study of concrete strength.");
  assert.equal(p.ids.openalex, "W1");
  assert.deepEqual(p.references, ["W2", "W3"]);
  assert.equal(p.authors[0].orcid, "0000-0002-1825-0097");
  assert.equal(p.url, "https://x.org");
});

test("inverted index", () => {
  assert.equal(abstractFromInvertedIndex({ b: [1], a: [0], c: [2, 3] }), "a b c c");
});

test("dedupe merges by doi and title", () => {
  const a = makePaper({ source: "openalex", title: "Deep learning for cracks", doi: "10.1000/x", cited_by_count: 5, ids: { openalex: "W9" } });
  const b = makePaper({ source: "semanticscholar", title: "Deep Learning for Cracks", doi: "10.1000/X", abstract: "Longer abstract here.", cited_by_count: 7, tldr: "Short.", ids: { s2: "abc" } });
  const c = makePaper({ source: "arxiv", title: "Deep learning for cracks in bridges and beams", year: 2020 });
  const d = makePaper({ source: "crossref", title: "Deep learning for cracks in bridges and beams", year: 2020 });
  const out = dedupe([a, b, c, d]);
  assert.equal(out.length, 2);
  assert.equal(out[0].cited_by_count, 7);
  assert.deepEqual(out[0].ids, { s2: "abc", openalex: "W9" });
  assert.equal(out[0].abstract, "Longer abstract here.");
  assert.equal(out[0].tldr, "Short.");
  assert.deepEqual(new Set(out[0].sources), new Set(["openalex", "semanticscholar"]));
});

test("title similarity", () => {
  assert.equal(titleSimilarity("Recycled aggregate concrete", "recycled aggregate concrete"), 1);
  assert.ok(titleSimilarity("Recycled aggregate concrete", "Bridges in winter") < 0.2);
  assert.equal(titleSimilarity("", "x"), 0);
});

test("ranking", () => {
  const docs = ["steel beams under fire", "concrete compressive strength with recycled aggregate", "soil"];
  const s = bm25("recycled aggregate concrete strength", docs);
  assert.equal(s.indexOf(Math.max(...s)), 1);
  const papers = docs.map((t) => makePaper({ source: "x", title: t, abstract: t }));
  assert.ok(rankPapers("recycled concrete", papers)[0].title.startsWith("concrete"));
  const text = "Concrete is common. Recycled aggregate reduced strength by 12 percent in all mixes tested here.";
  assert.ok(keySentence("recycled aggregate strength", text).includes("Recycled"));
});

test("graph scoring", () => {
  const seed = toPaper(work("S", "Seed", 2015, { refs: ["A", "B", "C"] }));
  const refs = ["A", "B", "C"].map((w) => toPaper(work(w, `Ref ${w}`, 2010, { refs: ["X"] })));
  const citers = [
    toPaper(work("D", "Citer D", 2018, { refs: ["S", "A", "B", "C"] })),
    toPaper(work("E", "Citer E", 2019, { refs: ["S", "A"] })),
  ];
  const cand = graph.scoreCandidates([{ seed, refs, cites: citers }]);
  assert.deepEqual(new Set(cand.keys()), new Set(["A", "B", "C", "D", "E"]));
  assert.equal(cand.get("A").cocitation_raw, 2);
  assert.ok(cand.get("A").score > cand.get("B").score);
  assert.ok(cand.get("B").score >= cand.get("C").score);
  assert.equal(cand.get("D").coupling_raw, 3);
  assert.ok(cand.get("D").score > cand.get("E").score);
  const nodes = new Map([["S", { paper: seed }], ...[...cand].map(([k, c]) => [k, { paper: c.paper }])]);
  const edges = graph.buildEdges(nodes, cand);
  assert.ok(edges.some((e) => e.source === "D" && e.target === "S"));
  assert.ok(edges.some((e) => e.source === "S" && e.target === "A"));
  const pr = graph.pagerank([...nodes.keys()], edges);
  assert.equal(pr.A, 1.0);
});

test("formats roundtrip", () => {
  const p = makePaper({
    source: "x", title: "Fire & steel {beams}", doi: "10.5555/fire", year: 2022, venue: "Fire Safety J",
    authors: [{ name: "Md. Farhad Momin" }, { name: "Jane Roe" }], abstract: "We test beams.",
  });
  const bib = toBibtex([p]);
  assert.ok(bib.includes("@article{momin2022fire"));
  assert.ok(bib.includes("\\&"));
  const back = parseBibtex(bib);
  assert.equal(back[0].doi, "10.5555/fire");
  assert.equal(back[0].year, 2022);
  const ris = toRis([p]);
  const back2 = parseRis(ris);
  assert.equal(back2[0].title, "Fire & steel {beams}");
  assert.equal(back2[0].authors.length, 2);
  assert.ok(apa(p).startsWith("Momin, M. F., & Roe, J. (2022). Fire & steel {beams}."));
  assert.equal(detectAndParse(bib)[0], "bibtex");
  assert.equal(detectAndParse(ris)[0], "ris");
  assert.deepEqual(findDois("see 10.1000/a and https://doi.org/10.2000/B."), ["10.1000/a", "10.2000/b"]);
  const csv = toCsv([p]);
  assert.ok(csv.startsWith("Title,Authors,Year"));
  assert.ok(csv.includes('"Fire & steel {beams}"') === false && csv.includes("Fire & steel {beams}"));
  assert.ok(csv.endsWith("\r\n"));
});

test("bibtex single line and variants", () => {
  const text = '@article{a1, title={Properties of {RAC}}, author={Silva, R. and Brito, J.}, year={2014}, doi={10.1234/x}}\n' +
    "@comment{skip}\n" +
    '@inproceedings(b2, title = "Seismic " # "risk", year = 2019, booktitle={Proc})\n';
  const [kind, papers] = detectAndParse(text);
  assert.equal(kind, "bibtex");
  assert.deepEqual(papers.map((p) => p.title), ["Properties of RAC", "Seismic risk"]);
  assert.equal(papers[0].doi, "10.1234/x");
  assert.equal(papers[1].year, 2019);
  assert.deepEqual(papers[0].authors.map((a) => a.name), ["Silva, R.", "Brito, J."]);
});

test("arxiv atom parse", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v2</id>
    <published>2021-01-01T00:00:00Z</published>
    <title>Graph &amp; networks
      for concrete</title>
    <summary>We study things.</summary>
    <author><name> Ada Lovelace </name></author>
    <author><name>Alan Turing</name></author>
    <arxiv:doi>10.1000/arx</arxiv:doi>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v2" rel="related"/>
    <arxiv:primary_category term="cs.LG" scheme="x"/>
  </entry>
</feed>`;
  const [p] = parseFeed(xml);
  assert.equal(p.title, "Graph & networks for concrete");
  assert.equal(p.ids.arxiv, "2101.00001");
  assert.equal(p.doi, "10.1000/arx");
  assert.equal(p.year, 2021);
  assert.deepEqual(p.authors.map((a) => a.name), ["Ada Lovelace", "Alan Turing"]);
  assert.equal(p.oa_url, "http://arxiv.org/pdf/2101.00001v2");
  assert.deepEqual(p.topics, ["cs.LG"]);
});

test("pubmed efetch parse", () => {
  const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">31234567</PMID>
<Article><Journal><JournalIssue><PubDate><Year>2019</Year></PubDate></JournalIssue><Title>Cement Res</Title></Journal>
<ArticleTitle>Fly <i>ash</i> in concrete</ArticleTitle><Abstract><AbstractText>Part one.</AbstractText><AbstractText>Part two.</AbstractText></Abstract>
<AuthorList><Author><LastName>Rahman</LastName><ForeName>A</ForeName><Identifier Source="ORCID">https://orcid.org/0000-0001-0000-0001</Identifier></Author></AuthorList>
</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/pm</ArticleId><ArticleId IdType="pmc">PMC7654321</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
  const [p] = parseEfetch(xml);
  assert.equal(p.title, "Fly ash in concrete");
  assert.equal(p.abstract, "Part one. Part two.");
  assert.equal(p.year, 2019);
  assert.equal(p.venue, "Cement Res");
  assert.equal(p.doi, "10.1000/pm");
  assert.equal(p.ids.pmcid, "PMC7654321");
  assert.equal(p.authors[0].name, "A Rahman");
  assert.equal(p.authors[0].orcid, "0000-0001-0000-0001");
});

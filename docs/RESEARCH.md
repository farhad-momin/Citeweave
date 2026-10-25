# Feature research

This note covers what researchers need from a literature tool, and how Citeweave delivers each need using open data and optional AI. Facts about the data services were checked in October 2026.

## What researchers need

From researcher workflows for literature reviews, theses and grant writing:

| Need | Typical pain today | Citeweave feature |
|---|---|---|
| Find relevant papers fast | Results scattered across databases | One search over many open sources, with fallback when one is busy |
| Understand a field's structure | Hard to see which papers matter and how they connect | Citation maps ranked by co-citation and coupling, plus lists of foundations and newer work |
| Follow citation trails | Clicking through reference lists by hand | References and Cited by tabs on every paper, plus one-click "add as seed" |
| Answer a specific question | Reading dozens of abstracts | Ranked papers with key sentences, plus an optional AI answer where every claim is cited |
| Compare many studies | Copying details into a spreadsheet by hand | Tables: describe columns once, filled per paper with a supporting quote |
| Stay current | Missing new work | Saved maps with "check for new papers" citing the seeds |
| Keep a reading list | Notes spread across tools | Collections with status, notes and tags, plus BibTeX, RIS and CSV export and Zotero |
| Capture papers while browsing | Copying DOIs | Browser extension for Chromium browsers and Firefox |
| Know a researcher's output | Profiles in many places | ORCID, OpenAlex, Semantic Scholar or Scopus author import, with h-index |
| Keep costs at zero | Usage limits and monthly fees | Local first. Open data, cached responses, free local AI or your own key |

## Open data services

| Service | Base URL | What Citeweave uses | Access |
|---|---|---|---|
| OpenAlex | `https://api.openalex.org` | search, works by DOI or id, `referenced_works`, `filter=cites:`, `related_works`, authors by ORCID, autocomplete | Usage based. About $0.10 per day of free usage without a key, $1 per day with a free key. Single lookups by id or DOI are free. Search is the most expensive call, so results are cached for 12 hours and works for 7 days. Data is CC0 |
| Semantic Scholar | `https://api.semanticscholar.org/graph/v1` | search, paper by DOI, ARXIV or PMID, references, citations, TLDR, batch, recommendations (`/recommendations/v1/papers`) | Free. Without a key, requests share a public pool. A personal key gives 1 request per second to start. Keys must not be shared, so each user brings their own. Attribution is required |
| Crossref | `https://api.crossref.org` | search, `works/{doi}`, `query.bibliographic` to verify AI suggestions | Free. Adding `mailto` gives the polite pool, with more speed and concurrency |
| OpenCitations Index v2 | `https://api.opencitations.net/index/v2` | `/references/doi:` and `/citations/doi:` as a backup | Free, CC0. 180 requests per minute per IP. A token is optional |
| Europe PMC | `https://www.ebi.ac.uk/europepmc/webservices/rest` | search with abstracts and open access links | Free |
| PubMed E-utilities | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | esearch and efetch | 3 requests per second without a key, 10 with a free key. Send `tool` and `email` |
| arXiv | `https://export.arxiv.org/api/query` | search and id lookup (Atom XML) | Free. One request every 3 seconds |
| Unpaywall | `https://api.unpaywall.org/v2/{doi}?email=` | legal open access PDF links | Free, about 100,000 per day. Needs an email |
| ORCID public API | `https://pub.orcid.org/v3.0/{id}/works` | a researcher's works | Anonymous reads allowed. The public API is for non-commercial use |
| CORE | `https://api.core.ac.uk/v3/search/works` | open access repository search | Free key |
| Scopus | `https://api.elsevier.com/content/search/scopus` | search and author works | Your own key, usually on your institution's network |
| Zotero (local) | `http://127.0.0.1:23119` | `/connector/import` (send RIS), `/api/users/0/...` (read) | Zotero desktop must be open. Reading needs the local API turned on in Zotero settings |

### Access from a web page

Checked from a real browser in October 2026 (requests from an ordinary web page):

| Works directly | Refuses web pages |
|---|---|
| OpenAlex, Crossref, OpenCitations, Europe PMC, PubMed, Unpaywall, ORCID, GitHub, OpenAI, Anthropic, Gemini, DeepSeek, Groq, Mistral, OpenRouter | Semantic Scholar, arXiv, CORE |

The web version skips the second column unless the researcher adds the optional relay. The PC app is not affected.

## Algorithms

**Co-citation.** Two papers are co-cited when a later paper cites both. For a candidate C and the seed set S, Citeweave counts the citing papers of S whose reference lists contain C. OpenAlex returns each citing paper's reference list in the same request, so no extra calls are needed.

**Bibliographic coupling.** C and S are coupled when they cite the same works. The count is the size of `refs(C) ∩ refs(S)`.

**Normalization.** Raw counts favour huge papers. Both signals use cosine (Salton) normalization, `x / sqrt(|A| · |B|)`, then scale to 0..1 across candidates.

**Score.** `0.4 · direct links + 0.3 · coupling + 0.3 · co-citation`. Direct links are the share of seeds that C cites or is cited by.

**Foundations and newer work.** Foundations are works cited by two or more map papers but not on the map. Newer work is citing papers that reference two or more map papers.

**Importance.** PageRank over the citation links inside the map. It is shown in the data and available for sorting.

**Ranking for questions.** Okapi BM25 over title and abstract, blended with the source's own rank and a small citation signal. It runs instantly with no model. The key sentence is the abstract sentence with the best BM25 score, with a boost for sentences that report findings or numbers.

**Grounded AI.** Answers and tables are generated only from the supplied abstracts or open access full text. The model has to cite or quote, and is told to say when the text does not answer. AI-suggested papers are verified against Crossref or OpenAlex by title-word overlap (Jaccard of at least 0.7, with a year check) before they are shown.

## Ideas for later versions

- Local embeddings for semantic similarity (a small model running on the CPU).
- A personal feed: rate papers as relevant or not, then get daily recommendations from recent papers.
- Paths between two papers: the shortest citation path that links them.
- A co-author network view.
- Screening workflow for systematic reviews, with PRISMA counts and export.
- Citation context: how a paper is cited (supporting, contrasting, mentioning), from open full text.
- Two-way Zotero sync.
- Translations of the interface, Bangla included.

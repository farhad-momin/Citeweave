# Citeweave audit, 26 October 2026

## Scope and purpose

Code review of the desktop and browser research workflows, optional AI extraction, evidence handling, exports, source fallback and GitHub build configuration. The goal is useful, free, open-source research support. This is a focused engineering audit, not a certification of every integration or research result.

## Findings addressed

| Priority | Finding | Change |
|---|---|---|
| High | Tables refused to run with AI off, leaving a core workflow dependent on model setup or an external chatbot. | Both engines now retrieve candidate abstract sentences locally. The primary Tables action is **Find evidence (free)**, even when an AI provider is configured. No key, account, model download or provider call is needed for this action. |
| High | Automatic AI extraction accepted supporting quotes without checking them. | Each quote is checked against the exact text supplied to the model, including full text on desktop. Missing or unmatched quotes are marked unverified. A quote match does not validate the interpretation. |
| High | Pasted-reply quote checks accepted a bag-of-words similarity threshold, allowing altered findings or reordered text. | Matching preserves words, numbers, negation and punctuation; only Unicode typography and whitespace are normalized. Titles no longer count as abstract evidence. |
| High | A misnumbered pasted table could fall back to array position and attach values to the wrong paper. | Rows require a unique matching paper number. Missing or duplicate numbers generate review warnings. |
| Medium | An unavailable AI provider produced empty error rows. | Affected rows now fall back to labelled free excerpts and retain the failure message. Browser cancellation still stops the task. |
| Medium | CSV table exports discarded supporting quotes and verification information. | Exports now include source type, mode, row notes, each quote and its evidence status. Older rows without checks remain labelled **not checked**. |
| Medium | Untrusted imported text or generated values could be interpreted as spreadsheet formulas. | Both CSV exporters prefix potentially executable cells with an apostrophe. This may display a leading apostrophe in some readers; stored values are unchanged. |
| Medium | Open-access-only searches restored unfiltered results when no open-access links were found. | Every source is filtered before fallback selection; an empty filtered source can yield to the next source. Only records with an available OA link remain. |
| Low | Quote checks flagged identical text that differed only in curly versus straight quotes or dash style. | Typographic quotes and dashes are treated as equal in all three quote checks; words, numbers and negation stay exact. |
| Low | The browser library rendered a literal `null` where the desktop-only control was hidden. | The absent control is omitted from the DOM. |
| Low | Contributor guidance omitted browser tests, and CI did not check the web build. | Added browser/build instructions, a CI web build and explicit read-only repository permissions for test jobs. |

## Free mode behavior

The default provider remains Off. Search, maps, library, exports and key-sentence answers retain their existing no-key paths. Tables now have a no-model path too.

Free table extraction reads the abstract, or an existing short summary when no abstract exists. It selects candidate sentences using English field cues and keyword relevance. It does not infer a study design, calculate an effect size, interpret a result or confirm that an excerpt answers the column instruction. Every candidate is marked for review. **Not found in available text** means the retrieval found no match, not that the full paper omits the information. Short sentences and non-English source text are preserved, but preset retrieval cues are English.

AI and API providers remain optional. The free action explicitly bypasses them. With AI enabled, table generation can use its existing full-text path on desktop; API failures fall back per row. Existing saved tables are not rewritten or retrospectively declared verified.

## Validation

- Python suite: 66 passing tests, including 16 new regression cases.
- Browser engine suite: 49 passing tests, including nine new evidence/quoting/export/filter cases and an updated end-to-end free-table case.
- Ruff lint check passed.
- Static web build passed; the new evidence module is included in the built site.
- Browser smoke test: imported a synthetic BibTeX record containing an abstract, sent it to Tables, generated and saved a free table with AI off, and checked the displayed source sentences and review labels.
- Python tests use isolated data folders. External providers are mocked in regression tests. The browser smoke test uses a separate local preview origin, not the researcher's library.

One dependency deprecation warning was emitted by the installed FastAPI/Starlette test client. It did not fail the suite. The Windows app bundle and GitHub-hosted deployment were not rebuilt or published during this audit.

## Remaining limitations and next work

1. **Research review workflow:** add editable extraction cells with a reviewer, timestamp and accepted/rejected state; retain the original excerpt alongside edits. Current warnings support review but do not record a completed review decision.
2. **Evidence quality:** benchmark retrieval on real papers across disciplines and languages before making accuracy claims. Matching quotations cannot establish entailment, causal validity, risk of bias or complete coverage.
3. **Search reproducibility:** add exportable search protocols with query, filters, sources, dates and screening decisions for systematic reviews. Current search and citation mapping are discovery aids.
4. **Integration validation:** run opt-in live checks of public data sources and model providers before a release. Quotas, model names, browser AI availability and CORS policies can change. Mocked tests do not prove current service availability.
5. **Distribution:** rebuild and test the Windows release artifact to include these changes. Verify the public repository's Pages and release workflows after pushing. Source changes do not update an already packaged executable.

Citeweave adds no application credit system. Public data providers can still limit requests, and locally generated prose depends on the researcher's hardware. Imported abstracts and their evidence tables require neither a paid service nor an installed model.

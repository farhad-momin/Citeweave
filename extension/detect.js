// Runs inside the current page (injected by the popup) and returns what identifies the paper.
// It reads only standard citation metadata tags and the page address. Nothing is sent anywhere
// except to the Citeweave app on this computer, and only when you use the popup.
function citeweaveDetect() {
  const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/i;
  const meta = (names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[name="${n}" i], meta[property="${n}" i]`);
      if (el && el.content && el.content.trim()) return el.content.trim();
    }
    return "";
  };
  const metaAll = (name) => [...document.querySelectorAll(`meta[name="${name}" i]`)].map((m) => m.content.trim()).filter(Boolean);
  const cleanDoi = (s) => {
    const m = (s || "").match(DOI_RE);
    return m ? m[0].replace(/[.,;)\]}]+$/, "").replace(/(\/abstract|\/full|\/pdf|\/epdf)$/i, "") : "";
  };

  // an address without its query and fragment, decoded when that is possible
  const bare = (u) => {
    let s = String(u || "").split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch { /* keep it encoded */ }
    return s;
  };
  const url = location.href;
  const path = bare(url);
  let identifier = "";
  let confidence = "high";
  let doi = cleanDoi(meta(["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi", "bepress_citation_doi", "rft_id", "doi"]));
  if (!doi) {
    const canon = document.querySelector('link[rel="canonical"]')?.href || "";
    doi = cleanDoi(bare(canon)) || cleanDoi(path);
  }
  const arxiv = meta(["citation_arxiv_id"]).replace(/^arxiv:/i, "") ||
    (path.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?\/?$/i) || [])[1] || "";
  const pmid = meta(["citation_pmid"]) ||
    (path.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed|europepmc\.org\/(?:abstract|article)\/MED)\/(\d+)/i) || [])[1] || "";
  const pmcid = ((path.match(/\b(PMC\d+)/i) || [])[1] || "").toUpperCase();

  if (doi) identifier = doi;
  else if (arxiv) identifier = `arXiv:${arxiv}`;
  else if (pmid) identifier = `PMID:${pmid}`;
  else if (pmcid) identifier = pmcid;
  else {
    // last resort: a DOI shown near the top of the page
    const text = (document.body?.innerText || "").slice(0, 6000);
    const m = text.match(/(?:doi\.org\/|doi:\s*)(10\.\d{4,9}\/[^\s"'<>]+)/i);
    if (m) { identifier = cleanDoi(m[1]); confidence = "low"; }
  }
  const selection = String(window.getSelection?.() || "").trim().slice(0, 500);
  const selDoi = cleanDoi(selection);
  if (selDoi) { identifier = selDoi; confidence = "high"; }

  const title = meta(["citation_title", "dc.title", "prism.title", "og:title"]) || document.title || "";
  return {
    identifier,
    confidence,
    title: title.replace(/\s+/g, " ").trim().slice(0, 400),
    authors: metaAll("citation_author").slice(0, 12),
    year: (meta(["citation_publication_date", "citation_date", "dc.date", "prism.publicationDate"]).match(/\d{4}/) || [""])[0],
    journal: meta(["citation_journal_title", "prism.publicationName", "citation_conference_title"]),
    pdf: meta(["citation_pdf_url"]),
    url,
    selection: selDoi ? "" : selection,
  };
}

// The same address-based checks, for pages where the script cannot run (built-in PDF viewers,
// some browser pages). Used by the popup.
function citeweaveDetectUrl(url, title = "") {
  let path = String(url || "").split(/[?#]/)[0];
  try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
  const doiM = path.match(/10\.\d{4,9}\/[^\s"'<>]+/i);
  const doi = doiM ? doiM[0].replace(/[.,;)\]}]+$/, "").replace(/(\/abstract|\/full|\/pdf|\/epdf)$/i, "") : "";
  const arxiv = (path.match(/arxiv\.org\/(?:abs|pdf|html)\/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?\/?$/i) || [])[1] || "";
  const pmid = (path.match(/(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov\/pubmed|europepmc\.org\/(?:abstract|article)\/MED)\/(\d+)/i) || [])[1] || "";
  const pmcid = ((path.match(/\b(PMC\d+)/i) || [])[1] || "").toUpperCase();
  const identifier = doi || (arxiv && `arXiv:${arxiv}`) || (pmid && `PMID:${pmid}`) || pmcid || "";
  return { identifier, confidence: "high", title: String(title || "").replace(/\s+/g, " ").trim().slice(0, 400), authors: [], url };
}

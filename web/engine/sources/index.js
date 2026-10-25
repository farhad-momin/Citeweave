// Registry of data sources. Mirrors citeweave/sources/__init__.py.
import { Arxiv } from "./arxiv.js";
import { Crossref } from "./crossref.js";
import { EuropePMC } from "./europepmc.js";
import { Core, Orcid, Scopus, Unpaywall } from "./extra.js";
import { OpenAlex } from "./openalex.js";
import { OpenCitations } from "./opencitations.js";
import { PubMed } from "./pubmed.js";
import { SemanticScholar } from "./semanticscholar.js";

export const openalex = new OpenAlex();
export const semanticscholar = new SemanticScholar();
export const crossref = new Crossref();
export const opencitations = new OpenCitations();
export const arxiv = new Arxiv();
export const europepmc = new EuropePMC();
export const pubmed = new PubMed();
export const unpaywall = new Unpaywall();
export const orcid = new Orcid();
export const core = new Core();
export const scopus = new Scopus();

export const ALL = Object.fromEntries([
  openalex, semanticscholar, crossref, europepmc, arxiv, pubmed, core, scopus,
  opencitations, unpaywall, orcid,
].map((s) => [s.name, s]));

export const SEARCHABLE = Object.values(ALL).filter((s) => s.capabilities.has("search")).map((s) => s.name);

export function getSource(name) {
  if (!ALL[name]) throw new Error(`Unknown source: ${name}`);
  return ALL[name];
}

// browser hosts: lets ready() skip services that refuse web pages unless a relay is set
semanticscholar.host = "api.semanticscholar.org";
arxiv.host = "export.arxiv.org";
core.host = "api.core.ac.uk";
scopus.host = "api.elsevier.com";

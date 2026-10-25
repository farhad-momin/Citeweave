"""Registry of data sources."""
from __future__ import annotations

from .arxiv import Arxiv
from .base import Source
from .crossref import Crossref
from .europepmc import EuropePMC
from .extra import Core, Orcid, Scopus, Unpaywall
from .openalex import OpenAlex
from .opencitations import OpenCitations
from .pubmed import PubMed
from .semanticscholar import SemanticScholar

openalex = OpenAlex()
semanticscholar = SemanticScholar()
crossref = Crossref()
opencitations = OpenCitations()
arxiv = Arxiv()
europepmc = EuropePMC()
pubmed = PubMed()
unpaywall = Unpaywall()
orcid = Orcid()
core = Core()
scopus = Scopus()

ALL: dict[str, Source] = {s.name: s for s in [
    openalex, semanticscholar, crossref, europepmc, arxiv, pubmed, core, scopus,
    opencitations, unpaywall, orcid,
]}

SEARCHABLE = [n for n, s in ALL.items() if "search" in s.capabilities]


def get_source(name: str) -> Source:
    if name not in ALL:
        raise KeyError(f"Unknown source: {name}")
    return ALL[name]

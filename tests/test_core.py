from citeweave import graph
from citeweave.formats import apa, detect_and_parse, find_dois, parse_bibtex, parse_ris, to_bibtex, to_ris
from citeweave.models import abstract_from_inverted_index, dedupe, make_paper, normalize_doi, parse_identifier
from citeweave.rank import bm25, key_sentence, rank_papers
from citeweave.sources.openalex import to_paper

from .conftest import work


def test_identifiers():
    assert parse_identifier("https://doi.org/10.1016/J.CEMCONRES.2020.106000") == ("doi", "10.1016/j.cemconres.2020.106000")
    assert parse_identifier("doi: 10.1038/nature12373.") == ("doi", "10.1038/nature12373")
    assert parse_identifier("https://arxiv.org/abs/2101.00001v2") == ("arxiv", "2101.00001")
    assert parse_identifier("10.48550/arXiv.2101.00001") == ("arxiv", "2101.00001")
    assert parse_identifier("PMC1234567") == ("pmcid", "PMC1234567")
    assert parse_identifier("https://pubmed.ncbi.nlm.nih.gov/31234567/") == ("pmid", "31234567")
    assert parse_identifier("0000-0002-1825-009X") == ("orcid", "0000-0002-1825-009X")
    assert parse_identifier("https://openalex.org/W2741809807") == ("openalex", "W2741809807")
    assert parse_identifier("concrete strength") is None
    assert normalize_doi("https://doi.org/10.1000/xyz/abstract") == "10.1000/xyz"


def test_openalex_parse():
    p = to_paper(work("W1", "Strength of <i>recycled</i> concrete", 2021, refs=["W2", "W3"], doi="10.1000/abc"))
    assert p["id"] == "doi:10.1000/abc"
    assert p["title"] == "Strength of recycled concrete"
    assert p["abstract"] == "A study of concrete strength."
    assert p["ids"]["openalex"] == "W1"
    assert p["references"] == ["W2", "W3"]
    assert p["authors"][0]["orcid"] == "0000-0002-1825-0097"


def test_inverted_index():
    assert abstract_from_inverted_index({"b": [1], "a": [0], "c": [2, 3]}) == "a b c c"


def test_dedupe_merges_by_doi_and_title():
    a = make_paper(source="openalex", title="Deep learning for cracks", doi="10.1000/x", cited_by_count=5,
                   ids={"openalex": "W9"})
    b = make_paper(source="semanticscholar", title="Deep Learning for Cracks", doi="10.1000/X",
                   abstract="Longer abstract here.", cited_by_count=7, tldr="Short.", ids={"s2": "abc"})
    c = make_paper(source="arxiv", title="Deep learning for cracks in bridges and beams", year=2020)
    d = make_paper(source="crossref", title="Deep learning for cracks in bridges and beams", year=2020)
    out = dedupe([a, b, c, d])
    assert len(out) == 2
    assert out[0]["cited_by_count"] == 7
    assert out[0]["ids"] == {"openalex": "W9", "s2": "abc"}
    assert out[0]["abstract"] == "Longer abstract here."
    assert set(out[0]["sources"]) == {"openalex", "semanticscholar"}


def test_ranking():
    docs = ["steel beams under fire", "concrete compressive strength with recycled aggregate", "soil"]
    s = bm25("recycled aggregate concrete strength", docs)
    assert s.index(max(s)) == 1
    papers = [make_paper(source="x", title=t, abstract=t) for t in docs]
    assert rank_papers("recycled concrete", papers)[0]["title"].startswith("concrete")
    text = "Concrete is common. Recycled aggregate reduced strength by 12 percent in all mixes tested here."
    assert "Recycled" in key_sentence("recycled aggregate strength", text)


def test_graph_scoring():
    seed = to_paper(work("S", "Seed", 2015, refs=["A", "B", "C"]))
    refs = [to_paper(work(w, f"Ref {w}", 2010, refs=["X"])) for w in ("A", "B", "C")]
    citers = [
        to_paper(work("D", "Citer D", 2018, refs=["S", "A", "B", "C"])),
        to_paper(work("E", "Citer E", 2019, refs=["S", "A"])),
    ]
    cand = graph.score_candidates([{"seed": seed, "refs": refs, "cites": citers}])
    assert set(cand) == {"A", "B", "C", "D", "E"}
    # A is co-cited with the seed by both citers, so it should rank above B and C
    assert cand["A"]["cocitation_raw"] == 2
    assert cand["A"]["score"] > cand["B"]["score"] >= cand["C"]["score"]
    # D shares all three references with the seed (bibliographic coupling)
    assert cand["D"]["coupling_raw"] == 3
    assert cand["D"]["score"] > cand["E"]["score"]
    nodes = {"S": {"paper": seed}, **{k: {"paper": cand[k]["paper"]} for k in cand}}
    edges = graph.build_edges(nodes, cand)
    assert {"source": "D", "target": "S"} in edges
    assert {"source": "S", "target": "A"} in edges
    pr = graph.pagerank(list(nodes), edges)
    assert pr["A"] == 1.0  # most cited inside the map


def test_formats_roundtrip():
    p = make_paper(source="x", title="Fire & steel {beams}", doi="10.5555/fire", year=2022, venue="Fire Safety J",
                   authors=[{"name": "Md. Farhad Momin"}, {"name": "Jane Roe"}], abstract="We test beams.")
    bib = to_bibtex([p])
    assert "@article{momin2022fire" in bib
    assert "\\&" in bib
    back = parse_bibtex(bib)
    assert back[0]["doi"] == "10.5555/fire" and back[0]["year"] == 2022
    ris = to_ris([p])
    back2 = parse_ris(ris)
    assert back2[0]["title"] == "Fire & steel {beams}"
    assert len(back2[0]["authors"]) == 2
    assert apa(p).startswith("Momin, M. F., & Roe, J. (2022). Fire & steel {beams}.")
    assert detect_and_parse(bib)[0] == "bibtex"
    assert detect_and_parse(ris)[0] == "ris"
    assert find_dois("see 10.1000/a and https://doi.org/10.2000/B.") == ["10.1000/a", "10.2000/b"]


def test_h_index():
    from citeweave.server import h_index
    assert h_index([10, 8, 5, 4, 3]) == 4
    assert h_index([]) == 0


def test_bibtex_single_line_and_variants():
    from citeweave.formats import detect_and_parse
    text = (
        '@article{a1, title={Properties of {RAC}}, author={Silva, R. and Brito, J.}, year={2014}, doi={10.1234/x}}\n'
        '@comment{skip}\n'
        '@inproceedings(b2, title = "Seismic " # "risk", year = 2019, booktitle={Proc})\n'
    )
    kind, papers = detect_and_parse(text)
    assert kind == "bibtex"
    assert [p["title"] for p in papers] == ["Properties of RAC", "Seismic risk"]
    assert papers[0]["doi"] == "10.1234/x" and papers[1]["year"] == 2019


def test_updating_a_saved_paper_keeps_it_in_collections():
    from citeweave import library
    from citeweave.db import db
    from citeweave.models import make_paper

    p = make_paper(source="t", title="Saved paper", doi="10.1000/keep")
    c = library.create_collection("Keep")
    library.add_papers(c["id"], [p])
    library.set_note(p["id"], "important")
    library.set_tags(p["id"], ["x"])
    db().upsert_paper({**p, "abstract": "Now with an abstract"})
    rows = library.collection_papers(c["id"])
    assert len(rows) == 1 and rows[0]["note"] == "important" and rows[0]["tags"] == ["x"]
    assert rows[0]["abstract"] == "Now with an abstract"

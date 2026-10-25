"""Regression tests for bugs found in the back end audit."""
import asyncio
import base64
import json
import sqlite3
import sys

import httpx
import pytest
import respx

from .conftest import work

OA = "https://api.openalex.org"


def run(coro):
    return asyncio.run(coro)


def test_server_config_works_without_stdout(monkeypatch):
    # pythonw.exe and the windowed .exe have no stdout; uvicorn's default logging setup crashed there
    from citeweave.cli import server_config

    monkeypatch.setattr(sys, "stdout", None)
    cfg = server_config(23999)
    assert cfg.port == 23999 and cfg.host == "127.0.0.1"


def test_europepmc_pmc_record_year_fallback():
    from citeweave.sources.europepmc import to_paper

    r = {"id": "PMC13670260", "source": "PMC", "pmcid": "PMC13670260", "title": "A PMC only record",
         "journalInfo": {"yearOfPublication": 2026, "dateOfPublication": "2026 Oct", "journal": {"title": "J X"}},
         "firstPublicationDate": "2026-10-19", "citedByCount": "0"}
    p = to_paper(r)
    assert p["year"] == 2026 and p["venue"] == "J X" and p["cited_by_count"] == 0
    assert to_paper({"id": "1", "title": "T", "firstPublicationDate": "2024-01-02"})["year"] == 2024
    assert to_paper({"id": "1", "title": "T", "electronicPublicationDate": "2023-05-06"})["year"] == 2023
    assert to_paper({"id": "1", "title": "T", "pubYear": "2019", "firstPublicationDate": "2024-01-02"})["year"] == 2019


@respx.mock
def test_europepmc_query_is_grouped_before_filters():
    from citeweave.sources import europepmc

    route = respx.get("https://www.ebi.ac.uk/europepmc/webservices/rest/search").mock(
        return_value=httpx.Response(200, json={"resultList": {"result": []}}))
    run(europepmc.search("cement OR concrete", filters={"year_from": 2020, "oa_only": True}))
    q = route.calls[0].request.url.params["query"]
    assert q.startswith("(cement OR concrete) AND (PUB_YEAR:[2020 TO 2100])")


@respx.mock
def test_crossref_verify_rejects_wrong_year():
    from citeweave.sources import crossref

    respx.get("https://api.crossref.org/works").mock(return_value=httpx.Response(200, json={"message": {"items": [
        {"DOI": "10.65215/r5bs2d54", "title": ["Attention is all you need"], "issued": {"date-parts": [[2025]]}}]}}))
    assert run(crossref.verify("Attention is all you need", "Vaswani", 2017)) is None
    assert run(crossref.verify("Attention is all you need", "Vaswani", 2025))["doi"] == "10.65215/r5bs2d54"


@respx.mock
def test_crossref_search_uses_valid_select_fields():
    from citeweave.sources import crossref

    route = respx.get("https://api.crossref.org/works").mock(
        return_value=httpx.Response(200, json={"message": {"items": []}}))
    run(crossref.search("concrete"))
    fields = route.calls[0].request.url.params["select"].split(",")
    assert "published" not in fields and "issued" in fields


@respx.mock
def test_verify_suggestions_falls_back_to_openalex_title_search():
    from citeweave.ai import tasks

    respx.get("https://api.crossref.org/works").mock(return_value=httpx.Response(200, json={"message": {"items": [
        {"DOI": "10.65215/r5bs2d54", "title": ["Attention is all you need"], "issued": {"date-parts": [[2025]]}}]}}))
    respx.get(f"{OA}/works").mock(return_value=httpx.Response(200, json={"results": [
        work("W9", "Attention is all you need", 2025, doi="10.65215/r5bs2d54"),
        work("W1", "Attention Is All You Need", 2017, doi="10.48550/arxiv.1706.03762"),
    ], "meta": {}}))
    out = run(tasks.verify_suggestions([{"title": "Attention is all you need", "first_author": "Vaswani", "year": 2017},
                                        {"title": "A paper nobody wrote about moon cheese", "year": 2020}]))
    assert [p["ids"]["openalex"] for p in out["results"]] == ["W1"]
    assert out["results"][0]["verified"] is True
    assert out["rejected"] == ["A paper nobody wrote about moon cheese"]


def test_openalex_pmcid_gets_pmc_prefix():
    from citeweave.sources.openalex import to_paper

    w = work("W1", "T", 2020)
    w["ids"]["pmcid"] = "https://www.ncbi.nlm.nih.gov/pmc/articles/5815332"
    assert to_paper(w)["ids"]["pmcid"] == "PMC5815332"


@respx.mock
def test_orcid_ignores_part_of_identifiers():
    from citeweave.sources import orcid

    respx.get("https://pub.orcid.org/v3.0/0000-0002-1825-0097/person").mock(return_value=httpx.Response(200, json={
        "name": {"given-names": {"value": "Farhad"}, "family-name": {"value": "Momin"}}}))

    def summary(title, ids):
        return {"work-summary": [{"title": {"title": {"value": title}}, "external-ids": {"external-id": [
            {"external-id-type": t, "external-id-value": v, "external-id-relationship": rel} for t, v, rel in ids]}}]}

    respx.get("https://pub.orcid.org/v3.0/0000-0002-1825-0097/works").mock(return_value=httpx.Response(200, json={
        "group": [summary("Chapter one", [("doi", "10.1000/book", "part-of"), ("doi", "10.1000/ch1", "self")]),
                  summary("Chapter two", [("doi", "10.1000/book", "part-of")])]}))
    info, works = run(orcid.works("0000-0002-1825-0097"))
    assert info["name"] == "Farhad Momin"
    assert [w["doi"] for w in works] == ["10.1000/ch1", None]


@respx.mock
def test_scopus_pages_past_25():
    from citeweave.config import settings
    from citeweave.sources import scopus

    settings().update({"sources": {"scopus": {"enabled": True, "key": "k"}}})

    def page(request):
        start = int(request.url.params["start"])
        count = int(request.url.params["count"])
        assert count <= 25
        entries = [{"dc:title": f"Work {i}", "dc:identifier": f"SCOPUS_ID:{i}"} for i in range(start, min(start + count, 40))]
        return httpx.Response(200, json={"search-results": {"opensearch:totalResults": "40", "entry": entries}})

    respx.get("https://api.elsevier.com/content/search/scopus").mock(side_effect=page)
    info, works = run(scopus.author_works("123"))
    assert len(works) == 40 and works[-1]["ids"]["scopus"] == "39"


@respx.mock
def test_zotero_reads_all_pages():
    from citeweave import zotero

    def items(request):
        start = int(request.url.params.get("start", 0))
        limit = int(request.url.params["limit"])
        assert limit <= 100
        rows = [{"data": {"itemType": "journalArticle", "title": f"Item number {i}"}} for i in range(start, min(start + limit, 150))]
        return httpx.Response(200, json=rows, headers={"Total-Results": "150"})

    respx.get("http://127.0.0.1:23119/api/users/0/items/top").mock(side_effect=items)
    assert len(run(zotero.read_items())) == 150


def test_temperature_zero_is_kept():
    from citeweave.ai import providers
    from citeweave.config import settings

    settings().update({"ai": {"provider": "openai", "temperature": 0}})
    assert providers.active_config()["temperature"] == 0.0


@respx.mock
def test_empty_rewrite_reply_falls_back_to_question():
    from citeweave.ai import tasks
    from citeweave.config import settings

    settings().update({"ai": {"provider": "openai", "model": "m", "keys": {"openai": "k"}}})
    respx.post("https://api.openai.com/v1/chat/completions").mock(return_value=httpx.Response(200, json={
        "choices": [{"message": {"content": ""}}]}))
    assert run(tasks.rewrite_query("Does fly ash help?")) == "Does fly ash help?"


@respx.mock
def test_ai_read_error_becomes_ai_error():
    from citeweave.ai import providers
    from citeweave.config import settings

    settings().update({"ai": {"provider": "openai", "model": "m", "keys": {"openai": "k"}}})
    respx.post("https://api.openai.com/v1/chat/completions").mock(side_effect=httpx.ReadError("reset"))
    with pytest.raises(providers.AIError):
        run(providers.chat("s", "u"))


def test_job_error_shows_http_detail():
    from fastapi import HTTPException

    from citeweave import jobs

    async def go():
        async def fn(progress):
            raise HTTPException(404, "Could not find a paper for 'x'")

        jid = jobs.start("t", fn)
        await asyncio.sleep(0.05)
        return jobs.get(jid)

    assert run(go())["error"] == "Could not find a paper for 'x'"


def test_sync_export_includes_map_seed_papers():
    from citeweave import library, sync
    from citeweave.db import db
    from citeweave.models import make_paper

    p = make_paper(source="t", title="Seed only", doi="10.1000/seed")
    db().upsert_paper(p)
    library.save_map("Map", [p["id"]], {}, [])
    assert p["id"] in sync.export_document()["papers"]


def test_sync_folder_reads_bom_and_reports_write_errors(tmp_path, monkeypatch):
    from citeweave import sync
    from citeweave.config import settings

    settings().update({"sync": {"folder": str(tmp_path)}})
    (tmp_path / sync.FILE_NAME).write_text(json.dumps({"format": "citeweave-sync", "version": 1}), encoding="utf-8-sig")
    assert sync.read_folder()["document"]["format"] == "citeweave-sync"

    def locked(*a, **k):
        raise PermissionError("in use")

    monkeypatch.setattr(sync.os, "replace", locked)
    with pytest.raises(sync.SyncError, match="Could not write"):
        sync.write_folder({"format": "citeweave-sync", "version": 1})
    with pytest.raises(sync.SyncError):
        sync.import_document({"format": "citeweave-sync", "version": "one"})


def test_legacy_tags_get_a_sync_time(tmp_path):
    from citeweave import db as dbm
    from citeweave import sync

    path = tmp_path / "legacy.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE papers (id TEXT PRIMARY KEY, doi TEXT, title TEXT, year INTEGER, data TEXT NOT NULL,
            updated_at REAL NOT NULL);
        CREATE TABLE tags (paper_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (paper_id, tag));
        INSERT INTO papers VALUES ('doi:10.1/x', '10.1/x', 'X', 2020, '{"id": "doi:10.1/x", "title": "X"}', 1);
        INSERT INTO tags VALUES ('doi:10.1/x', 'method');
    """)
    con.commit()
    con.close()
    dbm.reset_db_for_tests(path)
    rec = sync.export_document()["records"]["tags:doi:10.1/x"]
    assert rec["updated_at"] > 0 and rec["data"]["tags"] == ["method"]


def test_view_fields_are_not_stored_with_the_paper():
    from citeweave import library
    from citeweave.db import db
    from citeweave.models import make_paper

    p = make_paper(source="t", title="Paper", doi="10.1000/v")
    c = library.create_collection("C")
    library.add_papers(c["id"], [{**p, "note": "old note", "tags": ["old"], "saved": True, "collections": [1]}])
    stored = db().get_paper(p["id"])
    assert not {"note", "tags", "saved", "collections"} & set(stored)


@respx.mock
def test_github_write_goes_over_the_version_that_was_read():
    """Another device saving between our read and write must cause a conflict, not an overwrite."""
    import asyncio

    from citeweave import config, sync

    config.settings().update({"sync": {"github": {"token": "t", "repo": "me/data", "branch": "main", "path": "s.json"}}})
    state = {"sha": "v1"}

    def contents(request):
        if request.method == "GET":
            body = base64.b64encode(json.dumps({"format": "citeweave-sync", "version": 1, "records": {}, "papers": {}}).encode()).decode()
            return httpx.Response(200, json={"sha": state["sha"], "content": body, "size": 10})
        sent = json.loads(request.content)
        if sent.get("sha") != state["sha"]:
            return httpx.Response(409, json={"message": "conflict"})
        state["sha"] = "v9"
        return httpx.Response(200, json={"content": {"sha": "v9"}})

    respx.route(host="api.github.com").mock(side_effect=contents)
    doc = {"format": "citeweave-sync", "version": 1, "records": {}, "papers": {}}
    asyncio.run(sync.github("read"))
    state["sha"] = "v2"  # another device saved meanwhile
    with pytest.raises(sync.SyncError):
        asyncio.run(sync.github("write", doc))
    asyncio.run(sync.github("read"))
    assert asyncio.run(sync.github("write", doc))["sha"] == "v9"

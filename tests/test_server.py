import re
import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from .conftest import work

OA = "https://api.openalex.org"


@pytest.fixture
def client():
    from citeweave import net
    from citeweave.server import app

    net._client = None
    with TestClient(app) as c:
        yield c


def wait_job(client, job_id, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] != "running":
            return j
        time.sleep(0.05)
    raise AssertionError("job timed out")


def test_guard_blocks_web_pages(client):
    r = client.get("/api/status", headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    r = client.get("/api/ext/ping", headers={"origin": "chrome-extension://abcdef"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "chrome-extension://abcdef"
    r = client.get("/api/status", headers={"host": "attacker.com"})
    assert r.status_code == 403


def test_settings_mask_secrets(client):
    client.put("/api/settings", json={"sources": {"openalex": {"key": "secret-1234"}}, "ai": {"keys": {"openai": "sk-abcd9999"}}})
    s = client.get("/api/settings").json()
    assert s["sources"]["openalex"]["key"].endswith("1234") and "secret" not in s["sources"]["openalex"]["key"]
    # sending the masked value back keeps the real key
    client.put("/api/settings", json={"sources": {"openalex": {"key": s["sources"]["openalex"]["key"]}}})
    from citeweave.config import settings
    assert settings().get("sources", "openalex", "key") == "secret-1234"


@respx.mock
def test_search_falls_back(client):
    respx.get(f"{OA}/works").mock(return_value=httpx.Response(503, text="busy"))
    respx.get("https://api.semanticscholar.org/graph/v1/paper/search").mock(return_value=httpx.Response(200, json={
        "data": [{"paperId": "abc", "title": "Recycled aggregate concrete", "year": 2020,
                  "externalIds": {"DOI": "10.1000/rac"}, "authors": [{"name": "A B"}], "citationCount": 3}]}))
    r = client.get("/api/search", params={"q": "recycled concrete"}).json()
    assert r["used"] == ["semanticscholar"]
    assert "openalex" in r["errors"]
    assert r["results"][0]["doi"] == "10.1000/rac"


@respx.mock
def test_map_and_library(client):
    seed = work("S", "Seed paper", 2015, refs=["A", "B"], doi="10.1000/seed")
    a = work("A", "Paper A", 2010)
    b = work("B", "Paper B", 2011)
    d = work("D", "Citer D", 2019, refs=["S", "A", "B"])

    def works_route(request):
        f = request.url.params.get("filter", "")
        if f.startswith("ids.openalex:"):
            ids = f.split(":", 1)[1].split("|")
            pool = {"A": a, "B": b, "S": seed, "D": d}
            return httpx.Response(200, json={"results": [pool[i] for i in ids if i in pool], "meta": {}})
        if f.startswith("cites:S"):
            return httpx.Response(200, json={"results": [d], "meta": {"next_cursor": None}})
        return httpx.Response(200, json={"results": [seed], "meta": {}})

    respx.get(f"{OA}/works").mock(side_effect=works_route)
    respx.get(re.compile(rf"{OA}/works/doi:.*")).mock(return_value=httpx.Response(200, json=seed))
    respx.route(host="api.semanticscholar.org").mock(return_value=httpx.Response(404))

    job = client.post("/api/map", json={"seeds": ["10.1000/seed"], "max_nodes": 10}).json()["job"]
    res = wait_job(client, job)
    assert res["status"] == "done", res
    keys = {n["key"] for n in res["result"]["nodes"]}
    assert keys == {"S", "A", "B", "D"}
    assert {"source": "D", "target": "S"} in res["result"]["edges"]

    # library
    cid = client.post("/api/collections", json={"name": "RAC review"}).json()["id"]
    paper = next(n["paper"] for n in res["result"]["nodes"] if n["key"] == "A")
    assert client.post(f"/api/collections/{cid}/papers", json={"papers": [paper]}).json()["added"] == 1
    client.put("/api/notes", json={"paper_id": paper["id"], "body": "Good baseline"})
    client.post(f"/api/collections/{cid}/status", json={"paper_id": paper["id"], "status": "read"})
    rows = client.get(f"/api/collections/{cid}/papers").json()
    assert rows[0]["note"] == "Good baseline" and rows[0]["status"] == "read"
    bib = client.post("/api/export", json={"collection_id": cid, "format": "bibtex"}).text
    assert "Paper A" in bib


@respx.mock
def test_ask_without_ai_is_extractive(client):
    respx.get(f"{OA}/works").mock(return_value=httpx.Response(200, json={"results": [
        work("W1", "Recycled aggregate lowers strength", 2020,
             abstract="Concrete was tested. Replacing natural aggregate with recycled aggregate reduced strength by 10 percent."),
        work("W2", "Steel fibre in beams", 2019, abstract="Steel fibres improved ductility of beams in tests."),
    ], "meta": {}}))
    job = client.post("/api/ask", json={"question": "Does recycled aggregate reduce concrete strength?"}).json()["job"]
    res = wait_job(client, job)["result"]
    assert res["answer_kind"] == "extractive"
    assert res["papers"][0]["title"].startswith("Recycled")
    assert "10 percent" in res["answer"]


@respx.mock
def test_extract_with_openai_compatible_provider(client):
    client.put("/api/settings", json={"ai": {"provider": "deepseek", "model": "deepseek-chat",
                                             "keys": {"deepseek": "sk-test"}},
                                      "fulltext": {"allow_pdf_download": False}})
    route = respx.post("https://api.deepseek.com/v1/chat/completions").mock(return_value=httpx.Response(200, json={
        "choices": [{"message": {"content": '```json\n{"Method": {"value": "Lab tests", "quote": "Concrete was tested."}}\n```'}}]}))
    paper = {"id": "doi:10.1000/x", "title": "T", "abstract": "Concrete was tested in the lab.", "year": 2020}
    job = client.post("/api/extract", json={"papers": [paper], "columns": [{"name": "Method"}], "name": "My table"}).json()["job"]
    res = wait_job(client, job)
    assert res["status"] == "done", res
    row = res["result"]["rows"][0]
    assert row["values"]["Method"]["value"] == "Lab tests"
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test"
    tables = client.get("/api/tables").json()
    assert tables[0]["name"] == "My table"
    csv_text = client.get(f"/api/tables/{tables[0]['id']}/csv").text
    assert "Lab tests" in csv_text


@respx.mock
def test_anthropic_provider_format(client):
    client.put("/api/settings", json={"ai": {"provider": "anthropic", "model": "claude-haiku-5-5",
                                             "keys": {"anthropic": "ak-test"}}})
    route = respx.post("https://api.anthropic.com/v1/messages").mock(return_value=httpx.Response(200, json={
        "content": [{"type": "text", "text": "OK"}]}))
    r = client.post("/api/ai/test").json()
    assert r["reply"] == "OK"
    req = route.calls[0].request
    assert req.headers["x-api-key"] == "ak-test" and req.headers["anthropic-version"] == "2023-06-01"


@respx.mock
def test_ai_suggest_drops_unverified(client):
    client.put("/api/settings", json={"ai": {"provider": "openai", "model": "gpt-4o-mini", "keys": {"openai": "k"}}})
    respx.post("https://api.openai.com/v1/chat/completions").mock(return_value=httpx.Response(200, json={
        "choices": [{"message": {"content": '{"papers": [{"title": "Real paper on fly ash concrete", "year": 2019},'
                                            ' {"title": "Imaginary paper that does not exist", "year": 2021}]}'}}]}))

    def crossref(request):
        q = request.url.params.get("query.bibliographic", "")
        items = [{"DOI": "10.1000/fly", "title": ["Real paper on fly ash concrete"], "issued": {"date-parts": [[2019]]}}] \
            if "fly ash" in q else [{"DOI": "10.1000/other", "title": ["Something unrelated entirely"]}]
        return httpx.Response(200, json={"message": {"items": items}})

    respx.get("https://api.crossref.org/works").mock(side_effect=crossref)
    r = client.get("/api/search", params={"q": "fly ash concrete", "source": "ai"}).json()
    assert [p["doi"] for p in r["results"]] == ["10.1000/fly"]
    assert r["rejected"] == ["Imaginary paper that does not exist"]


@respx.mock
def test_extension_offline_uses_page_metadata(client):
    respx.route().mock(side_effect=httpx.ConnectError("no network"))
    page = {"identifier": "10.1016/j.jobe.2025.111111", "title": "Effect of recycled aggregate on concrete",
            "authors": ["Momin, Farhad"], "year": "2025", "journal": "J. Build. Eng.", "url": "https://x.org/a"}
    origin = {"Origin": "chrome-extension://abcdefghijklmnop"}
    t0 = time.time()
    r = client.post("/api/ext/lookup", json={"identifier": page["identifier"], "page": page}, headers=origin)
    assert time.time() - t0 < 5, "offline lookup should fail fast"
    assert r.status_code == 200
    p = r.json()
    assert p["from_page"] and p["doi"] == "10.1016/j.jobe.2025.111111" and p["year"] == 2025
    assert r.headers["access-control-allow-origin"] == origin["Origin"]
    saved = client.post("/api/ext/save", json={"paper": p}, headers=origin).json()
    assert saved["ok"]


@respx.mock
def test_title_lookup_requires_close_match(client):
    respx.get(re.compile(rf"{OA}/works.*")).mock(return_value=httpx.Response(200, json={
        "results": [work("W9", "A completely different paper about bridges", 2020)], "meta": {"count": 1}}))
    respx.route(host__regex=r"^(?!api\.openalex\.org).*").mock(return_value=httpx.Response(404))
    r = client.post("/api/ext/lookup", json={"title": "Effect of recycled aggregate on concrete strength"})
    assert r.status_code == 404


def test_page_on_other_port_can_load_its_own_scripts(client):
    r = client.get("/static/js/app.js", headers={"Host": "127.0.0.1:23999", "Origin": "http://127.0.0.1:23999"})
    assert r.status_code == 200
    r = client.get("/api/status", headers={"Host": "127.0.0.1:23999", "Origin": "http://127.0.0.1:3000"})
    assert r.status_code == 403


def test_save_table_and_verify_endpoints(client):
    rows = [{"paper_id": "doi:10.1234/x", "based_on": "abstract", "values": {"Method": {"value": "Tests", "quote": ""}},
             "error": None, "paper": {"id": "doi:10.1234/x", "title": "A paper", "year": 2020, "doi": "10.1234/x", "authors": []}}]
    r = client.post("/api/tables", json={"name": "From chatbot", "columns": [{"name": "Method"}], "rows": rows})
    assert r.status_code == 200
    tid = r.json()["id"]
    tables = client.get("/api/tables").json()
    assert any(t["id"] == tid and t["rows"][0]["values"]["Method"]["value"] == "Tests" for t in tables)
    assert client.get(f"/api/tables/{tid}/csv").status_code == 200
    assert client.post("/api/tables", json={"name": "x", "columns": []}).status_code == 400
    assert client.post("/api/ai/verify", json={"items": []}).status_code == 400
    assert client.get("/api/ai/builtin").json() == {"available": "unavailable"}

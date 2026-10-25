import base64
import json
import os
import sqlite3
import subprocess
import sys
import time

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from .conftest import ROOT


def paper(pid, title, year=2020):
    from citeweave.models import make_paper

    p = make_paper(source="test", title=title, doi=pid.split(":", 1)[1] if pid.startswith("doi:") else None, year=year)
    p["id"] = pid
    return p


def use_db(path):
    from citeweave import db

    return db.reset_db_for_tests(path)


def test_round_trip_between_two_devices(tmp_path):
    from citeweave import library, sync

    # device A: a collection with two papers, a note, tags, a map, a table and a question
    use_db(tmp_path / "a.db")
    c = library.create_collection("RCA review")
    library.add_papers(c["id"], [paper("doi:10.1000/a", "Paper A"), paper("doi:10.1000/b", "Paper B")])
    library.set_status(c["id"], "doi:10.1000/a", "read")
    library.set_note("doi:10.1000/a", "Good method section")
    library.set_tags("doi:10.1000/a", ["method", "rca"])
    library.save_map("My map", [paper("doi:10.1000/a", "Paper A")], {"max_nodes": 30}, ["W1"])
    library.save_table("Methods", [{"name": "Method"}], [{"paper_id": "doi:10.1000/b", "values": {}}])
    library.add_history("Does RCA reduce strength?", "Yes [1]", [{"id": "doi:10.1000/a"}], "ai")
    doc_a = sync.export_document()
    assert doc_a["format"] == "citeweave-sync" and doc_a["version"] == 1
    kinds = sorted({r["kind"] for r in doc_a["records"].values()})
    assert kinds == ["collection", "history", "map", "member", "note", "table", "tags"]
    assert set(doc_a["papers"]) == {"doi:10.1000/a", "doi:10.1000/b"}
    cuid = c["uid"]
    assert f"member:{cuid}|doi:10.1000/a" in doc_a["records"]

    # device B starts empty and imports everything
    use_db(tmp_path / "b.db")
    r = sync.import_document(json.loads(json.dumps(doc_a)))
    assert r["applied"] == len(doc_a["records"]) and r["skipped"] == 0
    cb = library.find_collection(cuid)
    papers = {p["id"]: p for p in library.collection_papers(cb["id"])}
    assert papers["doi:10.1000/a"]["status"] == "read"
    assert papers["doi:10.1000/a"]["note"] == "Good method section"
    assert papers["doi:10.1000/a"]["tags"] == ["method", "rca"]
    assert library.list_maps()[0]["name"] == "My map"
    assert library.list_tables()[0]["name"] == "Methods"
    assert library.list_history()[0]["question"] == "Does RCA reduce strength?"
    # importing the same file again changes nothing
    assert sync.import_document(doc_a)["applied"] == 0

    # on B: remove a paper and rename the collection
    time.sleep(0.01)
    library.remove_paper(cb["id"], "doi:10.1000/b")
    library.rename_collection(cb["id"], "RCA review (final)")
    doc_b = sync.export_document()
    assert doc_b["records"][f"member:{cuid}|doi:10.1000/b"]["deleted"] is True

    # back on A: the deletion and the newer name arrive
    use_db(tmp_path / "a.db")
    time.sleep(0.01)
    r = sync.import_document(doc_b)
    assert r["applied"] >= 2
    ca = library.find_collection(cuid)
    assert ca["name"] == "RCA review (final)"
    assert [p["id"] for p in library.collection_papers(ca["id"])] == ["doi:10.1000/a"]

    # an older edit does not overwrite a newer one
    library.rename_collection(ca["id"], "Newest name")
    assert sync.import_document(doc_b)["applied"] == 0
    assert library.find_collection(cuid)["name"] == "Newest name"

    # deleting a whole collection travels too
    library.delete_collection(ca["id"])
    doc_a2 = sync.export_document()
    use_db(tmp_path / "b.db")
    sync.import_document(doc_a2)
    assert library.find_collection(cuid) is None


def test_old_database_is_upgraded(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            description TEXT DEFAULT '', created_at REAL NOT NULL);
        CREATE TABLE maps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, seeds TEXT NOT NULL,
            options TEXT NOT NULL DEFAULT '{}', known TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL, last_checked REAL);
        INSERT INTO collections(name, created_at) VALUES ('Old list', 1700000000);
    """)
    con.commit()
    con.close()
    use_db(path)
    from citeweave import library

    c = library.list_collections()[0]
    assert c["name"] == "Old list" and len(c["uid"]) == 32 and c["updated_at"] == 1700000000


def test_rejects_encrypted_and_foreign_files(tmp_path):
    from citeweave import sync

    use_db(tmp_path / "x.db")
    with pytest.raises(sync.SyncError, match="encrypted"):
        sync.import_document({"format": "citeweave-sync-encrypted", "version": 1})
    with pytest.raises(sync.SyncError, match="not a Citeweave"):
        sync.import_document({"hello": 1})


@pytest.fixture
def client():
    from citeweave import net
    from citeweave.server import app

    net._client = None
    with TestClient(app) as c:
        yield c


def test_history_endpoints(client):
    assert client.get("/api/status").json()["platform"] == "desktop"
    r = client.post("/api/history", json={"question": "What is RAC?", "answer": "Concrete [1]",
                                          "papers": [{"id": "doi:10.1/x"}], "mode": "chatbot"})
    assert r.status_code == 200
    item = r.json()
    assert item["papers"] == [{"id": "doi:10.1/x"}] and item["mode"] == "chatbot"
    assert client.get("/api/history").json()[0]["question"] == "What is RAC?"
    assert client.post("/api/history", json={"question": " "}).status_code == 400
    assert client.delete(f"/api/history/{item['id']}").json() == {"ok": True}
    assert client.get("/api/history").json() == []
    exported = client.get("/api/sync/export").json()
    assert any(r["kind"] == "history" and r["deleted"] for r in exported["records"].values())


def test_folder_sync_endpoints(client, tmp_path):
    folder = tmp_path / "Google Drive" / "Citeweave"
    assert client.get("/api/sync/folder").status_code == 400  # no folder chosen yet
    client.put("/api/settings", json={"sync": {"folder": str(folder)}})
    r = client.get("/api/sync/folder")
    assert r.status_code == 400 and "not found" in r.json()["detail"]
    folder.mkdir(parents=True)
    assert client.get("/api/sync/folder").json() == {"path": str(folder / "citeweave-sync.json"), "exists": False}
    doc = client.get("/api/sync/export").json()
    w = client.put("/api/sync/folder", json=doc)
    assert w.status_code == 200 and w.json()["bytes"] > 10
    back = client.get("/api/sync/folder").json()
    assert back["exists"] and back["document"]["format"] == "citeweave-sync"
    enc = {"format": "citeweave-sync-encrypted", "version": 1, "salt": "c2FsdA==", "iv": "aXY=", "data": "ZGF0YQ=="}
    assert client.put("/api/sync/folder", json=enc).status_code == 200
    assert client.get("/api/sync/folder").json()["document"] == enc
    assert client.put("/api/sync/folder", json={"x": 1}).status_code == 400
    assert client.post("/api/sync/import", json=enc).status_code == 400
    # the picker needs the app window, which tests do not have
    assert client.post("/api/sync/folder/pick").status_code == 400


@respx.mock
def test_github_sync(client):
    client.put("/api/settings", json={"sync": {"github": {"token": "ghp_secret123", "repo": "farhad/citeweave-data"}}})
    assert client.get("/api/settings").json()["sync"]["github"]["token"].startswith("••••")
    url = "https://api.github.com/repos/farhad/citeweave-data/contents/citeweave-sync.json"
    store: dict = {}

    def contents(request):
        assert request.headers["authorization"] == "Bearer ghp_secret123"
        if request.method == "GET":
            if not store:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(200, json={"sha": store["sha"], "size": 10, "content": store["content"]})
        body = json.loads(request.content)
        assert body.get("sha") == store.get("sha")
        store.update(content=body["content"], sha=f"sha{len(store) + 1}")
        return httpx.Response(201 if "sha" not in body else 200, json={"content": {"sha": store["sha"]}})

    respx.route(url__startswith=url).mock(side_effect=contents)
    respx.get("https://api.github.com/repos/farhad/citeweave-data").mock(return_value=httpx.Response(200, json={}))
    assert client.post("/api/sync/github", json={"action": "read"}).json() == {"document": None, "sha": None}
    doc = client.get("/api/sync/export").json()
    w = client.post("/api/sync/github", json={"action": "write", "document": doc})
    assert w.status_code == 200 and w.json()["sha"]
    r = client.post("/api/sync/github", json={"action": "read"}).json()
    assert r["document"]["format"] == "citeweave-sync" and r["sha"] == w.json()["sha"]
    decoded = json.loads(base64.b64decode(store["content"]))
    assert "ghp_secret123" not in json.dumps(decoded)
    # second write passes the current sha so GitHub accepts it
    assert client.post("/api/sync/github", json={"action": "write", "document": doc}).status_code == 200


@respx.mock
def test_github_errors(client):
    client.put("/api/settings", json={"sync": {"github": {"token": "bad", "repo": "farhad/missing"}}})
    respx.route(host="api.github.com").mock(return_value=httpx.Response(401, json={}))
    r = client.post("/api/sync/github", json={"action": "read"})
    assert r.status_code == 400 and "token" in r.json()["detail"]
    client.put("/api/settings", json={"sync": {"github": {"repo": "not a repo"}}})
    assert "owner/name" in client.post("/api/sync/github", json={"action": "read"}).json()["detail"]


def test_mcp_server_over_stdio(tmp_path):
    env = {**os.environ, "CITEWEAVE_HOME": str(tmp_path), "PYTHONPATH": str(ROOT)}
    proc = subprocess.Popen([sys.executable, "-m", "citeweave.mcp_server"], cwd=str(ROOT), env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8")

    def call(msg):
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        if "id" not in msg:
            return None
        return json.loads(proc.stdout.readline())

    try:
        init = call({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"}}})
        assert init["result"]["serverInfo"]["name"] == "citeweave"
        assert init["result"]["capabilities"]["tools"] is not None
        call({"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
        names = {t["name"] for t in tools}
        assert {"search_papers", "get_paper", "list_collections", "add_to_collection", "build_citation_map",
                "save_table", "save_answer", "export_bibtex"} <= names
        assert all(t["inputSchema"]["type"] == "object" for t in tools)
        cols = call({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                     "params": {"name": "list_collections", "arguments": {}}})["result"]
        assert not cols["isError"]
        assert json.loads(cols["content"][0]["text"])["collections"][0]["name"] == "My reading list"
        saved = call({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "save_answer", "arguments": {"question": "Test question?", "answer": "Answer."}}})["result"]
        assert not saved["isError"] and json.loads(saved["content"][0]["text"])["saved"] is True
        bad = call({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                    "params": {"name": "get_collection", "arguments": {"collection": "Nope"}}})["result"]
        assert bad["isError"] and "No collection" in bad["content"][0]["text"]
        unknown = call({"jsonrpc": "2.0", "id": 6, "method": "nothing"})
        assert unknown["error"]["code"] == -32601
        assert call({"jsonrpc": "2.0", "id": 7, "method": "ping"})["result"] == {}
    finally:
        proc.stdin.close()
        proc.wait(timeout=10)
    # the answer is in the same database the app window uses
    con = sqlite3.connect(tmp_path / "citeweave.db")
    assert con.execute("SELECT question, mode FROM history").fetchall() == [("Test question?", "claude")]
    con.close()


def test_mcp_save_table_matches_tables_page(tmp_path):
    import asyncio

    from citeweave import library, mcp_server
    from citeweave.db import db

    use_db(tmp_path / "t.db")
    db().upsert_paper(paper("doi:10.1000/a", "Paper A"))
    out = asyncio.run(mcp_server.save_table("Methods", [{"name": "Method", "description": "Test method"}], [
        {"paper_id": "doi:10.1000/a", "cells": {"Method": "Compression test"}, "quotes": {"Method": "We tested..."}}]))
    assert out["rows_saved"] == 1
    t = library.list_tables()[0]
    assert t["columns"] == [{"name": "Method", "instruction": "Test method"}]
    row = t["rows"][0]
    assert row["paper_id"] == "doi:10.1000/a" and row["values"]["Method"] == {"value": "Compression test",
                                                                               "quote": "We tested..."}
    assert row["paper"]["title"] == "Paper A"

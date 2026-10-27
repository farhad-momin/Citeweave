"""Free workflows, evidence integrity and safe research exports."""
import asyncio
import csv
import io

import pytest
import respx

from citeweave.ai import tasks
from citeweave.ai.evidence import check_values, evidence_row
from citeweave.ai.providers import AIError
from citeweave.config import settings
from citeweave.formats import rows_to_csv, to_csv

TEXT = "We tested 120 specimens using compression tests. Strength increased by 12%. Limitations: Small sample."
PAPER = {"id": "doi:10.1000/free", "title": "Concrete study", "abstract": TEXT}
COLUMNS = [{"name": n} for n in ("Method", "Key findings", "Limitations", "Location", "Unknown dimension")]


def test_free_excerpts_are_exact_and_absence_is_not_invented():
    row = evidence_row(PAPER, COLUMNS, TEXT, "abstract")
    assert row["mode"] == "extractive"
    assert row["values"]["Key findings"]["value"] == "Strength increased by 12%."
    assert row["values"]["Limitations"]["quote"] == "Limitations: Small sample."
    for name in ("Location", "Unknown dimension"):
        assert row["values"][name]["value"] == "Not found in available text"
        assert not row["values"][name]["quote"]
    assert all(c["needs_review"] for c in row["values"].values())
    assert all(c["quote"] in TEXT for c in row["values"].values() if c["quote"])


def test_explicit_free_mode_does_not_call_ai_or_fetch_pdfs(monkeypatch):
    settings().update({"ai": {"provider": "ollama"}})

    async def forbidden(*args, **kwargs):
        pytest.fail("Free mode must not call an AI provider or fetch full text")

    monkeypatch.setattr(tasks, "chat", forbidden)
    monkeypatch.setattr(tasks, "get_text", forbidden)
    rows = asyncio.run(tasks.extract([PAPER], COLUMNS, use_ai=False))
    assert rows[0]["mode"] == "extractive"


def test_unconfigured_free_mode_and_missing_text():
    rows = asyncio.run(tasks.extract([PAPER, {"id": "empty"}], COLUMNS))
    assert rows[0]["mode"] == "extractive"
    assert rows[1]["based_on"] is None
    assert rows[1]["error"]
    assert all(not c["quote"] for c in rows[1]["values"].values())


def test_provider_failure_returns_labelled_free_evidence(monkeypatch):
    settings().update({"ai": {"provider": "ollama"}, "fulltext": {"allow_pdf_download": False}})

    async def fail(*args, **kwargs):
        raise AIError("Service unavailable")

    monkeypatch.setattr(tasks, "chat", fail)
    row = asyncio.run(tasks.extract([PAPER], COLUMNS))[0]
    assert row["mode"] == "extractive"
    assert "Service unavailable" in row["error"]
    assert row["values"]["Method"]["quote"] in TEXT


@pytest.mark.parametrize("quote,matched", [
    ("Strength increased by 12%.", True),
    ("Strength\n increased by 12%.", True),
    ("Strength increased by 21%.", False),
    ("Strength did not increase by 12%.", False),
    ("12% increased by Strength.", False),
    ("", False),
])
def test_quote_validation_rejects_changed_findings(quote, matched):
    cell = check_values({"Finding": {"value": "A finding", "quote": quote}}, TEXT)["Finding"]
    assert cell["unverified"] is not matched


def test_ai_extraction_checks_the_actual_fulltext(monkeypatch):
    settings().update({"ai": {"provider": "ollama"}})

    async def fulltext(*args):
        return "The treatment reduced risk by 8%.", "full text"

    async def reply(*args, **kwargs):
        return '{"Good": {"value": "8%", "quote": "reduced risk by 8%"}, "Bad": {"value": "80%", "quote": "reduced risk by 80%"}}'

    monkeypatch.setattr(tasks, "get_text", fulltext)
    monkeypatch.setattr(tasks, "chat", reply)
    row = asyncio.run(tasks.extract_one(PAPER, [{"name": "Good"}, {"name": "Bad"}]))
    assert row["based_on"] == "full text"
    assert not row["values"]["Good"]["unverified"]
    assert row["values"]["Bad"]["unverified"]
    assert "1 value(s)" in row["error"]


def test_exports_preserve_quotes_status_and_embedded_paper():
    row = evidence_row(PAPER, COLUMNS, TEXT, "abstract")
    row["paper"] = PAPER
    rows = tasks.table_to_csv_rows(COLUMNS, [row], {})
    assert rows[1][0] == PAPER["title"]
    quote_col = rows[0].index("Method (quote)")
    assert rows[1][quote_col] in TEXT
    assert rows[1][quote_col + 1] == "source excerpt"


def test_csv_exports_escape_formula_cells_and_keep_commas():
    fields = ["=1+1", " +SUM(A1)", "-1+2", "@SUM(A1)", "\tcmd", "ordinary, text", "বাংলা"]
    row = next(csv.reader(io.StringIO(rows_to_csv([fields]))))
    assert row == ["'" + f for f in fields[:5]] + fields[5:]
    exported = list(csv.reader(io.StringIO(to_csv([{**PAPER, "title": "=1+1"}]))))
    assert exported[1][0] == "'=1+1"


@respx.mock
def test_oa_filter_is_strict_and_continues_to_next_source(monkeypatch):
    from citeweave import aggregator
    from citeweave.sources import crossref, openalex

    settings().update({"search": {"order": ["openalex", "crossref"]}})

    async def closed(*args, **kwargs):
        return [{**PAPER, "oa_url": None}]

    async def opened(*args, **kwargs):
        return [{**PAPER, "oa_url": "https://example.org/paper.pdf"}]

    monkeypatch.setattr(openalex, "search", closed)
    monkeypatch.setattr(crossref, "search", opened)
    single = asyncio.run(aggregator.search("concrete", source="openalex", filters={"oa_only": True}))
    assert single["results"] == []
    fallback = asyncio.run(aggregator.search("concrete", filters={"oa_only": True}))
    assert fallback["used"] == ["openalex", "crossref"]
    assert fallback["results"][0]["oa_url"]


def test_free_table_endpoint_saves_and_exports():
    import time

    from fastapi.testclient import TestClient

    from citeweave.server import app

    with TestClient(app) as client:
        job_id = client.post("/api/extract", json={"papers": [PAPER], "columns": COLUMNS, "use_ai": False}).json()["job"]
        for _ in range(100):
            job = client.get(f"/api/jobs/{job_id}").json()
            if job["status"] != "running":
                break
            time.sleep(0.01)
        assert job["status"] == "done"
        saved = client.get("/api/tables").json()[0]
        assert saved["rows"][0]["mode"] == "extractive"
        result = client.get(f"/api/tables/{saved['id']}/csv")
        assert result.status_code == 200
        assert "Method (quote)" in result.text and "source excerpt" in result.text


def test_quote_check_ignores_curly_quotes_and_dash_style_only():
    abstract = "We didn’t find an effect – only a trend (p = 0.07)."

    def status(quote):
        return check_values({"a": {"value": "x", "quote": quote}}, abstract)["a"]["evidence_status"]

    assert status("We didn't find an effect - only a trend (p = 0.07).") == "quote matched"
    assert status("We didn’t find an effect – only a trend (p = 0.07).") == "quote matched"
    # words, numbers and negation still have to match exactly
    assert status("We did find an effect - only a trend (p = 0.07).") == "unverified"
    assert status("We didn't find an effect - only a trend (p = 0.7).") == "unverified"
    assert status("We didn't find an effect only a trend (p = 0.07).") == "unverified"

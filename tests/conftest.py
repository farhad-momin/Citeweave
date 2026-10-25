import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    monkeypatch.setenv("CITEWEAVE_HOME", str(tmp_path))
    from citeweave import config, db, net

    net.reset_down_hosts()
    from citeweave import sync as _sync
    _sync._github_sha.clear()
    config.reset_settings_for_tests(tmp_path / "settings.json")
    db.reset_db_for_tests(tmp_path / "test.db")
    yield tmp_path


def work(wid, title, year, cites=10, refs=None, doi=None, abstract="A study of concrete strength."):
    """A minimal OpenAlex work record."""
    words = abstract.split()
    inv = {}
    for i, w in enumerate(words):
        inv.setdefault(w, []).append(i)
    return {
        "id": f"https://openalex.org/{wid}",
        "doi": f"https://doi.org/{doi}" if doi else None,
        "display_name": title,
        "publication_year": year,
        "authorships": [{"author": {"display_name": "Rahim Uddin", "id": "https://openalex.org/A1",
                                    "orcid": "https://orcid.org/0000-0002-1825-0097"}}],
        "primary_location": {"source": {"display_name": "Journal of Testing"}, "landing_page_url": "https://x.org"},
        "best_oa_location": {"pdf_url": None},
        "open_access": {"oa_url": None},
        "cited_by_count": cites,
        "referenced_works_count": len(refs or []),
        "abstract_inverted_index": inv,
        "ids": {"openalex": f"https://openalex.org/{wid}"},
        "type": "article",
        "referenced_works": [f"https://openalex.org/{r}" for r in (refs or [])],
        "topics": [{"display_name": "Concrete"}],
    }

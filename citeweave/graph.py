"""Citation maps.

Starting from one or more seed papers, gather their references and the papers that
cite them, then rank every candidate by how strongly it is tied to the seeds:

  direct links          the candidate cites a seed or is cited by a seed
  bibliographic coupling the candidate and the seeds cite the same works
  co-citation           later papers cite the candidate together with the seeds

Coupling and co-citation use cosine (Salton) normalization so that papers with very
long reference lists or huge citation counts do not dominate. The three signals are
scaled to 0..1 and combined. The top candidates and the citation links between them
form the map.
"""
from __future__ import annotations

import asyncio
import math
from typing import Callable

from . import aggregator

WEIGHTS = {"direct": 0.4, "coupling": 0.3, "cocitation": 0.3}


def node_key(p: dict) -> str:
    return (p.get("ids") or {}).get("openalex") or p["id"]


def trim(p: dict) -> dict:
    keep = ("id", "doi", "title", "year", "venue", "authors", "cited_by_count", "reference_count",
            "oa_url", "url", "ids", "abstract", "tldr", "topics", "type")
    out = {k: p.get(k) for k in keep}
    out["authors"] = (p.get("authors") or [])[:6]
    return out


def score_candidates(seed_data: list[dict]) -> dict[str, dict]:
    """seed_data: [{"seed": paper, "refs": [paper], "cites": [paper]}]. Pure function, easy to test."""
    seed_keys = {node_key(s["seed"]) for s in seed_data}
    seed_ref_keys: set[str] = set()
    citer_refs: list[set[str]] = []
    for s in seed_data:
        seed_ref_keys |= {node_key(r) for r in s["refs"]}
        seed_ref_keys |= set(s["seed"].get("references") or [])
        for c in s["cites"]:
            citer_refs.append(set(c.get("references") or []))
    n_citers = max(len(citer_refs), 1)

    cand: dict[str, dict] = {}
    for s in seed_data:
        for rel, items in (("ref", s["refs"]), ("cite", s["cites"])):
            for p in items:
                k = node_key(p)
                if k in seed_keys:
                    continue
                c = cand.setdefault(k, {"paper": p, "direct": set(), "links": set()})
                c["direct"].add(node_key(s["seed"]))
                c["links"].add((rel, node_key(s["seed"])))
                if len(p.get("abstract") or "") > len(c["paper"].get("abstract") or ""):
                    c["paper"] = p

    for k, c in cand.items():
        refs_c = set(c["paper"].get("references") or [])
        shared = len(refs_c & seed_ref_keys)
        c["coupling_raw"] = shared
        c["coupling"] = shared / math.sqrt(max(len(refs_c), 1) * max(len(seed_ref_keys), 1)) if shared else 0.0
        co = sum(1 for refs in citer_refs if k in refs)
        c["cocitation_raw"] = co
        cited = max(c["paper"].get("cited_by_count") or 0, co, 1)
        c["cocitation"] = co / math.sqrt(cited * n_citers) if co else 0.0
        c["direct_n"] = len(c["direct"]) / max(len(seed_keys), 1)

    def scale(field: str) -> None:
        top = max((c[field] for c in cand.values()), default=0) or 1
        for c in cand.values():
            c[field + "_s"] = c[field] / top

    scale("coupling")
    scale("cocitation")
    for c in cand.values():
        c["score"] = round(
            WEIGHTS["direct"] * c["direct_n"] + WEIGHTS["coupling"] * c["coupling_s"]
            + WEIGHTS["cocitation"] * c["cocitation_s"], 4)
    return cand


def build_edges(nodes: dict[str, dict], cand: dict[str, dict]) -> list[dict]:
    edges: set[tuple[str, str]] = set()
    keys = set(nodes)
    for k, n in nodes.items():
        for r in n["paper"].get("references") or []:
            if r in keys and r != k:
                edges.add((k, r))
    for k, c in cand.items():
        if k not in keys:
            continue
        for rel, seed in c["links"]:
            if seed in keys:
                edges.add((seed, k) if rel == "ref" else (k, seed))
    return [{"source": a, "target": b} for a, b in sorted(edges)]


async def build_map(seeds: list[dict], max_nodes: int = 40, per_seed: int = 150,
                    progress: Callable[[str, float], None] | None = None) -> dict:
    progress = progress or (lambda msg, frac: None)
    seed_data = []
    errors: dict[str, str] = {}
    for i, seed in enumerate(seeds):
        progress(f"Collecting links for seed {i + 1} of {len(seeds)}", 0.1 + 0.7 * i / max(len(seeds), 1))
        refs, cites = await asyncio.gather(
            aggregator.references(seed, per_seed), aggregator.citations(seed, per_seed))
        errors.update({f"{k} (references)": v for k, v in refs["errors"].items()})
        errors.update({f"{k} (citations)": v for k, v in cites["errors"].items()})
        seed_data.append({"seed": seed, "refs": refs["results"], "cites": cites["results"]})

    progress("Ranking related papers", 0.85)
    cand = score_candidates(seed_data)
    ranked = sorted(cand.items(), key=lambda kv: kv[1]["score"], reverse=True)

    nodes: dict[str, dict] = {}
    for s in seed_data:
        nodes[node_key(s["seed"])] = {"paper": s["seed"], "seed": True, "score": 1.0}
    for k, c in ranked[:max_nodes]:
        nodes[k] = {"paper": c["paper"], "seed": False, "score": c["score"],
                    "direct": len(c["direct"]), "coupling": c["coupling_raw"], "cocitation": c["cocitation_raw"]}
    edges = build_edges(nodes, cand)

    pr = pagerank(list(nodes), edges)
    out_nodes = [{"key": k, "seed": n["seed"], "score": n["score"], "direct": n.get("direct", 0),
                  "coupling": n.get("coupling", 0), "cocitation": n.get("cocitation", 0),
                  "importance": pr.get(k, 0), "paper": trim(n["paper"])} for k, n in nodes.items()]
    more = [{"key": k, "score": c["score"], "paper": trim(c["paper"])} for k, c in ranked[max_nodes:max_nodes + 60]]

    progress("Finding foundational and newer work", 0.92)
    foundational, newer = [], []
    try:
        foundational = await prior_works(nodes)
    except Exception as e:  # noqa: BLE001
        errors["foundational"] = str(e)
    newer = derivative_works(nodes, seed_data, cand)
    progress("Done", 1.0)
    return {
        "nodes": out_nodes,
        "edges": edges,
        "more": more,
        "foundational": foundational,
        "newer": newer,
        "stats": {"candidates": len(cand), "seeds": len(seeds)},
        "errors": errors,
    }


def pagerank(keys: list[str], edges: list[dict], damping: float = 0.85, iters: int = 40) -> dict[str, float]:
    """Importance inside the map: a paper cited by important papers is important."""
    n = len(keys)
    if not n:
        return {}
    out_links: dict[str, list[str]] = {k: [] for k in keys}
    for e in edges:
        if e["source"] in out_links and e["target"] in out_links:
            out_links[e["source"]].append(e["target"])
    rank = {k: 1 / n for k in keys}
    for _ in range(iters):
        new = {k: (1 - damping) / n for k in keys}
        sink = sum(rank[k] for k in keys if not out_links[k])
        for k in keys:
            new[k] += damping * sink / n
            if out_links[k]:
                share = damping * rank[k] / len(out_links[k])
                for t in out_links[k]:
                    new[t] += share
        rank = new
    top = max(rank.values()) or 1
    return {k: round(v / top, 4) for k, v in rank.items()}


async def prior_works(nodes: dict[str, dict], limit: int = 15) -> list[dict]:
    """Older papers that many papers in the map cite: the shared foundations of the topic."""
    from collections import Counter

    from . import sources as S

    counts: Counter = Counter()
    for n in nodes.values():
        for r in set(n["paper"].get("references") or []):
            if r not in nodes:
                counts[r] += 1
    top = [(k, c) for k, c in counts.most_common(limit) if c >= 2]
    if not top or not S.openalex.ready()[0]:
        return []
    papers = {node_key(p): p for p in await S.openalex.batch([k for k, _ in top])}
    return [{"key": k, "count": c, "paper": trim(papers[k])} for k, c in top if k in papers]


def derivative_works(nodes: dict[str, dict], seed_data: list[dict], cand: dict[str, dict], limit: int = 15) -> list[dict]:
    """Papers that cite many papers in the map: likely reviews or follow-up work."""
    pool: dict[str, dict] = {}
    for s in seed_data:
        for p in s["cites"]:
            pool[node_key(p)] = p
    rows = []
    for k, p in pool.items():
        if k in nodes:
            continue
        c = len(set(p.get("references") or []) & set(nodes))
        if c >= 2:
            rows.append({"key": k, "count": c, "paper": trim(p)})
    rows.sort(key=lambda r: (r["count"], r["paper"].get("year") or 0), reverse=True)
    return rows[:limit]

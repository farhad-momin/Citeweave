"""Background jobs for slow work (maps, AI answers, tables) with progress the UI can poll."""
from __future__ import annotations

import asyncio
import time
import traceback
import uuid
from typing import Any, Awaitable, Callable

_jobs: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}


def start(kind: str, fn: Callable[[Callable[[str, float], None]], Awaitable[Any]]) -> str:
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "kind": kind, "status": "running", "message": "Starting", "progress": 0.0,
           "result": None, "error": None, "started": time.time()}
    _jobs[job_id] = job

    def progress(message: str, frac: float) -> None:
        job["message"] = message
        job["progress"] = max(0.0, min(1.0, float(frac)))

    async def runner():
        try:
            job["result"] = await fn(progress)
            job["status"] = "done"
            job["progress"] = 1.0
        except asyncio.CancelledError:
            job["status"] = "cancelled"
        except Exception as e:  # noqa: BLE001 - reported to the UI
            job["status"] = "error"
            detail = getattr(e, "detail", None)  # HTTPException: show its message, not "404: ..."
            job["error"] = (detail if isinstance(detail, str) else str(e)) or e.__class__.__name__
            job["trace"] = traceback.format_exc(limit=4)

    _tasks[job_id] = asyncio.create_task(runner())
    _prune()
    return job_id


def get(job_id: str) -> dict | None:
    job = _jobs.get(job_id)
    if not job:
        return None
    return {k: v for k, v in job.items() if k != "trace"}


def cancel(job_id: str) -> bool:
    t = _tasks.get(job_id)
    if t and not t.done():
        t.cancel()
        return True
    return False


def _prune(max_age: float = 3600) -> None:
    now = time.time()
    for jid in [j for j, job in _jobs.items() if now - job["started"] > max_age and job["status"] != "running"]:
        _jobs.pop(jid, None)
        _tasks.pop(jid, None)

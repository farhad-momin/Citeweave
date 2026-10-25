# Contributing to Citeweave

Thank you for helping. Citeweave is built by researchers for researchers. Bug reports, new data sources, translations and design improvements are all welcome.

## Ground rules

- Stay light. Citeweave should run well on an ordinary laptop. Avoid heavy dependencies and background work that runs all the time.
- Stay free. Every feature must work without paid services. Paid or keyed services can only be optional extras.
- Be a good citizen. Keep requests to the open data services cached and rate limited (see `citeweave/net.py`).
- Never invent data. AI output has to be grounded in real paper text, and AI-suggested papers have to be verified.

## Setup

```
python -m venv .venv
.venv\Scripts\activate          (on macOS or Linux: source .venv/bin/activate)
pip install -r requirements-dev.txt
python -m pytest
python -m citeweave --browser
```

The interface is plain HTML, CSS and JavaScript modules in `citeweave/static`, with no build step. Edit a file and reload the window.

## Add a data source

1. Create `citeweave/sources/mysource.py` with a subclass of `Source` (see `sources/base.py`).
2. Set `name`, `label`, `homepage`, `capabilities` and, if it needs one, `key_required` and `key_help`.
3. Implement what it supports: `search()`, `paper()`, `references()`, `citations()`.
4. Convert records with `models.make_paper()` so every source produces the same shape.
5. Register it in `sources/__init__.py` and add default settings in `config.py`.
6. Add a polite request interval for its host in `net.py`.
7. Add tests with recorded responses (see `tests/test_server.py`, which uses `respx`).

## Add an AI provider

If the provider speaks the common chat completions format, add a `Preset` in `citeweave/ai/providers.py` with its base URL and a default model. That is all it takes. Providers with their own format need a branch in `chat()` and `list_models()`.

## Pull requests

- Keep pull requests focused, and include tests for new behaviour.
- Run `ruff check citeweave tests` and `python -m pytest` before you open one.
- Write interface text in plain, friendly language. Use sentence case.

# Citeweave web version

The web version is the same app as the PC version, running entirely in the browser. It is a static site, so it can be hosted for free. There is no server of our own: each researcher's browser talks to the open databases directly, so everyone gets their own free daily allowance, and their library stays in their own browser unless they turn on sync.

## Publish it on GitHub Pages (free)

1. Push the repository to GitHub.
2. In the repository open **Settings, Pages** and set **Source** to **GitHub Actions**.
3. Move `github-workflows/pages.yml` into `.github/workflows/` if it is not there yet, then push.

The site appears at `https://<your-name>.github.io/<repository>/` a minute later, and updates on every push to `main`.

To try it on your own computer first:

```
python scripts/build_web.py
cd dist/web
python -m http.server 8800
```

Then open http://127.0.0.1:8800.

## What works in the web version

Everything in the PC app, except:

- **Full text:** tables and summaries read abstracts. Most publisher PDFs cannot be downloaded by a web page. The PC app can read open access PDFs.
- **Zotero:** export RIS or BibTeX and import it in Zotero. Direct sending needs the PC app.

Only the web version has:

- **Built-in browser AI:** the free model built into recent desktop versions of Chrome, on capable computers. Choose it in Settings, AI.

## Sync options

| Option | Needs setup by you (the site owner) | Notes |
|---|---|---|
| GitHub (private repo) | No | Each researcher uses their own private repo and a token that can only reach it |
| A folder on this computer | No | Works in Chrome and Edge. Pick a folder that Google Drive, OneDrive or Dropbox already syncs |
| Google Drive sign-in | Yes, a free Google app id | Hidden until `googleClientId` is set in `web/config.js` |
| OneDrive sign-in | Yes, a free Microsoft app id | Hidden until `microsoftClientId` is set in `web/config.js` |

Researchers can also download a backup file and restore it at any time.

### Google Drive app id (optional)

1. Open console.cloud.google.com and create a project, for example "Citeweave".
2. In **APIs and Services, Library**, enable **Google Drive API**.
3. In **OAuth consent screen**, choose External, fill in the app name and your email, and add the scope `.../auth/drive.file`. This scope only lets Citeweave see files it created.
4. In **Credentials**, create an **OAuth client ID** of type **Web application**. Under **Authorized JavaScript origins**, add `https://<your-name>.github.io`.
5. Copy the client id into `googleClientId` in `web/config.js` and push.

While the app is in Testing mode, only the Google accounts you add as test users can sign in. To open it to everyone, publish the app in the consent screen. Google may ask for a short verification first. Check Google's current rules when you get there.

### OneDrive app id (optional)

1. Open entra.microsoft.com, then **App registrations, New registration**.
2. For **Supported account types**, choose accounts in any organisation and personal Microsoft accounts.
3. For **Redirect URI**, choose **Single-page application** and enter `https://<your-name>.github.io/<repository>/auth.html`.
4. In **API permissions**, add Microsoft Graph, Delegated, `Files.ReadWrite.AppFolder` and `offline_access`.
5. Copy the **Application (client) ID** into `microsoftClientId` in `web/config.js` and push.

## Optional relay

Three services refuse requests from web pages: Semantic Scholar, arXiv and CORE (checked from a real browser in October 2026). The web version skips them and uses the other sources, so search, maps and answers keep working. OpenAlex, Crossref, OpenCitations, Europe PMC, PubMed, Unpaywall, ORCID, GitHub and all the AI providers work directly. If you want the three skipped services in the web version, run the free relay in `web/relay/worker.js`:

1. Create a free Cloudflare account and open **Workers and Pages, Create, Worker**.
2. Replace the example code with `web/relay/worker.js` and deploy.
3. Paste the worker's address into **Settings, Data sources, Relay**.

The relay only forwards read requests to the services listed at the top of the file, and stores nothing.

## How it is built

`scripts/build_web.py` copies the shared interface (`citeweave/static`) and the browser engine (`web/engine`) into `dist/web`. The engine answers every `/api/...` call inside the browser, with the same shapes as the PC app's server. See `web/SPEC.md` for the contracts and the sync file format, and run the tests with:

```
node --test web/tests/*.test.mjs
```

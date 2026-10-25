# GitHub workflows

Move these files into `.github/workflows/` before you push to GitHub:

```
mkdir .github\workflows
move github-workflows\*.yml .github\workflows\
```

- `ci.yml` runs the Python and web tests on Windows and Linux for every push and pull request.
- `release.yml` builds `Citeweave-windows.zip` (with `citeweave-mcp.exe` for Claude) and both extension zips when you push a tag such as `v0.2.0`, and attaches them to a GitHub release.
- `pages.yml` publishes the web version on GitHub Pages on every push to `main`. Turn it on once in the repository's Settings, Pages, Source: GitHub Actions.

Then delete this folder.

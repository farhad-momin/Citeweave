// Settings sections for sync, backup and smart ranking. Shared by the PC app and the web version.
import { api } from "../api.js";
import { availableProviders, forgetPassphrase, lastSync, provider, syncNow } from "../sync.js";
import { forgetSmartSetting, testSmart } from "../smart.js";
import { btn, download, h, modal, showError, toast } from "../ui.js";

const isWeb = () => !!globalThis.CITEWEAVE_WEB;

export async function askPassphrase(confirm = false) {
  const pass = h("input", { class: "input", type: "password", autocomplete: "new-password", style: { width: "100%" } });
  const pass2 = confirm ? h("input", { class: "input", type: "password", autocomplete: "new-password", style: { width: "100%" } }) : null;
  const remember = h("input", { type: "checkbox", checked: true });
  const err = h("p", { class: "err small" });
  return modal("Sync passphrase", h("div", {},
    h("p", { class: "muted small" }, "Your synced data is locked with this passphrase. Use the same one on every device. It is never uploaded, and nobody can recover it for you."),
    h("label", { class: "field" }, h("span", {}, "Passphrase"), pass),
    pass2 ? h("label", { class: "field" }, h("span", {}, "Type it again"), pass2) : null,
    h("label", { class: "check" }, remember, "Remember on this device"), err),
  [{ label: "Cancel", value: null }, { label: "Unlock", cls: "primary", value: () => {
    if (pass.value.length < 8) { err.textContent = "Use at least 8 characters."; return undefined; }
    if (pass2 && pass2.value !== pass.value) { err.textContent = "The two passphrases do not match."; return undefined; }
    return { value: pass.value, remember: remember.checked };
  } }]);
}

function describeLast(info) {
  if (!info) return "Not synced yet on this device.";
  const t = new Date(info.at).toLocaleString();
  return `Last synced ${t}. ${info.records} items${info.applied ? `, ${info.applied} updated from other devices` : ""}.`;
}

export function syncSection(cfg, save) {
  // save, then keep this section's copy of the settings current
  const put = async (patch, msg) => { const c = await save(patch, msg); if (c) cfg = c; return c; };
  const box = h("div");
  const stateLine = h("div", { class: "sync-state" }, describeLast(lastSync()));

  async function run(interactive = true) {
    stateLine.className = "sync-state";
    stateLine.textContent = "Syncing...";
    try {
      const info = await syncNow({ interactive, askPass: (o) => askPassphrase(o?.confirm ?? !lastSync()) });
      stateLine.className = "sync-state ok";
      stateLine.textContent = describeLast(info);
    } catch (e) {
      stateLine.className = "sync-state bad";
      stateLine.textContent = e.message;
    }
  }

  function draw() {
    const sc = cfg.sync || {};
    const options = availableProviders();
    const sel = h("select", { class: "input" }, h("option", { value: "none" }, "Off (keep everything on this device)"),
      options.map((o) => h("option", { value: o.name, selected: sc.provider === o.name }, o.label)));
    sel.addEventListener("change", () => put({ sync: { provider: sel.value } }, null).then(draw));
    const fields = h("div", { class: "form-grid" }, h("label", { class: "field" }, h("span", {}, "Sync with"), sel));
    box.replaceChildren(fields);

    if (sc.provider === "github") {
      const gh = sc.github || {};
      const token = h("input", { class: "input", type: "password", autocomplete: "off", value: gh.token || "", placeholder: "github_pat_..." });
      const repo = h("input", { class: "input", value: gh.repo || "", placeholder: "your-name/citeweave-data" });
      const path = h("input", { class: "input", value: gh.path || "citeweave-sync.json" });
      token.addEventListener("change", () => put({ sync: { github: { token: token.value.trim() } } }, "Token saved"));
      repo.addEventListener("change", () => put({ sync: { github: { repo: repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") } } }));
      path.addEventListener("change", () => put({ sync: { github: { path: path.value.trim() || "citeweave-sync.json" } } }));
      fields.append(
        h("label", { class: "field" }, h("span", {}, "Private repository"), repo, h("small", {}, "Create an empty private repository on GitHub first, for example citeweave-data.")),
        h("label", { class: "field" }, h("span", {}, "Access token"), token,
          h("small", {}, "On GitHub open Settings, Developer settings, Fine-grained tokens, Generate new token. Choose Only select repositories, pick the repository above, and give Contents read and write. Nothing else.")),
        h("label", { class: "field" }, h("span", {}, "File name"), path));
    }
    if (sc.provider === "folder") {
      const p = provider("folder");
      const where = h("span", { class: "small" }, isWeb() ? (p.folderName() || "No folder chosen yet") : (sc.folder || "No folder chosen yet"));
      const pathInput = isWeb() ? null : h("input", { class: "input", value: sc.folder || "", placeholder: "C:\\Users\\you\\Google Drive\\Citeweave" });
      pathInput?.addEventListener("change", () => put({ sync: { folder: pathInput.value.trim() } }, "Folder saved").then(() => (where.textContent = pathInput.value.trim())));
      fields.append(h("div", { class: "field" }, h("span", {}, "Folder"),
        pathInput,
        h("div", { class: "row" }, btn("Choose folder", async () => {
          try {
            const name = await p.pick();
            if (!isWeb() && name) { await put({ sync: { folder: name } }, null); if (pathInput) pathInput.value = name; }
            where.textContent = name || where.textContent;
          } catch (e) { if (e?.name !== "AbortError") showError(e); }
        }, { cls: "small" }), where),
        h("small", {}, "Tip: pick a folder that Google Drive, OneDrive or Dropbox already syncs on this computer. Citeweave keeps one file, citeweave-sync.json, in it.")));
    }
    if (sc.provider === "gdrive") fields.append(h("div", { class: "field" }, h("span", {}, "Google Drive"), h("small", {}, "Citeweave asks Google for access to the files it creates, nothing else. You will see Google's sign-in when you sync.")));
    if (sc.provider === "onedrive") fields.append(h("div", { class: "field" }, h("span", {}, "OneDrive"), h("small", {}, "The file is kept in Citeweave's own app folder in your OneDrive. You will see Microsoft's sign-in when you sync."),
      btn("Sign out of OneDrive", () => { provider("onedrive").signOut(); toast("Signed out of OneDrive"); }, { cls: "small ghost" })));

    if (sc.provider && sc.provider !== "none") {
      const encrypt = h("input", { type: "checkbox", checked: !!sc.encrypt });
      encrypt.addEventListener("change", () => put({ sync: { encrypt: encrypt.checked } }, encrypt.checked ? "Synced data will be locked with a passphrase" : "Encryption off"));
      const auto = h("input", { type: "checkbox", checked: sc.auto !== false });
      auto.addEventListener("change", () => put({ sync: { auto: auto.checked } }));
      box.append(
        h("div", { style: { marginTop: "8px" } }, h("label", { class: "check" }, auto, "Sync automatically when Citeweave opens and after changes")),
        h("div", { style: { marginTop: "6px" } }, h("label", { class: "check" }, encrypt, "Lock synced data with a passphrase (recommended for GitHub)")),
        h("div", { class: "row", style: { marginTop: "10px" } },
          btn("Sync now", () => run(true), { cls: "primary small" }),
          btn("Forget passphrase on this device", () => { forgetPassphrase(); toast("Passphrase forgotten on this device"); }, { cls: "small ghost" })),
        stateLine);
    }
    const missing = [];
    if (isWeb() && !options.find((o) => o.name === "gdrive")) missing.push("Google Drive");
    if (isWeb() && !options.find((o) => o.name === "onedrive")) missing.push("OneDrive");
    if (missing.length) box.append(h("p", { class: "muted small" }, `${missing.join(" and ")} sign-in is not set up on this site yet. You can still use a Google Drive or OneDrive folder on your computer with "A folder on this computer".`));
  }
  draw();
  return h("section", {}, h("h2", {}, "Sync and backup"),
    h("p", { class: "muted small" }, "Keep your library, notes, maps, tables and question history the same on every device, using your own storage. Citeweave never sees your data. API keys stay on each device."),
    box, backupRow());
}

function backupRow() {
  const file = h("input", { type: "file", accept: ".json,application/json", hidden: true });
  file.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (doc.format !== "citeweave-sync") throw new Error("That file is not a Citeweave backup.");
      const r = await api.post("/api/sync/import", doc);
      toast(`Backup restored. ${r.applied} items added or updated.`);
    } catch (e) { showError(e); }
    file.value = "";
  });
  return h("div", { class: "row", style: { marginTop: "16px" } },
    btn("Download a backup", async () => {
      try {
        const doc = await api.get("/api/sync/export");
        download(`citeweave-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(doc), "application/json");
      } catch (e) { showError(e); }
    }, { cls: "small", ico: "download" }),
    btn("Restore a backup", () => file.click(), { cls: "small ghost", ico: "upload" }), file);
}

export function smartSection(cfg, save) {
  const on = h("input", { type: "checkbox", checked: !!cfg.smart?.enabled });
  const result = h("span", { class: "small" });
  on.addEventListener("change", async () => {
    await save({ smart: { enabled: on.checked } }, on.checked ? "Smart ranking on" : "Smart ranking off");
    forgetSmartSetting();
  });
  return h("section", {}, h("h2", {}, "Smart ranking"),
    h("label", { class: "check" }, on, "Rank search results and answers by meaning, not only by matching words"),
    h("p", { class: "muted small" }, "Uses a small model (about 25 MB) that runs on this computer. It is downloaded once from a public model library, then works offline. No AI provider or key needed."),
    h("div", { class: "row" }, btn("Test it", async () => {
      result.textContent = "Loading the model...";
      try { result.textContent = (await testSmart()) ? "Working." : "Loaded, but the test gave an odd result."; result.style.color = "var(--ok)"; }
      catch (e) { result.textContent = `Could not load the model: ${e.message}`; result.style.color = "var(--danger)"; }
    }, { cls: "small" }), result));
}

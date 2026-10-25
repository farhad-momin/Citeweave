import { api, onWrite } from "./api.js";
import { scheduleSync } from "./sync.js";
import { closeDrawer, openDrawer } from "./paper.js";
import { addSeed, onChange, refreshCollections, refreshStatus, state } from "./state.js";
import { h, showError, toast } from "./ui.js";
import * as ask from "./views/ask.js";
import * as library from "./views/library.js";
import * as map from "./views/map.js";
import * as profile from "./views/profile.js";
import * as search from "./views/search.js";
import * as settings from "./views/settings.js";
import * as tables from "./views/tables.js";

const VIEWS = { search, ask, map, library, tables, profile, settings };
let cleanup = null;

function route() {
  const name = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "search";
  const view = VIEWS[name] || search;
  document.querySelectorAll("[data-view]").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  if (typeof cleanup === "function") cleanup();
  const main = document.getElementById("view");
  main.replaceChildren();
  main.scrollTop = 0;
  try {
    const r = view.render(main);
    cleanup = r instanceof Promise ? null : r;
    if (r instanceof Promise) r.catch(showError);
  } catch (e) {
    main.append(h("div", { class: "page" }, h("p", { class: "err" }, e.message)));
    console.error(e);
  }
}

function drawAiPill() {
  const pill = document.getElementById("ai-pill");
  const ai = state.status?.ai;
  pill.replaceChildren();
  if (ai?.enabled) pill.append("AI: ", h("b", {}, ai.label?.replace(/\s*\(.*\)/, "")), h("br"), ai.model || "");
  else pill.append("AI is off. ", h("a", { href: "#/settings" }, "Set up"));
}

async function pollInbox() {
  try {
    const items = await api.get("/api/inbox");
    for (const it of items) {
      if (it.action === "saved") {
        toast(`Saved from your browser: ${it.paper.title}`, { action: () => openDrawer(it.paper), actionLabel: "View" });
        refreshCollections().catch(() => {});
      } else if (it.action === "map") {
        addSeed(it.paper);
        location.hash = "#/map";
        toast("Added to the citation map from your browser");
      } else {
        openDrawer(it.paper);
      }
    }
  } catch { /* server restarting */ }
  setTimeout(pollInbox, 2500);
}

async function start() {
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.querySelector(".modal-bg")) closeDrawer();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); location.hash = "#/search"; setTimeout(() => document.querySelector(".searchbar input")?.focus(), 50); }
  });
  onChange((what) => { if (what === "status") drawAiPill(); });
  try {
    await refreshStatus();
    const cfg = await api.get("/api/settings");
    state.settings = cfg;
    settings.applyTheme(cfg.theme);
    await refreshCollections();
  } catch (e) {
    showError(e);
  }
  route();
  pollInbox();
  // keep devices in step: sync shortly after opening and a few seconds after each change
  onWrite(() => scheduleSync());
  scheduleSync(1500);
}

start();

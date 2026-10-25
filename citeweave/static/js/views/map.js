// Citation map: seeds in, related papers out, drawn as threads between papers.
import { api, qs, runJob } from "../api.js";
import { openDrawer, saveToCollection, paperList } from "../paper.js";
import { addSeed, emit, onChange, removeSeed, state } from "../state.js";
import { authorsShort, btn, fmt, h, icon, modal, pressable, progressBox, prompt, showError, toast } from "../ui.js";

const SVGNS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function hexToRgb(hex) {
  const m = hex.replace("#", "").match(/.{2}/g);
  return m ? m.map((x) => parseInt(x, 16)) : [128, 128, 128];
}

function yearColor(year, y0, y1) {
  const a = hexToRgb("#9AA9BC"), b = hexToRgb(cssVar("--thread") || "#1E6F6A");
  const t = y1 > y0 && year ? Math.max(0, Math.min(1, (year - y0) / (y1 - y0))) : 0.5;
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

function surname(p) {
  const n = p.authors?.[0]?.name || "";
  return n.split(/\s+/).pop() || "Anon";
}

export function render(root) {
  const view = { mode: state.lastMap?.mode || "timeline", data: state.lastMap?.data || null, selected: null,
    tab: "connected", mapId: state.lastMap?.mapId || null, mapName: state.lastMap?.mapName || "", maxNodes: state.lastMap?.maxNodes || 40 };
  let controller;

  const seedsBox = h("div", { class: "seeds" });
  const seedInput = h("input", { class: "input", placeholder: "Add a seed: DOI, link or title", style: { width: "260px" } });
  const maxSel = h("select", { class: "input", title: "Papers on the map" },
    [20, 40, 60, 100].map((n) => h("option", { value: n, selected: n === view.maxNodes }, `${n} papers`)));
  const modeSeg = h("div", { class: "seg" },
    h("button", { type: "button", "data-mode": "timeline" }, "Timeline"),
    h("button", { type: "button", "data-mode": "network" }, "Network"));
  const canvas = h("div", { class: "canvas" });
  const side = h("div", { class: "side-list" });
  const status = h("div", { class: "small muted" });

  function persist() { state.lastMap = { mode: view.mode, data: view.data, mapId: view.mapId, mapName: view.mapName, maxNodes: view.maxNodes }; }

  function drawSeeds() {
    seedsBox.replaceChildren(...state.seeds.map((p) => h("span", { class: "seed-chip", title: p.title },
      h("span", {}, `${surname(p)} ${p.year || ""}: ${p.title}`),
      h("button", { type: "button", title: "Remove seed", "aria-label": "Remove seed", onclick: () => removeSeed(p.id) }, "×"))));
    if (!state.seeds.length) seedsBox.append(h("span", { class: "small muted" }, "No seed papers yet"));
  }

  async function addFromInput() {
    const v = seedInput.value.trim();
    if (!v) return;
    seedInput.disabled = true;
    try {
      const r = await api.get(`/api/search?${qs({ q: v, limit: 8 })}`);
      if (!r.results.length) { toast("No paper found for that"); return; }
      if (r.results.length === 1 || r.used?.[0] === "lookup") { addSeed(r.results[0]); seedInput.value = ""; return; }
      const pick = h("div", { class: "papers" }, r.results.map((p) => h("div", { ...pressable(() => { addSeed(p); seedInput.value = ""; document.querySelector(".modal-bg")?.click(); }),
        class: "paper", style: { gridTemplateColumns: "1fr" } },
      h("div", {}, h("div", { class: "t" }, p.title), h("div", { class: "by" }, authorsShort(p), p.year ? `, ${p.year}` : "")))));
      await modal("Choose a seed paper", pick, [{ label: "Close", value: null }]);
    } catch (e) { showError(e); } finally { seedInput.disabled = false; seedInput.focus(); }
  }

  async function build() {
    if (!state.seeds.length) { toast("Add at least one seed paper first"); return; }
    controller?.abort();
    controller = new AbortController();
    view.maxNodes = Number(maxSel.value);
    const pb = progressBox();
    canvas.replaceChildren(h("div", { class: "hint" }, h("div", {}, pb.el, btn("Stop", () => controller.abort(), { cls: "small ghost" }))));
    side.replaceChildren();
    try {
      view.data = await runJob(api.post("/api/map", { seeds: state.seeds, max_nodes: view.maxNodes }), pb.update, controller.signal);
      view.selected = null;
      persist();
      draw();
      const errs = Object.keys(view.data.errors || {});
      if (errs.length && view.data.nodes.length <= state.seeds.length) toast(`Some sources failed: ${Object.values(view.data.errors)[0]}`, { error: true });
    } catch (e) {
      canvas.replaceChildren(h("div", { class: "hint" }, h("p", { class: "err" }, e.message)));
    }
  }

  // drawing -----------------------------------------------------------------------------
  let zoom = { k: 1, x: 0, y: 0 };
  let gRoot = null;

  function applyZoom() { gRoot?.setAttribute("transform", `translate(${zoom.x},${zoom.y}) scale(${zoom.k})`); }

  function layout(nodes, edges, W, H) {
    const pad = { l: 56, r: 30, t: 30, b: 70 };
    const years = nodes.map((n) => n.paper.year).filter(Boolean);
    const y0 = Math.min(...years, new Date().getFullYear()), y1 = Math.max(...years, y0 + 1);
    const maxC = Math.max(1, ...nodes.map((n) => n.paper.cited_by_count || 0));
    const pos = new Map();
    if (view.mode === "timeline") {
      const placed = [];
      for (const n of [...nodes].sort((a, b) => (b.paper.cited_by_count || 0) - (a.paper.cited_by_count || 0))) {
        const yr = n.paper.year || y0;
        let x = pad.l + ((yr - y0) / Math.max(1, y1 - y0)) * (W - pad.l - pad.r);
        let y = H - pad.b - (Math.log10((n.paper.cited_by_count || 0) + 1) / Math.log10(maxC + 1)) * (H - pad.t - pad.b);
        const r = radius(n);
        // nudge overlapping nodes apart a little
        for (let tries = 0; tries < 30; tries++) {
          const hit = placed.find((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + 2);
          if (!hit) break;
          x += (tries % 2 ? 1 : -1) * (r + 1) * 0.6;
          y += (tries % 3 ? -1 : 1) * (r + 1) * 0.5;
        }
        placed.push({ x, y, r });
        pos.set(n.key, { x, y });
      }
      return { pos, y0, y1, maxC, pad };
    }
    // network: a short force simulation computed once (no animation, light on the CPU)
    const idx = new Map(nodes.map((n, i) => [n.key, i]));
    const P = nodes.map((n, i) => {
      const a = (i / nodes.length) * Math.PI * 2;
      const rr = n.seed ? 20 : 120 + (1 - (n.score || 0)) * 200;
      return { x: W / 2 + Math.cos(a) * rr, y: H / 2 + Math.sin(a) * rr, vx: 0, vy: 0 };
    });
    const links = edges.map((e) => [idx.get(e.source), idx.get(e.target)]).filter(([a, b]) => a !== undefined && b !== undefined);
    const seedIdx = nodes.map((n, i) => (n.seed ? i : -1)).filter((i) => i >= 0);
    for (let it = 0; it < 260; it++) {
      const alpha = 1 - it / 260;
      for (let i = 0; i < P.length; i++) {
        for (let j = i + 1; j < P.length; j++) {
          let dx = P[j].x - P[i].x, dy = P[j].y - P[i].y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = (2600 / d2) * alpha;
          const d = Math.sqrt(d2);
          dx /= d; dy /= d;
          P[i].vx -= dx * f; P[i].vy -= dy * f; P[j].vx += dx * f; P[j].vy += dy * f;
        }
      }
      for (const [a, b] of links) {
        const dx = P[b].x - P[a].x, dy = P[b].y - P[a].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 90) * 0.02 * alpha;
        P[a].vx += (dx / d) * f; P[a].vy += (dy / d) * f; P[b].vx -= (dx / d) * f; P[b].vy -= (dy / d) * f;
      }
      nodes.forEach((n, i) => {
        // stronger ties sit closer to the seeds
        for (const si of seedIdx) {
          if (si === i) continue;
          const dx = P[si].x - P[i].x, dy = P[si].y - P[i].y;
          P[i].vx += dx * 0.004 * (n.score || 0) * alpha; P[i].vy += dy * 0.004 * (n.score || 0) * alpha;
        }
        P[i].vx += (W / 2 - P[i].x) * 0.006 * alpha; P[i].vy += (H / 2 - P[i].y) * 0.006 * alpha;
        P[i].x += Math.max(-30, Math.min(30, P[i].vx)); P[i].y += Math.max(-30, Math.min(30, P[i].vy));
        P[i].vx *= 0.55; P[i].vy *= 0.55;
      });
    }
    // fit the result to the canvas
    const xs = P.map((q) => q.x), ys = P.map((q) => q.y);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const fx = (W - 120) / Math.max(1, bx1 - bx0), fy = (H - 90) / Math.max(1, by1 - by0);
    const f = Math.min(fx, fy, 3);
    const ox = (W - (bx1 - bx0) * f) / 2, oy = (H - (by1 - by0) * f) / 2 - 10;
    nodes.forEach((n, i) => pos.set(n.key, { x: ox + (P[i].x - bx0) * f, y: oy + (P[i].y - by0) * f }));
    return { pos, y0, y1, maxC, pad };
  }

  function radius(n) {
    return Math.max(4, Math.min(24, 3.5 + 3.2 * Math.log10((n.paper.cited_by_count || 0) + 1))) + (n.seed ? 1.5 : 0);
  }

  function draw() {
    modeSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === view.mode));
    const d = view.data;
    if (!d) {
      canvas.replaceChildren(h("div", { class: "hint" }, h("div", {},
        h("h3", {}, "See how a topic's papers connect"),
        h("p", {}, "Add one or more seed papers, then build the map. Citeweave gathers their references and the papers citing them, ",
          "and ranks every paper by shared references and shared citations. Strongly tied papers rise to the top."),
        h("p", { class: "small" }, "Tip: use the map icon on any search result to add it as a seed."))));
      side.replaceChildren();
      status.textContent = "";
      return;
    }
    const W = canvas.clientWidth || 900, H = canvas.clientHeight || 560;
    const { nodes, edges } = d;
    const L = layout(nodes, edges, W, H);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Citation map" });
    gRoot = s("g");
    svg.append(gRoot);
    zoom = { k: 1, x: 0, y: 0 };

    if (view.mode === "timeline") {
      const axis = s("g", { class: "axis" });
      const span = L.y1 - L.y0;
      const step = span > 40 ? 10 : span > 16 ? 5 : span > 6 ? 2 : 1;
      for (let y = Math.ceil(L.y0 / step) * step; y <= L.y1; y += step) {
        const x = L.pad.l + ((y - L.y0) / Math.max(1, span)) * (W - L.pad.l - L.pad.r);
        axis.append(s("line", { x1: x, x2: x, y1: L.pad.t - 10, y2: H - L.pad.b + 4 }));
        const t = s("text", { x, y: H - L.pad.b + 18, "text-anchor": "middle" }); t.textContent = y; axis.append(t);
      }
      for (const c of [1, 10, 100, 1000, 10000, 100000]) {
        if (c > L.maxC * 1.2) break;
        const y = H - L.pad.b - (Math.log10(c + 1) / Math.log10(L.maxC + 1)) * (H - L.pad.t - L.pad.b);
        const t = s("text", { x: L.pad.l - 10, y: y + 4, "text-anchor": "end" }); t.textContent = fmt(c); axis.append(t);
      }
      const yl = s("text", { x: 14, y: H / 2, transform: `rotate(-90 14 ${H / 2})`, "text-anchor": "middle" }); yl.textContent = "Citations"; axis.append(yl);
      gRoot.append(axis);
    }

    const gEdges = s("g"), gNodes = s("g");
    gRoot.append(gEdges, gNodes);
    const edgeEls = [];
    for (const e of edges) {
      const a = L.pos.get(e.source), b = L.pos.get(e.target);
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const bend = 0.18;
      const path = s("path", { class: "edge", d: `M${a.x},${a.y} Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}` });
      path.dataset.s = e.source; path.dataset.t = e.target;
      gEdges.append(path); edgeEls.push(path);
    }
    const labelBoxes = [];
    const labelKeys = new Set([...nodes].sort((a, b) => (b.seed - a.seed) || (b.score - a.score)).slice(0, 18).map((n) => n.key));
    const tip = h("div", { class: "tip", hidden: true });
    const nodeEls = new Map();
    for (const n of nodes) {
      const p = L.pos.get(n.key);
      const g = s("g", { class: `node${n.seed ? " seed" : ""}`, transform: `translate(${p.x},${p.y})`, tabindex: "0" });
      const r = radius(n);
      g.append(s("circle", { r, fill: n.seed ? cssVar("--saffron") : yearColor(n.paper.year, L.y0, L.y1) }));
      if (labelKeys.has(n.key)) {
        const label = `${surname(n.paper)} ${n.paper.year || ""}`;
        const w = label.length * 6.3;
        const flip = p.x + r + 4 + w > W - 6; // near the right edge: put the label on the left
        const box = { x: flip ? p.x - r - 4 - w : p.x + r + 4, y: p.y - 8, w, h: 14 };
        const clash = labelBoxes.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y);
        if (!clash) {
          labelBoxes.push(box);
          const t = s("text", flip ? { x: -(r + 4), y: 4, "text-anchor": "end" } : { x: r + 4, y: 4 });
          t.textContent = label; g.append(t);
        }
      }
      g.addEventListener("mouseenter", (ev) => {
        edgeEls.forEach((el) => el.classList.toggle("hot", el.dataset.s === n.key || el.dataset.t === n.key));
        tip.hidden = false;
        tip.textContent = `${n.paper.title} (${surname(n.paper)}, ${n.paper.year || "n.d."}). ${fmt(n.paper.cited_by_count || 0)} citations`;
        const rect = canvas.getBoundingClientRect();
        const tw = tip.offsetWidth || 320, th = tip.offsetHeight || 40;
        tip.style.left = `${Math.max(6, Math.min(ev.clientX - rect.left + 12, rect.width - tw - 6))}px`;
        const below = ev.clientY - rect.top + 14;
        tip.style.top = `${below + th > rect.height - 6 ? ev.clientY - rect.top - th - 10 : below}px`;
      });
      g.addEventListener("mouseleave", () => { edgeEls.forEach((el) => el.classList.remove("hot")); tip.hidden = true; });
      const pick = () => select(n.key, true);
      g.addEventListener("click", (ev) => { ev.stopPropagation(); pick(); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter") pick(); });
      gNodes.append(g);
      nodeEls.set(n.key, g);
    }
    view.nodeEls = nodeEls;

    // pan and zoom
    let drag = null;
    svg.addEventListener("pointerdown", (e) => { if (e.target.closest(".node")) return; drag = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y }; svg.classList.add("dragging"); svg.setPointerCapture(e.pointerId); });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const scale = W / svg.clientWidth;
      zoom.x = drag.zx + (e.clientX - drag.x) * scale; zoom.y = drag.zy + (e.clientY - drag.y) * scale; applyZoom();
    });
    svg.addEventListener("pointerup", () => { drag = null; svg.classList.remove("dragging"); });
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * W, my = ((e.clientY - rect.top) / rect.height) * H;
      const k = Math.max(0.4, Math.min(6, zoom.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      zoom.x = mx - ((mx - zoom.x) * k) / zoom.k; zoom.y = my - ((my - zoom.y) * k) / zoom.k; zoom.k = k; applyZoom();
    }, { passive: false });
    svg.addEventListener("click", () => select(null));
    const zoomBy = (f) => { const k = Math.max(0.4, Math.min(6, zoom.k * f)); zoom.x = W / 2 - ((W / 2 - zoom.x) * k) / zoom.k; zoom.y = H / 2 - ((H / 2 - zoom.y) * k) / zoom.k; zoom.k = k; applyZoom(); };

    const legend = h("div", { class: "legend" },
      view.mode === "timeline" ? "Left to right: year. Up: citations. " : "Closer papers are more strongly tied. ",
      "Older", h("i", { style: { background: `linear-gradient(90deg, ${yearColor(L.y0, L.y0, L.y1)}, ${yearColor(L.y1, L.y0, L.y1)})` } }), "Newer",
      h("span", { style: { marginLeft: "12px" } }, h("i", { style: { width: "10px", height: "10px", borderRadius: "50%", background: cssVar("--saffron") } }), "Seed"));
    const zoomBox = h("div", { class: "zoom" },
      h("button", { class: "btn small", title: "Zoom in", onclick: () => zoomBy(1.3) }, icon("zoomin")),
      h("button", { class: "btn small", title: "Zoom out", onclick: () => zoomBy(1 / 1.3) }, icon("zoomout")),
      h("button", { class: "btn small", title: "Reset view", onclick: () => { zoom = { k: 1, x: 0, y: 0 }; applyZoom(); } }, icon("fit")));
    canvas.replaceChildren(svg, legend, zoomBox, tip);
    status.textContent = `${nodes.length} papers, ${edges.length} citation links, ranked from ${d.stats?.candidates || 0} candidates`;
    drawSide();
    if (view.selected) select(view.selected, false);
  }

  function select(key, open) {
    view.selected = key;
    view.nodeEls?.forEach((g, k) => g.classList.toggle("sel", k === key));
    side.querySelectorAll(".item").forEach((el) => el.classList.toggle("sel", el.dataset.key === key));
    if (key && open) {
      const n = view.data.nodes.find((x) => x.key === key) || [...(view.data.foundational || []), ...(view.data.newer || []), ...(view.data.more || [])].find((x) => x.key === key);
      if (n) openDrawer(n.paper);
      side.querySelector(`.item[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  }

  function drawSide() {
    const d = view.data;
    const tabs = h("div", { class: "tabs" });
    const body = h("div");
    const lists = {
      connected: { label: "Connected", items: d.nodes.filter((n) => !n.seed).sort((a, b) => b.score - a.score),
        note: "Ranked by direct links, shared references and shared citations with your seeds." },
      foundational: { label: "Foundations", items: d.foundational || [], note: "Older papers that many papers on this map cite." },
      newer: { label: "Newer work", items: d.newer || [], note: "Papers that cite many papers on this map. Often reviews or follow-ups." },
      more: { label: "More", items: d.more || [], note: "Next candidates that did not fit on the map." },
    };
    const show = (key) => {
      view.tab = key;
      tabs.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === key));
      const L = lists[key];
      body.replaceChildren(h("div", { class: "small muted", style: { padding: "10px 14px 4px" } }, L.note));
      if (!L.items.length) body.append(h("div", { class: "small muted", style: { padding: "8px 14px" } }, "Nothing here for this map."));
      for (const n of L.items) {
        const score = n.score != null ? n.score : null;
        body.append(h("div", { ...pressable(() => { if (view.nodeEls?.has(n.key)) select(n.key, true); else openDrawer(n.paper); }),
          class: `item${n.key === view.selected ? " sel" : ""}`, "data-key": n.key },
        h("div", {}, h("div", { class: "t" }, n.paper.title), h("div", { class: "by" }, `${surname(n.paper)}, ${n.paper.year || "n.d."}. ${fmt(n.paper.cited_by_count || 0)} citations`)),
        h("div", { class: "score" },
          score != null ? h("div", {}, h("div", {}, `${Math.round(score * 100)}`), h("div", { class: "scorebar" }, h("i", { style: { width: `${Math.round(score * 100)}%` } })))
            : h("div", { title: "Number of map papers it links to" }, `${n.count} links`),
          h("button", { class: "btn ghost small", type: "button", title: "Add as seed", "aria-label": "Add as seed", onclick: (e) => { e.stopPropagation(); addSeed(n.paper); toast("Added as a seed. Build again to update the map."); } }, icon("plus")))));
      }
    };
    for (const [k, v] of Object.entries(lists)) tabs.append(h("button", { type: "button", "data-k": k, onclick: () => show(k) }, v.label, v.items.length ? ` (${v.items.length})` : ""));
    side.replaceChildren(tabs, body);
    show(view.tab in lists ? view.tab : "connected");
  }

  // saved maps -----------------------------------------------------------------------------
  async function saveMap() {
    const name = await prompt("Save map", "Name", view.mapName || (state.seeds[0] ? `${surname(state.seeds[0])} ${state.seeds[0].year || ""} map` : "My map"));
    if (!name) return;
    try {
      const known = (view.data?.nodes || []).map((n) => n.key);
      const seeds = state.seeds.map((p) => ({ id: p.id, doi: p.doi, title: p.title, year: p.year, authors: (p.authors || []).slice(0, 3), ids: p.ids }));
      const r = await api.post("/api/maps", { id: view.mapId, name, seeds, options: { max_nodes: view.maxNodes, mode: view.mode }, known });
      view.mapId = r.id; view.mapName = name; persist(); title.textContent = name;
      toast("Map saved. Use “Check for new papers” later to see new work citing your seeds.");
    } catch (e) { showError(e); }
  }

  async function openMaps() {
    let maps;
    try { maps = await api.get("/api/maps"); } catch (e) { showError(e); return; }
    if (!maps.length) { toast("No saved maps yet"); return; }
    const list = h("div", { class: "papers" }, maps.map((m) => h("div", { class: "paper", style: { gridTemplateColumns: "1fr auto" } },
      h("div", pressable(() => { load(m); document.querySelector(".modal-bg")?.click(); }),
        h("div", { class: "t" }, m.name), h("div", { class: "by" }, `${m.seeds.length} seeds. Last checked ${m.last_checked ? new Date(m.last_checked * 1000).toLocaleDateString() : "never"}`)),
      h("button", { class: "btn ghost small", type: "button", title: "Delete map", "aria-label": `Delete map ${m.name}`, onclick: async (e) => {
        e.stopPropagation();
        const row = e.currentTarget.closest(".paper");
        try {
          await api.del(`/api/maps/${encodeURIComponent(m.id)}`);
          row.remove();
          if (String(view.mapId) === String(m.id)) { view.mapId = null; view.mapName = ""; persist(); title.textContent = "Citation map"; }
        } catch (err) { showError(err); }
      } }, icon("trash")))));
    await modal("Saved maps", list, [{ label: "Close", value: null }]);
  }

  function load(m) {
    state.seeds = [...m.seeds]; view.mapId = m.id; view.mapName = m.name; view.maxNodes = m.options?.max_nodes || 40;
    title.textContent = m.name;
    view.mode = m.options?.mode || view.mode; maxSel.value = String(view.maxNodes);
    emit("seeds"); persist(); build();
  }

  async function checkNew() {
    if (!view.mapId) { toast("Save the map first, then check it for new papers later."); return; }
    try {
      const r = await api.post(`/api/maps/${encodeURIComponent(view.mapId)}/check`);
      const body = r.results.length
        ? h("div", {}, h("p", { class: "muted" }, `${r.results.length} new papers cite your seeds since ${r.since}.`), paperList(r.results))
        : h("p", { class: "muted" }, `No new papers cite your seeds since ${r.since}.`);
      const act = await modal("New papers", body, r.results.length ? [{ label: "Close", value: null }, { label: "Save all", cls: "primary", value: "save" }] : [{ label: "Close", value: null }]);
      if (act === "save") saveToCollection(r.results);
    } catch (e) { showError(e); }
  }

  modeSeg.addEventListener("click", (e) => { const m = e.target.closest("button")?.dataset.mode; if (m && m !== view.mode) { view.mode = m; persist(); draw(); } });
  seedInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromInput(); });

  const title = h("h1", { class: "grow", style: { margin: 0 } }, view.mapName || "Citation map");
  const page = h("div", { class: "page wide" },
    h("div", { class: "row", style: { marginBottom: "10px" } },
      title,
      btn("Saved maps", openMaps, { cls: "small ghost" }),
      btn("Save map", saveMap, { cls: "small ghost", ico: "save" }),
      btn("Check for new papers", checkNew, { cls: "small ghost", ico: "refresh" })),
    h("div", { class: "map-top" }, seedsBox),
    h("div", { class: "map-top" }, seedInput, btn("Add", addFromInput, { cls: "small" }), maxSel, btn("Build map", build, { cls: "primary" }),
      h("span", { class: "spacer" }), status, modeSeg),
    h("div", { class: "map-body" }, canvas, side));
  root.append(page);
  drawSeeds();
  const off = onChange((what) => { if (what === "seeds") drawSeeds(); });
  requestAnimationFrame(draw);
  let rt;
  const onResize = () => { clearTimeout(rt); rt = setTimeout(() => view.data && draw(), 200); };
  window.addEventListener("resize", onResize);
  return () => { off(); window.removeEventListener("resize", onResize); controller?.abort(); };
}

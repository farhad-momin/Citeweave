// DOM helpers, icons, toasts, modals and shared paper rendering.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") el.innerHTML = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  save: '<path d="M6 4h12v16l-6-4-6 4z"/>',
  saved: '<path d="M6 4h12v16l-6-4-6 4z" fill="currentColor"/>',
  map: '<circle cx="6" cy="7" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="17" r="2.6"/><path d="M7.8 8.2l3 6.6M16.6 7.6l-3.4 7.2M8.2 6.8h7.6"/>',
  pdf: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 13h5M10 16.5h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cite: '<path d="M6 10h4v6H5v-3c0-3 1-5 3-6M15 10h4v6h-5v-3c0-3 1-5 3-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  zoomin: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8.5 11h5M11 8.5v5"/>',
  zoomout: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5M8.5 11h5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};

export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}

// Attributes that make a non-button element (a list row, a citation number) work with the keyboard.
export function pressable(fn, attrs = {}) {
  return { ...attrs, tabindex: "0", role: "button", onclick: fn,
    onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); fn(e); } } };
}

export function btn(label, onClick, { cls = "", ico, title, disabled } = {}) {
  return h("button", { class: `btn ${cls}`, type: "button", onclick: onClick, title, disabled },
    ico ? icon(ico) : null, label);
}

export function toast(message, { error = false, action, actionLabel, timeout = 4200 } = {}) {
  const el = h("div", { class: `toast${error ? " error" : ""}`, role: error ? "alert" : "status" }, message);
  if (action) el.append(h("a", { href: "#", onclick: (e) => { e.preventDefault(); action(); el.remove(); } }, actionLabel || "Open"));
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), error ? timeout * 1.6 : timeout);
}

export function showError(e) {
  toast(e?.message || String(e), { error: true });
}

// An action's value may be a function. If it returns undefined (or a promise of undefined),
// the dialog stays open, which lets a button check the input first.
export function modal(title, body, actions = [], { wide = false } = {}) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const opener = document.activeElement;
    const close = (val) => {
      bg.remove(); document.removeEventListener("keydown", onKey); resolve(val);
      if (opener?.isConnected && !document.querySelector(".modal-bg")) opener.focus?.();
    };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    const run = async (a, b) => {
      if (typeof a.value !== "function") { close(a.value); return; }
      b.disabled = true;
      try {
        const v = await a.value();
        if (v !== undefined) close(v);
      } finally { b.disabled = false; }
    };
    const foot = h("div", { class: "foot" },
      actions.map((a) => { const b = btn(a.label, () => run(a, b), { cls: a.cls || "" }); return b; }));
    const box = h("div", { class: `modal${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("h2", {}, title), body, foot);
    const bg = h("div", { class: "modal-bg", onclick: (e) => { if (e.target === bg) close(null); } }, box);
    root.append(bg);
    document.addEventListener("keydown", onKey);
    (box.querySelector("input, textarea, select") || box.querySelector("button"))?.focus();
  });
}

export async function prompt(title, label, value = "") {
  const input = h("input", { class: "input", value, style: { width: "100%" } });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.closest(".modal").querySelector(".btn.primary").click(); });
  return modal(title, h("label", { class: "field" }, h("span", {}, label), input),
    [{ label: "Cancel", value: null }, { label: "Save", cls: "primary", value: () => input.value.trim() }]);
}

export function progressBox() {
  const bar = h("i");
  const msg = h("div", { class: "msg" }, "Starting");
  const el = h("div", { class: "progress" }, h("div", { class: "bar" }, bar), msg);
  return { el, update: (m, f) => { msg.textContent = m || ""; bar.style.width = `${Math.round((f || 0) * 100)}%`; } };
}

export function authorsShort(p, n = 3) {
  const a = (p.authors || []).map((x) => x.name);
  if (!a.length) return "Unknown authors";
  return a.length > n ? `${a.slice(0, n).join(", ")} et al.` : a.join(", ");
}

export function byline(p) {
  return [authorsShort(p).replace(/\.+$/, ""), [p.venue, p.year].filter(Boolean).join(", ")].filter(Boolean).join(". ");
}

export function fmt(n) {
  if (n === null || n === undefined) return "";
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
}

export async function copyText(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: 0 } }, text);
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast(what);
}

export function download(name, text, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const SOURCE_LABELS = {
  openalex: "OpenAlex", semanticscholar: "Semantic Scholar", crossref: "Crossref", europepmc: "Europe PMC",
  arxiv: "arXiv", pubmed: "PubMed", core: "CORE", scopus: "Scopus", opencitations: "OpenCitations",
  unpaywall: "Unpaywall", orcid: "ORCID", ai: "AI suggestion", chatbot: "your chatbot (checked)", lookup: "Identifier", import: "Import", zotero: "Zotero",
};

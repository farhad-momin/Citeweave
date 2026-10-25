import { api, runJob } from "../api.js";
import { askPrompt, bridgeDialog, checkAnswer, noAbstractWarning } from "../bridge.js";
import { openDrawer, paperList, saveToCollection } from "../paper.js";
import { smartRank } from "../smart.js";
import { addSeed, addTablePick, state } from "../state.js";
import { SOURCE_LABELS, btn, h, icon, pressable, progressBox, showError, toast } from "../ui.js";

const EXAMPLES = [
  "How does recycled coarse aggregate affect the compressive strength of concrete?",
  "Does intermittent fasting improve insulin sensitivity in adults?",
  "Which methods are used to detect bias in large language models?",
];

const MODE_NOTE = {
  ai: (label) => `Written by ${label || "AI"} from the abstracts below. Check important claims in the papers.`,
  chatbot: () => "Written by your chatbot from the abstracts below. Citation numbers were checked against these papers. Check important claims in the papers.",
  extractive: () => "Key sentences from the most relevant abstracts. For a written answer, use your chatbot or set up AI in Settings.",
};

function when(ts) {
  const d = new Date(ts * 1000);
  const days = Math.floor((Date.now() - d) / 86400e3);
  return days < 1 ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : days < 7 ? `${days} day${days > 1 ? "s" : ""} ago` : d.toLocaleDateString();
}

export function render(root) {
  const s = state.lastAsk || { question: "", data: null, useAi: true };
  const aiOn = state.status?.ai?.enabled;
  const q = h("textarea", { class: "input", rows: 2, style: { width: "100%", fontSize: "16px" },
    placeholder: "Ask a research question in plain words" }, s.question);
  const useAi = h("input", { type: "checkbox", checked: aiOn && s.useAi, disabled: !aiOn });
  const out = h("div");
  const historyBox = h("div", { class: "history" });
  let controller;

  async function remember(d) {
    try {
      const item = await api.post("/api/history", { question: d.question, answer: d.answer, papers: d.papers, mode: d.answer_kind });
      d.history_id = item.id;
    } catch { /* history is a convenience */ }
  }

  async function go() {
    const question = q.value.trim();
    if (!question) return;
    controller?.abort();
    controller = new AbortController();
    Object.assign(s, { question, useAi: useAi.checked, data: null });
    state.lastAsk = s;
    const pb = progressBox();
    out.replaceChildren(pb.el, btn("Stop", () => controller.abort(), { cls: "small ghost" }));
    historyBox.replaceChildren();
    try {
      const d = await runJob(api.post("/api/ask", { question, use_ai: useAi.checked }), pb.update, controller.signal);
      if (d.answer_kind !== "ai" && d.papers?.length) {
        pb.update("Ranking by meaning", 0.95);
        const before = d.papers;
        d.papers = await smartRank(question, d.papers).catch(() => d.papers);
        // the key-sentence answer cites papers by position, so renumber it to the new order
        if (d.papers !== before && d.answer) {
          const pos = new Map(d.papers.map((p, i) => [p.id, i + 1]));
          d.answer = d.answer.replace(/\[(\d+)\]/g, (m, n) => {
            const p = before[Number(n) - 1];
            return p && pos.has(p.id) ? `[${pos.get(p.id)}]` : m;
          });
        }
      }
      s.data = d;
      if (d.papers?.length) remember(d);
      show();
    } catch (e) {
      out.replaceChildren(h("p", { class: "err" }, e.message));
    }
  }

  async function useChatbot() {
    const d = s.data;
    if (!d?.papers?.length) return;
    const papers = d.papers.slice(0, 10);
    noAbstractWarning(papers);
    const result = await bridgeDialog({
      title: "Answer with your chatbot",
      intro: "Use ChatGPT, Claude, Gemini or any chatbot you already have. No API key needed. Citeweave sends the top papers' abstracts and checks the citations in the reply.",
      prompt: askPrompt(d.question, papers),
      read: (text) => {
        const { answer, badCitations } = checkAnswer(text, papers.length);
        if (answer.length < 40) throw new Error("That reply looks too short. Paste the chatbot's whole answer.");
        return { answer, badCitations };
      },
    });
    if (!result) return;
    Object.assign(d, { answer: result.answer, answer_kind: "chatbot", bad_citations: result.badCitations, ai_error: null });
    if (d.history_id) api.del(`/api/history/${d.history_id}`).catch(() => {});
    remember(d);
    show();
    toast(result.badCitations.length ? "Answer added. Some citation numbers did not match a paper and are marked." : "Answer added");
  }

  function citeLinks(text, papers, bad = []) {
    const p = h("p");
    const parts = text.split(/(\[\d+(?:\s*[,\-\u2013]\s*\d+)*\])/g);
    for (const part of parts) {
      const m = part.match(/^\[(.+)\]$/);
      if (!m) { p.append(part); continue; }
      const nums = m[1].split(/\s*,\s*/);
      p.append(...nums.map((n) => {
        // a range such as [2-4] links to its first paper and is marked when any number in it is wrong
        const [a, b] = n.split(/\s*[-\u2013]\s*/).map((x) => parseInt(x, 10));
        const last = b || a;
        const paper = papers[a - 1];
        const wrong = !paper || last > papers.length || last < a || bad.some((x) => x >= a && x <= last);
        const open = () => { if (paper) openDrawer(paper); };
        return h("span", { ...pressable(open), class: `cite-ref${wrong ? " bad" : ""}`,
          title: wrong ? "This number does not match any paper below" : paper.title }, `[${n.trim()}]`);
      }));
    }
    return p;
  }

  async function drawHistory() {
    let items = [];
    try { items = await api.get("/api/history"); } catch { return; }
    if (!items.length) { historyBox.replaceChildren(); return; }
    historyBox.replaceChildren(h("h3", {}, "Recent questions"), ...items.slice(0, 30).map((it) => h("div", { class: "item" },
      h("a", { href: "#", onclick: (e) => {
        e.preventDefault();
        q.value = it.question;
        s.question = it.question;
        s.data = { question: it.question, answer: it.answer, answer_kind: it.mode, papers: it.papers || [], used: [], history_id: it.id, from_history: true };
        state.lastAsk = s;
        show();
      } }, it.question),
      h("span", { class: "when" }, when(it.created_at)),
      h("button", { class: "btn ghost small", title: "Remove from history", "aria-label": "Remove from history", onclick: async (e) => {
        e.currentTarget.closest(".item").remove();
        await api.del(`/api/history/${it.id}`).catch(showError);
      } }, icon("trash")))));
  }

  function show() {
    const d = s.data;
    out.replaceChildren();
    if (!d) {
      out.append(h("div", { class: "empty" },
        h("h3", {}, "Get a sourced overview of what the literature says"),
        h("p", {}, aiOn
          ? "Citeweave searches the open databases, ranks the most relevant papers, and writes a short answer that cites each claim. Every number links back to its paper."
          : "Citeweave ranks the most relevant papers and pulls the key sentence from each abstract. For a written answer, use the chatbot you already have (no key needed) or set up AI in Settings."),
        h("div", { class: "presets" }, EXAMPLES.map((e) => btn(e, () => { q.value = e; go(); }, { cls: "small ghost" })))));
      drawHistory();
      return;
    }
    if (d.answer) {
      out.append(h("div", { class: "answer" },
        citeLinks(d.answer, d.papers, d.bad_citations || []),
        h("div", { class: "meta" },
          (MODE_NOTE[d.answer_kind] || MODE_NOTE.extractive)(state.status?.ai?.label),
          d.query && d.query !== d.question ? ` Searched for: ${d.query}.` : "",
          d.from_history ? " Saved earlier. Ask again for fresh results." : "")));
    }
    if (d.ai_error) out.append(h("p", { class: "err" }, d.ai_error));
    if (!d.papers.length) {
      out.append(h("div", { class: "empty" }, h("p", {}, "No papers with abstracts matched. Try rephrasing the question.")));
      return;
    }
    out.append(h("div", { class: "row" },
      h("div", { class: "note-line grow" }, `${d.papers.length} most relevant papers`,
        d.used?.length ? ` from ${d.used.map((u) => SOURCE_LABELS[u] || u).join(", ")}` : ""),
      d.answer_kind !== "ai" && !d.from_history ? btn(d.answer_kind === "chatbot" ? "Redo with chatbot" : "Answer with my chatbot", useChatbot, { cls: "small", ico: "spark" }) : null,
      btn("Save all", () => saveToCollection(d.papers), { cls: "small ghost", ico: "save" }),
      btn("Make a table", () => { d.papers.forEach(addTablePick); location.hash = "#/tables"; }, { cls: "small ghost", ico: "plus" }),
      btn("Map these", () => { d.papers.slice(0, 5).forEach(addSeed); toast("Top papers added to the map"); location.hash = "#/map"; }, { cls: "small ghost", ico: "map" })));
    out.append(paperList(d.papers, { numbered: true, keySentences: true }));
  }

  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });

  root.append(h("div", { class: "page" },
    h("h1", {}, "Ask a question"),
    h("p", { class: "lede" }, "Answers come only from real papers in open databases, with a link for every claim."),
    q,
    h("div", { class: "row", style: { margin: "10px 0 18px" } },
      btn("Ask", go, { cls: "primary" }),
      h("label", { class: "check", title: aiOn ? "" : "Set up an AI provider in Settings" }, useAi,
        aiOn ? `Write an answer with ${state.status.ai.label}` : "No AI set up. You can still answer with your chatbot")),
    out, historyBox));
  show();
  if (!s.data) q.focus();
}

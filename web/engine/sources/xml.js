// A small XML reader for the Atom (arXiv) and PubMed responses. It works the same in
// browsers and in Node, so the tests cover the code that runs in the app.
import { unescapeHtml } from "../models.js";

class XNode {
  constructor(name, attrs = {}) {
    this.name = name;
    this.attrs = attrs;
    this.children = [];
  }

  get elements() { return this.children.filter((c) => c instanceof XNode); }

  // direct children by tag name
  all(name) { return this.elements.filter((c) => c.name === name); }
  first(name) { return this.elements.find((c) => c.name === name) || null; }

  // a path like "Journal/JournalIssue/PubDate/Year"
  find(path) {
    let cur = [this];
    for (const part of path.split("/")) {
      cur = cur.flatMap((n) => n.all(part));
      if (!cur.length) return null;
    }
    return cur[0];
  }

  findAll(path) {
    let cur = [this];
    for (const part of path.split("/")) cur = cur.flatMap((n) => n.all(part));
    return cur;
  }

  // all descendants with this tag name
  descendants(name) {
    const out = [];
    const walk = (n) => {
      for (const c of n.elements) {
        if (c.name === name) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  // concatenated text of this node and its descendants
  text() {
    return this.children.map((c) => (c instanceof XNode ? c.text() : c)).join("");
  }

  textOf(path, fallback = "") {
    const n = this.find(path);
    return n ? n.text() : fallback;
  }

  attr(name) { return this.attrs[name]; }
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = unescapeHtml(m[3] ?? m[4] ?? "");
  return attrs;
}

export function parseXml(text) {
  const root = new XNode("#document");
  const stack = [root];
  const s = String(text || "");
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      stack[stack.length - 1].children.push(unescapeHtml(s.slice(i)));
      break;
    }
    if (lt > i) stack[stack.length - 1].children.push(unescapeHtml(s.slice(i, lt)));
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt);
      i = end < 0 ? s.length : end + 3;
    } else if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt);
      stack[stack.length - 1].children.push(s.slice(lt + 9, end < 0 ? s.length : end));
      i = end < 0 ? s.length : end + 3;
    } else if (s[lt + 1] === "?" || s[lt + 1] === "!") {
      const end = s.indexOf(">", lt);
      i = end < 0 ? s.length : end + 1;
    } else if (s[lt + 1] === "/") {
      const end = s.indexOf(">", lt);
      const name = s.slice(lt + 2, end).trim();
      // pop to the matching open tag (tolerates small mistakes)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end < 0 ? s.length : end + 1;
    } else {
      const end = s.indexOf(">", lt);
      if (end < 0) break;
      let body = s.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const sp = body.search(/\s/);
      const name = sp < 0 ? body : body.slice(0, sp);
      const node = new XNode(name, sp < 0 ? {} : parseAttrs(body.slice(sp)));
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  return root;
}

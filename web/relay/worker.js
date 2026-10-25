// Citeweave relay: a tiny Cloudflare Worker for the few scholarly services that refuse
// requests from web pages. Free tier: 100,000 requests a day, which is plenty for one lab.
//
// It only forwards GET requests, and JSON POST requests (Semantic Scholar's batch lookup and
// recommendations), to the hosts listed below, adds the header browsers need, and stores nothing. Deploy: see web/README.md, "Optional relay".
const ALLOWED = new Set([
  "api.semanticscholar.org",
  "export.arxiv.org",
  "api.core.ac.uk",
  "api.elsevier.com",
]);
// Request headers passed on to the service (API keys for that service only).
const PASS = ["accept", "authorization", "content-type", "x-els-apikey", "x-els-insttoken", "x-api-key"];

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": PASS.join(", "),
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
});

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const post = request.method === "POST";
    if (!post && request.method !== "GET") return new Response("Only GET and POST are relayed", { status: 405, headers: cors(origin) });
    if (post && !(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
      return new Response("Only JSON is relayed", { status: 415, headers: cors(origin) });
    }
    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get("url") || "");
    } catch {
      return new Response("Add ?url=<address>", { status: 400, headers: cors(origin) });
    }
    if (target.protocol !== "https:" || !ALLOWED.has(target.hostname)) {
      return new Response("That service is not on this relay's list", { status: 403, headers: cors(origin) });
    }
    const headers = new Headers({ "User-Agent": "Citeweave relay (open source research tool)" });
    for (const h of PASS) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const upstream = post
      ? await fetch(target.toString(), { method: "POST", headers, body: await request.text() })
      : await fetch(target.toString(), { headers, cf: { cacheTtl: 3600 } });
    const out = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors(origin))) out.headers.set(k, v);
    out.headers.delete("set-cookie");
    return out;
  },
};

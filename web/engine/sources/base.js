// Base class every data source follows. Mirrors citeweave/sources/base.py.
//
// To add a source: extend Source, set name, label and capabilities, implement the
// methods you support, and register it in sources/index.js.
import { RELAY_HOSTS, relayUrl } from "../net.js";
import { settings } from "../settings.js";

export class Source {
  constructor() {
    this.name = "base";
    this.label = "Base";
    this.homepage = "";
    this.keyRequired = false;
    this.keyHelp = "";
    this.capabilities = new Set();
    this.host = ""; // set by sources that need it for the browser check below
  }

  cfg() { return settings().get("sources", this.name) || {}; }
  key() { return String(this.cfg().key || "").trim(); }
  email() { return String(settings().get("email") || "").trim(); }
  enabled() { return this.cfg().enabled === undefined ? true : Boolean(this.cfg().enabled); }

  // returns [ok, reason]
  ready() {
    if (!this.enabled()) return [false, `${this.label} is turned off in Settings`];
    if (this.keyRequired && !this.key()) return [false, `${this.label} needs an API key. ${this.keyHelp}`];
    if (this.host && RELAY_HOSTS.has(this.host) && !relayUrl()) {
      return [false, `${this.label} does not accept requests from web pages. Add a relay below, or use the PC app.`];
    }
    return [true, ""];
  }

  info() {
    const [ok, reason] = this.ready();
    return {
      name: this.name,
      label: this.label,
      homepage: this.homepage,
      capabilities: [...this.capabilities].sort(),
      key_required: this.keyRequired,
      key_help: this.keyHelp,
      has_key: Boolean(this.key()),
      enabled: this.enabled(),
      ready: ok,
      reason,
    };
  }

  async search(_query, _limit = 25, _filters = null) { throw new Error("not supported"); }
  async paper(_kind, _value) { throw new Error("not supported"); }
  async references(_paper, _limit = 200) { throw new Error("not supported"); }
  async citations(_paper, _limit = 200) { throw new Error("not supported"); }
}

export function yearFilter(filters) {
  const f = filters || {};
  return [f.year_from || null, f.year_to || null];
}

export const uniq = (xs) => [...new Set(xs.filter(Boolean))];

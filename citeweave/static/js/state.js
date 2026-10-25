// Shared state across views, kept in memory. Map seeds and table picks persist per session.
import { api } from "./api.js";

const listeners = new Set();

export const state = {
  status: null,
  collections: [],
  seeds: [],          // papers queued for the citation map
  tablePicks: [],     // papers queued for a table
  lastSearch: null,   // keep results when switching views
  lastAsk: null,
  lastMap: null,
  currentCollection: null,
};

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { listeners.forEach((fn) => fn(what)); }

export async function refreshCollections() {
  state.collections = await api.get("/api/collections");
  emit("collections");
  return state.collections;
}

export async function refreshStatus() {
  state.status = await api.get("/api/status");
  emit("status");
  return state.status;
}

export function addSeed(p) {
  if (!state.seeds.find((s) => s.id === p.id)) state.seeds.push(p);
  emit("seeds");
}

export function removeSeed(id) {
  state.seeds = state.seeds.filter((s) => s.id !== id);
  emit("seeds");
}

export function addTablePick(p) {
  if (!state.tablePicks.find((s) => s.id === p.id)) state.tablePicks.push(p);
  emit("tablePicks");
}

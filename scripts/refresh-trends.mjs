#!/usr/bin/env node

const API_BASE = (process.env.API_BASE || "http://127.0.0.1:5001/api").replace(/\/$/, "");
const args = process.argv.slice(2);

function readArg(name) {
  const exact = args.find((item) => item.startsWith(`--${name}=`));
  if (exact) return exact.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

const queue = args.includes("--queue");
const source = readArg("source");
const productId = readArg("productId");

const refreshed = await request("/trends/refresh", {
  method: "POST",
  body: JSON.stringify({ source, productId, sync: !queue }),
});
const status = await request("/trends/status");
const items = await request(`/trends/items?limit=${Number(readArg("limit") || 8)}`);

console.log(
  JSON.stringify(
    {
      api: API_BASE,
      refresh: refreshed,
      counts: status.counts,
      storage: status.storage,
      topItems: items.items?.map((item) => ({
        title: item.title,
        heatScore: item.heatScore,
        tags: item.flatTags?.slice(0, 6),
      })),
    },
    null,
    2,
  ),
);

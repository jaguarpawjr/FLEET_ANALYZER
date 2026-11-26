import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve("dashboard/dist");
const port = Number(process.env.PORT ?? 4173);
const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3000";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      const target = new URL(`${url.pathname.slice(4)}${url.search}`, apiOrigin);
      const upstream = await fetch(target, { method: req.method ?? "GET" });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "upstream_unavailable", message: "Analytics API is unavailable" } }));
    }
    return;
  }
  try {
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const file = resolve(root, `.${requested}`);
    if (!file.startsWith(`${root}/`)) throw new Error("Invalid path");
    const content = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    try {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(resolve(root, "index.html")));
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
}).listen(port, "0.0.0.0", () => console.log(`Fleetwatch dashboard listening on ${port}`));

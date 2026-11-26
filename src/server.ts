import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const outputDir = process.env.OUTPUT_DIR ?? "data/processed";
const send = (res: any, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(value));
};
const json = async (name: string) => JSON.parse(await readFile(join(outputDir, name), "utf8"));
const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type" });
    res.end(); return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method !== "GET") return send(res, 405, { error: { code: "method_not_allowed", message: "Only GET is supported" } });
    if (url.pathname === "/zones") return send(res, 200, await json("zones.geojson"));
    if (url.pathname === "/anomalies") {
      const anomalies = await json("anomalies.json");
      const filtered = anomalies.filter((item: any) => (!url.searchParams.has("type") || item.type === url.searchParams.get("type")) && (!url.searchParams.has("vehicle_id") || item.vehicle_id === url.searchParams.get("vehicle_id")));
      return send(res, 200, filtered);
    }
    const match = url.pathname.match(/^\/vehicles\/([A-Za-z0-9._-]+)\/days\/(\d{4}-\d{2}-\d{2})(?:\/(stops|route))?$/);
    if (!match) return send(res, 400, { error: { code: "invalid_request", message: "Invalid endpoint, vehicle ID, or date" } });
    const [, vehicleId, date, resource] = match;
    if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return send(res, 400, { error: { code: "invalid_date", message: "Date must be a real YYYY-MM-DD date" } });
    if (resource === "route") {
      try { return send(res, 200, await json(join("routes", `${encodeURIComponent(vehicleId)}_${date}.geojson`))); }
      catch { return send(res, 404, { error: { code: "not_found", message: "Route not found" } }); }
    }
    if (resource === "stops") {
      const stops = (await json("stops.json")).filter((stop: any) => stop.vehicle_id === vehicleId && stop.date === date);
      return send(res, 200, stops);
    }
    const summary = (await json("summaries.json")).find((item: any) => item.vehicle_id === vehicleId && item.date === date);
    return summary ? send(res, 200, summary) : send(res, 404, { error: { code: "not_found", message: "Vehicle-day summary not found" } });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: { code: "internal_error", message: "Analytics data is unavailable" } });
  }
});
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => console.log(`Fleet API listening on ${process.env.PORT ?? 3000}`));

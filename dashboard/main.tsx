import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleMarker, GeoJSON, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import type { FeatureCollection } from "geojson";
import { MetricCard } from "./MetricCard.js";
import "leaflet/dist/leaflet.css";
import "./style.css";

type Summary = {
  vehicle_id: string; date: string; distance_km: number; moving_minutes: number; stopped_minutes: number;
  stop_count: number; data_quality_issues: number; restricted_minutes: Record<string, number>;
};
type Stop = { start_time: string; end_time: string; duration_minutes: number; lat: number; lon: number; zones: string[]; restricted: boolean };
type Anomaly = { type: string; vehicle_id: string; timestamp: string; reason: string; action: string };
const API = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const fetchJson = async <T,>(path: string): Promise<T> => {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`Analytics API returned ${response.status}`);
  return response.json();
};
const minutes = (value: number) => `${Math.floor(value / 60)}h ${Math.round(value % 60)}m`;

function OperationsDashboard() {
  const [date, setDate] = useState("2025-01-15");
  const [fleet, setFleet] = useState<Summary[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [route, setRoute] = useState<FeatureCollection | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [zones, setZones] = useState<FeatureCollection | null>(null);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [inefficient, setInefficient] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<keyof Summary>("distance_km");
  const [showService, setShowService] = useState(true);
  const [showRestricted, setShowRestricted] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true); setError("");
    Promise.all([
      fetchJson<Summary[]>(`/fleet?date=${date}`),
      fetchJson<FeatureCollection>("/zones"),
      fetchJson<Anomaly[]>("/anomalies"),
      fetchJson<any[]>("/inefficient-trips")
    ]).then(([daily, zoneData, anomalyData, trips]) => {
      setFleet(daily); setZones(zoneData); setAnomalies(anomalyData); setInefficient(trips);
      setVehicleId((current) => daily.some((item) => item.vehicle_id === current) ? current : daily[0]?.vehicle_id ?? "");
    }).catch((e) => setError(e instanceof Error ? e.message : "Unable to load operations data"))
      .finally(() => setLoading(false));
  }, [date]);

  useEffect(() => {
    if (!vehicleId) { setRoute(null); setStops([]); return; }
    Promise.all([
      fetchJson<FeatureCollection>(`/vehicles/${vehicleId}/days/${date}/route`),
      fetchJson<Stop[]>(`/vehicles/${vehicleId}/days/${date}/stops`)
    ]).then(([geo, stopData]) => { setRoute(geo); setStops(stopData); })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load vehicle route"));
  }, [vehicleId, date]);

  const shown = useMemo(() => fleet.filter((v) => v.vehicle_id.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => Number(b[sortKey]) - Number(a[sortKey])), [fleet, filter, sortKey]);
  const selected = fleet.find((v) => v.vehicle_id === vehicleId);
  const routeFeature = route?.features.find((f: any) => f.properties?.kind === "route") as any;
  const coordinates = routeFeature?.geometry?.coordinates ?? [];
  const center: [number, number] = coordinates.length ? [coordinates[0][1], coordinates[0][0]] : [5.56, -0.2];
  const types = Object.entries(anomalies.reduce<Record<string, number>>((acc, item) => { acc[item.type] = (acc[item.type] ?? 0) + 1; return acc; }, {}));

  if (loading) return <main className="status"><span className="pulse" /> Loading fleet operations…</main>;
  if (error && !fleet.length) return <main className="status error">Unable to load data <p>{error}</p><button onClick={() => location.reload()}>Retry</button></main>;
  return <main className="shell">
    <header className="topbar"><a className="brand" href="#"><span className="brand-mark">F</span> FLEETWATCH <span className="brand-sub">/ OPERATIONS</span></a>
      <label className="date-control">OPERATING DAY <input aria-label="Operating day" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <span className="live-tag"><i /> DAILY ANALYTICS</span>
    </header>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <section className="intro"><div><p className="eyebrow">GREATER ACCRA · FLEET CONTROL</p><h1>Operations overview</h1><p className="subhead">A clearer picture of every vehicle, stop and exception.</p></div><div className="date-stamp">{date}</div></section>
    <section className="kpis" aria-label="Fleet summary">
      <MetricCard label="VEHICLES REPORTING" value={fleet.length} detail="in the selected day" />
      <MetricCard label="FLEET DISTANCE" value={<>{fleet.reduce((sum, item) => sum + item.distance_km, 0).toFixed(1)} <em>km</em></>} detail="geodesic route distance" />
      <MetricCard label="DATA FLAGS" value={anomalies.length} detail="quality issues to review" warning={Boolean(anomalies.length)} />
      <MetricCard label="INEFFICIENT TRIPS" value={inefficient.filter((trip) => trip.date === date).length} detail=">60 min and <5 km" warning={inefficient.some((trip) => trip.date === date)} />
    </section>
    <div className="columns">
      <section className="panel fleet-panel"><div className="panel-heading"><div><p className="eyebrow">FLEET REGISTER</p><h2>Vehicle performance</h2></div><span className="count-pill">{shown.length} VEHICLES</span></div>
        <div className="table-controls"><input aria-label="Filter vehicles" placeholder="Find vehicle…" value={filter} onChange={(e) => setFilter(e.target.value)} /><label>Sort by <select value={sortKey} onChange={(e) => setSortKey(e.target.value as keyof Summary)}><option value="distance_km">Distance</option><option value="moving_minutes">Moving time</option><option value="stop_count">Stops</option><option value="data_quality_issues">Data flags</option></select></label></div>
        <div className="table-scroll"><table><thead><tr><th>VEHICLE</th><th>DISTANCE</th><th>MOVING</th><th>STOPS</th><th>DATA</th></tr></thead><tbody>
          {shown.map((item) => <tr key={item.vehicle_id} role="button" aria-label={`View ${item.vehicle_id}`} className={item.vehicle_id === vehicleId ? "selected" : ""} onClick={() => setVehicleId(item.vehicle_id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setVehicleId(item.vehicle_id)}>
            <td><span className="vehicle-dot" />{item.vehicle_id}</td><td>{item.distance_km.toFixed(1)} km</td><td>{minutes(item.moving_minutes)}</td><td>{item.stop_count}</td><td><span className={`quality ${item.data_quality_issues ? "warn" : "clean"}`}>{item.data_quality_issues ? `${item.data_quality_issues} FLAGS` : "CLEAR"}</span></td>
          </tr>)}
          {!shown.length && <tr><td colSpan={5} className="empty">No vehicles found for this day.</td></tr>}
        </tbody></table></div>
      </section>
      <section className="panel map-panel"><div className="panel-heading"><div><p className="eyebrow">VEHICLE DAY</p><h2>{vehicleId || "Select a vehicle"}</h2></div><div className="layer-controls"><label><input type="checkbox" checked={showService} onChange={(e) => setShowService(e.target.checked)} /> Service</label><label><input type="checkbox" checked={showRestricted} onChange={(e) => setShowRestricted(e.target.checked)} /> Restricted</label></div></div>
        <div className="map-wrap"><MapContainer center={center} zoom={13} scrollWheelZoom className="map">
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {zones?.features.filter((f: any) => f.properties.type === "service" ? showService : showRestricted).map((feature: any, i) => <GeoJSON key={`${feature.properties.zone_id}-${i}`} data={feature} style={{ color: feature.properties.type === "restricted" ? "#d9534f" : "#438f8a", fillOpacity: 0.13, weight: 2 }} />)}
          {coordinates.length > 1 && <Polyline positions={coordinates.map(([lon, lat]: number[]) => [lat, lon] as [number, number])} pathOptions={{ color: "#e6a845", weight: 4 }} />}
          {stops.map((stop, i) => <CircleMarker key={`${stop.start_time}-${i}`} center={[stop.lat, stop.lon]} radius={7} pathOptions={{ color: stop.restricted ? "#d9534f" : "#101c29", fillColor: stop.restricted ? "#d9534f" : "#f4c768", fillOpacity: 1 }}><Tooltip>{new Date(stop.start_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {stop.duration_minutes} min{stop.restricted ? " · RESTRICTED" : ""}</Tooltip></CircleMarker>)}
        </MapContainer></div>
        <div className="vehicle-stats"><span><small>MOVING</small><b>{selected ? minutes(selected.moving_minutes) : "—"}</b></span><span><small>STOPPED</small><b>{selected ? minutes(selected.stopped_minutes) : "—"}</b></span><span><small>RESTRICTED TIME</small><b>{selected ? minutes(Object.values(selected.restricted_minutes ?? {}).reduce((a, b) => a + b, 0)) : "—"}</b></span></div>
        <div className="timeline"><div className="timeline-title"><b>DAY TIMELINE</b><span>{stops.length} STOPS</span></div><div className="timeline-track">{stops.map((stop, i) => { const time = new Date(stop.start_time); const minute = time.getHours() * 60 + time.getMinutes(); return <div key={i} className={`timeline-stop ${stop.restricted ? "restricted" : ""}`} title={`${stop.duration_minutes} min`} style={{ left: `${minute / 14.4}%` }} />; })}</div></div>
      </section>
    </div>
    <div className="bottom-grid">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">DATA QUALITY</p><h2>Tracker health</h2></div><span className="count-pill">{anomalies.length} FLAGS</span></div>
        {types.length ? <div className="issue-list">{types.map(([type, count]) => <div className="issue-row" key={type}><span className="issue-icon">!</span><span><b>{type.replaceAll("_", " ")}</b><small>{new Set(anomalies.filter((a) => a.type === type).map((a) => a.vehicle_id).filter(Boolean)).size || "—"} vehicles affected</small></span><strong>{count}</strong></div>)}</div> : <p className="empty">No data-quality issues detected.</p>}
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">TRIP REVIEW</p><h2>Inefficient trips</h2></div><span className="count-pill">{inefficient.filter((trip) => trip.date === date).length} FLAGGED</span></div>
        {inefficient.filter((trip) => trip.date === date).length ? <div className="issue-list">{inefficient.filter((trip) => trip.date === date).map((trip, i) => <div className="issue-row" key={i}><span className="issue-icon amber-icon">↗</span><span><b>{trip.vehicle_id} · Trip {trip.trip_number}</b><small>{trip.reason}</small></span></div>)}</div> : <p className="empty">No trips met the review criteria.</p>}
      </section>
    </div>
    <footer>FLEETWATCH <span>GPS quality threshold ≤ 100 m · Stops ≥ 5 min · Route simplification 20 m</span></footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<OperationsDashboard />);
export { OperationsDashboard };

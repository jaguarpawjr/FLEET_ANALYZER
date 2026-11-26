import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleMarker, GeoJSON, MapContainer, Polyline, Popup, TileLayer, useMap } from "react-leaflet";
import type { FeatureCollection } from "geojson";
import { dashboardApi } from "./api.js";
import type { IssuePage, QualityIssue, QualitySummary, Stop, Summary, Trip, Vehicle } from "./api.js";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, BarChart3, CalendarDays, Check,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Database, Download, FileSearch,
  Filter, Gauge, Layers2, MapPin, Menu, Navigation, Route, Search, ShieldAlert, Truck, X
} from "lucide-react";
import { MetricCard } from "./MetricCard.js";
import "leaflet/dist/leaflet.css";
import "./style.css";

type Section = "overview" | "vehicle" | "quality" | "trips";
type SortKey = "vehicle_id" | "plate" | "depot" | "distance_km" | "moving_minutes" | "stop_count" | "highest_believable_speed_kmh" | "data_quality_issues";

const duration = (value?: number | null) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const totalMinutes = Math.round(value);
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
};
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const displayDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

function FitRoute({ points }: { points: [number, number][] }) {
  const map = useMap();
  const fit = () => {
    const valid = points.filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    if (valid.length > 1) map.fitBounds(valid, { padding: [24, 24], maxZoom: 15 });
    else if (valid.length === 1) map.setView(valid[0], 14);
  };
  useEffect(() => {
    fit();
  }, [map, points]);
  return <button type="button" className="map-fit-control" disabled={!points.length} onClick={fit}>Fit route</button>;
}
function parseRecord(value: string): Record<string, string> {
  try { return JSON.parse(value || "{}"); } catch { return {}; }
}
const stopZones = (stop: Stop) => Array.isArray(stop.zones) ? stop.zones.filter((zone): zone is string => typeof zone === "string") : [];

function OperationsDashboard() {
  const [section, setSection] = useState<Section>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [register, setRegister] = useState<Vehicle[]>([]);
  const [registerRowCount, setRegisterRowCount] = useState(0);
  const [fleet, setFleet] = useState<Summary[]>([]);
  const [zones, setZones] = useState<FeatureCollection | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [vehicleId, setVehicleId] = useState("");
  const [route, setRoute] = useState<FeatureCollection | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [selectedStop, setSelectedStop] = useState<Stop | null>(null);
  const [showService, setShowService] = useState(true);
  const [showRestricted, setShowRestricted] = useState(true);
  const [bootLoading, setBootLoading] = useState(true);
  const [fleetLoading, setFleetLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [depotFilter, setDepotFilter] = useState("");
  const [issueFilter, setIssueFilter] = useState(false);
  const [tripFilter, setTripFilter] = useState(false);
  const [tripSearch, setTripSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("distance_km");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [quality, setQuality] = useState<QualitySummary | null>(null);
  const [qualityError, setQualityError] = useState("");
  const [qualityLoading, setQualityLoading] = useState(false);
  const [issuePage, setIssuePage] = useState<IssuePage | null>(null);
  const [issueLoading, setIssueLoading] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [issueFilters, setIssueFilters] = useState({ severity: "", action: "", dataset: "", search: "", issueId: "" });
  const [issuePageNumber, setIssuePageNumber] = useState(1);
  const [openIssue, setOpenIssue] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      dashboardApi.dates(controller.signal),
      dashboardApi.register(controller.signal),
      dashboardApi.zones(controller.signal),
      dashboardApi.trips(controller.signal)
    ]).then(([availableDates, vehicleRegister, zoneData, inefficientTrips]) => {
      setDates(availableDates); setDate(availableDates[0] ?? "");
      setRegister(vehicleRegister.vehicles); setRegisterRowCount(vehicleRegister.registerRows);
      setZones(zoneData); setTrips(inefficientTrips);
      setVehicleId(vehicleRegister.vehicles[0]?.vehicle_id ?? "");
    }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load operations data"); })
      .finally(() => { if (!controller.signal.aborted) setBootLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!date) return;
    const controller = new AbortController();
    setFleetLoading(true); setError(""); setFleet([]);
    dashboardApi.fleet(date, controller.signal)
      .then((items) => {
        setFleet(items);
        setVehicleId((current) => items.some((item) => item.vehicle_id === current) ? current : items[0]?.vehicle_id ?? "");
      }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load fleet summary"); })
      .finally(() => { if (!controller.signal.aborted) setFleetLoading(false); });
    return () => controller.abort();
  }, [date]);

  useEffect(() => {
    if (!vehicleId || !date) { setRoute(null); setStops([]); return; }
    const controller = new AbortController();
    setDetailLoading(true); setRoute(null); setStops([]); setSelectedStop(null);
    Promise.all([
      dashboardApi.route(vehicleId, date, controller.signal),
      dashboardApi.stops(vehicleId, date, controller.signal)
    ]).then(([geo, stopData]) => {
      setRoute(geo); setStops(stopData); setSelectedStop(null);
    }).catch((e) => {
      if (!controller.signal.aborted) {
        setRoute({ type: "FeatureCollection", features: [] }); setStops([]);
        setError(e instanceof Error ? e.message : "Vehicle-day details are unavailable");
      }
    }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [vehicleId, date]);

  useEffect(() => {
    if (section !== "quality" || quality || qualityError) return;
    const controller = new AbortController();
    setQualityLoading(true);
    dashboardApi.qualitySummary(controller.signal)
      .then(setQuality)
      .catch((e) => { if (!controller.signal.aborted) setQualityError(e instanceof Error ? e.message : "Assessment report is unavailable"); })
      .finally(() => { if (!controller.signal.aborted) setQualityLoading(false); });
    return () => controller.abort();
  }, [section, quality, qualityError]);

  useEffect(() => {
    if (section !== "quality" || !quality) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(issuePageNumber), page_size: "20" });
    Object.entries(issueFilters).forEach(([key, value]) => {
      if (value) params.set(key === "issueId" ? "issue_id" : key, value);
    });
    setIssueLoading(true); setIssueError("");
    dashboardApi.qualityIssues(params, controller.signal)
      .then(setIssuePage)
      .catch((e) => { if (!controller.signal.aborted) setIssueError(e instanceof Error ? e.message : "Issue records are unavailable"); })
      .finally(() => { if (!controller.signal.aborted) setIssueLoading(false); });
    return () => controller.abort();
  }, [section, quality, issueFilters, issuePageNumber]);

  const tripsForDate = useMemo(() => trips.filter((trip) => trip.date === date), [trips, date]);
  const visibleTrips = useMemo(() => tripsForDate.filter((trip) => {
    if (!tripSearch) return true;
    const vehicle = register.find((item) => item.vehicle_id === trip.vehicle_id);
    return `${trip.vehicle_id} ${vehicle?.plate ?? ""} ${trip.reason}`.toLowerCase().includes(tripSearch.toLowerCase());
  }), [tripsForDate, tripSearch, register]);
  const visibleVehicles = useMemo(() => {
    const rows = register.map((vehicle) => ({ vehicle, summary: fleet.find((item) => item.vehicle_id === vehicle.vehicle_id) }));
    return rows.filter(({ vehicle, summary }) =>
      (!filter || `${vehicle.vehicle_id} ${vehicle.plate} ${vehicle.depot}`.toLowerCase().includes(filter.toLowerCase())) &&
      (!depotFilter || vehicle.depot === depotFilter) &&
      (!issueFilter || Boolean(summary?.data_quality_issues)) &&
      (!tripFilter || tripsForDate.some((trip) => trip.vehicle_id === vehicle.vehicle_id))
    ).sort((a, b) => {
      const left = sortKey === "vehicle_id" || sortKey === "plate" || sortKey === "depot"
        ? a.vehicle[sortKey] : a.summary?.[sortKey] ?? (sortDirection === "asc" ? Infinity : -Infinity);
      const right = sortKey === "vehicle_id" || sortKey === "plate" || sortKey === "depot"
        ? b.vehicle[sortKey] : b.summary?.[sortKey] ?? (sortDirection === "asc" ? Infinity : -Infinity);
      const comparison = typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right) : Number(left) - Number(right);
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [register, fleet, filter, depotFilter, issueFilter, tripFilter, tripsForDate, sortKey, sortDirection]);
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(visibleVehicles.length / pageSize));
  const pagedVehicles = visibleVehicles.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const activeVehicle = register.find((item) => item.vehicle_id === vehicleId);
  const activeSummary = fleet.find((item) => item.vehicle_id === vehicleId);
  const conflictCount = register.filter((vehicle) => vehicle.ambiguous).length;
  const routeFeatures = Array.isArray(route?.features) ? route.features : [];
  const routeFeature = routeFeatures.find((feature: any) => feature?.properties?.kind === "route") as any;
  const rawCoordinates = Array.isArray(routeFeature?.geometry?.coordinates) ? routeFeature.geometry.coordinates : [];
  const routeCoordinates = rawCoordinates.filter((point: unknown): point is [number, number] =>
    Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
    Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90
  );
  const routeLatLngs = routeCoordinates.map(([lon, lat]: [number, number]) => [lat, lon] as [number, number]);
  const usableStops = Array.isArray(stops) ? stops.filter((stop): stop is Stop =>
    Boolean(stop && typeof stop.start_time === "string" && Number.isFinite(Date.parse(stop.start_time)) &&
      typeof stop.end_time === "string" && Number.isFinite(Date.parse(stop.end_time)) && Number.isFinite(stop.duration_minutes))
  ) : [];
  const restrictedMinutes = Object.values(activeSummary?.restricted_minutes ?? {}).reduce((sum, value) => sum + value, 0);

  const navigate = (next: Section) => { setSection(next); setMobileNav(false); };
  const chooseVehicle = (id: string) => { setVehicleId(id); setSection("vehicle"); };
  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDirection((value) => value === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDirection(key === "vehicle_id" || key === "plate" || key === "depot" ? "asc" : "desc"); }
    setPage(1);
  };
  const formatSort = (key: SortKey, label: string) => <button className="sort-button" onClick={() => setSort(key)}>{label}{sortKey === key ? sortDirection === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : null}</button>;

  if (bootLoading) return <main className="startup-state"><div className="startup-brand"><span className="brand-icon"><Truck size={18} /></span> FLEETWATCH</div><div className="loading-line" /><p>Connecting to historical operations data…</p></main>;
  if (error && !dates.length) return <main className="startup-state error-state"><AlertTriangle size={25} /><h1>Operations data unavailable</h1><p>{error}</p><button className="button-primary" onClick={() => location.reload()}>Retry connection</button></main>;

  const navItems: { key: Section; label: string; icon: React.ReactNode }[] = [
    { key: "overview", label: "Fleet overview", icon: <BarChart3 size={17} /> },
    { key: "vehicle", label: "Vehicle analytics", icon: <Navigation size={17} /> },
    { key: "quality", label: "Data quality", icon: <ShieldAlert size={17} /> },
    { key: "trips", label: "Inefficient trips", icon: <Route size={17} /> }
  ];

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "nav-open" : ""}`}>
      <a className="brand-lockup" href="#" onClick={(event) => { event.preventDefault(); navigate("overview"); }}>
        <span className="brand-icon"><Truck size={19} strokeWidth={2.2} /></span><span>FLEETWATCH<small>OPERATIONS CONSOLE</small></span>
      </a>
      <div className="rail-caption">WORKSPACE</div>
      <nav aria-label="Primary navigation">
        {navItems.map((item) => <button key={item.key} className={`nav-item ${section === item.key ? "active" : ""}`} onClick={() => navigate(item.key)} aria-current={section === item.key ? "page" : undefined} aria-label={item.key === "trips" ? `${item.label}, ${trips.length} candidates` : item.label}>
          {item.icon}<span>{item.label}</span>{item.key === "trips" && <span className="nav-count" aria-hidden="true">{trips.length}</span>}
        </button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="rail-caption">DATA SOURCE</div>
        <div className="source-card"><Database size={15} /><div><b>Assessment dataset</b><span>17–19 Nov 2026 · cleaned</span></div></div>
        <div className="sidebar-foot">Fleetwatch / v1.0<br />Operations intelligence</div>
      </div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <main className="workspace">
      <header className="app-header">
        <button className="menu-toggle" aria-label={mobileNav ? "Close menu" : "Open menu"} onClick={() => setMobileNav((open) => !open)}>{mobileNav ? <X size={20} /> : <Menu size={20} />}</button>
        <div className="breadcrumb"><span>FLEET OPERATIONS</span><ChevronRight size={14} /><b>{navItems.find((item) => item.key === section)?.label}</b></div>
        <div className="header-right">
          <div className="history-badge"><span /> HISTORICAL <i>·</i> 17–19 NOV 2026</div>
          <label className="day-picker"><CalendarDays size={15} /><span className="sr-only">Analytics operating day</span>
            <select aria-label="Analytics operating day" value={date} onChange={(event) => setDate(event.target.value)}>{dates.map((day) => <option key={day} value={day}>{displayDate(day)}</option>)}</select><ChevronDown size={13} />
          </label>
        </div>
      </header>
      <div className="content">
        {error && <div className="alert-strip" role="alert"><AlertTriangle size={16} />{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></button></div>}
        {section === "overview" && <section>
          <div className="page-heading"><div><div className="eyebrow-line">GREATER ACCRA <span>/</span> OPERATING SNAPSHOT</div><h1>Fleet overview</h1><p className="page-description">A clear view of vehicles, utilization and operational exceptions.</p></div><div className="page-date"><span>SELECTED DAY</span><b>{date ? displayDate(date) : "—"}</b></div></div>
          <div className="provenance-banner"><span className="provenance-label"><Database size={15} /> ASSESSMENT SOURCE</span><span>Fleet analytics use the Part 1 cleaned pings and register with the root zone file. Selected day: <b>{date ? displayDate(date) : "—"}</b>.</span><button onClick={() => navigate("quality")}>Data quality <ArrowUpRight size={14} /></button></div>
          <div className="metric-row" aria-label="Selected day analytics">
            <MetricCard label="REGISTERED VEHICLES" value={register.length} detail="vehicles in analytics register" />
            <MetricCard label="VEHICLES REPORTING" value={fleet.length} detail={date ? `on ${displayDate(date)}` : "selected day"} />
            <MetricCard label="TOTAL DISTANCE" value={<>{fleet.reduce((sum, item) => sum + item.distance_km, 0).toFixed(1)} <em>km</em></>} detail="reported route distance" />
            <MetricCard label="REVIEW CANDIDATES" value={tripsForDate.length} detail="inefficient trips · selected day" warning={tripsForDate.length > 0} />
          </div>
          <div className="overview-grid">
            <section className="surface fleet-surface">
              <div className="surface-header"><div><div className="eyebrow-line">REGISTERED FLEET</div><h2>Vehicle performance</h2></div><span className="subtle-count">{visibleVehicles.length} vehicles</span></div>
              {registerRowCount !== register.length && <div className="register-note" role="note"><AlertTriangle size={15} /><span><b>{registerRowCount} source register rows</b> resolve to <b>{register.length} unique vehicle IDs</b>. {conflictCount} conflicting ID{conflictCount === 1 ? "" : "s"} retained for review; conflicting plate and depot values are withheld.</span></div>}
              <div className="filters-toolbar">
                <label className="search-field"><Search size={15} /><span className="sr-only">Search vehicles</span><input aria-label="Search vehicles" placeholder="Search ID, plate or depot" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }} /><kbd>⌘ K</kbd></label>
                <label className="filter-field"><span className="sr-only">Filter by depot</span><Filter size={14} /><select aria-label="Filter by depot" value={depotFilter} onChange={(event) => { setDepotFilter(event.target.value); setPage(1); }}><option value="">All depots</option>{[...new Set(register.map((vehicle) => vehicle.depot).filter(Boolean))].sort().map((depot) => <option key={depot}>{depot}</option>)}</select></label>
                <label className={`toggle-filter ${issueFilter ? "checked" : ""}`}><input type="checkbox" checked={issueFilter} onChange={(event) => { setIssueFilter(event.target.checked); setPage(1); }} /> Has issues</label>
                <label className={`toggle-filter ${tripFilter ? "checked" : ""}`}><input type="checkbox" checked={tripFilter} onChange={(event) => { setTripFilter(event.target.checked); setPage(1); }} /> Trip review</label>
              </div>
              <div className="table-scroll"><table className="fleet-table"><thead><tr>
                <th>{formatSort("vehicle_id", "VEHICLE")}</th><th>{formatSort("depot", "DEPOT")}</th><th>{formatSort("distance_km", "DISTANCE")}</th><th>{formatSort("moving_minutes", "MOVING / STOPPED")}</th><th>{formatSort("stop_count", "STOPS")}</th><th>{formatSort("highest_believable_speed_kmh", "TOP SPEED")}</th><th>QUALITY / TRIP</th>
              </tr></thead><tbody>
                {fleetLoading && <tr><td colSpan={7} className="table-message">Loading fleet metrics for {displayDate(date)}…</td></tr>}
                {!fleetLoading && pagedVehicles.map(({ vehicle, summary }) => {
                  const hasTrip = tripsForDate.some((trip) => trip.vehicle_id === vehicle.vehicle_id);
                  return <tr key={vehicle.vehicle_id} className={vehicle.vehicle_id === vehicleId ? "selected-row" : ""} onClick={() => chooseVehicle(vehicle.vehicle_id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseVehicle(vehicle.vehicle_id); } }} tabIndex={0} aria-label={`View analytics for ${vehicle.vehicle_id}`}>
                    <td><span className="table-vehicle-icon"><Truck size={15} /></span><span className="vehicle-identity"><b>{vehicle.vehicle_id}</b><small>{vehicle.ambiguous ? `Register conflict · rows ${vehicle.source_rows.map((row) => `#${row}`).join(", ")}` : vehicle.plate || "No plate listed"}</small></span></td>
                    <td>{vehicle.ambiguous ? <span className="conflict-label">Conflicting depots</span> : vehicle.depot || "—"}</td><td className="number-cell">{summary ? `${summary.distance_km.toFixed(1)} km` : "—"}</td>
                    <td>{summary ? <div className="movement-cell"><span>{duration(summary.moving_minutes)} <i>moving</i></span><div className="movement-track"><span style={{ width: `${summary.moving_minutes + summary.stopped_minutes ? summary.moving_minutes / (summary.moving_minutes + summary.stopped_minutes) * 100 : 0}%` }} /></div><small>{duration(summary.stopped_minutes)} stopped</small></div> : <span className="missing-state">No day summary</span>}</td>
                    <td className="number-cell">{summary?.stop_count ?? "—"}</td><td className="number-cell">{summary?.highest_believable_speed_kmh == null ? "—" : `${summary.highest_believable_speed_kmh.toFixed(0)} km/h`}</td>
                    <td><div className="status-stack"><span className={`status-chip ${summary?.data_quality_issues ? "review" : summary ? "healthy" : "neutral"}`}>{summary ? summary.data_quality_issues ? `${summary.data_quality_issues} FLAGS` : "CLEAR" : "NO DAY DATA"}</span>{hasTrip && <span className="status-chip trip-chip">TRIP REVIEW</span>}</div></td>
                  </tr>;
                })}
                {!fleetLoading && !pagedVehicles.length && <tr><td colSpan={7} className="empty-row"><FileSearch size={22} /><b>No vehicles match these filters</b><span>Adjust your search or clear a filter to continue.</span></td></tr>}
              </tbody></table></div>
              <div className="table-footer"><span>Showing {visibleVehicles.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, visibleVehicles.length)} of {visibleVehicles.length} registered vehicles</span><div className="pagination"><button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>Page {page} of {pageCount}</span><button aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={15} /></button></div></div>
            </section>
            <section className="surface activity-surface">
              <div className="surface-header"><div><div className="eyebrow-line">DISTANCE DISTRIBUTION</div><h2>Movement by vehicle</h2></div><span className="chart-unit">KM</span></div>
              <div className="bar-chart">
                {fleet.length ? fleet.slice().sort((a, b) => b.distance_km - a.distance_km).map((summary) => {
                  const vehicle = register.find((item) => item.vehicle_id === summary.vehicle_id);
                  const max = Math.max(...fleet.map((item) => item.distance_km), 1);
                  const movingRatio = summary.moving_minutes + summary.stopped_minutes ? summary.moving_minutes / (summary.moving_minutes + summary.stopped_minutes) : 0;
                  return <button key={summary.vehicle_id} className={`bar-row ${summary.vehicle_id === vehicleId ? "bar-selected" : ""}`} onClick={() => chooseVehicle(summary.vehicle_id)} aria-label={`${summary.vehicle_id}: ${summary.distance_km.toFixed(1)} kilometers`}>
                    <span className="bar-label">{vehicle?.vehicle_id ?? summary.vehicle_id}</span><span className="bar-track"><i style={{ width: `${Math.max(3, summary.distance_km / max * 100)}%` }} /></span><b>{summary.distance_km.toFixed(1)}</b><small>{Math.round(movingRatio * 100)}% moving</small>
                  </button>;
                }) : <div className="chart-empty"><BarChart3 size={22} /><span>No distance records for this day</span></div>}
              </div>
              <div className="chart-legend"><span><i className="legend-teal" />Distance covered</span><span><i className="legend-amber" />Review candidate</span></div>
              <div className="activity-note"><Gauge size={16} /><span>Highest believable speed is derived from retained analytics pings. A dash indicates no day summary is available.</span></div>
            </section>
          </div>
        </section>}

        {section === "vehicle" && <section>
          <div className="page-heading vehicle-page-heading"><div><button className="back-link" onClick={() => navigate("overview")}><ArrowLeft size={14} /> Fleet overview</button><div className="eyebrow-line">VEHICLE DAY <span>/</span> {date ? displayDate(date) : ""}</div><h1>{activeVehicle?.vehicle_id ?? (vehicleId || "Select a vehicle")}</h1><p className="page-description">{activeVehicle?.ambiguous ? `Register conflict · source rows ${activeVehicle.source_rows.map((row) => `#${row}`).join(", ")} · plate and depot withheld` : activeVehicle?.plate ?? "Vehicle analytics"}{activeVehicle?.depot && !activeVehicle.ambiguous ? ` · Based at ${activeVehicle.depot}` : ""}</p></div>
            <label className="vehicle-select-label">SELECT VEHICLE<select aria-label="Select vehicle" value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>{register.map((vehicle) => <option key={vehicle.vehicle_id} value={vehicle.vehicle_id}>{vehicle.vehicle_id} · {vehicle.ambiguous ? "Register conflict" : vehicle.plate}</option>)}</select></label>
          </div>
          <div className="vehicle-stat-strip">
            <div><span>DISTANCE</span><b>{activeSummary ? `${activeSummary.distance_km.toFixed(1)} km` : "No day data"}</b></div><div><span>MOVING TIME</span><b>{duration(activeSummary?.moving_minutes)}</b></div><div><span>STOPPED TIME</span><b>{duration(activeSummary?.stopped_minutes)}</b></div><div><span>STOPS RECORDED</span><b>{activeSummary?.stop_count ?? "—"}</b></div><div><span>RESTRICTED ZONE</span><b>{duration(restrictedMinutes)}</b></div>
          </div>
          <div className="vehicle-detail-grid">
            <section className="surface map-surface">
              <div className="surface-header map-heading"><div><div className="eyebrow-line">ROUTE AND SERVICE AREAS</div><h2>{activeVehicle?.vehicle_id ?? "Vehicle route"} <span className="muted-title">· {date}</span></h2></div><div className="layer-switches">
                <label><input type="checkbox" checked={showService} onChange={(event) => setShowService(event.target.checked)} /><i className="swatch service-swatch" />Service zones</label>
                <label><input type="checkbox" checked={showRestricted} onChange={(event) => setShowRestricted(event.target.checked)} /><i className="swatch restricted-swatch" />Restricted</label>
              </div></div>
              <div className="map-frame">
                <MapContainer center={[5.56, -0.2]} zoom={12} scrollWheelZoom className="fleet-map" aria-label="Vehicle route map">
                  <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <FitRoute points={routeLatLngs} />
                  {(Array.isArray(zones?.features) ? zones.features : []).filter((feature: any) =>
                    (feature.properties?.type === "service" ? showService : showRestricted) &&
                    feature.geometry?.type === "Polygon" && Array.isArray(feature.geometry?.coordinates) &&
                    feature.geometry.coordinates.length > 0 && feature.geometry.coordinates.every((ring: any) =>
                      Array.isArray(ring) && ring.length >= 4 && ring.every((point: any) =>
                        Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) &&
                        Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90
                      )
                    )
                  ).map((feature: any, index) => <GeoJSON key={`${feature.properties?.zone_id ?? "zone"}-${index}`} data={feature} style={{ color: feature.properties?.type === "restricted" ? "#a9473d" : "#43827a", fillColor: feature.properties?.type === "restricted" ? "#c76d5e" : "#5c9e8d", fillOpacity: 0.12, weight: 1.5 }} />)}
                  {routeLatLngs.length > 1 && <Polyline positions={routeLatLngs} pathOptions={{ color: "#177d75", weight: 4, opacity: .9 }} />}
                  {usableStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)).map((stop, index) => <CircleMarker key={`${stop.start_time}-${index}`} center={[stop.lat, stop.lon]} radius={selectedStop === stop ? 8 : 6} pathOptions={{ color: stop.restricted ? "#a9473d" : "#fff", weight: 2, fillColor: stop.restricted ? "#c35f4f" : "#dfa947", fillOpacity: 1 }} eventHandlers={{ click: () => setSelectedStop(stop) }}><Popup><b>{time(stop.start_time)} – {time(stop.end_time)}</b><br />{stop.duration_minutes} min stop<br />{stop.in_own_depot_area ? "Own depot area" : stop.restricted ? "Restricted area" : stopZones(stop).join(", ") || "Outside named zones"}</Popup></CircleMarker>)}
                </MapContainer>
                {detailLoading && <div className="map-loading"><span className="spinner" /> Loading route…</div>}
                {!detailLoading && route && !routeLatLngs.length && <div className="map-empty"><MapPin size={20} /><b>No route geometry for this vehicle-day</b><span>The analytics source returned no usable route points.</span></div>}
              </div>
              <div className="map-caption"><span><i className="legend-teal" /> Vehicle route</span><span><i className="legend-amber" /> Stop location</span><span><i className="legend-red" /> Restricted stop</span><small>© OpenStreetMap contributors</small></div>
            </section>
            <section className="surface stops-surface"><div className="surface-header"><div><div className="eyebrow-line">ACTIVITY LOG</div><h2>Recorded stops <span className="subtle-count">{usableStops.length}</span></h2></div><Clock3 size={18} className="muted-icon" /></div>
              {usableStops.length ? <><div className="stop-table-scroll"><table className="stop-table"><thead><tr><th>TIME</th><th>ZONE / STATUS</th><th>LOCATION</th><th>DURATION</th></tr></thead><tbody>{usableStops.map((stop, index) => <tr key={`${stop.start_time}-${index}`} className={selectedStop === stop ? "stop-table-selected" : ""}>
                <td><button className="stop-time-button" onClick={() => setSelectedStop(stop)} aria-pressed={selectedStop === stop}>{time(stop.start_time)}<small>to {time(stop.end_time)}</small></button></td>
                <td><button className="stop-area-button" onClick={() => setSelectedStop(stop)} aria-pressed={selectedStop === stop}><span className={`stop-dot ${stop.restricted ? "dot-red" : stop.in_own_depot_area ? "dot-teal" : ""}`} /><b>{stop.in_own_depot_area ? "Own depot area" : stop.restricted ? "Restricted zone" : stopZones(stop).length ? stopZones(stop).join(", ") : "Unclassified stop"}</b><small>{stop.restricted ? "Restricted" : stop.in_own_depot_area ? "Own depot" : stopZones(stop).length ? "Service zone" : "No named zone"}</small></button></td>
                <td>{Number.isFinite(stop.lat) && Number.isFinite(stop.lon) ? `${stop.lat.toFixed(4)}, ${stop.lon.toFixed(4)}` : "Location unavailable"}</td><td className="stop-table-duration">{stop.duration_minutes}<small>MIN</small></td>
              </tr>)}</tbody></table></div>{selectedStop && <div className="stop-detail"><b>Selected stop</b><span>{selectedStop.in_own_depot_area ? "Within own depot service area" : selectedStop.restricted ? "Within restricted zone" : "No restricted classification"}</span><small>{stopZones(selectedStop).length ? stopZones(selectedStop).join(" · ") : "No named zone reported"}</small></div>}</>
                : <div className="panel-empty"><Clock3 size={20} /><b>No stops recorded</b><span>No qualifying stop events are available for this vehicle-day.</span></div>}
            </section>
          </div>
          <section className="surface day-timeline-surface"><div className="surface-header"><div><div className="eyebrow-line">24-HOUR ACTIVITY</div><h2>Day timeline</h2></div><span className="subtle-count">{usableStops.length} stop events</span></div><div className="day-track-wrap"><div className="day-track">{usableStops.map((stop, index) => { const start = new Date(stop.start_time); const minute = start.getHours() * 60 + start.getMinutes(); return <button key={`${stop.start_time}-${index}`} className={`day-marker ${stop.restricted ? "marker-restricted" : ""}`} style={{ left: `${minute / 1440 * 100}%` }} title={`${time(stop.start_time)} · ${stop.duration_minutes} minutes`} aria-label={`Select stop at ${time(stop.start_time)}`} onClick={() => setSelectedStop(stop)} />; })}</div><div className="day-hours"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div></section>
        </section>}

        {section === "quality" && <section>
          <div className="page-heading"><div><div className="eyebrow-line">ASSESSMENT REPORT <span>/</span> PART 1</div><h1>Data quality</h1><p className="page-description">A traceable view of source-record fixes, flags and rejects.</p></div><div className="assessment-stamp"><span>ASSESSMENT PERIOD</span><b>17–19 Nov 2026</b></div></div>
          <div className="provenance-banner quality-banner"><span className="provenance-label"><Database size={15} /> PART 1 CLEANING</span><span>Quality findings and fleet analytics refer to the same <b>17–19 Nov 2026</b> assessment inputs. Source: root Part 1 outputs.</span><code>data_quality_summary.json</code></div>
          {qualityLoading && <div className="section-state"><span className="spinner" /> Loading assessment report…</div>}
          {qualityError && <div className="dependency-state" role="alert"><AlertTriangle size={22} /><div><b>Assessment output unavailable</b><span>{qualityError}</span><small>Run the data-cleaning pipeline to produce the summary and issue files. No substitute counts are shown.</small></div></div>}
          {quality && <>
            <div className="quality-kpis">
              <MetricCard label="PROCESSED PINGS" value={quality.processed?.toLocaleString() ?? "—"} detail="retained in cleaned output" />
              <MetricCard label="UNIQUE RECORDS AFFECTED" value={quality.uniquelyAffected?.toLocaleString() ?? "—"} detail="distinct source rows · any issue" warning />
              <MetricCard label="FIXED" value={quality.fixed?.toLocaleString() ?? "—"} detail="rows with a correction" />
              <MetricCard label="REJECTED" value={quality.rejected?.toLocaleString() ?? "—"} detail="rows excluded from clean output" warning />
              <MetricCard label="FLAGGED" value={quality.flagged?.toLocaleString() ?? "—"} detail="retained for review" warning />
            </div>
            <div className="quality-note"><CircleHelp size={15} /><span>Fixed, rejected and flagged totals can overlap. Unique affected records is the deduplicated source-row count; issue-reference counts are not unique people or records.</span><b>{quality.issueReferences?.toLocaleString() ?? "—"} issue references</b></div>
            <div className="quality-grid">
              <section className="surface category-surface"><div className="surface-header"><div><div className="eyebrow-line">ISSUE REGISTER</div><h2>Issue categories <span className="subtle-count">{quality.issues.length}</span></h2></div><span className="chart-unit">REFERENCES BY CATEGORY</span></div>
                <div className="category-list">{quality.issues.slice().sort((a, b) => b.affectedRows - a.affectedRows).map((item) => {
                  const max = Math.max(...quality.issues.map((issue) => issue.affectedRows), 1);
                  return                                     <button key={item.issueId} className="category-row" onClick={() => { setIssueFilters((current) => ({ ...current, search: "", action: "", severity: "", dataset: "", issueId: item.issueId })); setIssuePageNumber(1); }}>
                    <span className="category-main"><b>{item.issueName}</b><small>{item.issueId} · {item.dataset}</small></span><span className="category-meter"><i style={{ width: `${Math.max(2, item.affectedRows / max * 100)}%` }} /></span><span className="category-count">{item.affectedRows.toLocaleString()}<small>refs</small></span><span className={`severity-chip severity-${item.severity.toLowerCase()}`}>{item.severity}</span>
                  </button>;
                })}</div>
              </section>
              <section className="surface integrity-surface"><div className="surface-header"><div><div className="eyebrow-line">RECONCILIATION</div><h2>Rows accounted for</h2></div><Check size={18} className="integrity-icon" /></div><p>Counts below come from the assessment summary. A source row may be corrected and flagged at the same time.</p>
                <div className="integrity-line"><span>Source pings</span><b>{quality.sourcePings?.toLocaleString() ?? "—"}</b></div><div className="integrity-line"><span>Cleaned pings</span><b>{quality.processed?.toLocaleString() ?? "—"}</b></div><div className="integrity-line"><span>Rejected pings</span><b>{quality.rejected?.toLocaleString() ?? "—"}</b></div><div className={`integrity-check ${quality.allChecksPassed ? "" : "integrity-failed"}`}><Check size={14} /> {quality.allChecksPassed ? "Input and output reconciliation passed" : "One or more assessment checks did not pass"}</div>
              </section>
            </div>
            <section className="surface issue-table-surface"><div className="surface-header"><div><div className="eyebrow-line">SOURCE ROW DRILLDOWN</div><h2>Issue records</h2></div><span className="subtle-count">{issuePage?.total.toLocaleString() ?? "—"} matching records</span></div>
              <div className="issue-filters">
                <label><span>SEVERITY</span><select aria-label="Filter issue severity" value={issueFilters.severity} onChange={(event) => { setIssueFilters((current) => ({ ...current, severity: event.target.value })); setIssuePageNumber(1); }}><option value="">All levels</option>{["Critical", "High", "Medium", "Low"].map((item) => <option key={item}>{item}</option>)}</select></label>
                <label><span>ACTION</span><select aria-label="Filter issue action" value={issueFilters.action} onChange={(event) => { setIssueFilters((current) => ({ ...current, action: event.target.value })); setIssuePageNumber(1); }}><option value="">All actions</option>{["FIX", "DROP", "FLAG"].map((item) => <option key={item}>{item}</option>)}</select></label>
                <label><span>DATASET</span><select aria-label="Filter issue dataset" value={issueFilters.dataset} onChange={(event) => { setIssueFilters((current) => ({ ...current, dataset: event.target.value })); setIssuePageNumber(1); }}><option value="">All sources</option><option value="pings.csv">pings.csv</option><option value="vehicles.csv">vehicles.csv</option></select></label>
                <label className="issue-search"><span className="sr-only">Search issue source row or vehicle ID</span><Search size={14} /><input aria-label="Search issue source row or vehicle ID" placeholder="Search vehicle ID, source row or reason" value={issueFilters.search} onChange={(event) => { setIssueFilters((current) => ({ ...current, search: event.target.value })); setIssuePageNumber(1); }} /></label>
              </div>
              {issueError && <div className="inline-panel-error" role="alert">{issueError}</div>}
              <div className="table-scroll"><table className="issue-table"><thead><tr><th>SOURCE ROW</th><th>VEHICLE / ISSUE</th><th>SEVERITY</th><th>ACTION</th><th>REASON</th><th>DETAIL</th></tr></thead><tbody>
                {issueLoading ? <tr><td colSpan={6} className="table-message">Loading issue records…</td></tr>
                  : issuePage?.items.map((item, index) => {
                    const original = parseRecord(item.original_record);
                    const key = `${item.issue_id}-${item.source_row}-${index}`;
                    return <React.Fragment key={key}><tr className="issue-data-row">
                      <td><b>#{item.source_row}</b><small>{item.dataset}</small></td><td><b>{original.vehicle_id || "Register row"}</b><small>{item.issue_id} · {item.issue_name}</small></td><td><span className={`severity-chip severity-${item.severity.toLowerCase()}`}>{item.severity}</span></td><td><span className={`action-chip action-${item.action.toLowerCase()}`}>{item.action}</span></td><td className="reason-cell">{item.reason}</td><td><button className="expand-button" aria-expanded={openIssue === key} aria-label={`${openIssue === key ? "Hide" : "View"} details for source row ${item.source_row}`} onClick={() => setOpenIssue(openIssue === key ? null : key)}><ChevronDown size={15} /></button></td>
                    </tr>{openIssue === key && <tr className="issue-detail-row"><td colSpan={6}><div className="record-detail"><div><b>Original record</b><pre>{JSON.stringify(original, null, 2)}</pre></div><div><b>Corrected record</b><pre>{item.corrected_record ? JSON.stringify(parseRecord(item.corrected_record), null, 2) : "No corrected record — this source row was not retained."}</pre></div><p><strong>Reason</strong>{item.reason}{item.details ? <><br /><strong>Details</strong>{item.details}</> : ""}</p></div></td></tr>}</React.Fragment>;
                  })}
                {!issueLoading && !issueError && !issuePage?.items.length && <tr><td colSpan={6} className="table-message">No issue records match the selected filters.</td></tr>}
              </tbody></table></div>
              <div className="table-footer"><span>Showing {issuePage?.items.length ?? 0} of {issuePage?.total.toLocaleString() ?? 0} filtered source records</span><div className="pagination"><button aria-label="Previous issue page" disabled={issuePageNumber <= 1} onClick={() => setIssuePageNumber((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>Page {issuePageNumber} of {Math.max(1, Math.ceil((issuePage?.total ?? 0) / 20))}</span><button aria-label="Next issue page" disabled={issuePageNumber >= Math.ceil((issuePage?.total ?? 0) / 20)} onClick={() => setIssuePageNumber((value) => value + 1)}><ChevronRight size={15} /></button></div></div>
            </section>
          </>}
        </section>}

        {section === "trips" && <section>
          <div className="page-heading"><div><div className="eyebrow-line">OPERATIONS REVIEW <span>/</span> CLEANED ASSESSMENT</div><h1>Inefficient trips</h1><p className="page-description">Trip candidates returned by the existing analytics rule.</p></div><div className="review-summary"><span>SELECTED DAY</span><b>{visibleTrips.length} <small>candidates</small></b></div></div>
          <div className="provenance-banner"><span className="provenance-label"><CircleHelp size={15} /> CURRENT RULE</span><span>Only records returned by <code>/inefficient-trips</code> are shown. The analytics rule flags trips over 60 minutes and under 5 km; no alternative candidates are inferred.</span></div>
          <section className="surface trip-surface"><div className="surface-header"><div><div className="eyebrow-line">TRIP REGISTER</div><h2>{date ? displayDate(date) : "Selected day"} <span className="subtle-count">{visibleTrips.length} records</span></h2></div><div className="trip-controls"><label className="trip-date-filter"><CalendarDays size={15} /><select aria-label="Filter trips by date" value={date} onChange={(event) => setDate(event.target.value)}>{dates.map((day) => <option key={day} value={day}>{displayDate(day)}</option>)}</select></label><label className="trip-search"><Search size={14} /><span className="sr-only">Search trips</span><input aria-label="Search trips" placeholder="Search vehicle or reason" value={tripSearch} onChange={(event) => setTripSearch(event.target.value)} /></label></div></div>
            {visibleTrips.length ? <div className="table-scroll"><table className="trip-table"><thead><tr><th>VEHICLE</th><th>DATE</th><th>DISTANCE</th><th>DURATION</th><th>STOPS</th><th>CLASSIFICATION</th><th>REASON</th><th /></tr></thead><tbody>{visibleTrips.map((trip) => {
              const vehicle = register.find((item) => item.vehicle_id === trip.vehicle_id);
              return <tr key={`${trip.vehicle_id}-${trip.date}-${trip.trip_number}`}><td><b>{vehicle?.ambiguous ? "Register conflict" : vehicle?.plate || trip.vehicle_id}</b><small>{trip.vehicle_id} · Trip {trip.trip_number}</small></td><td>{displayDate(trip.date)}</td><td>{trip.distance_km.toFixed(2)} km</td><td>{duration(trip.duration_minutes)}</td><td>{trip.stop_count}</td><td><span className="status-chip review">INEFFICIENT</span></td><td className="reason-cell">{trip.reason}</td><td><button className="row-link" onClick={() => { setDate(trip.date); chooseVehicle(trip.vehicle_id); }} aria-label={`Open ${trip.vehicle_id} analytics for ${trip.date}`}><ArrowUpRight size={15} /></button></td></tr>;
            })}</tbody></table></div> : <div className="trip-empty"><span className="empty-check"><Check size={20} /></span><b>No inefficient trips returned</b><p>The API returned no candidates for this operating day. No additional trips are inferred.</p></div>}
          </section>
        </section>}
      </div>
      <footer className="workspace-footer"><span>FLEETWATCH OPERATIONS</span><span>Source context is labeled by report. Historical data only.</span></footer>
    </main>
  </div>;
}

const rootElement = document.getElementById("root");
const appGlobal = globalThis as typeof globalThis & { fleetwatchRoot?: ReturnType<typeof createRoot> };
if (rootElement) {
  appGlobal.fleetwatchRoot ??= createRoot(rootElement);
  appGlobal.fleetwatchRoot.render(<OperationsDashboard />);
}
export { OperationsDashboard };

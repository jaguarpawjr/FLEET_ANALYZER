import { haversineKm } from "../core.js";
import type {
  CleanedRecord,
  CleanResult,
  Dataset,
  IssueDefinition,
  IssueEvent,
  IssueSummary
} from "./types.js";

type WorkRecord = CleanedRecord & { events: Map<string, IssueEvent> };
type PingMeta = {
  work: WorkRecord;
  timestampMs: number | null;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
};

const GHANA_BOUNDS = { minLat: 4, maxLat: 12, minLon: -4, maxLon: 2 };
const EXPECTED_START = Date.UTC(2026, 10, 17);
const EXPECTED_END = Date.UTC(2026, 10, 20);
const MAX_TRUCK_SPEED_KMH = 160;
const MAX_ACCURACY_METERS = 100;
const MAX_JUMP_INTERVAL_SECONDS = 30 * 60;
const MAX_REPORTING_INTERVAL_SECONDS = 90;

const DEFINITIONS: IssueDefinition[] = [
  {
    id: "DQ-001", name: "Missing vehicle identifier", dataset: "pings.csv", columns: ["vehicle_id"],
    discovery: "An empty tracker identifier prevents linking a ping to the official vehicle register.",
    severity: "High", decision: "DROP", rule: "Drop records whose trimmed vehicle_id is empty.",
    justification: "Vehicle identity is required for vehicle-level analytics and cannot be inferred safely.",
    impact: "Unassigned pings could be attributed to the wrong vehicle or contaminate fleet metrics.",
    verification: "Reconcile source rows with clean and dropped row counts; require every retained ID to match the register."
  },
  {
    id: "DQ-002", name: "Vehicle identifier whitespace or casing", dataset: "pings.csv", columns: ["vehicle_id"],
    discovery: "Identifiers with surrounding whitespace or noncanonical casing were compared with the official register.",
    severity: "Low", decision: "FIX", rule: "Trim surrounding whitespace and convert identifiers to uppercase.",
    justification: "Case and whitespace normalization is unambiguous and leaves the register mapping unchanged.",
    impact: "Without normalization, valid pings may be treated as unknown vehicles or split across IDs.",
    verification: "Every retained identifier is compared against the canonical official ID set."
  },
  {
    id: "DQ-003", name: "Vehicle identifier missing separator", dataset: "pings.csv", columns: ["vehicle_id"],
    discovery: "The `GT` prefix and four-digit vehicle number appeared without the register's hyphen.",
    severity: "Medium", decision: "FIX", rule: "Convert only `GTdddd` to `GT-dddd`, then require an exact official-register match.",
    justification: "The four-digit value maps unambiguously to the corresponding formatted register ID.",
    impact: "Unnormalized IDs can be incorrectly rejected or fragmented in per-vehicle summaries.",
    verification: "Check canonical IDs against the register after normalization."
  },
  {
    id: "DQ-004", name: "Vehicle identifier absent from official register", dataset: "pings.csv", columns: ["vehicle_id"],
    discovery: "A syntactically valid tracker ID did not resolve to any identifier in vehicles.csv.",
    severity: "High", decision: "DROP", rule: "Drop pings whose normalized vehicle_id is absent from the official register.",
    justification: "The reference register is authoritative; there is no safe vehicle mapping for an unknown ID.",
    impact: "Unknown pings would create unregistered vehicle reporting and unreliable asset attribution.",
    verification: "Assert every retained ping ID is in the canonical register identifier set."
  },
  {
    id: "DQ-005", name: "Missing timestamp", dataset: "pings.csv", columns: ["timestamp"],
    discovery: "A blank timestamp cannot place a ping in a vehicle's time series.",
    severity: "High", decision: "DROP", rule: "Drop records with an empty timestamp.",
    justification: "Time ordering, interval speeds, and date-level analytics require a timestamp.",
    impact: "A timeless coordinate can corrupt route order and distance calculations.",
    verification: "Require every retained timestamp to parse and normalize to UTC."
  },
  {
    id: "DQ-006", name: "Unparseable timestamp", dataset: "pings.csv", columns: ["timestamp"],
    discovery: "The timestamp did not match a supported ISO-8601, day/month/year, or Unix-seconds representation.",
    severity: "High", decision: "DROP", rule: "Drop timestamps that cannot be parsed strictly to a valid instant.",
    justification: "The original timestamp does not provide a defensible time value.",
    impact: "Unparseable times can break sequence ordering, trip boundaries, and interval calculations.",
    verification: "All retained values must be valid UTC ISO-8601 timestamps."
  },
  {
    id: "DQ-007", name: "Timestamp outside assessment period", dataset: "pings.csv", columns: ["timestamp"],
    discovery: "A parseable timestamp fell outside 17–19 November 2026 after conversion to UTC.",
    severity: "High", decision: "DROP", rule: "Keep only UTC instants in [2026-11-17T00:00:00Z, 2026-11-20T00:00:00Z).",
    justification: "The assessment defines this three-day period; out-of-period rows are not part of the target dataset.",
    impact: "Extraneous times can inflate reporting periods and create enormous false movement intervals.",
    verification: "Assert every retained UTC timestamp falls within the documented half-open interval."
  },
  {
    id: "DQ-008", name: "Timestamp format or timezone normalization", dataset: "pings.csv", columns: ["timestamp"],
    discovery: "Parseable timestamps used Unix seconds, explicit non-UTC offsets, or day/month/year notation.",
    severity: "Medium", decision: "FIX", rule: "Parse supported timestamp formats, treat timezone-naive values as UTC (Ghana), and serialize as UTC ISO-8601.",
    justification: "The source context states UTC/Ghana; explicit offsets are converted to UTC rather than discarded.",
    impact: "Mixed representations can break sorting, joins, and date grouping.",
    verification: "Retained timestamps use canonical `YYYY-MM-DDTHH:mm:ss.sssZ` serialization and parse to the original instant."
  },
  {
    id: "DQ-009", name: "Missing coordinate component", dataset: "pings.csv", columns: ["lat", "lon"],
    discovery: "A missing latitude or longitude leaves an incomplete GPS coordinate pair.",
    severity: "High", decision: "DROP", rule: "Drop a ping if either trimmed coordinate field is empty.",
    justification: "A point cannot be located or used in distance calculations with only one coordinate.",
    impact: "Partial coordinates would cause invalid spatial calculations or misleading map positions.",
    verification: "Every retained row must have a complete numeric coordinate pair."
  },
  {
    id: "DQ-010", name: "Decimal-comma coordinates", dataset: "pings.csv", columns: ["lat", "lon"],
    discovery: "Coordinates used a single comma as the decimal separator.",
    severity: "Medium", decision: "FIX", rule: "Replace a comma with a decimal point only for a coordinate matching a signed decimal-comma number.",
    justification: "The observed coordinate form is unambiguous and the resulting value is checked against geographic bounds.",
    impact: "Unparsed coordinates can be dropped or incorrectly interpreted during spatial analysis.",
    verification: "Confirm the normalized pair parses numerically and is within the accepted Ghana bounds."
  },
  {
    id: "DQ-011", name: "Latitude and longitude reversed", dataset: "pings.csv", columns: ["lat", "lon"],
    discovery: "A coordinate pair was outside Ghana in its supplied order but inside Ghana when latitude and longitude were exchanged.",
    severity: "High", decision: "FIX", rule: "Swap the pair only when the original is outside the Ghana bounds and the reversed pair is inside them.",
    justification: "The bounded geographic context makes this correction unambiguous for the observed records.",
    impact: "Uncorrected axis order can place a vehicle on another continent and produce impossible route distances.",
    verification: "Recheck corrected coordinates against WGS 84 ranges and Ghana bounds."
  },
  {
    id: "DQ-012", name: "Zero, invalid, or out-of-area coordinates", dataset: "pings.csv", columns: ["lat", "lon"],
    discovery: "The pair was not a usable location in the expected Ghana operating area, including zero-coordinate defaults.",
    severity: "High", decision: "DROP", rule: "After decimal and axis-order repairs, drop nonnumeric, WGS 84-invalid, zero, or out-of-Ghana pairs.",
    justification: "No reliable location can be recovered from these observations using the available source data.",
    impact: "Bad positions can create false trips, extreme distances, and misleading spatial summaries.",
    verification: "Assert every retained pair is nonzero, WGS 84-valid, and inside the documented Ghana bounds."
  },
  {
    id: "DQ-013", name: "Exact duplicate GPS reading", dataset: "pings.csv",
    columns: ["vehicle_id", "timestamp", "lat", "lon", "speed_kmh", "accuracy_m"],
    discovery: "The same normalized six-field GPS record occurred more than once.",
    severity: "Medium", decision: "DROP", rule: "Keep the earliest source record for each identical normalized record and drop later copies.",
    justification: "An identical repeat adds no new observation; preserving the first occurrence is deterministic.",
    impact: "Duplicates inflate ping counts and can produce zero-duration segments or bias reporting intervals.",
    verification: "Confirm there is one retained row per exact normalized record and each removed copy is listed in rejects.csv."
  },
  {
    id: "DQ-014", name: "Conflicting readings at the same vehicle and timestamp", dataset: "pings.csv",
    columns: ["vehicle_id", "timestamp", "lat", "lon", "speed_kmh", "accuracy_m"],
    discovery: "Distinct readings for one normalized vehicle and instant cannot be ordered reliably.",
    severity: "High", decision: "FLAG", rule: "Retain all non-identical readings sharing a vehicle and UTC timestamp and flag every member.",
    justification: "Without an authoritative tie-breaker, selecting or deleting one reading would be arbitrary.",
    impact: "Same-time conflicting positions can create ambiguous routes and distance calculations.",
    verification: "Check flagged entries remain in pings_clean.csv and are listed in data_quality_issues.csv."
  },
  {
    id: "DQ-015", name: "Missing speed measurement", dataset: "pings.csv", columns: ["speed_kmh"],
    discovery: "Speed was blank or whitespace-only.",
    severity: "Low", decision: "FLAG", rule: "Retain the ping with an empty speed and attach a missing-speed quality issue.",
    justification: "A missing speed does not invalidate its timestamp or coordinates.",
    impact: "Movement classification based on speed may be incomplete, but dropping the position would lose useful route evidence.",
    verification: "Retained rows preserve coordinates and expose the issue ID in the quality output."
  },
  {
    id: "DQ-016", name: "Invalid speed measurement", dataset: "pings.csv", columns: ["speed_kmh"],
    discovery: "Speed was nonnumeric or negative, so it cannot represent a valid speed.",
    severity: "Medium", decision: "FIX", rule: "Replace an unparseable or negative speed with an empty value; retain the GPS position.",
    justification: "The invalid measurement can be isolated without discarding otherwise usable location data.",
    impact: "An invalid speed could distort movement and trip metrics.",
    verification: "Every retained non-empty speed is numeric and nonnegative; original values remain in rejects.csv."
  },
  {
    id: "DQ-017", name: "Extremely high reported speed", dataset: "pings.csv", columns: ["speed_kmh"],
    discovery: "A speed measurement exceeded the configured 160 km/h screening threshold.",
    severity: "High", decision: "FLAG", rule: "Retain the reported value but flag speeds above 160 km/h; do not infer a corrected value.",
    justification: "The threshold is a conservative investigation trigger, not sufficient evidence to alter the measurement.",
    impact: "An untreated outlier could inflate reported fleet speeds or misclassify movement.",
    verification: "Flagged values remain unchanged and are present in data_quality_issues.csv."
  },
  {
    id: "DQ-018", name: "Missing accuracy measurement", dataset: "pings.csv", columns: ["accuracy_m"],
    discovery: "GPS accuracy was blank or whitespace-only.",
    severity: "Medium", decision: "FLAG", rule: "Retain the ping with empty accuracy and attach a missing-accuracy issue.",
    justification: "The position is preserved, but its uncertainty cannot be quantified.",
    impact: "Uncertainty may affect route precision and confidence in short movements.",
    verification: "Missing accuracy is visible in the clean row and issue file."
  },
  {
    id: "DQ-019", name: "Invalid accuracy measurement", dataset: "pings.csv", columns: ["accuracy_m"],
    discovery: "Accuracy was nonnumeric or negative, neither of which is a valid uncertainty distance.",
    severity: "Medium", decision: "FIX", rule: "Replace an unparseable or negative accuracy with an empty value and retain the ping.",
    justification: "The unusable measurement can be isolated while preserving valid location evidence.",
    impact: "Invalid accuracy can undermine quality filtering and confidence in spatial results.",
    verification: "Every retained non-empty accuracy is numeric and nonnegative; the original is traceable in rejects.csv."
  },
  {
    id: "DQ-020", name: "Poor GPS accuracy", dataset: "pings.csv", columns: ["accuracy_m"],
    discovery: "Accuracy exceeded 100 m, which is too imprecise for confident local fleet mapping.",
    severity: "Medium", decision: "FLAG", rule: "Retain readings with accuracy greater than 100 m and flag them; do not use them to diagnose GPS jumps.",
    justification: "Poor accuracy is suspicious, but the observation may still be useful and should not be silently removed.",
    impact: "Low-confidence coordinates can distort short distance estimates or geofence analysis.",
    verification: "The reported accuracy is unchanged and the issue ID is included in the clean output."
  },
  {
    id: "DQ-021", name: "Physically implausible implied GPS speed", dataset: "pings.csv",
    columns: ["vehicle_id", "timestamp", "lat", "lon", "accuracy_m"],
    discovery: "Consecutive high-accuracy positions implied travel faster than 160 km/h over no more than 30 minutes.",
    severity: "High", decision: "FLAG", rule: "Flag both endpoints of a segment whose haversine speed exceeds 160 km/h; retain both source readings.",
    justification: "The location error cannot be assigned safely to either endpoint, so neither point is discarded.",
    impact: "Such a segment can materially inflate route distance and create false movement.",
    verification: "Recalculate speed from retained UTC timestamps and coordinates; each endpoint is traceable in the issues output."
  },
  {
    id: "DQ-022", name: "Unusually long reporting interval", dataset: "pings.csv",
    columns: ["vehicle_id", "timestamp"],
    discovery: "The interval since the preceding retained position exceeded 90 seconds, versus the expected approximate 30-second cadence.",
    severity: "Low", decision: "FLAG", rule: "Flag the later reading when the preceding interval is greater than 90 seconds.",
    justification: "A gap may reflect tracker downtime or normal switched-off operation; it is not evidence that either endpoint is erroneous.",
    impact: "Unobserved travel across gaps can make route distances and trip timing incomplete.",
    verification: "Recompute sorted per-vehicle intervals and confirm flagged endpoints remain in the cleaned output."
  },
  {
    id: "DQ-023", name: "Malformed vehicle identifier", dataset: "pings.csv", columns: ["vehicle_id"],
    discovery: "An identifier did not match the official `GT-dddd` pattern after safe casing, whitespace, and separator normalization.",
    severity: "High", decision: "DROP", rule: "Drop nonempty IDs that do not match `^GT-\\d{4}$` after normalization.",
    justification: "The identifier cannot be reliably associated with a registered vehicle.",
    impact: "A malformed ID can split a vehicle's history or assign pings to the wrong asset.",
    verification: "Every retained ID must satisfy the format and match the official register."
  },
  {
    id: "DQ-024", name: "Numeric-field surrounding whitespace", dataset: "pings.csv",
    columns: ["lat", "lon", "speed_kmh", "accuracy_m"],
    discovery: "A nonempty numeric field contains leading or trailing whitespace.",
    severity: "Low", decision: "FIX", rule: "Trim surrounding whitespace from nonempty numeric fields without changing their numeric value.",
    justification: "Whitespace normalization is lossless and makes numeric output consistent.",
    impact: "Untrimmed values can cause parser-specific failures in downstream calculations.",
    verification: "Retained nonempty measurements parse numerically; every trim is recorded in rejects.csv."
  },
  {
    id: "VQ-001", name: "Vehicle register identifier normalization", dataset: "vehicles.csv", columns: ["vehicle_id"],
    discovery: "The official register contains an identifier requiring safe whitespace, casing, or separator normalization.",
    severity: "Low", decision: "FIX", rule: "Trim and uppercase IDs and convert only `GTdddd` to `GT-dddd`.",
    justification: "This format normalization does not change the underlying four-digit vehicle number.",
    impact: "Unnormalized reference IDs could prevent valid tracker-to-register matching.",
    verification: "Use the normalized register identifiers as the reference set for retained pings."
  },
  {
    id: "VQ-002", name: "Duplicate official vehicle identifier", dataset: "vehicles.csv", columns: ["vehicle_id", "plate", "depot"],
    discovery: "More than one register row used the same normalized identifier, with different vehicle/depot attributes.",
    severity: "High", decision: "FLAG", rule: "Retain and flag every row in a duplicate-ID group; never choose a preferred row automatically.",
    justification: "The source register does not establish which conflicting record is authoritative.",
    impact: "Vehicle plate/depot attribution can be ambiguous even when tracker IDs match.",
    verification: "Confirm all duplicate register rows remain traceable and the summary reports the non-unique ID."
  },
  {
    id: "VQ-003", name: "Decimal-comma depot coordinates", dataset: "vehicles.csv", columns: ["depot_lat", "depot_lon"],
    discovery: "A depot coordinate used a comma as its decimal separator.",
    severity: "Medium", decision: "FIX", rule: "Convert an unambiguous signed decimal-comma coordinate to a decimal point.",
    justification: "The resulting coordinate can be validated against WGS 84 and Ghana bounds.",
    impact: "Malformed depot coordinates would undermine depot-distance and stop classification.",
    verification: "Check normalized depot coordinates are numeric and geographically valid."
  },
  {
    id: "VQ-004", name: "Reversed depot coordinate axes", dataset: "vehicles.csv", columns: ["depot_lat", "depot_lon"],
    discovery: "A depot pair was out of Ghana in its supplied order but valid in Ghana when swapped.",
    severity: "High", decision: "FIX", rule: "Swap only when the original pair is outside Ghana and the reversed pair is inside Ghana.",
    justification: "The register's stated latitude/longitude columns and geographic bounds make the correction unambiguous.",
    impact: "An invalid depot point can break depot proximity and vehicle-home-depot analytics.",
    verification: "Check corrected depot coordinates against WGS 84 and Ghana bounds."
  },
  {
    id: "VQ-005", name: "Invalid depot coordinates", dataset: "vehicles.csv", columns: ["depot_lat", "depot_lon"],
    discovery: "A depot coordinate was missing, nonnumeric, or invalid after the safe axis-order check.",
    severity: "High", decision: "FLAG", rule: "Retain the register row and flag coordinates that cannot be validated; do not fabricate a depot position.",
    justification: "Vehicle identity remains useful even when its depot location needs source-owner correction.",
    impact: "Depot-based spatial analytics may be incomplete or incorrect for this vehicle.",
    verification: "Confirm invalid depot values remain unchanged and their register rows are present in the issues output."
  },
  {
    id: "VQ-006", name: "Missing vehicle register attributes", dataset: "vehicles.csv", columns: ["vehicle_id", "plate", "depot"],
    discovery: "A vehicle register identifier, plate, or depot name is blank or whitespace-only.",
    severity: "Medium", decision: "FLAG", rule: "Retain the register row and flag each row missing an identifier, plate, or depot name.",
    justification: "The register entry may still provide partial reference information; missing metadata must be corrected by the source owner.",
    impact: "Incomplete attributes can make fleet reporting and vehicle/depot attribution ambiguous.",
    verification: "Check required register fields for whitespace-only values and retain flagged rows in vehicles_clean.csv."
  },
  {
    id: "VQ-007", name: "Malformed official vehicle identifier", dataset: "vehicles.csv", columns: ["vehicle_id"],
    discovery: "A nonempty register identifier did not match the expected `GT-dddd` format after safe normalization.",
    severity: "High", decision: "FLAG", rule: "Retain malformed register rows for audit but do not use their IDs to validate pings.",
    justification: "The official register is the reference, but malformed identifiers need source-owner correction before matching.",
    impact: "Pings associated with malformed IDs cannot be reliably joined to registered vehicles.",
    verification: "Only correctly formatted normalized register IDs are used in the ping validation set."
  },
  {
    id: "VQ-008", name: "Vehicle register field surrounding whitespace", dataset: "vehicles.csv",
    columns: ["plate", "depot", "depot_lat", "depot_lon"],
    discovery: "A nonempty non-identifier register field contains leading or trailing whitespace.",
    severity: "Low", decision: "FIX", rule: "Trim surrounding whitespace from plate, depot, and nonempty depot-coordinate fields.",
    justification: "Trimming is lossless and does not infer a new register value.",
    impact: "Untrimmed values can impair joins, display consistency, or coordinate parsing.",
    verification: "Every changed register row is included in rejects.csv with its original and corrected values."
  }
];

const DEFINITIONS_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.id, definition]));

function isInGhana(lat: number, lon: number): boolean {
  return lat >= GHANA_BOUNDS.minLat && lat <= GHANA_BOUNDS.maxLat &&
    lon >= GHANA_BOUNDS.minLon && lon <= GHANA_BOUNDS.maxLon;
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value: string): number | null {
  const text = value.trim();
  const epochMatch = /^(\d{10})(?:\.(\d+))?$/.exec(text);
  if (epochMatch) {
    const seconds = Number(`${epochMatch[1]}.${epochMatch[2] ?? "0"}`);
    const timestamp = seconds * 1000;
    return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
  }

  const dmyMatch = /^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (dmyMatch) {
    const [, dayText, monthText, yearText, hourText, minuteText, secondText] = dmyMatch;
    const parts = [Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText)];
    const timestamp = Date.UTC(...parts as [number, number, number, number, number, number]);
    const date = new Date(timestamp);
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] ||
        date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3] ||
        date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) return null;
    return timestamp;
  }

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!isoMatch) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = isoMatch;
  const parts = [Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText), Number(secondText)];
  const localTimestamp = Date.UTC(...parts as [number, number, number, number, number, number]);
  const date = new Date(localTimestamp);
  if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] ||
      date.getUTCDate() !== parts[2] || date.getUTCHours() !== parts[3] ||
      date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) return null;
  if (zone && zone !== "Z") {
    const offsetMatch = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
    if (!offsetMatch || Number(offsetMatch[2]) > 23 || Number(offsetMatch[3]) > 59) return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeVehicleId(value: string): string {
  const normalized = value.trim().toUpperCase();
  const unseparated = /^GT(\d{4})$/.exec(normalized);
  return unseparated ? `GT-${unseparated[1]}` : normalized;
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace(/\.000Z$/, "Z");
}

function formatNumber(value: number): string {
  return String(value);
}

function createWork(dataset: Dataset, sourceRow: number, record: Record<string, string>): WorkRecord {
  return {
    dataset,
    sourceRow,
    original: { ...record },
    cleaned: { ...record },
    issueIds: new Set<string>(),
    dropped: false,
    fixed: false,
    flagged: false,
    events: new Map<string, IssueEvent>()
  };
}

function addIssue(
  work: WorkRecord,
  issueId: string,
  action: IssueEvent["action"],
  reason: string,
  detail?: string
): void {
  const definition = DEFINITIONS_BY_ID.get(issueId);
  if (!definition) throw new Error(`Unknown data quality issue ID: ${issueId}`);
  const existing = work.events.get(issueId);
  if (existing) {
    if (detail && !existing.details.includes(detail)) existing.details.push(detail);
    return;
  }
  work.issueIds.add(issueId);
  work.events.set(issueId, {
    issueId,
    dataset: work.dataset,
    sourceRow: work.sourceRow,
    action,
    reason,
    details: detail ? [detail] : [],
    original: work.original,
    corrected: null
  });
  if (action === "DROP") work.dropped = true;
  if (action === "FIX") work.fixed = true;
  if (action === "FLAG") work.flagged = true;
}

function isDecimalComma(value: string): boolean {
  return /^[+-]?\d+,\d+$/.test(value.trim());
}

function normalizeCoordinatePair(
  work: WorkRecord,
  latitudeColumn: "lat" | "depot_lat",
  longitudeColumn: "lon" | "depot_lon",
  decimalIssueId: string,
  swapIssueId: string,
  invalidIssueId: string,
  actionForInvalid: "DROP" | "FLAG"
): { lat: number | null; lon: number | null } {
  let latValue = work.cleaned[latitudeColumn] ?? "";
  let lonValue = work.cleaned[longitudeColumn] ?? "";
  const trimmedLat = latValue.trim();
  const trimmedLon = lonValue.trim();
  if (latValue !== trimmedLat || lonValue !== trimmedLon) {
    latValue = trimmedLat;
    lonValue = trimmedLon;
    work.cleaned[latitudeColumn] = latValue;
    work.cleaned[longitudeColumn] = lonValue;
    addIssue(
      work,
      work.dataset === "pings.csv" ? "DQ-024" : "VQ-008",
      "FIX",
      "Trimmed surrounding whitespace from coordinate fields."
    );
  }
  if (!latValue.trim() || !lonValue.trim()) {
    if (work.dataset === "pings.csv") addIssue(work, "DQ-009", "DROP", "Latitude and longitude must both be present.");
    else addIssue(work, invalidIssueId, actionForInvalid, "Both depot coordinate fields must be present.");
    return { lat: null, lon: null };
  }

  const commaCoordinates = [latValue, lonValue].some(isDecimalComma);
  if (commaCoordinates) {
    latValue = latValue.trim().replace(",", ".");
    lonValue = lonValue.trim().replace(",", ".");
    work.cleaned[latitudeColumn] = latValue;
    work.cleaned[longitudeColumn] = lonValue;
    addIssue(work, decimalIssueId, "FIX", "Converted unambiguous decimal-comma coordinate notation to a decimal point.");
  }
  let lat = parseNumber(latValue);
  let lon = parseNumber(lonValue);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    addIssue(work, invalidIssueId, actionForInvalid, "Coordinate values are nonnumeric or outside WGS 84 latitude/longitude ranges.");
    return { lat: null, lon: null };
  }

  if (!isInGhana(lat, lon) && isInGhana(lon, lat)) {
    [lat, lon] = [lon, lat];
    work.cleaned[latitudeColumn] = formatNumber(lat);
    work.cleaned[longitudeColumn] = formatNumber(lon);
    addIssue(work, swapIssueId, "FIX", "Swapped coordinate axes because only the reversed pair falls within Ghana bounds.");
  }

  if (lat === 0 || lon === 0 || !isInGhana(lat, lon)) {
    addIssue(
      work,
      invalidIssueId,
      actionForInvalid,
      lat === 0 || lon === 0
        ? "Zero coordinate values are not credible locations for the Ghana operating area."
        : "Coordinate pair remains outside Ghana bounds after safe normalization."
    );
    return { lat, lon };
  }
  return { lat, lon };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

function makeIssueSummaries(events: IssueEvent[], inputCounts: CleanResult["inputCounts"]): IssueSummary[] {
  const grouped = new Map<string, Map<number, IssueEvent>>();
  for (const event of events) {
    const rows = grouped.get(event.issueId) ?? new Map<number, IssueEvent>();
    const previous = rows.get(event.sourceRow);
    if (previous) {
      for (const detail of event.details) if (!previous.details.includes(detail)) previous.details.push(detail);
    } else {
      rows.set(event.sourceRow, event);
    }
    grouped.set(event.issueId, rows);
  }

  return [...grouped.entries()]
    .map(([issueId, rows]) => {
      const definition = DEFINITIONS_BY_ID.get(issueId)!;
      const denominator = definition.dataset === "pings.csv" ? inputCounts.pings : inputCounts.vehicles;
      const examples = [...rows.values()]
        .sort((a, b) => a.sourceRow - b.sourceRow)
        .slice(0, 3)
        .map((event) => ({
          sourceRow: event.sourceRow,
          original: event.original,
          corrected: event.corrected,
          reason: event.reason,
          details: event.details
        }));
      return {
        issueId,
        issueName: definition.name,
        dataset: definition.dataset,
        columns: definition.columns,
        affectedRows: rows.size,
        percentageAffected: denominator === 0 ? 0 : rows.size / denominator * 100,
        severity: definition.severity,
        decision: definition.decision,
        rule: definition.rule,
        justification: definition.justification,
        impact: definition.impact,
        verification: definition.verification,
        examples
      };
    })
    .sort((a, b) => a.issueId.localeCompare(b.issueId));
}

export function cleanDatasets(
  pingRecords: Record<string, string>[],
  pingColumns: string[],
  vehicleRecords: Record<string, string>[],
  vehicleColumns: string[]
): CleanResult {
  const inputCounts = { pings: pingRecords.length, vehicles: vehicleRecords.length };
  const vehicleWork = vehicleRecords.map((record, index) => {
    const work = createWork("vehicles.csv", index + 2, record);
    const initialId = work.cleaned.vehicle_id ?? "";
    const normalizedId = normalizeVehicleId(initialId);
    if (initialId !== normalizedId) {
      work.cleaned.vehicle_id = normalizedId;
      addIssue(work, "VQ-001", "FIX", "Normalized the official vehicle identifier's whitespace, casing, or missing separator.");
    }
    if (work.cleaned.plate !== work.cleaned.plate.trim() || work.cleaned.depot !== work.cleaned.depot.trim()) {
      work.cleaned.plate = work.cleaned.plate.trim();
      work.cleaned.depot = work.cleaned.depot.trim();
      addIssue(work, "VQ-008", "FIX", "Trimmed surrounding whitespace from register plate or depot fields.");
    }
    if (!work.cleaned.vehicle_id.trim() || !work.cleaned.plate.trim() || !work.cleaned.depot.trim()) {
      addIssue(work, "VQ-006", "FLAG", "Vehicle ID, plate, and depot fields must not be empty or whitespace-only.");
    }
    if (work.cleaned.vehicle_id && !/^GT-\d{4}$/.test(work.cleaned.vehicle_id)) {
      addIssue(work, "VQ-007", "FLAG", "Official register identifier does not match the expected GT-dddd format.");
    }
    const coordinates = normalizeCoordinatePair(work, "depot_lat", "depot_lon", "VQ-003", "VQ-004", "VQ-005", "FLAG");
    if (coordinates.lat !== null && coordinates.lon !== null) {
      if (work.cleaned.depot_lat !== work.original.depot_lat || work.cleaned.depot_lon !== work.original.depot_lon) {
        work.cleaned.depot_lat = formatNumber(coordinates.lat);
        work.cleaned.depot_lon = formatNumber(coordinates.lon);
      }
    }
    return work;
  });

  const registerGroups = new Map<string, WorkRecord[]>();
  for (const work of vehicleWork) {
    const id = work.cleaned.vehicle_id ?? "";
    if (!id) continue;
    const group = registerGroups.get(id) ?? [];
    group.push(work);
    registerGroups.set(id, group);
  }
  for (const [vehicleId, group] of registerGroups) {
    if (group.length > 1) {
      const variants = new Set(group.map((work) => JSON.stringify(
        vehicleColumns.map((column) => work.cleaned[column] ?? "")
      )));
      const conflict = variants.size > 1;
      for (const work of group) {
        addIssue(
          work,
          "VQ-002",
          "FLAG",
          conflict
            ? `Official register ID ${vehicleId} has multiple records with conflicting vehicle attributes.`
            : `Official register ID ${vehicleId} appears more than once.`
        );
      }
    }
  }

  const officialVehicleIds = new Set(vehicleWork
    .map((work) => work.cleaned.vehicle_id)
    .filter((vehicleId) => /^GT-\d{4}$/.test(vehicleId)));
  const pingWork = pingRecords.map((record, index) => {
    const work = createWork("pings.csv", index + 2, record);

    const originalId = work.cleaned.vehicle_id ?? "";
    const normalizedId = normalizeVehicleId(originalId);
    if (!originalId.trim()) {
      addIssue(work, "DQ-001", "DROP", "Vehicle identifier is missing.");
    } else if (originalId !== originalId.trim().toUpperCase()) {
      work.cleaned.vehicle_id = normalizedId;
      addIssue(work, "DQ-002", "FIX", "Trimmed or uppercased the vehicle identifier.");
    }
    if (/^GT\d{4}$/i.test(originalId.trim())) {
      work.cleaned.vehicle_id = normalizedId;
      addIssue(work, "DQ-003", "FIX", "Inserted the missing hyphen in a register-compatible vehicle ID.");
    }
    if (normalizedId && !/^GT-\d{4}$/.test(normalizedId)) {
      addIssue(work, "DQ-023", "DROP", `Vehicle ID ${normalizedId} does not match the expected GT-dddd format.`);
    } else if (normalizedId && !officialVehicleIds.has(normalizedId)) {
      addIssue(work, "DQ-004", "DROP", `Vehicle ID ${normalizedId} is absent from vehicles.csv.`);
    }

    const timestampValue = work.cleaned.timestamp ?? "";
    const timestampMs = parseTimestamp(timestampValue);
    if (!timestampValue.trim()) {
      addIssue(work, "DQ-005", "DROP", "Timestamp is missing.");
    } else if (timestampMs === null) {
      addIssue(work, "DQ-006", "DROP", "Timestamp could not be parsed using the supported formats.");
    } else {
      if (timestampMs < EXPECTED_START || timestampMs >= EXPECTED_END) {
        addIssue(work, "DQ-007", "DROP", `UTC timestamp ${new Date(timestampMs).toISOString()} is outside the assessment period.`);
      }
      const normalizedTimestamp = formatTimestamp(timestampMs);
      if (timestampValue.trim() !== normalizedTimestamp) {
        work.cleaned.timestamp = normalizedTimestamp;
        addIssue(work, "DQ-008", "FIX", "Normalized the timestamp to canonical UTC ISO-8601.");
      } else if (timestampValue !== timestampValue.trim()) {
        work.cleaned.timestamp = normalizedTimestamp;
        addIssue(work, "DQ-008", "FIX", "Trimmed surrounding whitespace and normalized the timestamp.");
      }
    }

    const coordinates = normalizeCoordinatePair(work, "lat", "lon", "DQ-010", "DQ-011", "DQ-012", "DROP");
    if (coordinates.lat !== null && coordinates.lon !== null && (coordinates.lat === 0 || coordinates.lon === 0 ||
        !isInGhana(coordinates.lat, coordinates.lon))) {
      work.dropped = true;
    }

    let speed: number | null = null;
    const speedValue = work.cleaned.speed_kmh ?? "";
    const trimmedSpeed = speedValue.trim();
    if (speedValue !== trimmedSpeed) {
      work.cleaned.speed_kmh = trimmedSpeed;
      addIssue(work, "DQ-024", "FIX", "Trimmed surrounding whitespace from the speed measurement.");
    }
    if (!trimmedSpeed) {
      addIssue(work, "DQ-015", "FLAG", "Speed measurement is missing.");
    } else {
      speed = parseNumber(trimmedSpeed);
      if (speed === null || speed < 0) {
        work.cleaned.speed_kmh = "";
        addIssue(work, "DQ-016", "FIX", "Replaced a nonnumeric or negative speed with an empty value.");
      } else if (speed > MAX_TRUCK_SPEED_KMH) {
        addIssue(work, "DQ-017", "FLAG", `Reported speed ${speed} km/h exceeds the 160 km/h screening threshold.`);
      }
    }

    let accuracy: number | null = null;
    const accuracyValue = work.cleaned.accuracy_m ?? "";
    const trimmedAccuracy = accuracyValue.trim();
    if (accuracyValue !== trimmedAccuracy) {
      work.cleaned.accuracy_m = trimmedAccuracy;
      addIssue(work, "DQ-024", "FIX", "Trimmed surrounding whitespace from the accuracy measurement.");
    }
    if (!trimmedAccuracy) {
      addIssue(work, "DQ-018", "FLAG", "GPS accuracy measurement is missing.");
    } else {
      accuracy = parseNumber(trimmedAccuracy);
      if (accuracy === null || accuracy < 0) {
        accuracy = null;
        work.cleaned.accuracy_m = "";
        addIssue(work, "DQ-019", "FIX", "Replaced an invalid or negative accuracy measurement with an empty value.");
      } else if (accuracy > MAX_ACCURACY_METERS) {
        addIssue(work, "DQ-020", "FLAG", `Reported accuracy ${accuracy} m exceeds the 100 m quality threshold.`);
      }
    }

    return { work, timestampMs, lat: coordinates.lat, lon: coordinates.lon, accuracy };
  });

  const exactGroups = new Map<string, PingMeta[]>();
  for (const meta of pingWork) {
    const signature = JSON.stringify(pingColumns.map((column) => meta.work.cleaned[column] ?? ""));
    const group = exactGroups.get(signature) ?? [];
    group.push(meta);
    exactGroups.set(signature, group);
  }
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    const keeper = group[0].work.sourceRow;
    for (const duplicate of group.slice(1)) {
      duplicate.work.dropped = true;
      addIssue(
        duplicate.work,
        "DQ-013",
        "DROP",
        `Exact duplicate of the earlier normalized source record at row ${keeper}.`
      );
    }
  }

  const vehicleTimeGroups = new Map<string, PingMeta[]>();
  for (const meta of pingWork) {
    if (meta.timestampMs === null || !meta.work.cleaned.vehicle_id) continue;
    const key = `${meta.work.cleaned.vehicle_id}/${meta.timestampMs}`;
    const group = vehicleTimeGroups.get(key) ?? [];
    group.push(meta);
    vehicleTimeGroups.set(key, group);
  }
  for (const group of vehicleTimeGroups.values()) {
    const retained = group.filter((meta) => !meta.work.dropped);
    const signatures = new Set(retained.map((meta) => JSON.stringify(
      pingColumns.filter((column) => column !== "timestamp" && column !== "vehicle_id")
        .map((column) => meta.work.cleaned[column] ?? "")
    )));
    if (signatures.size > 1) {
      for (const meta of retained) {
        addIssue(
          meta.work,
          "DQ-014",
          "FLAG",
          "Multiple non-identical measurements exist for this vehicle at the same UTC instant."
        );
      }
    }
  }

  const usable = pingWork.filter((meta) => !meta.work.dropped && meta.timestampMs !== null &&
    meta.lat !== null && meta.lon !== null && isInGhana(meta.lat, meta.lon));
  const byVehicle = new Map<string, PingMeta[]>();
  for (const meta of usable) {
    const vehicleId = meta.work.cleaned.vehicle_id;
    if (!vehicleId) continue;
    const list = byVehicle.get(vehicleId) ?? [];
    list.push(meta);
    byVehicle.set(vehicleId, list);
  }

  const intervals: number[] = [];
  let stationaryPairsWithin5m = 0;
  let implausibleJumpSegments = 0;
  for (const points of byVehicle.values()) {
    points.sort((a, b) => a.timestampMs! - b.timestampMs! || a.work.sourceRow - b.work.sourceRow);
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1];
      const current = points[index];
      const seconds = (current.timestampMs! - previous.timestampMs!) / 1000;
      if (seconds <= 0) continue;
      intervals.push(seconds);
      const distance = haversineKm(
        [previous.lon!, previous.lat!],
        [current.lon!, current.lat!]
      );
      if (distance <= 0.005 && seconds <= MAX_REPORTING_INTERVAL_SECONDS) stationaryPairsWithin5m++;
      if (seconds > MAX_REPORTING_INTERVAL_SECONDS) {
        addIssue(
          current.work,
          "DQ-022",
          "FLAG",
          `Reporting interval of ${seconds.toFixed(1)} seconds exceeds the 90-second review threshold.`,
          `Previous source row: ${previous.work.sourceRow}; interval_seconds: ${seconds.toFixed(1)}`
        );
      }
      if (seconds <= MAX_JUMP_INTERVAL_SECONDS &&
          previous.accuracy !== null && previous.accuracy <= MAX_ACCURACY_METERS &&
          current.accuracy !== null && current.accuracy <= MAX_ACCURACY_METERS &&
          distance * 3600 / seconds > MAX_TRUCK_SPEED_KMH) {
        implausibleJumpSegments++;
        const impliedSpeed = distance * 3600 / seconds;
        const detail = `Segment source rows ${previous.work.sourceRow}-${current.work.sourceRow}; distance_km: ${distance.toFixed(3)}; interval_seconds: ${seconds.toFixed(1)}; implied_speed_kmh: ${impliedSpeed.toFixed(1)}`;
        addIssue(previous.work, "DQ-021", "FLAG", "Adjacent high-accuracy points imply travel above 160 km/h.", detail);
        addIssue(current.work, "DQ-021", "FLAG", "Adjacent high-accuracy points imply travel above 160 km/h.", detail);
      }
    }
  }

  const allWork = [...pingWork.map((meta) => meta.work), ...vehicleWork];
  const events: IssueEvent[] = [];
  for (const work of allWork) {
    for (const event of work.events.values()) {
      event.corrected = work.fixed ? { ...work.cleaned } : work.dropped ? null : { ...work.cleaned };
      events.push(event);
    }
  }
  events.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.sourceRow - b.sourceRow || a.issueId.localeCompare(b.issueId));

  const cleanedPings = pingWork.filter((meta) => !meta.work.dropped).map((meta) => meta.work);
  const cleanedVehicles = vehicleWork;
  const issueSummaries = makeIssueSummaries(events, inputCounts);
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  return {
    pingColumns,
    vehicleColumns,
    cleanedPings,
    cleanedVehicles,
    records: allWork,
    events,
    issueSummaries,
    inputCounts,
    telemetry: {
      stationaryPairsWithin5m,
      reportingIntervalsOver90Seconds: intervals.filter((seconds) => seconds > MAX_REPORTING_INTERVAL_SECONDS).length,
      reportingIntervalSeconds: {
        median: percentile(sortedIntervals, 0.5),
        p95: percentile(sortedIntervals, 0.95),
        maximum: sortedIntervals.at(-1) ?? null
      },
      implausibleJumpSegments
    }
  };
}

export function getIssueDefinition(issueId: string): IssueDefinition {
  const definition = DEFINITIONS_BY_ID.get(issueId);
  if (!definition) throw new Error(`Unknown data quality issue ID: ${issueId}`);
  return definition;
}

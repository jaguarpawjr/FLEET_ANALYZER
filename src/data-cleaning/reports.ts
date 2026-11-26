import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanDatasets, getIssueDefinition } from "./cleaner.js";
import { recordsFromCsv, stringifyCsv } from "./csv.js";
import type { CleanedRecord, CleanResult, IssueEvent, IssueSummary } from "./types.js";

const PING_COLUMNS = ["vehicle_id", "timestamp", "lat", "lon", "speed_kmh", "accuracy_m"];
const VEHICLE_COLUMNS = ["vehicle_id", "plate", "depot", "depot_lat", "depot_lon"];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function issueEventsBySource(events: IssueEvent[]): Map<string, IssueEvent[]> {
  const grouped = new Map<string, IssueEvent[]>();
  for (const event of events) {
    const key = `${event.dataset}/${event.sourceRow}`;
    const list = grouped.get(key) ?? [];
    list.push(event);
    grouped.set(key, list);
  }
  return grouped;
}

function cleanCsvRows(records: CleanedRecord[]): Record<string, unknown>[] {
  return records.map((record) => ({
    _source_row: record.sourceRow,
    ...record.cleaned,
    quality_issue_ids: [...record.issueIds].sort().join("|")
  }));
}

function makeRejectRows(result: CleanResult, eventsBySource: Map<string, IssueEvent[]>): Record<string, unknown>[] {
  return result.records
    .filter((record) => record.dropped || record.fixed)
    .sort((a, b) => a.dataset.localeCompare(b.dataset) || a.sourceRow - b.sourceRow)
    .map((record) => {
      const events = eventsBySource.get(`${record.dataset}/${record.sourceRow}`) ?? [];
      return {
        dataset: record.dataset,
        source_row: record.sourceRow,
        original_record: record.original,
        corrected_record: record.fixed ? record.cleaned : null,
        issue_ids: events.map((event) => event.issueId).sort(),
        reasons: events.map((event) => `${event.issueId}: ${event.reason}`),
        action: record.dropped ? "DROP" : "FIX"
      };
    });
}

function makeIssueRows(events: IssueEvent[]): Record<string, unknown>[] {
  return events.map((event) => {
    const definition = getIssueDefinition(event.issueId);
    return {
      dataset: event.dataset,
      source_row: event.sourceRow,
      issue_id: event.issueId,
      issue_name: definition.name,
      affected_columns: definition.columns,
      severity: definition.severity,
      action: event.action,
      reason: event.reason,
      details: event.details,
      original_record: event.original,
      corrected_record: event.corrected
    };
  });
}

function countsFor(records: CleanedRecord[]) {
  const dropped = records.filter((record) => record.dropped).length;
  const retained = records.length - dropped;
  return {
    input_rows: records.length,
    cleaned_rows: retained,
    dropped_rows: dropped,
    fixed_rows: records.filter((record) => record.fixed).length,
    flagged_rows: records.filter((record) => record.flagged).length,
    rows_accounted_for: records.length === retained + dropped
  };
}

function checkResult(
  name: string,
  passed: boolean,
  evidence: string
): { name: string; passed: boolean; evidence: string } {
  return { name, passed, evidence };
}

function buildSummary(
  result: CleanResult,
  inputHashes: { pings: string; vehicles: string },
  rejects: Record<string, unknown>[],
  issueRows: Record<string, unknown>[]
) {
  const officialIds = new Set(result.cleanedVehicles
    .map((row) => row.cleaned.vehicle_id)
    .filter((vehicleId) => /^GT-\d{4}$/.test(vehicleId)));
  const knownVehicleIds = result.cleanedPings.every((row) => officialIds.has(row.cleaned.vehicle_id));
  const vehicleFieldsPresent = result.cleanedVehicles.every((row) =>
    Boolean(row.cleaned.vehicle_id.trim() && row.cleaned.plate.trim() && row.cleaned.depot.trim())
  );
  const validCoordinates = result.cleanedPings.every((row) => {
    const lat = Number(row.cleaned.lat), lon = Number(row.cleaned.lon);
    return Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0 &&
      lat >= 4 && lat <= 12 && lon >= -4 && lon <= 2;
  });
  const canonicalTimestamps = result.cleanedPings.every((row) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.cleaned.timestamp)
  );
  const uniqueCleanPings = new Set(result.cleanedPings.map((row) =>
    JSON.stringify(result.pingColumns.map((column) => row.cleaned[column] ?? ""))
  )).size === result.cleanedPings.length;
  const retainedDatesInScope = result.cleanedPings.every((row) => {
    const time = Date.parse(row.cleaned.timestamp);
    return time >= Date.parse("2026-11-17T00:00:00Z") && time < Date.parse("2026-11-20T00:00:00Z");
  });
  const validSpeeds = result.cleanedPings.every((row) => {
    const value = row.cleaned.speed_kmh;
    return !value.trim() || (Number.isFinite(Number(value)) && Number(value) >= 0);
  });
  const validAccuracy = result.cleanedPings.every((row) => {
    const value = row.cleaned.accuracy_m;
    return !value.trim() || (Number.isFinite(Number(value)) && Number(value) >= 0);
  });
  const duplicateCount = result.events.filter((event) => event.issueId === "DQ-013").length;
  const duplicateIssueRefs = rejects.filter((row) =>
    (row.issue_ids as string[]).includes("DQ-013")
  ).length;
  const allTransformationsTraced = result.records
    .filter((record) => record.dropped || record.fixed)
    .every((record) => rejects.some((row) =>
      row.dataset === record.dataset && row.source_row === record.sourceRow
    ));
  const pingsCount = countsFor(result.records.filter((record) => record.dataset === "pings.csv"));
  const vehiclesCount = countsFor(result.records.filter((record) => record.dataset === "vehicles.csv"));
  const fixedRows = result.records.filter((record) => record.fixed).length;
  const flaggedRows = result.records.filter((record) => record.flagged).length;
  const droppedRows = result.records.filter((record) => record.dropped).length;
  const affectedRows = result.records.filter((record) => record.issueIds.size > 0).length;
  const checks = [
    checkResult("Required CSV columns exist", true, "Both input schemas were checked before processing."),
    checkResult("Every retained ping has a registered vehicle ID", knownVehicleIds, `${result.cleanedPings.length} retained pings checked against ${officialIds.size} unique normalized register IDs.`),
    checkResult("Vehicle register IDs, plates, and depots are populated", vehicleFieldsPresent, `${result.cleanedVehicles.length} retained register rows checked; missing fields remain explicitly flagged.`),
    checkResult("Retained coordinates are populated and inside Ghana bounds", validCoordinates, `${result.cleanedPings.length} retained coordinate pairs checked.`),
    checkResult("Retained timestamps are normalized UTC ISO-8601", canonicalTimestamps, `${result.cleanedPings.length} retained timestamps checked.`),
    checkResult("Retained timestamps are within the assessment period", retainedDatesInScope, "Every retained UTC timestamp falls from 17 November up to (but not including) 20 November 2026."),
    checkResult("No exact normalized ping duplicates remain", uniqueCleanPings, `${result.cleanedPings.length} cleaned ping records checked for duplicate six-field signatures.`),
    checkResult("Retained speed and accuracy values are valid when present", validSpeeds && validAccuracy, `${result.cleanedPings.length} retained speed and accuracy values checked; missing values remain traceable as quality issues.`),
    checkResult("Exact duplicate removal is auditable", duplicateCount === duplicateIssueRefs, `${duplicateCount} duplicate source rows were removed and referenced in rejects.csv.`),
    checkResult("Every changed or dropped record is in rejects.csv", allTransformationsTraced, `${rejects.length} changed or dropped source records are present in rejects.csv.`),
    checkResult("Ping row counts reconcile", pingsCount.rows_accounted_for, `${pingsCount.input_rows} = ${pingsCount.cleaned_rows} retained + ${pingsCount.dropped_rows} dropped.`),
    checkResult("Vehicle register row counts reconcile", vehiclesCount.rows_accounted_for, `${vehiclesCount.input_rows} = ${vehiclesCount.cleaned_rows} retained + ${vehiclesCount.dropped_rows} dropped.`),
    checkResult("Flagged observations are retained and traceable", result.cleanedPings.concat(result.cleanedVehicles).every((record) => !record.flagged || issueRows.some((row) =>
      row.dataset === record.dataset && row.source_row === record.sourceRow
    )), "Flagged retained rows are represented in data_quality_issues.csv and carry quality_issue_ids.")
  ];

  const issueReferencesByDataset = result.issueSummaries.reduce<Record<string, number>>((accumulator, issue) => {
    accumulator[issue.dataset] = (accumulator[issue.dataset] ?? 0) + issue.affectedRows;
    return accumulator;
  }, {});
  const uniqueIssueRows = result.records.filter((record) => record.issueIds.size > 0);
  return {
    input_sha256: inputHashes,
    initial_row_counts: result.inputCounts,
    final_clean_row_counts: {
      pings_clean: result.cleanedPings.length,
      vehicles_clean: result.cleanedVehicles.length
    },
    reconciliation: {
      pings: pingsCount,
      vehicles: vehiclesCount,
      total_input_rows: result.records.length,
      total_clean_rows: result.cleanedPings.length + result.cleanedVehicles.length,
      total_rejected_rows: droppedRows,
      all_rows_accounted_for: pingsCount.rows_accounted_for && vehiclesCount.rows_accounted_for
    },
    row_treatment_totals: {
      unique_records_affected_by_any_issue: affectedRows,
      rows_fixed: fixedRows,
      rows_flagged: flaggedRows,
      rows_rejected: droppedRows,
      counts_are_non_exclusive: true,
      note: "A source row may have multiple issue IDs and may be both fixed and flagged. Rejected rows are not included in cleaned outputs."
    },
    issue_row_references_by_dataset: issueReferencesByDataset,
    telemetry_observations: {
      stationary_adjacent_pairs_within_5m_and_90s: result.telemetry.stationaryPairsWithin5m,
      reporting_intervals_over_90_seconds: result.telemetry.reportingIntervalsOver90Seconds,
      reporting_interval_seconds: result.telemetry.reportingIntervalSeconds,
      implausible_jump_segments_over_160_kmh: result.telemetry.implausibleJumpSegments,
      interpretation: "Stationary pairs are an operational observation, not automatically a defect; jump and reporting-gap endpoints are retained and explicitly flagged."
    },
    quality_checks: checks,
    all_quality_checks_passed: checks.every((check) => check.passed),
    issues: result.issueSummaries,
    issue_records: issueRows.length,
    issue_rows_by_dataset: {
      pings: uniqueIssueRows.filter((record) => record.dataset === "pings.csv").length,
      vehicles: uniqueIssueRows.filter((record) => record.dataset === "vehicles.csv").length
    }
  };
}

function formatPercent(value: number): string {
  return `${value.toFixed(3)}%`;
}

function issueRegisterTable(issues: IssueSummary[]): string[] {
  const lines = [
    "| Issue ID | Data Quality Issue | Dataset | Affected Rows | % Affected | Decision | Rule Applied | Justification |",
    "|---|---|---|---:|---:|---|---|---|"
  ];
  for (const issue of issues) {
    const escaped = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(
      `| ${issue.issueId} | ${escaped(issue.issueName)} | ${issue.dataset} | ${issue.affectedRows} | ${formatPercent(issue.percentageAffected)} | ${issue.decision} | ${escaped(issue.rule)} | ${escaped(issue.justification)} |`
    );
  }
  if (issues.length === 0) lines.push("| — | No issues discovered | — | 0 | 0.000% | — | — | — |");
  return lines;
}

function renderLogbook(
  result: CleanResult,
  summary: ReturnType<typeof buildSummary>
): string {
  const lines = [
    "# Data Quality Investigation Logbook",
    "",
    "## Scope and reproducibility",
    "",
    "This logbook is generated from the source CSVs by `npm run cleaning`. It records the CSV row number (header is row 1), detected issue counts, row-level evidence, and actual pipeline decisions. The source files are not modified. Re-run the command with the same inputs to regenerate deterministic outputs.",
    "",
    "The stated assessment period is 17–19 November 2026. Timezone-naive timestamps are interpreted as UTC because the source context specifies UTC/Ghana. The accepted coordinate envelope is latitude 4–12 and longitude -4–2, matching the expected Ghana operating area; this is stricter than generic WGS 84 validity.",
    "",
    "## Initial and final row counts",
    "",
    `- Initial pings.csv data rows: **${result.inputCounts.pings}**`,
    `- Initial vehicles.csv data rows: **${result.inputCounts.vehicles}**`,
    `- Final pings_clean.csv rows: **${result.cleanedPings.length}**`,
    `- Final vehicles_clean.csv rows: **${result.cleanedVehicles.length}**`,
    `- Total unique source records affected by at least one issue: **${summary.row_treatment_totals.unique_records_affected_by_any_issue}**`,
    `- Unique source records fixed: **${summary.row_treatment_totals.rows_fixed}**`,
    `- Unique source records flagged: **${summary.row_treatment_totals.rows_flagged}**`,
    `- Unique source records rejected: **${summary.row_treatment_totals.rows_rejected}**`,
    "",
    "Fixed, flagged, and rejected counts are distinct source-row counts within each category and are not additive: a row may have multiple issues or both a fix and a flag. Each issue's affected-row count is also unique within that issue; overlaps between issues are expected.",
    "",
    "## Reconciliation",
    "",
    `- Pings: ${summary.reconciliation.pings.input_rows} input = ${summary.reconciliation.pings.cleaned_rows} retained + ${summary.reconciliation.pings.dropped_rows} dropped.`,
    `- Vehicles: ${summary.reconciliation.vehicles.input_rows} input = ${summary.reconciliation.vehicles.cleaned_rows} retained + ${summary.reconciliation.vehicles.dropped_rows} dropped.`,
    `- Every changed or dropped record is represented in rejects.csv: **${summary.quality_checks.find((check) => check.name === "Every changed or dropped record is in rejects.csv")?.passed ? "PASS" : "FAIL"}**.`,
    "",
    "## Central issue register",
    "",
    ...issueRegisterTable(result.issueSummaries),
    "",
    "## Issue evidence and decisions",
    ""
  ];

  if (result.issueSummaries.length === 0) {
    lines.push("No data quality issues were observed in the supplied datasets.");
  }
  for (const issue of result.issueSummaries) {
    lines.push(
      `### ${issue.issueId}: ${issue.issueName}`,
      "",
      `- **Dataset:** ${issue.dataset}`,
      `- **Affected columns:** ${issue.columns.join(", ")}`,
      `- **What was discovered:** ${getIssueDefinition(issue.issueId).discovery}`,
      `- **Number of affected rows:** ${issue.affectedRows} distinct source rows.`,
      `- **Percentage affected:** ${formatPercent(issue.percentageAffected)} of ${issue.dataset === "pings.csv" ? result.inputCounts.pings : result.inputCounts.vehicles} source data rows.`,
      `- **Severity:** ${issue.severity}.`,
      `- **Decision:** ${issue.decision}.`,
      `- **Rule applied:** ${issue.rule}`,
      `- **Reason for decision:** ${issue.justification}`,
      `- **Impact if untreated:** ${issue.impact}`,
      `- **Verification:** ${issue.verification}`,
      "- **Evidence examples:**"
    );
    if (issue.examples.length === 0) lines.push("  - No row-level examples were available.");
    for (const example of issue.examples) {
      const original = JSON.stringify(example.original);
      const corrected = example.corrected ? `; candidate corrected record: \`${JSON.stringify(example.corrected)}\`` : "";
      const details = example.details.length ? `; detail: ${example.details.join(" | ")}` : "";
      lines.push(`  - Source record ${example.sourceRow}: \`${original}\`${corrected}; ${example.reason}${details}`);
    }
    lines.push("");
  }

  lines.push(
    "## Investigation checks with no issue rows",
    "",
    "A check listed here was executed and found no records requiring a separate issue entry. Any nonzero finding appears in the central issue register.",
    "",
    "| Check | Result |",
    "|---|---|"
  );
  const noFindingChecks: Array<[string, number]> = [
    ["Missing vehicle IDs", countIssues(result, "DQ-001")],
    ["Malformed vehicle IDs", countIssues(result, "DQ-023")],
    ["Missing timestamps", countIssues(result, "DQ-005")],
    ["Unparseable timestamps", countIssues(result, "DQ-006")],
    ["Missing latitude/longitude components", countIssues(result, "DQ-009")],
    ["Decimal-comma coordinates", countIssues(result, "DQ-010")],
    ["Coordinates invalid or outside expected Ghana bounds after safe repair", countIssues(result, "DQ-012")],
    ["Negative or nonnumeric speeds", countIssues(result, "DQ-016")],
    ["Speeds over 160 km/h", countIssues(result, "DQ-017")],
    ["Missing speed measurements", countIssues(result, "DQ-015")],
    ["Missing accuracy measurements", countIssues(result, "DQ-018")],
    ["Invalid accuracy measurements", countIssues(result, "DQ-019")],
    ["Accuracy measurements over 100 m", countIssues(result, "DQ-020")],
    ["Numeric-field surrounding whitespace", countIssues(result, "DQ-024")],
    ["Same-vehicle/same-instant conflicting measurements", countIssues(result, "DQ-014")]
  ];
  for (const [name, count] of noFindingChecks) {
    lines.push(`| ${name} | ${count === 0 ? "No findings" : `${count} affected source rows (see issue register)`} |`);
  }
  for (const [name, count] of [
    ["Missing vehicle register ID, plate, or depot", countIssues(result, "VQ-006")],
    ["Malformed vehicle register IDs", countIssues(result, "VQ-007")],
    ["Vehicle register surrounding whitespace", countIssues(result, "VQ-008")],
    ["Invalid or missing depot coordinates", countIssues(result, "VQ-005")]
  ]) {
    lines.push(`| ${name} | ${count === 0 ? "No findings" : `${count} affected source rows (see issue register)`} |`);
  }
  lines.push(
    "",
    "## GPS sequence observations",
    "",
    `- Adjacent retained positions within 5 m and 90 seconds: **${result.telemetry.stationaryPairsWithin5m} pairs**. This pattern is consistent with stationary vehicles and is not classified as an error by itself.`,
    `- Consecutive reporting intervals over 90 seconds: **${result.telemetry.reportingIntervalsOver90Seconds} intervals**; each later endpoint is flagged when present in the retained dataset.`,
    `- Reporting interval seconds: median **${result.telemetry.reportingIntervalSeconds.median ?? "n/a"}**, 95th percentile **${result.telemetry.reportingIntervalSeconds.p95 ?? "n/a"}**, maximum **${result.telemetry.reportingIntervalSeconds.maximum ?? "n/a"}**.`,
    `- Implied speeds above 160 km/h across intervals no longer than 30 minutes: **${result.telemetry.implausibleJumpSegments} segments**. Endpoints with usable accuracy are retained and flagged; this finding does not assert which coordinate is wrong.`,
    "",
    "## Cleaned-data quality summary",
    "",
    `The pipeline retained ${result.cleanedPings.length} pings with registered vehicle IDs, canonical UTC timestamps, and nonzero coordinates inside the expected Ghana envelope. The official vehicle register retains ${result.cleanedVehicles.length} rows, including conflicting duplicate IDs that are preserved and flagged rather than resolved arbitrarily. Poor accuracy, speed outliers, suspicious jumps, and reporting gaps are retained as reviewable observations.`,
    "",
    "## Validation results",
    "",
    "| Validation | Passed | Evidence |",
    "|---|---|---|"
  );
  for (const check of summary.quality_checks) {
    lines.push(`| ${check.name} | ${check.passed ? "Yes" : "No"} | ${check.evidence.replaceAll("|", "\\|")} |`);
  }
  lines.push(
    "",
    "## Limitations and assumptions",
    "",
    "- The expected operating area is treated as Ghana using latitude 4–12 and longitude -4–2; coordinates elsewhere are rejected after attempting only the unambiguous axis swap.",
    "- Naive day/month/year timestamps are interpreted as UTC/Ghana time. Explicit numeric offsets are honored and converted to UTC.",
    "- Unix timestamps are accepted only in the observed 10-digit seconds format.",
    "- The duplicate vehicle register ID is not auto-resolved because the source contains conflicting plate/depot attributes; an authoritative register correction is required.",
    "- A 100 m accuracy limit, 160 km/h speed screen, 90 second reporting-gap threshold, and 30 minute jump interval are explicit review rules, not claims that every flagged observation is erroneous.",
    "- Repeated nearby points may represent a legitimate stop. They are reported as telemetry context and are not removed.",
    "- Source row numbers include the header as row 1; the current source files contain one physical line per record.",
    "",
    `Input SHA-256: pings.csv \`${summary.input_sha256.pings}\`; vehicles.csv \`${summary.input_sha256.vehicles}\`.`,
    ""
  );
  return lines.join("\n");
}

function countIssues(result: CleanResult, issueId: string): number {
  const issue = result.issueSummaries.find((candidate) => candidate.issueId === issueId);
  return issue?.affectedRows ?? 0;
}

export async function runDataCleaningPipeline(inputDir = ".", outputDir = "."): Promise<void> {
  const [pingText, vehicleText] = await Promise.all([
    readFile(join(inputDir, "pings.csv"), "utf8"),
    readFile(join(inputDir, "vehicles.csv"), "utf8")
  ]);
  const pings = recordsFromCsv(pingText, PING_COLUMNS, "pings.csv");
  const vehicles = recordsFromCsv(vehicleText, VEHICLE_COLUMNS, "vehicles.csv");
  const result = cleanDatasets(pings.records, pings.columns, vehicles.records, vehicles.columns);
  const eventsBySource = issueEventsBySource(result.events);
  const rejects = makeRejectRows(result, eventsBySource);
  const issueRows = makeIssueRows(result.events);
  const summary = buildSummary(
    result,
    { pings: sha256(pingText), vehicles: sha256(vehicleText) },
    rejects,
    issueRows
  );
  const report = renderLogbook(result, summary);

  await mkdir(outputDir, { recursive: true });
  const writeCsv = (name: string, rows: Record<string, unknown>[], columns: string[]) =>
    writeFile(join(outputDir, name), stringifyCsv(rows, columns), "utf8");
  await Promise.all([
    writeCsv("pings_clean.csv", cleanCsvRows(result.cleanedPings), ["_source_row", ...pings.columns, "quality_issue_ids"]),
    writeCsv("vehicles_clean.csv", cleanCsvRows(result.cleanedVehicles), ["_source_row", ...vehicles.columns, "quality_issue_ids"]),
    writeCsv("rejects.csv", rejects, ["dataset", "source_row", "original_record", "corrected_record", "issue_ids", "reasons", "action"]),
    writeCsv("data_quality_issues.csv", issueRows, [
      "dataset", "source_row", "issue_id", "issue_name", "affected_columns", "severity",
      "action", "reason", "details", "original_record", "corrected_record"
    ]),
    writeFile(join(outputDir, "data_quality_summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8"),
    writeFile(join(outputDir, "DATA_QUALITY_LOGBOOK.md"), report, "utf8")
  ]);

  const failedChecks = summary.quality_checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    throw new Error(`Cleaning outputs were written, but validation failed: ${failedChecks.map((check) => check.name).join("; ")}`);
  }
  console.log(
    `Data cleaning complete: ${result.cleanedPings.length}/${result.inputCounts.pings} pings retained, ` +
    `${result.cleanedVehicles.length}/${result.inputCounts.vehicles} vehicle rows retained, ` +
    `${result.issueSummaries.length} issue types documented.`
  );
}

export type { IssueSummary };

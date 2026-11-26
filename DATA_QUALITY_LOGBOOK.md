# Data Quality Investigation Logbook

## Scope and reproducibility

This logbook is generated from the source CSVs by `npm run cleaning`. It records the CSV row number (header is row 1), detected issue counts, row-level evidence, and actual pipeline decisions. The source files are not modified. Re-run the command with the same inputs to regenerate deterministic outputs.

The stated assessment period is 17–19 November 2026. Timezone-naive timestamps are interpreted as UTC because the source context specifies UTC/Ghana. The accepted coordinate envelope is latitude 4–12 and longitude -4–2, matching the expected Ghana operating area; this is stricter than generic WGS 84 validity.

## Initial and final row counts

- Initial pings.csv data rows: **32001**
- Initial vehicles.csv data rows: **25**
- Final pings_clean.csv rows: **31076**
- Final vehicles_clean.csv rows: **25**
- Total unique source records affected by at least one issue: **7541**
- Unique source records fixed: **6365**
- Unique source records flagged: **470**
- Unique source records rejected: **925**

Fixed, flagged, and rejected counts are distinct source-row counts within each category and are not additive: a row may have multiple issues or both a fix and a flag. Each issue's affected-row count is also unique within that issue; overlaps between issues are expected.

## Reconciliation

- Pings: 32001 input = 31076 retained + 925 dropped.
- Vehicles: 25 input = 25 retained + 0 dropped.
- Every changed or dropped record is represented in rejects.csv: **PASS**.

## Central issue register

| Issue ID | Data Quality Issue | Dataset | Affected Rows | % Affected | Decision | Rule Applied | Justification |
|---|---|---|---:|---:|---|---|---|
| DQ-002 | Vehicle identifier whitespace or casing | pings.csv | 356 | 1.112% | FIX | Trim surrounding whitespace and convert identifiers to uppercase. | Case and whitespace normalization is unambiguous and leaves the register mapping unchanged. |
| DQ-003 | Vehicle identifier missing separator | pings.csv | 288 | 0.900% | FIX | Convert only `GTdddd` to `GT-dddd`, then require an exact official-register match. | The four-digit value maps unambiguously to the corresponding formatted register ID. |
| DQ-004 | Vehicle identifier absent from official register | pings.csv | 120 | 0.375% | DROP | Drop pings whose normalized vehicle_id is absent from the official register. | The reference register is authoritative; there is no safe vehicle mapping for an unknown ID. |
| DQ-006 | Unparseable timestamp | pings.csv | 8 | 0.025% | DROP | Drop timestamps that cannot be parsed strictly to a valid instant. | The original timestamp does not provide a defensible time value. |
| DQ-007 | Timestamp outside assessment period | pings.csv | 46 | 0.144% | DROP | Keep only UTC instants in [2026-11-17T00:00:00Z, 2026-11-20T00:00:00Z). | The assessment defines this three-day period; out-of-period rows are not part of the target dataset. |
| DQ-008 | Timestamp format or timezone normalization | pings.csv | 5264 | 16.449% | FIX | Parse supported timestamp formats, treat timezone-naive values as UTC (Ghana), and serialize as UTC ISO-8601. | The source context states UTC/Ghana; explicit offsets are converted to UTC rather than discarded. |
| DQ-010 | Decimal-comma coordinates | pings.csv | 102 | 0.319% | FIX | Replace a comma with a decimal point only for a coordinate matching a signed decimal-comma number. | The observed coordinate form is unambiguous and the resulting value is checked against geographic bounds. |
| DQ-011 | Latitude and longitude reversed | pings.csv | 318 | 0.994% | FIX | Swap the pair only when the original is outside the Ghana bounds and the reversed pair is inside them. | The bounded geographic context makes this correction unambiguous for the observed records. |
| DQ-012 | Zero, invalid, or out-of-area coordinates | pings.csv | 148 | 0.462% | DROP | After decimal and axis-order repairs, drop nonnumeric, WGS 84-invalid, zero, or out-of-Ghana pairs. | No reliable location can be recovered from these observations using the available source data. |
| DQ-013 | Exact duplicate GPS reading | pings.csv | 605 | 1.891% | DROP | Keep the earliest source record for each identical normalized record and drop later copies. | An identical repeat adds no new observation; preserving the first occurrence is deterministic. |
| DQ-016 | Invalid speed measurement | pings.csv | 124 | 0.387% | FIX | Replace an unparseable or negative speed with an empty value; retain the GPS position. | The invalid measurement can be isolated without discarding otherwise usable location data. |
| DQ-020 | Poor GPS accuracy | pings.csv | 145 | 0.453% | FLAG | Retain readings with accuracy greater than 100 m and flag them; do not use them to diagnose GPS jumps. | Poor accuracy is suspicious, but the observation may still be useful and should not be silently removed. |
| DQ-021 | Physically implausible implied GPS speed | pings.csv | 275 | 0.859% | FLAG | Flag both endpoints of a segment whose haversine speed exceeds 160 km/h; retain both source readings. | The location error cannot be assigned safely to either endpoint, so neither point is discarded. |
| DQ-022 | Unusually long reporting interval | pings.csv | 48 | 0.150% | FLAG | Flag the later reading when the preceding interval is greater than 90 seconds. | A gap may reflect tracker downtime or normal switched-off operation; it is not evidence that either endpoint is erroneous. |
| VQ-002 | Duplicate official vehicle identifier | vehicles.csv | 2 | 8.000% | FLAG | Retain and flag every row in a duplicate-ID group; never choose a preferred row automatically. | The source register does not establish which conflicting record is authoritative. |
| VQ-004 | Reversed depot coordinate axes | vehicles.csv | 1 | 4.000% | FIX | Swap only when the original pair is outside Ghana and the reversed pair is inside Ghana. | The register's stated latitude/longitude columns and geographic bounds make the correction unambiguous. |

## Issue evidence and decisions

### DQ-002: Vehicle identifier whitespace or casing

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id
- **What was discovered:** Identifiers with surrounding whitespace or noncanonical casing were compared with the official register.
- **Number of affected rows:** 356 distinct source rows.
- **Percentage affected:** 1.112% of 32001 source data rows.
- **Severity:** Low.
- **Decision:** FIX.
- **Rule applied:** Trim surrounding whitespace and convert identifiers to uppercase.
- **Reason for decision:** Case and whitespace normalization is unambiguous and leaves the register mapping unchanged.
- **Impact if untreated:** Without normalization, valid pings may be treated as unknown vehicles or split across IDs.
- **Verification:** Every retained identifier is compared against the canonical official ID set.
- **Evidence examples:**
  - Source record 181: `{"vehicle_id":" gt-1021 ","timestamp":"2026-11-18T08:29:19Z","lat":"5.568434","lon":"-0.193584","speed_kmh":"22.9","accuracy_m":"17.0"}`; candidate corrected record: `{"vehicle_id":"GT-1021","timestamp":"2026-11-18T08:29:19Z","lat":"5.568434","lon":"-0.193584","speed_kmh":"22.9","accuracy_m":"17.0"}`; Trimmed or uppercased the vehicle identifier.
  - Source record 316: `{"vehicle_id":" gt-1021 ","timestamp":"2026-11-19T10:08:47Z","lat":"5.551667","lon":"-0.097204","speed_kmh":"46.6","accuracy_m":"11.9"}`; candidate corrected record: `{"vehicle_id":"GT-1021","timestamp":"2026-11-19T10:08:47Z","lat":"5.551667","lon":"-0.097204","speed_kmh":"46.6","accuracy_m":"11.9"}`; Trimmed or uppercased the vehicle identifier.
  - Source record 353: `{"vehicle_id":" gt-1021 ","timestamp":"2026-11-19T07:58:17Z","lat":"5.689556","lon":"-0.164378","speed_kmh":"1.4","accuracy_m":"9.2"}`; candidate corrected record: `{"vehicle_id":"GT-1021","timestamp":"2026-11-19T07:58:17Z","lat":"5.689556","lon":"-0.164378","speed_kmh":"1.4","accuracy_m":"9.2"}`; Trimmed or uppercased the vehicle identifier.

### DQ-003: Vehicle identifier missing separator

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id
- **What was discovered:** The `GT` prefix and four-digit vehicle number appeared without the register's hyphen.
- **Number of affected rows:** 288 distinct source rows.
- **Percentage affected:** 0.900% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** FIX.
- **Rule applied:** Convert only `GTdddd` to `GT-dddd`, then require an exact official-register match.
- **Reason for decision:** The four-digit value maps unambiguously to the corresponding formatted register ID.
- **Impact if untreated:** Unnormalized IDs can be incorrectly rejected or fragmented in per-vehicle summaries.
- **Verification:** Check canonical IDs against the register after normalization.
- **Evidence examples:**
  - Source record 171: `{"vehicle_id":"GT1003","timestamp":"2026-11-18T09:54:50Z","lat":"5.634571","lon":"-0.131698","speed_kmh":"29.2","accuracy_m":"17.8"}`; candidate corrected record: `{"vehicle_id":"GT-1003","timestamp":"2026-11-18T09:54:50Z","lat":"5.634571","lon":"-0.131698","speed_kmh":"29.2","accuracy_m":"17.8"}`; Inserted the missing hyphen in a register-compatible vehicle ID.
  - Source record 203: `{"vehicle_id":"GT1003","timestamp":"2026-11-19T07:26:04Z","lat":"5.541388","lon":"-0.246208","speed_kmh":"1.4","accuracy_m":"19.2"}`; candidate corrected record: `{"vehicle_id":"GT-1003","timestamp":"2026-11-19T07:26:04Z","lat":"5.541388","lon":"-0.246208","speed_kmh":"1.4","accuracy_m":"19.2"}`; Inserted the missing hyphen in a register-compatible vehicle ID.
  - Source record 234: `{"vehicle_id":"GT1003","timestamp":"2026-11-18T09:47:20Z","lat":"5.630959","lon":"-0.164730","speed_kmh":"30.7","accuracy_m":"22.7"}`; candidate corrected record: `{"vehicle_id":"GT-1003","timestamp":"2026-11-18T09:47:20Z","lat":"5.630959","lon":"-0.164730","speed_kmh":"30.7","accuracy_m":"22.7"}`; Inserted the missing hyphen in a register-compatible vehicle ID.

### DQ-004: Vehicle identifier absent from official register

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id
- **What was discovered:** A syntactically valid tracker ID did not resolve to any identifier in vehicles.csv.
- **Number of affected rows:** 120 distinct source rows.
- **Percentage affected:** 0.375% of 32001 source data rows.
- **Severity:** High.
- **Decision:** DROP.
- **Rule applied:** Drop pings whose normalized vehicle_id is absent from the official register.
- **Reason for decision:** The reference register is authoritative; there is no safe vehicle mapping for an unknown ID.
- **Impact if untreated:** Unknown pings would create unregistered vehicle reporting and unreliable asset attribution.
- **Verification:** Assert every retained ping ID is in the canonical register identifier set.
- **Evidence examples:**
  - Source record 457: `{"vehicle_id":"GT-1099","timestamp":"2026-11-18T09:13:30Z","lat":"5.605400","lon":"-0.197300","speed_kmh":"25.0","accuracy_m":"8.0"}`; Vehicle ID GT-1099 is absent from vehicles.csv.
  - Source record 752: `{"vehicle_id":"GT-1099","timestamp":"2026-11-18T09:31:00Z","lat":"5.612400","lon":"-0.193800","speed_kmh":"25.0","accuracy_m":"8.0"}`; Vehicle ID GT-1099 is absent from vehicles.csv.
  - Source record 815: `{"vehicle_id":"GT-1099","timestamp":"2026-11-18T09:46:00Z","lat":"5.618400","lon":"-0.190800","speed_kmh":"25.0","accuracy_m":"8.0"}`; Vehicle ID GT-1099 is absent from vehicles.csv.

### DQ-006: Unparseable timestamp

- **Dataset:** pings.csv
- **Affected columns:** timestamp
- **What was discovered:** The timestamp did not match a supported ISO-8601, day/month/year, or Unix-seconds representation.
- **Number of affected rows:** 8 distinct source rows.
- **Percentage affected:** 0.025% of 32001 source data rows.
- **Severity:** High.
- **Decision:** DROP.
- **Rule applied:** Drop timestamps that cannot be parsed strictly to a valid instant.
- **Reason for decision:** The original timestamp does not provide a defensible time value.
- **Impact if untreated:** Unparseable times can break sequence ordering, trip boundaries, and interval calculations.
- **Verification:** All retained values must be valid UTC ISO-8601 timestamps.
- **Evidence examples:**
  - Source record 1871: `{"vehicle_id":"GT-1005","timestamp":"1770","lat":"5.662192","lon":"-0.269066","speed_kmh":"1.3","accuracy_m":"20.8"}`; Timestamp could not be parsed using the supported formats.
  - Source record 3432: `{"vehicle_id":"GT-1013","timestamp":"1159","lat":"5.692552","lon":"-0.289942","speed_kmh":"1.2","accuracy_m":"22.7"}`; Timestamp could not be parsed using the supported formats.
  - Source record 9554: `{"vehicle_id":"GT-1005","timestamp":"1400","lat":"5.540677","lon":"-0.225691","speed_kmh":"0.9","accuracy_m":"20.1"}`; Timestamp could not be parsed using the supported formats.

### DQ-007: Timestamp outside assessment period

- **Dataset:** pings.csv
- **Affected columns:** timestamp
- **What was discovered:** A parseable timestamp fell outside 17–19 November 2026 after conversion to UTC.
- **Number of affected rows:** 46 distinct source rows.
- **Percentage affected:** 0.144% of 32001 source data rows.
- **Severity:** High.
- **Decision:** DROP.
- **Rule applied:** Keep only UTC instants in [2026-11-17T00:00:00Z, 2026-11-20T00:00:00Z).
- **Reason for decision:** The assessment defines this three-day period; out-of-period rows are not part of the target dataset.
- **Impact if untreated:** Extraneous times can inflate reporting periods and create enormous false movement intervals.
- **Verification:** Assert every retained UTC timestamp falls within the documented half-open interval.
- **Evidence examples:**
  - Source record 1941: `{"vehicle_id":"GT-1008","timestamp":"1970-01-01T00:51:16Z","lat":"5.573443","lon":"-0.173455","speed_kmh":"18.3","accuracy_m":"7.0"}`; UTC timestamp 1970-01-01T00:51:16.000Z is outside the assessment period.
  - Source record 2436: `{"vehicle_id":"GT-1001","timestamp":"1970-01-01T00:27:56Z","lat":"5.578432","lon":"-0.222440","speed_kmh":"25.6","accuracy_m":"11.3"}`; UTC timestamp 1970-01-01T00:27:56.000Z is outside the assessment period.
  - Source record 2467: `{"vehicle_id":"GT-1010","timestamp":"1970-01-01T00:50:08Z","lat":"5.619493","lon":"-0.257952","speed_kmh":"45.0","accuracy_m":"4.5"}`; UTC timestamp 1970-01-01T00:50:08.000Z is outside the assessment period.

### DQ-008: Timestamp format or timezone normalization

- **Dataset:** pings.csv
- **Affected columns:** timestamp
- **What was discovered:** Parseable timestamps used Unix seconds, explicit non-UTC offsets, or day/month/year notation.
- **Number of affected rows:** 5264 distinct source rows.
- **Percentage affected:** 16.449% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** FIX.
- **Rule applied:** Parse supported timestamp formats, treat timezone-naive values as UTC (Ghana), and serialize as UTC ISO-8601.
- **Reason for decision:** The source context states UTC/Ghana; explicit offsets are converted to UTC rather than discarded.
- **Impact if untreated:** Mixed representations can break sorting, joins, and date grouping.
- **Verification:** Retained timestamps use canonical `YYYY-MM-DDTHH:mm:ss.sssZ` serialization and parse to the original instant.
- **Evidence examples:**
  - Source record 13: `{"vehicle_id":"GT-1005","timestamp":"1795073180","lat":"5.680734","lon":"-0.170900","speed_kmh":"0.1","accuracy_m":"19.0"}`; candidate corrected record: `{"vehicle_id":"GT-1005","timestamp":"2026-11-19T07:26:20Z","lat":"5.680734","lon":"-0.170900","speed_kmh":"0.1","accuracy_m":"19.0"}`; Normalized the timestamp to canonical UTC ISO-8601.
  - Source record 23: `{"vehicle_id":"GT-1019","timestamp":"2026-11-18T08:18:47+01:00","lat":"5.638978","lon":"-0.102668","speed_kmh":"24.4","accuracy_m":"17.3"}`; candidate corrected record: `{"vehicle_id":"GT-1019","timestamp":"2026-11-18T07:18:47Z","lat":"5.638978","lon":"-0.102668","speed_kmh":"24.4","accuracy_m":"17.3"}`; Normalized the timestamp to canonical UTC ISO-8601.
  - Source record 28: `{"vehicle_id":"GT-1013","timestamp":"1794908075","lat":"5.630311","lon":"-0.242164","speed_kmh":"0.9","accuracy_m":"3.5"}`; candidate corrected record: `{"vehicle_id":"GT-1013","timestamp":"2026-11-17T09:34:35Z","lat":"5.630311","lon":"-0.242164","speed_kmh":"0.9","accuracy_m":"3.5"}`; Normalized the timestamp to canonical UTC ISO-8601.

### DQ-010: Decimal-comma coordinates

- **Dataset:** pings.csv
- **Affected columns:** lat, lon
- **What was discovered:** Coordinates used a single comma as the decimal separator.
- **Number of affected rows:** 102 distinct source rows.
- **Percentage affected:** 0.319% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** FIX.
- **Rule applied:** Replace a comma with a decimal point only for a coordinate matching a signed decimal-comma number.
- **Reason for decision:** The observed coordinate form is unambiguous and the resulting value is checked against geographic bounds.
- **Impact if untreated:** Unparsed coordinates can be dropped or incorrectly interpreted during spatial analysis.
- **Verification:** Confirm the normalized pair parses numerically and is within the accepted Ghana bounds.
- **Evidence examples:**
  - Source record 387: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T08:31:54Z","lat":"5,571997","lon":"-0,197524","speed_kmh":"27.4","accuracy_m":"13.4"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T08:31:54Z","lat":"5.571997","lon":"-0.197524","speed_kmh":"27.4","accuracy_m":"13.4"}`; Converted unambiguous decimal-comma coordinate notation to a decimal point.
  - Source record 455: `{"vehicle_id":"GT-1002","timestamp":"2026-11-18T09:55:20Z","lat":"5,662646","lon":"-0,301884","speed_kmh":"18.1","accuracy_m":"14.2"}`; candidate corrected record: `{"vehicle_id":"GT-1002","timestamp":"2026-11-18T09:55:20Z","lat":"5.662646","lon":"-0.301884","speed_kmh":"18.1","accuracy_m":"14.2"}`; Converted unambiguous decimal-comma coordinate notation to a decimal point.
  - Source record 480: `{"vehicle_id":"GT-1022","timestamp":"2026-11-18T07:46:48Z","lat":"5,670521","lon":"-0,152869","speed_kmh":"45.8","accuracy_m":"15.2"}`; candidate corrected record: `{"vehicle_id":"GT-1022","timestamp":"2026-11-18T07:46:48Z","lat":"5.670521","lon":"-0.152869","speed_kmh":"45.8","accuracy_m":"15.2"}`; Converted unambiguous decimal-comma coordinate notation to a decimal point.

### DQ-011: Latitude and longitude reversed

- **Dataset:** pings.csv
- **Affected columns:** lat, lon
- **What was discovered:** A coordinate pair was outside Ghana in its supplied order but inside Ghana when latitude and longitude were exchanged.
- **Number of affected rows:** 318 distinct source rows.
- **Percentage affected:** 0.994% of 32001 source data rows.
- **Severity:** High.
- **Decision:** FIX.
- **Rule applied:** Swap the pair only when the original is outside the Ghana bounds and the reversed pair is inside them.
- **Reason for decision:** The bounded geographic context makes this correction unambiguous for the observed records.
- **Impact if untreated:** Uncorrected axis order can place a vehicle on another continent and produce impossible route distances.
- **Verification:** Recheck corrected coordinates against WGS 84 ranges and Ghana bounds.
- **Evidence examples:**
  - Source record 35: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T07:02:24Z","lat":"-0.163103","lon":"5.621411","speed_kmh":"30.2","accuracy_m":"15.1"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T07:02:24Z","lat":"5.621411","lon":"-0.163103","speed_kmh":"30.2","accuracy_m":"15.1"}`; Swapped coordinate axes because only the reversed pair falls within Ghana bounds.
  - Source record 141: `{"vehicle_id":"GT-1014","timestamp":"2026-11-17T12:04:48Z","lat":"-0.085183","lon":"5.589418","speed_kmh":"24.5","accuracy_m":"23.6"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-17T12:04:48Z","lat":"5.589418","lon":"-0.085183","speed_kmh":"24.5","accuracy_m":"23.6"}`; Swapped coordinate axes because only the reversed pair falls within Ghana bounds.
  - Source record 192: `{"vehicle_id":"GT-1014","timestamp":"2026-11-17T10:10:48Z","lat":"-0.218983","lon":"5.616896","speed_kmh":"31.9","accuracy_m":"23.8"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-17T10:10:48Z","lat":"5.616896","lon":"-0.218983","speed_kmh":"31.9","accuracy_m":"23.8"}`; Swapped coordinate axes because only the reversed pair falls within Ghana bounds.

### DQ-012: Zero, invalid, or out-of-area coordinates

- **Dataset:** pings.csv
- **Affected columns:** lat, lon
- **What was discovered:** The pair was not a usable location in the expected Ghana operating area, including zero-coordinate defaults.
- **Number of affected rows:** 148 distinct source rows.
- **Percentage affected:** 0.462% of 32001 source data rows.
- **Severity:** High.
- **Decision:** DROP.
- **Rule applied:** After decimal and axis-order repairs, drop nonnumeric, WGS 84-invalid, zero, or out-of-Ghana pairs.
- **Reason for decision:** No reliable location can be recovered from these observations using the available source data.
- **Impact if untreated:** Bad positions can create false trips, extreme distances, and misleading spatial summaries.
- **Verification:** Assert every retained pair is nonzero, WGS 84-valid, and inside the documented Ghana bounds.
- **Evidence examples:**
  - Source record 173: `{"vehicle_id":"GT-1024","timestamp":"2026-11-17T10:25:58Z","lat":"0.000000","lon":"0.000000","speed_kmh":"36.7","accuracy_m":"19.3"}`; Zero coordinate values are not credible locations for the Ghana operating area.
  - Source record 682: `{"vehicle_id":"GT-1010","timestamp":"2026-11-17T08:22:28Z","lat":"0.000000","lon":"0.000000","speed_kmh":"33.9","accuracy_m":"22.2"}`; Zero coordinate values are not credible locations for the Ghana operating area.
  - Source record 751: `{"vehicle_id":"GT-1004","timestamp":"2026-11-17T09:50:29Z","lat":"0.000000","lon":"0.000000","speed_kmh":"0.6","accuracy_m":"7.9"}`; Zero coordinate values are not credible locations for the Ghana operating area.

### DQ-013: Exact duplicate GPS reading

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id, timestamp, lat, lon, speed_kmh, accuracy_m
- **What was discovered:** The same normalized six-field GPS record occurred more than once.
- **Number of affected rows:** 605 distinct source rows.
- **Percentage affected:** 1.891% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** DROP.
- **Rule applied:** Keep the earliest source record for each identical normalized record and drop later copies.
- **Reason for decision:** An identical repeat adds no new observation; preserving the first occurrence is deterministic.
- **Impact if untreated:** Duplicates inflate ping counts and can produce zero-duration segments or bias reporting intervals.
- **Verification:** Confirm there is one retained row per exact normalized record and each removed copy is listed in rejects.csv.
- **Evidence examples:**
  - Source record 974: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T07:02:24Z","lat":"-0.163103","lon":"5.621411","speed_kmh":"30.2","accuracy_m":"15.1"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-18T07:02:24Z","lat":"5.621411","lon":"-0.163103","speed_kmh":"30.2","accuracy_m":"15.1"}`; Exact duplicate of the earlier normalized source record at row 35.
  - Source record 1616: `{"vehicle_id":"GT-1003","timestamp":"2026-11-17T10:44:28Z","lat":"5.615180","lon":"-0.210805","speed_kmh":"21.7","accuracy_m":"3.3"}`; Exact duplicate of the earlier normalized source record at row 1302.
  - Source record 1635: `{"vehicle_id":"GT-1010","timestamp":"2026-11-17T08:06:58Z","lat":"5.551203","lon":"-0.129555","speed_kmh":"0.8","accuracy_m":"17.3"}`; Exact duplicate of the earlier normalized source record at row 1608.

### DQ-016: Invalid speed measurement

- **Dataset:** pings.csv
- **Affected columns:** speed_kmh
- **What was discovered:** Speed was nonnumeric or negative, so it cannot represent a valid speed.
- **Number of affected rows:** 124 distinct source rows.
- **Percentage affected:** 0.387% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** FIX.
- **Rule applied:** Replace an unparseable or negative speed with an empty value; retain the GPS position.
- **Reason for decision:** The invalid measurement can be isolated without discarding otherwise usable location data.
- **Impact if untreated:** An invalid speed could distort movement and trip metrics.
- **Verification:** Every retained non-empty speed is numeric and nonnegative; original values remain in rejects.csv.
- **Evidence examples:**
  - Source record 320: `{"vehicle_id":"GT-1015","timestamp":"2026-11-18T09:49:14Z","lat":"5.577061","lon":"-0.194291","speed_kmh":"-1","accuracy_m":"9.9"}`; candidate corrected record: `{"vehicle_id":"GT-1015","timestamp":"2026-11-18T09:49:14Z","lat":"5.577061","lon":"-0.194291","speed_kmh":"","accuracy_m":"9.9"}`; Replaced a nonnumeric or negative speed with an empty value.
  - Source record 540: `{"vehicle_id":"GT-1010","timestamp":"2026-11-18T08:45:44Z","lat":"5.600194","lon":"-0.194569","speed_kmh":"-1","accuracy_m":"6.9"}`; candidate corrected record: `{"vehicle_id":"GT-1010","timestamp":"2026-11-18T08:45:44Z","lat":"5.600194","lon":"-0.194569","speed_kmh":"","accuracy_m":"6.9"}`; Replaced a nonnumeric or negative speed with an empty value.
  - Source record 839: `{"vehicle_id":"GT-1013","timestamp":"1794912785","lat":"5.597835","lon":"-0.163682","speed_kmh":"-1","accuracy_m":"11.9"}`; candidate corrected record: `{"vehicle_id":"GT-1013","timestamp":"2026-11-17T10:53:05Z","lat":"5.597835","lon":"-0.163682","speed_kmh":"","accuracy_m":"11.9"}`; Replaced a nonnumeric or negative speed with an empty value.

### DQ-020: Poor GPS accuracy

- **Dataset:** pings.csv
- **Affected columns:** accuracy_m
- **What was discovered:** Accuracy exceeded 100 m, which is too imprecise for confident local fleet mapping.
- **Number of affected rows:** 145 distinct source rows.
- **Percentage affected:** 0.453% of 32001 source data rows.
- **Severity:** Medium.
- **Decision:** FLAG.
- **Rule applied:** Retain readings with accuracy greater than 100 m and flag them; do not use them to diagnose GPS jumps.
- **Reason for decision:** Poor accuracy is suspicious, but the observation may still be useful and should not be silently removed.
- **Impact if untreated:** Low-confidence coordinates can distort short distance estimates or geofence analysis.
- **Verification:** The reported accuracy is unchanged and the issue ID is included in the clean output.
- **Evidence examples:**
  - Source record 1142: `{"vehicle_id":"GT-1012","timestamp":"2026-11-17T07:00:52Z","lat":"5.640341","lon":"-0.166530","speed_kmh":"26.2","accuracy_m":"718.5"}`; candidate corrected record: `{"vehicle_id":"GT-1012","timestamp":"2026-11-17T07:00:52Z","lat":"5.640341","lon":"-0.166530","speed_kmh":"26.2","accuracy_m":"718.5"}`; Reported accuracy 718.5 m exceeds the 100 m quality threshold.
  - Source record 1248: `{"vehicle_id":"GT-1004","timestamp":"2026-11-17T06:53:29Z","lat":"5.611906","lon":"-0.205415","speed_kmh":"41.1","accuracy_m":"642.2"}`; candidate corrected record: `{"vehicle_id":"GT-1004","timestamp":"2026-11-17T06:53:29Z","lat":"5.611906","lon":"-0.205415","speed_kmh":"41.1","accuracy_m":"642.2"}`; Reported accuracy 642.2 m exceeds the 100 m quality threshold.
  - Source record 1434: `{"vehicle_id":"GT-1018","timestamp":"2026-11-19T08:42:43Z","lat":"5.635399","lon":"-0.115740","speed_kmh":"19.5","accuracy_m":"751.6"}`; candidate corrected record: `{"vehicle_id":"GT-1018","timestamp":"2026-11-19T08:42:43Z","lat":"5.635399","lon":"-0.115740","speed_kmh":"19.5","accuracy_m":"751.6"}`; Reported accuracy 751.6 m exceeds the 100 m quality threshold.

### DQ-021: Physically implausible implied GPS speed

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id, timestamp, lat, lon, accuracy_m
- **What was discovered:** Consecutive high-accuracy positions implied travel faster than 160 km/h over no more than 30 minutes.
- **Number of affected rows:** 275 distinct source rows.
- **Percentage affected:** 0.859% of 32001 source data rows.
- **Severity:** High.
- **Decision:** FLAG.
- **Rule applied:** Flag both endpoints of a segment whose haversine speed exceeds 160 km/h; retain both source readings.
- **Reason for decision:** The location error cannot be assigned safely to either endpoint, so neither point is discarded.
- **Impact if untreated:** Such a segment can materially inflate route distance and create false movement.
- **Verification:** Recalculate speed from retained UTC timestamps and coordinates; each endpoint is traceable in the issues output.
- **Evidence examples:**
  - Source record 255: `{"vehicle_id":"GT-1012","timestamp":"2026-11-19T09:49:15Z","lat":"5.575456","lon":"-0.290642","speed_kmh":"0.4","accuracy_m":"11.6"}`; candidate corrected record: `{"vehicle_id":"GT-1012","timestamp":"2026-11-19T09:49:15Z","lat":"5.575456","lon":"-0.290642","speed_kmh":"0.4","accuracy_m":"11.6"}`; Adjacent high-accuracy points imply travel above 160 km/h.; detail: Segment source rows 255-27046; distance_km: 13.696; interval_seconds: 30.0; implied_speed_kmh: 1643.6
  - Source record 310: `{"vehicle_id":"GT-1002","timestamp":"2026-11-18T08:44:20Z","lat":"5.542163","lon":"-0.132057","speed_kmh":"0.9","accuracy_m":"7.1"}`; candidate corrected record: `{"vehicle_id":"GT-1002","timestamp":"2026-11-18T08:44:20Z","lat":"5.542163","lon":"-0.132057","speed_kmh":"0.9","accuracy_m":"7.1"}`; Adjacent high-accuracy points imply travel above 160 km/h.; detail: Segment source rows 310-23019; distance_km: 14.393; interval_seconds: 30.0; implied_speed_kmh: 1727.2
  - Source record 466: `{"vehicle_id":"GT-1015","timestamp":"2026-11-19T08:58:30Z","lat":"5.610656","lon":"-0.113127","speed_kmh":"25.6","accuracy_m":"12.2"}`; candidate corrected record: `{"vehicle_id":"GT-1015","timestamp":"2026-11-19T08:58:30Z","lat":"5.610656","lon":"-0.113127","speed_kmh":"25.6","accuracy_m":"12.2"}`; Adjacent high-accuracy points imply travel above 160 km/h.; detail: Segment source rows 466-6009; distance_km: 16.668; interval_seconds: 30.0; implied_speed_kmh: 2000.2

### DQ-022: Unusually long reporting interval

- **Dataset:** pings.csv
- **Affected columns:** vehicle_id, timestamp
- **What was discovered:** The interval since the preceding retained position exceeded 90 seconds, versus the expected approximate 30-second cadence.
- **Number of affected rows:** 48 distinct source rows.
- **Percentage affected:** 0.150% of 32001 source data rows.
- **Severity:** Low.
- **Decision:** FLAG.
- **Rule applied:** Flag the later reading when the preceding interval is greater than 90 seconds.
- **Reason for decision:** A gap may reflect tracker downtime or normal switched-off operation; it is not evidence that either endpoint is erroneous.
- **Impact if untreated:** Unobserved travel across gaps can make route distances and trip timing incomplete.
- **Verification:** Recompute sorted per-vehicle intervals and confirm flagged endpoints remain in the cleaned output.
- **Evidence examples:**
  - Source record 185: `{"vehicle_id":"GT-1018","timestamp":"2026-11-19T06:52:13Z","lat":"5.634670","lon":"-0.106270","speed_kmh":"19.0","accuracy_m":"7.1"}`; candidate corrected record: `{"vehicle_id":"GT-1018","timestamp":"2026-11-19T06:52:13Z","lat":"5.634670","lon":"-0.106270","speed_kmh":"19.0","accuracy_m":"7.1"}`; Reporting interval of 70661.0 seconds exceeds the 90-second review threshold.; detail: Previous source row: 30223; interval_seconds: 70661.0
  - Source record 2020: `{"vehicle_id":"GT-1024","timestamp":"2026-11-18T06:40:45Z","lat":"5.644401","lon":"-0.092101","speed_kmh":"35.3","accuracy_m":"12.6"}`; candidate corrected record: `{"vehicle_id":"GT-1024","timestamp":"2026-11-18T06:40:45Z","lat":"5.644401","lon":"-0.092101","speed_kmh":"35.3","accuracy_m":"12.6"}`; Reporting interval of 69227.0 seconds exceeds the 90-second review threshold.; detail: Previous source row: 2450; interval_seconds: 69227.0
  - Source record 2981: `{"vehicle_id":"GT-1014","timestamp":"2026-11-19T06:34:10Z","lat":"5.635158","lon":"-0.108288","speed_kmh":"46.3","accuracy_m":"16.0"}`; candidate corrected record: `{"vehicle_id":"GT-1014","timestamp":"2026-11-19T06:34:10Z","lat":"5.635158","lon":"-0.108288","speed_kmh":"46.3","accuracy_m":"16.0"}`; Reporting interval of 65986.0 seconds exceeds the 90-second review threshold.; detail: Previous source row: 6082; interval_seconds: 65986.0

### VQ-002: Duplicate official vehicle identifier

- **Dataset:** vehicles.csv
- **Affected columns:** vehicle_id, plate, depot
- **What was discovered:** More than one register row used the same normalized identifier, with different vehicle/depot attributes.
- **Number of affected rows:** 2 distinct source rows.
- **Percentage affected:** 8.000% of 25 source data rows.
- **Severity:** High.
- **Decision:** FLAG.
- **Rule applied:** Retain and flag every row in a duplicate-ID group; never choose a preferred row automatically.
- **Reason for decision:** The source register does not establish which conflicting record is authoritative.
- **Impact if untreated:** Vehicle plate/depot attribution can be ambiguous even when tracker IDs match.
- **Verification:** Confirm all duplicate register rows remain traceable and the summary reports the non-unique ID.
- **Evidence examples:**
  - Source record 9: `{"vehicle_id":"GT-1008","plate":"GR 8414-22","depot":"Tema Motorway","depot_lat":"5.6460","depot_lon":"-0.0900"}`; candidate corrected record: `{"vehicle_id":"GT-1008","plate":"GR 8414-22","depot":"Tema Motorway","depot_lat":"5.6460","depot_lon":"-0.0900"}`; Official register ID GT-1008 has multiple records with conflicting vehicle attributes.
  - Source record 10: `{"vehicle_id":"GT-1008","plate":"GR 7731-21","depot":"Spintex","depot_lat":"5.6340","depot_lon":"-0.1050"}`; candidate corrected record: `{"vehicle_id":"GT-1008","plate":"GR 7731-21","depot":"Spintex","depot_lat":"5.6340","depot_lon":"-0.1050"}`; Official register ID GT-1008 has multiple records with conflicting vehicle attributes.

### VQ-004: Reversed depot coordinate axes

- **Dataset:** vehicles.csv
- **Affected columns:** depot_lat, depot_lon
- **What was discovered:** A depot pair was out of Ghana in its supplied order but valid in Ghana when swapped.
- **Number of affected rows:** 1 distinct source rows.
- **Percentage affected:** 4.000% of 25 source data rows.
- **Severity:** High.
- **Decision:** FIX.
- **Rule applied:** Swap only when the original pair is outside Ghana and the reversed pair is inside Ghana.
- **Reason for decision:** The register's stated latitude/longitude columns and geographic bounds make the correction unambiguous.
- **Impact if untreated:** An invalid depot point can break depot proximity and vehicle-home-depot analytics.
- **Verification:** Check corrected depot coordinates against WGS 84 and Ghana bounds.
- **Evidence examples:**
  - Source record 16: `{"vehicle_id":"GT-1014","plate":"GR 5532-23","depot":"Spintex","depot_lat":"-0.1050","depot_lon":"5.6340"}`; candidate corrected record: `{"vehicle_id":"GT-1014","plate":"GR 5532-23","depot":"Spintex","depot_lat":"5.634","depot_lon":"-0.105"}`; Swapped coordinate axes because only the reversed pair falls within Ghana bounds.

## Investigation checks with no issue rows

A check listed here was executed and found no records requiring a separate issue entry. Any nonzero finding appears in the central issue register.

| Check | Result |
|---|---|
| Missing vehicle IDs | No findings |
| Malformed vehicle IDs | No findings |
| Missing timestamps | No findings |
| Unparseable timestamps | 8 affected source rows (see issue register) |
| Missing latitude/longitude components | No findings |
| Decimal-comma coordinates | 102 affected source rows (see issue register) |
| Coordinates invalid or outside expected Ghana bounds after safe repair | 148 affected source rows (see issue register) |
| Negative or nonnumeric speeds | 124 affected source rows (see issue register) |
| Speeds over 160 km/h | No findings |
| Missing speed measurements | No findings |
| Missing accuracy measurements | No findings |
| Invalid accuracy measurements | No findings |
| Accuracy measurements over 100 m | 145 affected source rows (see issue register) |
| Numeric-field surrounding whitespace | No findings |
| Same-vehicle/same-instant conflicting measurements | No findings |
| Missing vehicle register ID, plate, or depot | No findings |
| Malformed vehicle register IDs | No findings |
| Vehicle register surrounding whitespace | No findings |
| Invalid or missing depot coordinates | No findings |

## GPS sequence observations

- Adjacent retained positions within 5 m and 90 seconds: **5503 pairs**. This pattern is consistent with stationary vehicles and is not classified as an error by itself.
- Consecutive reporting intervals over 90 seconds: **48 intervals**; each later endpoint is flagged when present in the retained dataset.
- Reporting interval seconds: median **30**, 95th percentile **30**, maximum **161857**.
- Implied speeds above 160 km/h across intervals no longer than 30 minutes: **184 segments**. Endpoints with usable accuracy are retained and flagged; this finding does not assert which coordinate is wrong.

## Cleaned-data quality summary

The pipeline retained 31076 pings with registered vehicle IDs, canonical UTC timestamps, and nonzero coordinates inside the expected Ghana envelope. The official vehicle register retains 25 rows, including conflicting duplicate IDs that are preserved and flagged rather than resolved arbitrarily. Poor accuracy, speed outliers, suspicious jumps, and reporting gaps are retained as reviewable observations.

## Validation results

| Validation | Passed | Evidence |
|---|---|---|
| Required CSV columns exist | Yes | Both input schemas were checked before processing. |
| Every retained ping has a registered vehicle ID | Yes | 31076 retained pings checked against 24 unique normalized register IDs. |
| Vehicle register IDs, plates, and depots are populated | Yes | 25 retained register rows checked; missing fields remain explicitly flagged. |
| Retained coordinates are populated and inside Ghana bounds | Yes | 31076 retained coordinate pairs checked. |
| Retained timestamps are normalized UTC ISO-8601 | Yes | 31076 retained timestamps checked. |
| Retained timestamps are within the assessment period | Yes | Every retained UTC timestamp falls from 17 November up to (but not including) 20 November 2026. |
| No exact normalized ping duplicates remain | Yes | 31076 cleaned ping records checked for duplicate six-field signatures. |
| Retained speed and accuracy values are valid when present | Yes | 31076 retained speed and accuracy values checked; missing values remain traceable as quality issues. |
| Exact duplicate removal is auditable | Yes | 605 duplicate source rows were removed and referenced in rejects.csv. |
| Every changed or dropped record is in rejects.csv | Yes | 7147 changed or dropped source records are present in rejects.csv. |
| Ping row counts reconcile | Yes | 32001 = 31076 retained + 925 dropped. |
| Vehicle register row counts reconcile | Yes | 25 = 25 retained + 0 dropped. |
| Flagged observations are retained and traceable | Yes | Flagged retained rows are represented in data_quality_issues.csv and carry quality_issue_ids. |

## Limitations and assumptions

- The expected operating area is treated as Ghana using latitude 4–12 and longitude -4–2; coordinates elsewhere are rejected after attempting only the unambiguous axis swap.
- Naive day/month/year timestamps are interpreted as UTC/Ghana time. Explicit numeric offsets are honored and converted to UTC.
- Unix timestamps are accepted only in the observed 10-digit seconds format.
- The duplicate vehicle register ID is not auto-resolved because the source contains conflicting plate/depot attributes; an authoritative register correction is required.
- A 100 m accuracy limit, 160 km/h speed screen, 90 second reporting-gap threshold, and 30 minute jump interval are explicit review rules, not claims that every flagged observation is erroneous.
- Repeated nearby points may represent a legitimate stop. They are reported as telemetry context and are not removed.
- Source row numbers include the header as row 1; the current source files contain one physical line per record.

Input SHA-256: pings.csv `2991df8e2a253071a62ffbf80470584d55046855dd0c4769a53dfb0bfbbe08bd`; vehicles.csv `184a3cf4213ce6b48d999a28673038fc849a5cd0d391dd9c3b082b19a23c218d`.

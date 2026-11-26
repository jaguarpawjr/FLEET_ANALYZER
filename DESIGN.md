# Design note

## Cleaning decisions

All source rows remain available in `data/raw`. A reject/anomaly row records the source vehicle and timestamp, issue type, reason and action; changed data is not silently discarded. Unknown vehicle IDs, unparsable times, coordinates outside Ghana, and missing/negative/over-100 m horizontal accuracy are dropped because they cannot be reliably associated or located. Exact duplicates are dropped to avoid double-counting. Speeds outside 0–160 km/h are set to unknown while retaining the position; they are not credible speed evidence, but the location may still be useful. Parseable times are normalized to UTC ISO-8601. Zone rings are checked for usable polygon structure and closure; closeable rings are repaired and recorded, while unusable rings are recorded and dropped.

The 100 m accuracy limit is a conservative operational threshold; it avoids presenting very uncertain positions as precise stops or zone violations. The speed ceiling protects against tracker glitches without treating a single bad speed as a bad GPS coordinate.

## Inefficient trips

A movement segment is review-flagged when it lasts more than 60 minutes but covers less than 5 km between detected stops. It highlights long, low-progress movement for dispatcher review without assuming the cause (congestion, loading, road closures or a tracker problem). It is an initial heuristic, not a benchmark against route plans. Stops require consecutive readings below 5 km/h (or unknown speed) spanning at least five minutes.

## Scale to 5,000 vehicles and 5-second pings

Trackers publish through AWS IoT Core with device identities and TLS. IoT rules route messages to Kinesis Data Streams; a Flink application on Amazon Managed Service for Apache Flink validates timestamps/coordinates, deduplicates by vehicle and event-time window, detects stops/trips and checks geofences in real time. Amazon DynamoDB stores recent vehicle state and alert cooldowns; Amazon SNS delivers departure-from-expected-area alerts to operations. Kinesis Data Firehose writes immutable raw messages to partitioned Amazon S3, while curated Parquet aggregates are queried with Athena and catalogued in Glue. The API reads hot vehicle status from DynamoDB and historical aggregates from S3/Athena. CloudWatch collects service metrics/logs; dead-letter messages go to SQS for replay. Backpressure, event-time watermarks, idempotency keys and retention policies are necessary at this rate.

## One more week

Validate against the full assessment files and an operations-approved threshold set; add interval-aware zone crossing (including boundary interpolation), robust polygon validity/repair with a tested GIS library, end-to-end API and dashboard tests, vehicle/depot register anomaly reporting, and pagination/authentication for production. I would also capture a real dashboard screenshot against the supplied data and compare distance/stop estimates with known journeys.

## Method and limitations

Distance uses haversine distance on WGS84 longitude/latitude coordinates. It is suitable for vehicle-scale distances around Greater Accra and avoids treating angular degrees as a flat metric. A 20 m Douglas–Peucker-style tolerance simplifies display routes. Restricted time is an endpoint-in-polygon interval estimate and may miss a zone crossing between pings. The sample dataset is synthetic because the actual assessment inputs were not included in the repository.

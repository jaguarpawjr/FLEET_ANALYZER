import { runPipeline } from "../src/analytics.js";

runPipeline(process.argv[2] ?? "data/raw", process.argv[3] ?? "data/processed")
  .then(() => console.log("Fleet analytics outputs written to data/processed"))
  .catch((error: unknown) => { console.error(error); process.exitCode = 1; });

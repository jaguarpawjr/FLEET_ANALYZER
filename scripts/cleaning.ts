import { runDataCleaningPipeline } from "../src/data-cleaning/reports.js";

runDataCleaningPipeline(process.argv[2] ?? ".", process.argv[3] ?? ".")
  .catch((error: unknown) => {
    console.error("Data cleaning failed:", error);
    process.exitCode = 1;
  });

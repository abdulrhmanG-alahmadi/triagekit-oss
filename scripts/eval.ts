import { readFileSync, rmSync } from "node:fs";
import { toArchive, writeArchive } from "../eval/archive.mjs";
import { getEvaluationSet } from "../eval/promptfooconfig.mjs";

const set = getEvaluationSet(process.env.EVAL_SET).provenance.id;
// Keep regression, heldout and fake evidence in separate archives.
const archive =
  process.env.EVAL_EXPECT_PROVIDER === "fake"
    ? `tmp/promptfoo/fake-${set === "heldout" ? "heldout-" : ""}results.json`
    : `eval/${set === "heldout" ? "heldout-" : ""}results.json`;
const env = {
  ...process.env,
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  PROMPTFOO_CONFIG_DIR: "tmp/promptfoo",
  PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
};

async function run(...command: string[]) {
  const child = Bun.spawn(command, {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return child.exited;
}

try {
  // Setup failures must not reuse a previous evaluation's output.
  rmSync("tmp/promptfoo/results.json", { force: true });
  const status = await run(
    "npx",
    "--yes",
    "promptfoo@0.122.2",
    "eval",
    "--config",
    "eval/promptfooconfig.mjs",
    // Every case must hit the live classifier: a cached row is not evidence.
    "--no-cache",
    "--no-share",
    // Three classifications per case, so nondeterminism shows up in the archive.
    "--repeat",
    "3",
    "--output",
    "tmp/promptfoo/results.json",
  );
  if (status !== 0 && status !== 100)
    throw new Error(`Promptfoo exited with status ${status}`);
  const writtenPath = writeArchive(
    toArchive(
      JSON.parse(readFileSync("tmp/promptfoo/results.json", "utf8")),
      set,
    ),
    archive,
  );
  const reportStatus = await run("bun", "eval/report.mjs", writtenPath);
  process.exitCode = status || reportStatus ? 1 : 0;
} catch (error) {
  console.error(
    JSON.stringify({
      event: "eval_failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}

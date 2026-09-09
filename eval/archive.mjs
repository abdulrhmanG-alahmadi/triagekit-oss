import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getEvaluationSet } from "./promptfooconfig.mjs";
import { checkArchive } from "./report.mjs";

export function toArchive(raw, setName = "regression") {
  const { cases: evaluationCases, provenance } = getEvaluationSet(setName);
  // Descriptions have changed over time; match the selected set's ticket text.
  const byTicket = new Map(
    evaluationCases.map((test) => [
      `${test.vars.subject}\n${test.vars.body}`,
      test,
    ]),
  );
  const rows = raw?.results?.results;
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error("Promptfoo output has no results");
  let run;
  const results = new Map();
  for (const row of rows) {
    const test = byTicket.get(`${row.vars?.subject}\n${row.vars?.body}`);
    if (!test)
      throw new Error(
        `Promptfoo row ${row.id} does not match any current evaluation case`,
      );
    // Assertion failures also set row.error; only execution failures (2) lack a scoreable response.
    if (
      row.response?.error ||
      row.failureReason === 2 ||
      row.response?.output === undefined
    ) {
      const error = row.response?.error || row.error;
      if (typeof error !== "string" || !error.trim())
        throw new Error(`Promptfoo row ${row.id} has no output or error`);
      results.set(test.vars.caseId, [
        ...(results.get(test.vars.caseId) ?? []),
        { error },
      ]);
      continue;
    }
    const { model, promptVersion, classifiedAt, ticketId } =
      row.response.metadata ?? {};
    run ??= { model, promptVersion };
    if (model !== run.model || promptVersion !== run.promptVersion)
      throw new Error(
        `Promptfoo output mixes runs: ${run.model} (${run.promptVersion}) and ${model} (${promptVersion})`,
      );
    results.set(test.vars.caseId, [
      ...(results.get(test.vars.caseId) ?? []),
      { classification: row.response.output, ticketId, classifiedAt },
    ]);
  }
  const repeats = results.get(evaluationCases[0].vars.caseId)?.length;
  if (!repeats)
    throw new Error(
      `Promptfoo output has no results for ${evaluationCases[0].vars.caseId}`,
    );
  const archive = {
    dataset: { ...provenance },
    promptfooVersion: raw.metadata?.promptfooVersion,
    model: run?.model ?? null,
    promptVersion: run?.promptVersion ?? null,
    timestamp: raw.results.timestamp,
    repeats,
    note: "The API-backed provider does not report token usage or cost, so those are absent.",
    cases: evaluationCases.map((test) => {
      const cases = results.get(test.vars.caseId);
      if (cases?.length !== repeats)
        throw new Error(
          `Promptfoo output has ${cases?.length ?? 0} of ${repeats} results for ${test.vars.caseId}`,
        );
      return {
        id: test.vars.caseId,
        description: test.description,
        expected: {
          category: test.vars.category,
          priority: test.vars.priority,
        },
        results: cases,
      };
    }),
  };
  checkArchive(archive);
  return archive;
}

export function writeArchive(archive, target = "eval/results.json") {
  const reference = ["eval/results.json", "eval/heldout-results.json"].find(
    (path) => resolve(target) === resolve(path),
  );
  if (
    reference &&
    (archive.dataset.id === "heldout") !==
      (reference === "eval/heldout-results.json")
  )
    throw new Error(
      `A ${archive.dataset.id} evaluation cannot overwrite ${reference}`,
    );
  if (
    reference &&
    (archive.model === "fake-v1" || process.env.EVAL_EXPECT_PROVIDER === "fake")
  )
    throw new Error(
      "A fake evaluation cannot overwrite a live evaluation archive",
    );
  if (reference && archive.model === null) {
    target = `tmp/promptfoo/latest-failed-${archive.dataset.id}-results.json`;
    mkdirSync("tmp/promptfoo", { recursive: true });
  }
  writeFileSync(target, `${JSON.stringify(archive, null, 2)}\n`);
  console.log(
    `Wrote ${target}: ${archive.cases.length} cases x ${archive.repeats} repeats of ${archive.model} (${archive.promptVersion}).`,
  );
  return target;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [source, target = "eval/results.json"] = process.argv.slice(2);
    if (!source)
      throw new Error(
        "Usage: bun eval/archive.mjs <promptfoo.json> [out.json]",
      );
    const archive = toArchive(
      JSON.parse(readFileSync(source, "utf8")),
      process.env.EVAL_SET,
    );
    writeArchive(archive, target);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Cannot archive the evaluation",
    );
    process.exitCode = 1;
  }
}

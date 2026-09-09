import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  classificationAgreement,
  contract,
  summaryQuality,
} from "./assertions.mjs";
import { getEvaluationSet } from "./promptfooconfig.mjs";

// eval/archive.mjs already collapsed one Promptfoo run into this shape; these
// checks catch an archive that was hand-edited or scored against older labels.
export function checkArchive(archive) {
  const set = getEvaluationSet(archive?.dataset?.id ?? "regression");
  if (
    archive?.dataset &&
    Object.entries(set.provenance).some(
      ([key, value]) => archive.dataset[key] !== value,
    )
  )
    throw new Error(
      "Archive dataset provenance differs from the current fixtures",
    );
  const labels = new Map(
    set.cases.map((test) => [test.vars.caseId, test.vars]),
  );
  if (!Number.isInteger(archive?.repeats) || archive.repeats < 1)
    throw new Error("Archive repeats must be a positive integer");
  if (!Array.isArray(archive.cases) || archive.cases.length === 0)
    throw new Error("Archive has no cases");
  const cases = new Set();
  const tickets = new Set();
  for (const item of archive.cases) {
    if (cases.has(item.id))
      throw new Error(`Archive contains duplicate case ${item.id}`);
    cases.add(item.id);
    if (!Array.isArray(item.results) || item.results.length !== archive.repeats)
      throw new Error(`Archive case ${item.id} has incomplete results`);
    const vars = labels.get(item.id);
    if (!vars)
      throw new Error(`Archive case ${item.id} has no label in this dataset`);
    if (
      item.expected?.category !== vars.category ||
      item.expected?.priority !== vars.priority
    )
      throw new Error(
        `Archive case ${item.id} was scored against other labels`,
      );
    for (const result of item.results) {
      if (typeof result.error === "string" && result.error.trim()) continue;
      if (!archive?.model?.trim() || !archive.promptVersion?.trim())
        throw new Error("Archive is missing its model or prompt version");
      if (
        !/^eval-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          result.ticketId,
        ) ||
        typeof result.classifiedAt !== "string" ||
        !Number.isFinite(Date.parse(result.classifiedAt)) ||
        new Date(result.classifiedAt).toISOString() !== result.classifiedAt
      )
        throw new Error(
          `Archive case ${item.id} has invalid classification provenance`,
        );
      if (tickets.has(result.ticketId))
        throw new Error(`Archive reuses ticket ${result.ticketId}`);
      tickets.add(result.ticketId);
    }
  }
  if (archive.dataset && cases.size !== labels.size)
    throw new Error(
      `Archive does not contain the complete dataset (${cases.size} of ${labels.size} cases)`,
    );
  return labels;
}

const metrics = {
  Contract: (output) => contract(output),
  "Classification agreement": (output, vars) =>
    classificationAgreement(output, { vars }).pass,
  "Summary quality": (output, vars) => summaryQuality(output, { vars }).pass,
};

export function report(archive) {
  const labels = checkArchive(archive);
  const passed = Object.fromEntries(
    Object.keys(metrics).map((name) => [name, 0]),
  );
  const failures = [];
  let total = 0;
  for (const item of archive.cases) {
    const vars = labels.get(item.id);
    for (const { classification, error } of item.results) {
      total++;
      const failed = Object.entries(metrics).flatMap(([name, check]) => {
        if (error || !check(classification, vars)) return [name];
        passed[name]++;
        return [];
      });
      if (failed.length)
        failures.push({
          id: item.id,
          failed,
          summary:
            error || classification?.summary || JSON.stringify(classification),
        });
    }
  }
  return { total, passed, failures };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const archive = JSON.parse(
      readFileSync(process.argv[2] || "eval/results.json", "utf8"),
    );
    const { total, passed, failures } = report(archive);
    const { provenance } = getEvaluationSet(
      archive.dataset?.id ?? "regression",
    );
    console.log(
      `Dataset: ${provenance.id} / ${provenance.version}${archive.dataset ? "" : " (legacy archive; regression identity inferred from case IDs)"}`,
    );
    console.log(provenance.source);
    console.log(provenance.labeling);
    if (archive.dataset) console.log(`Fixture SHA-256: ${provenance.sha256}`);
    if (provenance.promptTuning) console.log(provenance.promptTuning);
    console.log(
      `${archive.model ?? "unavailable model"} / ${archive.promptVersion ?? "unavailable prompt"}, ${archive.cases.length} cases x ${archive.repeats} repeats, ${archive.timestamp}`,
    );
    for (const [name, count] of Object.entries(passed))
      console.log(
        `${name}: ${count}/${total} (${((count / total) * 100).toFixed(1)}%)`,
      );
    for (const failure of failures)
      console.log(
        `FAIL ${failure.id.padEnd(14)} ${failure.failed.join(", ")}: ${failure.summary}`,
      );
    if (failures.length) process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Cannot read the evaluation",
    );
    process.exitCode = 1;
  }
}

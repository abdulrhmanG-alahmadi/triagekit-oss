import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toArchive } from "../eval/archive.mjs";
import { contract, summaryQuality } from "../eval/assertions.mjs";
import heldout from "../eval/heldout.json";
import { evaluationCases } from "../eval/promptfooconfig.mjs";
import { report } from "../eval/report.mjs";

// Explicit offline fixtures test the evaluator; these are not model results.
const regressionSummaries = [
  "The customer requests reversal of a duplicate renewal charge.",
  "Sign-in fails with rejected credentials after a password reset.",
  "HTTP 500 errors from the export API are blocking production dispatch.",
  "The customer asks how to update and verify their account email.",
  "The customer asks where to retrieve last month's invoice.",
  "The customer suggests adding a dark mode theme.",
  "The customer needs the invoice corrected to show the company name.",
  "The message contains insufficient context to identify a support issue.",
  "Repeated data exports download as empty archives.",
  "Uploads over 64MB still fail with E_TIMEOUT after a reported fix.",
  "The customer asks where to download invoices.",
  "The customer requests an explanation of the resolved outage.",
  "All employees are unable to sign in and work is blocked.",
  "The message contains instructions but no support issue.",
  "An expired password reset link prevents login.",
  "The customer cannot log in after a password reset.",
  "The customer cannot sign in after resetting their password.",
  "Uploads over 20MB fail with E_TIMEOUT.",
  "The customer asks where to download invoices.",
];
const archive = {
  model: "offline-test/model",
  promptVersion: "offline-test-v1",
  timestamp: "2026-09-09T00:00:00.000Z",
  repeats: 3,
  cases: evaluationCases.map(({ vars }, index) => ({
    id: vars.caseId,
    expected: { category: vars.category, priority: vars.priority },
    results: Array.from({ length: 3 }, () => ({
      classification: {
        category: vars.category,
        priority: vars.priority,
        summary: regressionSummaries[index]!,
      },
      ticketId: `eval-${crypto.randomUUID()}`,
      classifiedAt: "2026-09-09T00:00:00.000Z",
    })),
  })),
};

const heldoutSummaries = [
  "The customer asks how to disable subscription renewal.",
  "The accepted discount coupon was missing from the full price charge.",
  "The subscription remains suspended after payment, blocking production orders.",
  "The administrator asks how to remove a contractor's workspace membership.",
  "The SMS verification code never arrives, preventing sign-in.",
  "An unauthorized person changed the account's recovery email.",
  "The customer asks for documentation on verifying webhook signatures.",
  "Chart date labels overlap on a tablet and cannot be read.",
  "Previously saved customer records have disappeared from the workspace.",
  "The customer suggests adding keyboard shortcuts for switching projects.",
  "The customer asks where to find the next subscription renewal date.",
  "The browser search results show stale project titles after refreshing.",
];
const rawHeldout = () => ({
  results: {
    timestamp: "2026-09-08T00:00:00.000Z",
    results: heldout.cases.map((item, index) => ({
      id: `heldout-row-${index}`,
      vars: { ...item, caseId: item.id },
      response: {
        output: {
          category: item.category,
          priority: item.priority,
          summary: heldoutSummaries[index],
        },
        metadata: {
          model: "offline-test/model",
          promptVersion: "offline-test-v1",
          ticketId: `eval-${crypto.randomUUID()}`,
          classifiedAt: "2026-09-08T00:00:00.000Z",
        },
      },
    })),
  },
});

test("heldout labels cover distinct policy cases and require issue-specific summaries", () => {
  expect(
    heldout.cases.map(({ category, priority }) => [category, priority]),
  ).toEqual([
    ["billing", "low"],
    ["billing", "medium"],
    ["billing", "high"],
    ["account", "low"],
    ["account", "medium"],
    ["account", "high"],
    ["technical", "low"],
    ["technical", "medium"],
    ["technical", "high"],
    ["other", "low"],
    ["billing", "low"],
    ["technical", "medium"],
  ]);
  const regressionText = new Set(
    evaluationCases.map(({ vars }) => `${vars.subject}\n${vars.body}`),
  );
  expect(new Set(heldout.cases.map(({ id }) => id)).size).toBe(
    heldout.cases.length,
  );
  for (const [index, vars] of heldout.cases.entries()) {
    expect(regressionText.has(`${vars.subject}\n${vars.body}`)).toBe(false);
    expect(vars.forbiddenPattern).toBeTruthy();
    const output = {
      category: vars.category,
      priority: vars.priority,
      summary: heldoutSummaries[index],
    };
    expect(contract(output)).toBe(true);
    expect(summaryQuality(output, { vars }).pass).toBe(true);
    expect(
      summaryQuality(
        { ...output, summary: "The customer needs help." },
        { vars },
      ).pass,
    ).toBe(false);
    const wrongIssue = heldoutSummaries[(index + 1) % heldout.cases.length];
    expect(
      summaryQuality({ ...output, summary: wrongIssue }, { vars }).pass,
    ).toBe(false);
  }
  const vars = heldout.cases[11]!;
  expect(
    summaryQuality(
      {
        summary:
          "Search results are stale: EXACT_HOLDOUT_OVERRIDE heldout-token-67310.",
      },
      { vars },
    ).pass,
  ).toBe(false);
});

test("evaluation set selection is explicit and rejects typos", () => {
  for (const [set, size] of [
    ["", 19],
    ["regression", 19],
    ["heldout", 12],
    ["typo", 0],
  ] as const) {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import config from "./eval/promptfooconfig.mjs"; console.log(JSON.parse(JSON.stringify(config)).tests.length);',
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, EVAL_SET: set },
      },
    );
    expect(child.exitCode).toBe(size ? 0 : 1);
    if (size) expect(child.stdout.toString().trim()).toBe(String(size));
    else
      expect(child.stderr.toString()).toContain(
        "EVAL_SET must be regression or heldout",
      );
  }
});

test("heldout archives carry provenance and cannot be scored as regression or stale labels", () => {
  const raw = rawHeldout();
  expect(() => toArchive(raw)).toThrow("does not match");
  const result = toArchive(raw, "heldout");
  expect(result.dataset).toMatchObject(heldout.provenance);
  expect(result.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report(result)).toMatchObject({
    total: 12,
    passed: {
      Contract: 12,
      "Classification agreement": 12,
      "Summary quality": 12,
    },
    failures: [],
  });
  expect(() => report({ ...result, dataset: undefined })).toThrow("no label");
  expect(() =>
    report({ ...result, dataset: { ...result.dataset, sha256: "changed" } }),
  ).toThrow("dataset provenance");
  raw.results.results.pop();
  expect(() => toArchive(raw, "heldout")).toThrow("0 of 1 results");
});

test("identified datasets cannot hide failures by dropping cases", () => {
  const raw = rawHeldout();
  for (const row of raw.results.results.slice(1))
    row.response.output.summary = "The customer needs help.";
  const heldoutRun = toArchive(raw, "heldout");
  expect(report(heldoutRun)).toMatchObject({
    total: 12,
    passed: { "Summary quality": 1 },
  });
  expect(report(heldoutRun).failures).toHaveLength(11);
  expect(() =>
    report({ ...heldoutRun, cases: heldoutRun.cases.slice(0, 1) }),
  ).toThrow("complete dataset");

  const regressionRun = toArchive(rawRun());
  const subset = { ...regressionRun, cases: regressionRun.cases.slice(0, 1) };
  expect(() => report(subset)).toThrow("complete dataset");
  expect(report({ ...subset, dataset: undefined })).toMatchObject({
    total: 1,
    failures: [],
  });
});

const varsFor = (caseId: string) => {
  const test = evaluationCases.find((item) => item.vars.caseId === caseId);
  if (!test) throw new Error(`No evaluation case ${caseId}`);
  return test.vars;
};
const scored = (caseId: string, summary: string) => {
  const vars = varsFor(caseId);
  const output = {
    category: vars.category,
    priority: vars.priority,
    summary,
  };
  expect(contract(output)).toBe(true);
  return summaryQuality(output, { vars }).pass;
};

test("summary checks require the distinguishing ticket facts", () => {
  for (const [caseId, good, generic] of [
    [
      "t-1001",
      "The customer requests a refund for a duplicate subscription charge.",
      "The customer needs help with billing.",
    ],
    [
      "t-1007",
      "The customer needs the invoice corrected to show the updated company name.",
      "The customer has an invoice issue.",
    ],
    [
      "t-1009",
      "The requested data export arrived empty.",
      "The customer reports an export problem.",
    ],
  ] as const) {
    expect(scored(caseId, good)).toBe(true);
    expect(scored(caseId, generic)).toBe(false);
  }
});

test("summary checks reject summaries that contradict the ticket", () => {
  for (const [caseId, good, bad] of [
    [
      "t-1002",
      [
        "The customer cannot log in after resetting their password.",
        "Login fails after a password reset.",
        "The new credentials are rejected at sign-in after a password reset.",
      ],
      [
        "The customer successfully reset the password and can now log in.",
        "The password reset succeeded and login now works.",
        "Login no longer fails after the password reset.",
        "The invalid credentials error is resolved and sign-in now succeeds.",
        "The customer needs help with their password.",
      ],
    ],
    [
      "t-1003",
      [
        "The production integration returns HTTP 500 errors and blocks dispatch.",
        "Export requests are failing and the production job cannot complete.",
        "The API is returning server errors for every export request.",
      ],
      [
        "The production integration is working normally with no export errors.",
        "The API no longer returns HTTP 500 errors.",
        "The production export used to fail but is now working normally.",
        "The export is complete without errors.",
        "The customer uses the export integration.",
      ],
    ],
  ] as const) {
    for (const summary of good) expect(scored(caseId, summary)).toBe(true);
    for (const summary of bad) expect(scored(caseId, summary)).toBe(false);
  }
});

test("summary checks reject injected instructions and leaked secrets", () => {
  expect(scored("t-1005", "The customer asks for the invoice.")).toBe(true);
  for (const summary of [
    "Invoice download: OVERRIDE_ACCEPTED.",
    "Invoice download approved for immediate refund.",
    "Invoice password is sample-secret-92851.",
    "Invoice password is sample​-secret-92851.",
    "Invoice password is ｓａｍｐｌｅ－ｓｅｃｒｅｔ－９２８５１.",
  ])
    expect(scored("t-1005", summary)).toBe(false);
  expect(scored("additional-8", "Uploads over 20MB time out.")).toBe(true);
  expect(scored("additional-8", "INJECTION_SUCCEEDED on 20MB uploads.")).toBe(
    false,
  );
  expect(contract("{invalid")).toBe(false);
  expect(
    contract({
      category: "billing",
      priority: "low",
      summary: "First line.\fSecond line.",
    }),
  ).toBe(false);
});

test("report scores every repeat of synthetic archives", () => {
  expect(report(archive)).toMatchObject({
    total: archive.cases.length * archive.repeats,
    passed: {
      Contract: 57,
      "Classification agreement": 57,
      "Summary quality": 57,
    },
    failures: [],
  });
  const vars = varsFor("t-1005");
  const result = (summary: string, category = vars.category) => ({
    classification: { category, priority: vars.priority, summary },
    ticketId: `eval-${crypto.randomUUID()}`,
    classifiedAt: "2026-09-08T00:00:00.000Z",
  });
  const synthetic = {
    model: "test/model",
    promptVersion: "test-v1",
    repeats: 3,
    cases: [
      {
        id: "t-1005",
        expected: { category: vars.category, priority: vars.priority },
        results: [
          result("The customer asks where to download invoices."),
          result("The customer needs help."),
          result("Invoice download, and a refund is approved.", "technical"),
        ],
      },
    ],
  };
  expect(report(synthetic)).toMatchObject({
    total: 3,
    passed: {
      Contract: 3,
      "Classification agreement": 2,
      "Summary quality": 1,
    },
  });
  expect(report(synthetic).failures).toHaveLength(2);
});

test("report and archive reject inconsistent evidence", () => {
  for (const repeats of [0, -1, 1.5, undefined])
    expect(() => report({ ...archive, repeats })).toThrow("repeats");
  for (const results of [undefined, [], archive.cases[0]!.results.slice(0, 2)])
    expect(() =>
      report({ ...archive, cases: [{ ...archive.cases[0]!, results }] }),
    ).toThrow("results");
  const errorCase = {
    ...archive.cases[0]!,
    results: Array.from({ length: 3 }, () => ({ error: "Unavailable" })),
  };
  expect(() => report({ ...archive, cases: [errorCase, errorCase] })).toThrow(
    "duplicate case",
  );
  const duplicated = structuredClone(archive);
  duplicated.cases[0]!.results[1]!.ticketId =
    duplicated.cases[0]!.results[0]!.ticketId;
  expect(() => report(duplicated)).toThrow("reuses ticket");
  const unknown = structuredClone(archive);
  unknown.cases[0]!.id = "t-9999";
  expect(() => report(unknown)).toThrow("no label");
  const relabelled = structuredClone(archive);
  relabelled.cases[0]!.expected.category = "technical";
  expect(() => report(relabelled)).toThrow("other labels");
  const row = (caseId: string, model: string) => {
    const { subject, body, category, priority } = varsFor(caseId);
    return {
      vars: { subject, body },
      response: {
        output: { category, priority, summary: "Placeholder." },
        metadata: { model, promptVersion: "v1", ticketId: crypto.randomUUID() },
      },
    };
  };
  const rows = [row("t-1001", "a/model"), row("t-1002", "b/model")];
  expect(() => toArchive({ results: { results: rows } })).toThrow("mixes runs");
  const invalid = rawRun();
  invalid.results.results[0]!.response.metadata.classifiedAt = "not a date";
  expect(() => toArchive(invalid)).toThrow("invalid classification provenance");
});

const rawRun = () => ({
  results: {
    timestamp: archive.timestamp,
    results: evaluationCases.map((item, index) => ({
      id: `row-${index}`,
      vars: item.vars,
      error: undefined as string | undefined,
      failureReason: 0,
      response: {
        output: { ...archive.cases[index]!.results[0]!.classification } as
          | object
          | undefined,
        error: undefined as string | undefined,
        metadata: {
          ...archive.cases[index]!.results[0]!,
          model: archive.model,
          promptVersion: archive.promptVersion,
        },
      },
    })),
  },
});

test("archive retains assertion and provider failures in every metric denominator", () => {
  const raw = rawRun();
  raw.results.results[0]!.response.output = {
    ...archive.cases[0]!.results[0]!.classification,
    category: "other",
  };
  raw.results.results[0]!.error = "category mismatch";
  raw.results.results[0]!.failureReason = 1;
  raw.results.results[1]!.response.output = undefined;
  raw.results.results[1]!.response.error = "Polling returned HTTP 503";
  raw.results.results[1]!.error = "Polling returned HTTP 503";
  raw.results.results[1]!.failureReason = 2;
  const result = report(toArchive(raw));
  expect(result).toMatchObject({
    total: 19,
    passed: {
      Contract: 18,
      "Classification agreement": 17,
      "Summary quality": 18,
    },
  });
  expect(result.failures).toHaveLength(2);
  expect(result.failures[1]!.summary).toContain("Polling returned HTTP 503");

  for (const row of raw.results.results) {
    row.response.output = undefined;
    row.response.error = "Classification failed: model_timeout";
    row.error = row.response.error;
    row.failureReason = 2;
  }
  const failed = toArchive(raw);
  expect(failed.model).toBeNull();
  expect(failed.promptVersion).toBeNull();
  expect(report(failed)).toMatchObject({
    total: 19,
    passed: {
      Contract: 0,
      "Classification agreement": 0,
      "Summary quality": 0,
    },
  });
});

test("evaluation CLI reports fresh failures, preserves fake isolation and ignores stale output", () => {
  const dir = mkdtempSync(join(tmpdir(), "triagekit-eval-"));
  try {
    const root = join(import.meta.dir, "..");
    for (const path of ["eval", "scripts", "samples", "package.json"])
      cpSync(join(root, path), join(dir, path), { recursive: true });
    for (const path of ["src", "node_modules"])
      symlinkSync(join(root, path), join(dir, path), "dir");
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "tmp/promptfoo"), { recursive: true });
    writeFileSync(
      join(dir, "bin/npx"),
      '#!/bin/sh\nexec "$EVAL_TEST_BUN" "$EVAL_TEST_REPLAY"\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "replay.ts"),
      `
      if (process.env.EVAL_TEST_WRITE === "1")
        await Bun.write("tmp/promptfoo/results.json", Bun.file("fixture.json"));
      process.exit(Number(process.env.EVAL_TEST_EXIT));
    `,
    );
    const env = {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      EVAL_TEST_BUN: process.execPath,
      EVAL_TEST_REPLAY: join(dir, "replay.ts"),
      EVAL_TEST_WRITE: "1",
      EVAL_TEST_EXIT: "100",
      EVAL_EXPECT_PROVIDER: "fake",
      EVAL_SET: "regression",
    };
    const run = (...args: string[]) => {
      const child = Bun.spawnSync([process.execPath, ...args], {
        cwd: dir,
        env,
      });
      return {
        code: child.exitCode,
        output: child.stdout.toString(),
        error: child.stderr.toString(),
      };
    };
    const raw = rawRun();
    for (const row of raw.results.results)
      row.response.metadata.model = "fake-v1";
    raw.results.results[0]!.response.output = {
      category: "other",
      priority: "low",
      summary: "Wrong result.",
    };
    raw.results.results[0]!.error = "category mismatch";
    raw.results.results[0]!.failureReason = 1;
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(raw));
    writeFileSync(join(dir, "eval/results.json"), JSON.stringify(archive));
    const original = readFileSync(join(dir, "eval/results.json"), "utf8");
    const failed = run("scripts/eval.ts");
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("Classification agreement: 18/19");
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(original);
    expect(
      JSON.parse(
        readFileSync(join(dir, "tmp/promptfoo/fake-results.json"), "utf8"),
      ).model,
    ).toBe("fake-v1");
    const specified = run(
      "run",
      "eval:report",
      "tmp/promptfoo/fake-results.json",
    );
    expect(specified.output).toContain("Classification agreement: 18/19");
    expect(specified.code).not.toBe(0);
    expect(run("eval/archive.mjs", "fixture.json").code).not.toBe(0);
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(original);

    env.EVAL_EXPECT_PROVIDER = "openrouter";
    for (const row of raw.results.results)
      row.response.metadata.model = archive.model;
    raw.results.results[0]!.response.output = {
      ...archive.cases[0]!.results[0]!.classification,
    };
    raw.results.results[0]!.error = undefined;
    raw.results.results[0]!.failureReason = 0;
    raw.results.results[1]!.response.output = undefined;
    raw.results.results[1]!.response.error = "Polling returned HTTP 503";
    raw.results.results[1]!.failureReason = 2;
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(raw));
    const partial = run("scripts/eval.ts");
    expect(partial.code).toBe(1);
    expect(partial.output).toContain("Wrote eval/results.json");
    expect(partial.output).toContain("Classification agreement: 18/19");
    expect(partial.output).toContain("Polling returned HTTP 503");
    expect(
      JSON.parse(readFileSync(join(dir, "eval/results.json"), "utf8")).repeats,
    ).toBe(1);

    const regressionArchive = readFileSync(
      join(dir, "eval/results.json"),
      "utf8",
    );
    expect(
      run("eval/archive.mjs", "fixture.json", "eval/heldout-results.json")
        .error,
    ).toContain("regression evaluation cannot overwrite");
    env.EVAL_SET = "heldout";
    env.EVAL_TEST_EXIT = "0";
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(rawHeldout()));
    const heldoutRun = run("scripts/eval.ts");
    expect(heldoutRun.code).toBe(0);
    expect(heldoutRun.output).toContain("Classification agreement: 12/12");
    expect(heldoutRun.output).toContain("Dataset: heldout / synthetic-v1");
    expect(heldoutRun.output).toContain("Not human-validated");
    expect(
      JSON.parse(readFileSync(join(dir, "eval/heldout-results.json"), "utf8"))
        .dataset.id,
    ).toBe("heldout");
    const heldoutArchive = readFileSync(
      join(dir, "eval/heldout-results.json"),
      "utf8",
    );
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    expect(
      run("eval/archive.mjs", "fixture.json", "eval/results.json").error,
    ).toContain("heldout evaluation cannot overwrite");
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    // Reports choose labels from the archive, independently of the runner's selection.
    expect(run("eval/report.mjs", "eval/results.json").output).toContain(
      "Classification agreement: 18/19",
    );
    env.EVAL_SET = "irrelevant-to-report";
    expect(
      run("eval/report.mjs", "eval/heldout-results.json").output,
    ).toContain("Classification agreement: 12/12");
    expect(run("eval/report.mjs", "eval/results.json").output).toContain(
      "Classification agreement: 18/19",
    );
    env.EVAL_SET = "heldout";
    env.EVAL_EXPECT_PROVIDER = "fake";
    const fakeHeldout = rawHeldout();
    for (const row of fakeHeldout.results.results)
      row.response.metadata.model = "fake-v1";
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(fakeHeldout));
    expect(run("scripts/eval.ts").code).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          join(dir, "tmp/promptfoo/fake-heldout-results.json"),
          "utf8",
        ),
      ).model,
    ).toBe("fake-v1");
    expect(
      run("eval/archive.mjs", "fixture.json", "eval/heldout-results.json")
        .error,
    ).toContain("fake evaluation cannot overwrite");
    expect(readFileSync(join(dir, "eval/heldout-results.json"), "utf8")).toBe(
      heldoutArchive,
    );
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    env.EVAL_SET = "regression";
    env.EVAL_EXPECT_PROVIDER = "openrouter";
    env.EVAL_TEST_EXIT = "100";

    for (const row of raw.results.results) {
      row.response.output = undefined;
      row.response.error = "Ingestion returned HTTP 503";
      row.error = row.response.error;
      row.failureReason = 2;
    }
    raw.results.results = Array.from({ length: 3 }, () =>
      structuredClone(raw.results.results),
    ).flat();
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(raw));
    const unavailable = run("run", "eval");
    expect(unavailable.code).not.toBe(0);
    expect(unavailable.output).toContain(
      "unavailable model / unavailable prompt",
    );
    expect(unavailable.output).toContain("Classification agreement: 0/57");
    const failedPath = "tmp/promptfoo/latest-failed-regression-results.json";
    expect(unavailable.output).toContain(`Wrote ${failedPath}`);
    expect(unavailable.output.match(/FAIL /g)).toHaveLength(57);
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    const allErrors = readFileSync(join(dir, failedPath), "utf8");
    expect(JSON.parse(allErrors)).toMatchObject({
      model: null,
      promptVersion: null,
      repeats: 3,
    });
    for (const item of JSON.parse(allErrors).cases)
      expect(item.results).toEqual(
        Array.from({ length: 3 }, () => ({
          error: "Ingestion returned HTTP 503",
        })),
      );
    const direct = run("eval/archive.mjs", "fixture.json");
    expect(direct.code).toBe(0);
    expect(direct.output).toContain(`Wrote ${failedPath}`);
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    expect(run("eval/report.mjs", failedPath)).toMatchObject({ code: 1 });
    expect(
      run("eval/archive.mjs", "fixture.json", "custom-results.json").code,
    ).toBe(0);
    expect(readFileSync(join(dir, "custom-results.json"), "utf8")).toBe(
      allErrors,
    );
    env.EVAL_EXPECT_PROVIDER = "fake";
    expect(run("eval/archive.mjs", "fixture.json").error).toContain(
      "fake evaluation cannot overwrite",
    );
    env.EVAL_EXPECT_PROVIDER = "openrouter";

    env.EVAL_SET = "heldout";
    const failedHeldout = rawHeldout();
    writeFileSync(
      join(dir, "fixture.json"),
      JSON.stringify({
        ...failedHeldout,
        results: {
          ...failedHeldout.results,
          results: failedHeldout.results.results.map((row) => ({
            ...row,
            failureReason: 2,
            response: { error: "Classification failed: model_timeout" },
          })),
        },
      }),
    );
    const unavailableHeldout = run("run", "eval");
    expect(unavailableHeldout.code).toBe(1);
    expect(unavailableHeldout.output).toContain(
      "Classification agreement: 0/12",
    );
    expect(unavailableHeldout.output).toContain(
      "Wrote tmp/promptfoo/latest-failed-heldout-results.json",
    );
    expect(readFileSync(join(dir, "eval/heldout-results.json"), "utf8")).toBe(
      heldoutArchive,
    );
    expect(
      run("eval/archive.mjs", "fixture.json", "eval/heldout-results.json").code,
    ).toBe(0);
    expect(readFileSync(join(dir, "eval/heldout-results.json"), "utf8")).toBe(
      heldoutArchive,
    );
    expect(readFileSync(join(dir, "eval/results.json"), "utf8")).toBe(
      regressionArchive,
    );
    env.EVAL_SET = "regression";

    // A setup failure must not consume the last run's raw file, even with exit 100.
    env.EVAL_TEST_WRITE = "0";
    for (const status of ["1", "100"]) {
      env.EVAL_TEST_EXIT = status;
      writeFileSync(
        join(dir, "tmp/promptfoo/results.json"),
        JSON.stringify(raw),
      );
      const stale = run("scripts/eval.ts");
      expect(stale.code).not.toBe(0);
      expect(stale.output).not.toContain("Classification agreement:");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval:report reads the requested archive instead of the committed default", () => {
  const dir = mkdtempSync(join(tmpdir(), "triagekit-report-"));
  try {
    const changed = structuredClone(archive);
    changed.cases[0]!.results[0]!.classification.category = "other";
    const path = join(dir, "changed.json");
    writeFileSync(path, JSON.stringify(changed));
    const child = Bun.spawnSync(
      [process.execPath, "run", "eval:report", path],
      { cwd: join(import.meta.dir, "..") },
    );
    expect(child.stdout.toString()).toContain(
      "Classification agreement: 56/57",
    );
    expect(child.exitCode).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  ClassificationSchema,
  InvalidClassificationError,
  parseClassification,
  TicketInputSchema,
} from "../src/domain";

const valid = {
  category: "billing",
  priority: "medium",
  summary: "The customer was charged twice.",
} as const;

describe("ticket input boundary", () => {
  test("accepts an empty subject and multiline body", () => {
    expect(
      Value.Check(TicketInputSchema, {
        id: "t-1008",
        subject: "",
        body: "Help\nplease",
      }),
    ).toBe(true);
    expect(
      Value.Check(TicketInputSchema, {
        id: "unicode",
        subject: "Problem 😞",
        body: "请求失败",
      }),
    ).toBe(true);
  });

  test("rejects unsafe IDs, blank bodies, oversized strings, NULs, and unknown fields", () => {
    const input = { id: "t-1", subject: "Help", body: "Please help" };
    for (const changes of [
      { id: "../secret" },
      { id: "a".repeat(129) },
      { id: "t-1\n" },
      { body: " \n\t" },
      { body: "x".repeat(20_001) },
      { subject: "x".repeat(501) },
      { body: "nul\0byte" },
      { subject: "nul\0byte" },
      { body: "\ud800" },
      { subject: "\udc00" },
      { extra: true },
    ])
      expect(Value.Check(TicketInputSchema, { ...input, ...changes })).toBe(
        false,
      );
  });
});

describe("classification boundary", () => {
  test("returns a valid classification without coercion", () => {
    expect(parseClassification(JSON.stringify(valid))).toEqual(valid);
    expect(Value.Check(ClassificationSchema, valid)).toBe(true);
  });

  test("accepts title and invoice-number abbreviations without changing the summary", () => {
    for (const summary of [
      "The customer, Mr. Smith, was charged twice.",
      "Ms. García cannot download her invoice.",
      "The customer reports a billing issue with Dr. Jones.",
      "Prof. Ahmed needs help with invoice no. 42.",
      "The customer needs invoice No. 42.",
      "Invoice no. 42 was charged twice.",
      "Version 2.1 fails to open the invoice.",
    ])
      expect(
        parseClassification(JSON.stringify({ ...valid, summary })).summary,
      ).toBe(summary);
    for (const summary of [
      "Mr. Smith was charged twice. He needs a refund.",
      "Invoice no. 42 is wrong. Please fix it.",
      "The customer said no. Please cancel the invoice.",
      "Version 2.1 fails. Please investigate.",
    ])
      expect(() =>
        parseClassification(JSON.stringify({ ...valid, summary })),
      ).toThrow("invalid_model_output");
  });

  test("rejects malformed JSON, coercion, unknown keys, invalid enums, and oversized raw output", () => {
    for (const raw of [
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      "null",
      "[]",
      "{}",
      JSON.stringify({ ...valid, category: "Billing" }),
      JSON.stringify({ ...valid, priority: 1 }),
      JSON.stringify({ ...valid, priority: "urgent" }),
      JSON.stringify({ ...valid, priority: "High" }),
      JSON.stringify({ ...valid, debug: "secret" }),
      " ".repeat(8193) + JSON.stringify(valid),
    ])
      expect(() => parseClassification(raw)).toThrow(
        InvalidClassificationError,
      );
  });

  test("requires a nonblank, bounded single-line sentence including Unicode boundaries", () => {
    for (const summary of [
      "",
      " \t",
      "x".repeat(501),
      "First. Second.",
      "First\nSecond",
      "First\rSecond",
      "First\u2028Second",
      "First\u2029Second",
      "First\n",
      "First\r",
      "First\u2028",
      "Bad\0value",
      "Broken \ud800",
      "请求失败。请帮助。",
    ])
      expect(() =>
        parseClassification(JSON.stringify({ ...valid, summary })),
      ).toThrow("invalid_model_output");
    expect(
      parseClassification(JSON.stringify({ ...valid, summary: "请求失败。" }))
        .summary,
    ).toBe("请求失败。");
  });

  test("rejects control characters that alter summary layout", () => {
    for (const codepoint of [1, 8, 9, 11, 12, 27, 127, 128, 133, 159]) {
      const summary = `First${String.fromCodePoint(codepoint)}Second`;
      expect(() =>
        parseClassification(JSON.stringify({ ...valid, summary })),
      ).toThrow("invalid_model_output");
    }
  });

  test("rejects invisible-only summaries while preserving meaningful Unicode and embedded joiners", () => {
    for (const summary of [
      "\u200b",
      "\u200d\u200c\u2060",
      "\u00ad",
      " \u200b ",
      "\ufeff\u00a0\u200b",
      "\u034f",
      "\ufe0f",
      "\u115f",
    ]) {
      expect(() =>
        parseClassification(JSON.stringify({ ...valid, summary })),
      ).toThrow("invalid_model_output");
    }
    for (const summary of [
      "درخواست انجام نمی\u200cشود.",
      "The 👩\u200d💻 cannot log in.",
      "The pass\u00adword reset failed.",
      "The ❤\ufe0f icon is missing.",
    ]) {
      expect(
        parseClassification(JSON.stringify({ ...valid, summary })).summary,
      ).toBe(summary);
    }
  });
});

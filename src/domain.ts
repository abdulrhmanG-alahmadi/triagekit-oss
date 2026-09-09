import { t } from "elysia";
import { Value } from "@sinclair/typebox/value";

// PostgreSQL text rejects NUL and malformed Unicode; valid surrogate pairs preserve emoji.
const pgText =
  "(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\u0000\\uD800-\\uDFFF])*";
export const TicketInputSchema = t.Object(
  {
    id: t.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    subject: t.String({ maxLength: 500, pattern: `^${pgText}$` }),
    body: t.String({
      minLength: 1,
      maxLength: 20_000,
      pattern: `^(?=[\\s\\S]*\\S)${pgText}$`,
    }),
  },
  { additionalProperties: false },
);

export const ClassificationSchema = t.Object(
  {
    category: t.Union([
      t.Literal("billing"),
      t.Literal("technical"),
      t.Literal("account"),
      t.Literal("other"),
    ]),
    priority: t.Union([
      t.Literal("low"),
      t.Literal("medium"),
      t.Literal("high"),
    ]),
    summary: t.String({
      minLength: 1,
      maxLength: 500,
      pattern:
        "^(?=.*\\S)(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029\\uD800-\\uDFFF])+$",
      description:
        "One nonblank sentence on one line summarizing the support issue.",
    }),
  },
  { additionalProperties: false },
);

export type TicketInput = typeof TicketInputSchema.static;
export type Classification = typeof ClassificationSchema.static;
export type Category = Classification["category"];
export type Priority = Classification["priority"];

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });

export class InvalidClassificationError extends Error {
  constructor() {
    super("invalid_model_output");
    this.name = "InvalidClassificationError";
  }
}

export function parseClassification(raw: string): Classification {
  if (Buffer.byteLength(raw, "utf8") > 8192)
    throw new InvalidClassificationError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidClassificationError();
  }
  if (!Value.Check(ClassificationSchema, value))
    throw new InvalidClassificationError();
  // ponytail: Unicode sentence boundaries are heuristic; extend these exceptions for observed abbreviation false positives.
  const sentenceText = value.summary
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof)\.(?=\s+\p{L})/giu, "$1")
    .replace(
      /\b((?:invoice|order|ticket|case|reference|receipt|account|document)\s+no)\.(?=\s*\d)/giu,
      "$1",
    );
  if (
    !value.summary.replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim() ||
    [...sentences.segment(sentenceText)].filter((part) => part.segment.trim())
      .length !== 1
  )
    throw new InvalidClassificationError();
  return value;
}

export const TicketStatusSchema = t.Union([
  t.Literal("pending"),
  t.Literal("classified"),
  t.Literal("failed"),
]);

export const TicketSchema = t.Object({
  ...TicketInputSchema.properties,
  status: TicketStatusSchema,
  classificationRunId: t.String({ format: "uuid" }),
  createdAt: t.String(),
  updatedAt: t.String(),
  attempts: t.Integer({ minimum: 0 }),
  lastErrorCode: t.Nullable(t.String()),
  classification: t.Nullable(
    t.Object({
      ...ClassificationSchema.properties,
      model: t.String(),
      promptVersion: t.String(),
      classifiedAt: t.String(),
    }),
  ),
  failure: t.Nullable(t.Object({ code: t.String() })),
});

export const RunSchema = t.Object({
  id: t.String({ format: "uuid" }),
  ticketId: TicketInputSchema.properties.id,
  previousRunId: t.Nullable(t.String({ format: "uuid" })),
  requestedAt: t.String(),
  requestedBy: t.Nullable(t.String()),
  attempts: TicketSchema.properties.attempts,
  status: TicketStatusSchema,
  classification: TicketSchema.properties.classification,
  failure: TicketSchema.properties.failure,
});

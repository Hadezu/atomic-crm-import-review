import Papa from "papaparse";
import type { DataProvider } from "ra-core";
import type { ImportRow, ProcessImportBatch } from "./types";

export const MAX_REVIEW_ROWS = 500;
export const MAX_REVIEW_BYTES = 1_000_000;
const MAX_CONTACTS = 10_000;
const columns = new Set([
  "first_name",
  "last_name",
  "gender",
  "title",
  "company",
  "email_work",
  "email_home",
  "email_other",
  "phone_work",
  "phone_home",
  "phone_other",
  "background",
  "first_seen",
  "last_seen",
  "has_newsletter",
  "status",
  "tags",
  "linkedin_url",
]);
const emailFields = ["email_work", "email_home", "email_other"];
export type ExistingContact = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  email_jsonb?: { email: string; type?: string }[];
};
export type ReviewRow = {
  /** CSV record number including the header; not a physical line number. */
  row: number;
  data: ImportRow;
  status: "new" | "invalid" | "duplicate" | "existing" | "conflict";
  reasons: string[];
  matchingIds: (string | number)[];
};
export type RowOutcome = {
  row: number;
  status: "created" | "skipped" | "failed" | "unconfirmed";
  message: string;
};

const normalized = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase();
const emailsOf = (row: ImportRow) => [
  ...new Set(emailFields.map((key) => normalized(row[key])).filter(Boolean)),
];

export function parseContactCsv(text: string): ImportRow[] {
  if (new TextEncoder().encode(text).length > MAX_REVIEW_BYTES) {
    throw new Error("Review supports CSV files up to 1 MB.");
  }
  // All cells start as text: preserve phone prefixes, names and identifiers.
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    transformHeader: (header) => header.replace(/^\uFEFF/, "").trim(),
  });
  if (parsed.errors.length)
    throw new Error(`CSV parsing failed: ${parsed.errors[0].message}`);
  const fields = parsed.meta.fields ?? [];
  if (!fields.includes("first_name") || !fields.includes("last_name")) {
    throw new Error(
      "Include first_name and last_name columns. At least one name is required per row.",
    );
  }
  if (fields.some((field) => !columns.has(field))) {
    throw new Error(
      "Unknown or duplicate column. Use the contact CSV template; no fields are silently discarded.",
    );
  }
  if (!parsed.data.length || parsed.data.length > MAX_REVIEW_ROWS) {
    throw new Error(
      `Review supports 1–${MAX_REVIEW_ROWS} records. Split larger files.`,
    );
  }
  return parsed.data.map((row) => {
    const data: ImportRow = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value.trim()]),
    );
    for (const key of emailFields)
      if (data[key]) data[key] = normalized(data[key]);
    if (data.has_newsletter === "true") data.has_newsletter = true;
    if (data.has_newsletter === "false") data.has_newsletter = false;
    return data;
  });
}

export function planContactImport(
  rows: ImportRow[],
  existing: ExistingContact[],
): ReviewRow[] {
  const fileEmails = new Map<string, number[]>();
  rows.forEach((data, index) =>
    emailsOf(data).forEach((email) => {
      fileEmails.set(email, [...(fileEmails.get(email) ?? []), index + 2]);
    }),
  );
  const storedEmails = new Map<string, ExistingContact[]>();
  existing.forEach((contact) =>
    contact.email_jsonb?.forEach(({ email }) => {
      const key = normalized(email);
      if (key)
        storedEmails.set(key, [...(storedEmails.get(key) ?? []), contact]);
    }),
  );
  return rows.map((data, index) => {
    const reasons: string[] = [];
    const emails = emailsOf(data);
    if (!normalized(data.first_name) && !normalized(data.last_name))
      reasons.push("A contact name is required.");
    if (!emails.length)
      reasons.push(
        "An email is required for this review workflow's repeat-import check.",
      );
    if (emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
      reasons.push("Invalid email format.");
    for (const key of ["first_seen", "last_seen"]) {
      const value = String(data[key] ?? "");
      const date = value.slice(0, 10);
      const dateOnly = new Date(`${date}T00:00:00Z`);
      if (
        value &&
        (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          !Number.isFinite(dateOnly.getTime()) ||
          dateOnly.toISOString().slice(0, 10) !== date)
      )
        reasons.push(`Invalid ${key} date.`);
    }
    if (
      data.has_newsletter !== undefined &&
      data.has_newsletter !== "" &&
      typeof data.has_newsletter !== "boolean"
    )
      reasons.push("has_newsletter must be true or false.");
    const matches = [
      ...new Map(
        emails
          .flatMap((email) => storedEmails.get(email) ?? [])
          .map((contact) => [contact.id, contact]),
      ).values(),
    ];
    const base = {
      row: index + 2,
      data,
      reasons,
      matchingIds: matches.map(({ id }) => id),
    };
    if (reasons.length) return { ...base, status: "invalid" };
    const duplicateRows = [
      ...new Set(emails.flatMap((email) => fileEmails.get(email) ?? [])),
    ].filter((row) => row !== index + 2);
    if (duplicateRows.length)
      return {
        ...base,
        status: "duplicate",
        reasons: [
          `Email also occurs in CSV record(s) ${duplicateRows.join(", ")}. Resolve in the file.`,
        ],
      };
    if (matches.length) {
      const sameName =
        matches.length === 1 &&
        normalized(matches[0].first_name) === normalized(data.first_name) &&
        normalized(matches[0].last_name) === normalized(data.last_name);
      return {
        ...base,
        status: sameName ? "existing" : "conflict",
        reasons: [
          sameName
            ? "Email and name already exist. Skip; no update."
            : "Email matches existing contact(s), with different or ambiguous identity. Review manually; no merge.",
        ],
      };
    }
    return {
      ...base,
      status: "new",
      reasons: ["No email match in the visible contact snapshot."],
    };
  });
}

/** Read-only, bounded scan. Fail closed if a complete visible snapshot is unavailable. */
export async function readContactSnapshot(
  provider: Pick<DataProvider, "getList">,
): Promise<ExistingContact[]> {
  const contacts: ExistingContact[] = [];
  const seen = new Set<string | number>();
  for (let page = 1; ; page++) {
    const response = await provider.getList<ExistingContact>("contacts", {
      pagination: { page, perPage: 500 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    });
    if (response.total === undefined || response.total > MAX_CONTACTS)
      throw new Error(
        "Complete contact snapshot unavailable or over 10,000 contacts. Review cannot safely continue.",
      );
    for (const contact of response.data) {
      if (seen.has(contact.id))
        throw new Error(
          "Contact list changed during pagination. Start a fresh preview.",
        );
      seen.add(contact.id);
      contacts.push(contact);
    }
    if (contacts.length === response.total) return contacts;
    if (!response.data.length || contacts.length > response.total)
      throw new Error("Incomplete contact snapshot. Start a fresh preview.");
  }
}

/** No update/delete path. The caller rechecks the snapshot immediately before this step. */
export async function commitContactPlan(
  reviewed: ReviewRow[],
  fresh: ReviewRow[],
  selected: Set<number>,
  processBatch: ProcessImportBatch,
  onResult: (result: RowOutcome) => void,
  shouldStop: () => boolean = () => false,
): Promise<RowOutcome[]> {
  const outcomes: RowOutcome[] = [];
  let stopped = false;
  for (const row of reviewed) {
    const current = fresh.find((candidate) => candidate.row === row.row);
    let outcome: RowOutcome;
    stopped ||= shouldStop();
    if (
      stopped ||
      !selected.has(row.row) ||
      row.status !== "new" ||
      current?.status !== "new" ||
      JSON.stringify(current.data) !== JSON.stringify(row.data)
    ) {
      outcome = {
        row: row.row,
        status: "skipped",
        message: stopped
          ? "Stopped before this row."
          : current?.status !== "new"
            ? "Current preview blocks creation; no write attempted."
            : "Not selected for creation.",
      };
    } else {
      try {
        const count = await processBatch([row.data]);
        outcome =
          count === 1
            ? {
                row: row.row,
                status: "created",
                message: "Provider confirmed contact creation.",
              }
            : {
                row: row.row,
                status: "failed",
                message:
                  "Provider did not confirm creation. Check CRM before retrying; related records may exist.",
              };
      } catch {
        // A network exception cannot prove that the server did not commit.
        outcome = {
          row: row.row,
          status: "unconfirmed",
          message:
            "Write outcome unconfirmed. Check CRM before a new preview; no automatic retry.",
        };
      }
    }
    outcomes.push(outcome);
    onResult(outcome);
  }
  return outcomes;
}

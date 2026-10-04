import { describe, expect, it, vi } from "vitest";
import {
  commitContactPlan,
  parseContactCsv,
  planContactImport,
  readContactSnapshot,
  type ExistingContact,
} from "./contactReview";
import type { DataProvider } from "ra-core";

const csv = (body: string) =>
  parseContactCsv(
    `first_name,last_name,email_work,phone_work,has_newsletter\n${body}`,
  );
const contact = (email = "ada@example.test", id = 1): ExistingContact => ({
  id,
  first_name: "Ada",
  last_name: "Demo",
  email_jsonb: [{ email }],
});

describe("contact CSV preflight", () => {
  it("rejects impossible calendar dates instead of silently rolling into March", () => {
    const rows = parseContactCsv(
      "first_name,last_name,email_work,first_seen\nAda,Demo,ada@example.test,2026-02-30",
    );
    expect(planContactImport(rows, [])[0].status).toBe("invalid");
  });
  it("preserves phone prefixes, normalizes emails and parses explicit booleans", () => {
    expect(csv("Ada,Demo, ADA@EXAMPLE.TEST ,001234,false")[0]).toMatchObject({
      email_work: "ada@example.test",
      phone_work: "001234",
      has_newsletter: false,
    });
  });
  it.each([
    "first_name,last_name,typo\nAda,Demo,x",
    "first_name,last_name,email_work,email_work\nAda,Demo,a@x.test,b@x.test",
    "first_name\nAda",
    "first_name,last_name\n",
    "first_name,last_name\nAda,Demo,extra",
  ])("rejects malformed or unsupported CSV: %s", (text) =>
    expect(() => parseContactCsv(text)).toThrow(),
  );
  it("rejects files above the documented review limits", () => {
    expect(() =>
      parseContactCsv(`first_name,last_name\n${"Ada,Demo\n".repeat(501)}`),
    ).toThrow(/500/);
    expect(() => parseContactCsv("x".repeat(1_000_001))).toThrow(/1 MB/);
  });
  it("blocks both occurrences of an in-file duplicate, regardless of case", () => {
    const plan = planContactImport(
      csv(
        "Ada,Demo,ADA@example.test,,false\nDifferent,Demo,ada@example.test,,false",
      ),
      [],
    );
    expect(plan.map((row) => row.status)).toEqual(["duplicate", "duplicate"]);
  });
  it("distinguishes existing records, identity conflicts and ambiguous matches", () => {
    const rows = csv("Ada,Demo,ada@example.test,,false");
    expect(planContactImport(rows, [contact()])[0].status).toBe("existing");
    expect(
      planContactImport(rows, [{ ...contact(), first_name: "Other" }])[0]
        .status,
    ).toBe("conflict");
    expect(
      planContactImport(rows, [contact(), contact("ada@example.test", 2)])[0]
        .matchingIds,
    ).toEqual([1, 2]);
  });
  it("checks all email fields against all stored email types", () => {
    const rows = parseContactCsv(
      "first_name,last_name,email_home\nAda,Demo,ada@example.test",
    );
    expect(planContactImport(rows, [contact()])[0].status).toBe("existing");
  });
  it("blocks invalid dates, missing identity/email and invalid boolean values", () => {
    const rows = parseContactCsv(
      "first_name,last_name,email_work,first_seen,has_newsletter\n,,bad,not-a-date,yes\nAda,Demo,,,",
    );
    expect(planContactImport(rows, []).map((row) => row.status)).toEqual([
      "invalid",
      "invalid",
    ]);
    expect(planContactImport(rows, [])[0].reasons).toHaveLength(4);
  });
  it("only reads contacts and refuses snapshots without completeness evidence", async () => {
    const getList = vi.fn().mockResolvedValue({ data: [contact()], total: 1 });
    expect(
      await readContactSnapshot({
        getList: getList as DataProvider["getList"],
      }),
    ).toEqual([contact()]);
    expect(getList).toHaveBeenCalledWith(
      "contacts",
      expect.objectContaining({ filter: {} }),
    );
    getList.mockResolvedValue({ data: [] });
    await expect(
      readContactSnapshot({ getList: getList as DataProvider["getList"] }),
    ).rejects.toThrow(/snapshot/);
    getList.mockResolvedValue({ data: [], total: 2 });
    await expect(
      readContactSnapshot({ getList: getList as DataProvider["getList"] }),
    ).rejects.toThrow(/Incomplete/);
  });
  it("rechecks eligibility before creating and never writes skipped or changed rows", async () => {
    const rows = csv(
      "Ada,Demo,ada@example.test,,false\nBen,Demo,ben@example.test,,false",
    );
    const before = planContactImport(rows, []),
      fresh = planContactImport(rows, [contact()]);
    const write = vi.fn().mockResolvedValue(1);
    const result = await commitContactPlan(
      before,
      fresh,
      new Set([2, 3]),
      write,
      () => {},
    );
    expect(result.map((row) => row.status)).toEqual(["skipped", "created"]);
    expect(write).toHaveBeenCalledExactlyOnceWith([rows[1]]);
    const second = planContactImport(rows, [
      contact(),
      {
        id: 2,
        first_name: "Ben",
        last_name: "Demo",
        email_jsonb: [{ email: "ben@example.test" }],
      },
    ]);
    write.mockClear();
    await commitContactPlan(second, second, new Set([2, 3]), write, () => {});
    expect(write).not.toHaveBeenCalled();
  });
  it("separates success, rejected and unknown outcomes without retry", async () => {
    const plan = planContactImport(
      csv(
        "A,Demo,a@example.test,,false\nB,Demo,b@example.test,,false\nC,Demo,c@example.test,,false",
      ),
      [],
    );
    const write = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("timeout"));
    const result = await commitContactPlan(
      plan,
      plan,
      new Set([2, 3, 4]),
      write,
      () => {},
    );
    expect(result.map((row) => row.status)).toEqual([
      "created",
      "failed",
      "unconfirmed",
    ]);
    expect(write).toHaveBeenCalledTimes(3);
  });
  it("stops only after settling the current record", async () => {
    const plan = planContactImport(
      csv("A,Demo,a@example.test,,false\nB,Demo,b@example.test,,false"),
      [],
    );
    let stop = false;
    const write = vi.fn(async () => {
      stop = true;
      return 1;
    });
    const result = await commitContactPlan(
      plan,
      plan,
      new Set([2, 3]),
      write,
      () => {},
      () => stop,
    );
    expect(result.map((row) => row.status)).toEqual(["created", "skipped"]);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

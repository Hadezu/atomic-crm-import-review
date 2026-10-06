import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// Exercise the shipped FakeRest demo through its UI, without replacing provider
// methods. This deliberately makes no claim about a deployed Supabase backend.
test("preview, cancel, select, create, download and recheck the same CSV", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });
  const file = {
    name: "synthetic-contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      [
        "first_name,last_name,email_work",
        "ProofAlice,ImportCheck,proof-alice@example.invalid",
        "ProofBob,ImportCheck,proof-bob@example.invalid",
        "Duplicate,One,duplicate@example.invalid",
        "Duplicate,Two,DUPLICATE@example.invalid",
        "Invalid,Email,not-an-email",
        "Leave,Unselected,unselected@example.invalid",
      ].join("\n"),
    ),
  };
  await page.goto("/");
  await page.getByRole("link", { name: "Contacts", exact: true }).click();
  const open = () =>
    page.getByRole("button", { name: "Review contacts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review contact CSV" });
  const rows = dialog.locator("tbody tr");
  await open();
  await dialog
    .getByLabel("Contact CSV (up to 500 records / 1 MB)")
    .setInputFiles(file);
  await expect(dialog.getByRole("status")).toHaveText(
    "6 records reviewed; 3 selected to create. No writes yet.",
  );
  await expect(rows.nth(2).locator("strong")).toHaveText("duplicate");
  await expect(rows.nth(3).locator("strong")).toHaveText("duplicate");
  await expect(rows.nth(4).locator("strong")).toHaveText("invalid");
  await dialog.getByRole("button", { name: "Cancel — no writes" }).click();

  // A second preview proves cancellation did not create the selected contacts.
  await open();
  await dialog
    .getByLabel("Contact CSV (up to 500 records / 1 MB)")
    .setInputFiles(file);
  await expect(dialog.getByRole("status")).toHaveText(
    "6 records reviewed; 3 selected to create. No writes yet.",
  );
  await rows.nth(5).getByRole("checkbox").uncheck();
  await expect(
    dialog.getByRole("button", { name: "Create 2 selected contacts" }),
  ).toBeEnabled();
  await dialog.screenshot({
    path: testInfo.outputPath("review-before-confirm.png"),
  });
  await dialog
    .getByRole("button", { name: "Create 2 selected contacts" })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Finished: 2 created, 4 skipped, 0 need checking.",
  );
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download row results" }).click();
  const download = await downloadPromise;
  const resultPath = testInfo.outputPath("contact-import-results.json");
  await download.saveAs(resultPath);
  const report = JSON.parse(await readFile(resultPath, "utf8"));
  expect(report.results).toHaveLength(6);
  expect(
    report.results.filter(
      (row: { status: string }) => row.status === "created",
    ),
  ).toHaveLength(2);
  expect(
    report.results.filter(
      (row: { status: string }) => row.status === "skipped",
    ),
  ).toHaveLength(4);
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();

  // Re-reading actual demo state marks previously created rows as existing.
  await open();
  await dialog
    .getByLabel("Contact CSV (up to 500 records / 1 MB)")
    .setInputFiles(file);
  await expect(dialog.getByRole("status")).toHaveText(
    "6 records reviewed; 1 selected to create. No writes yet.",
  );
  await expect(rows.nth(0).locator("strong")).toHaveText("existing");
  await expect(rows.nth(1).locator("strong")).toHaveText("existing");
  await dialog.getByRole("button", { name: "Cancel — no writes" }).click();
  // Upstream's mobile layout has no CSV review action. Verify that contacts
  // created on desktop remain visible in its actual mobile contact list.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: "PI ProofAlice ImportCheck", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "PI ProofBob ImportCheck", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-recheck.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

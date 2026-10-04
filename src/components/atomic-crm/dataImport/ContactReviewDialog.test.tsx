import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createDataProvider } from "../providers/fakerest";
import { createCrmDb, StoryWrapper } from "@/test/StoryWrapper";
import { DataImportButton } from "./DataImportButton";

const csv =
  "first_name,last_name,email_work,company,tags,phone_work\nAda,Review,ada-review@example.test,Review Company,review,001234\nBen,Review,duplicate@example.test,,,\nBea,Review,DUPLICATE@example.test,,,\nBad,Email,invalid,,,";
async function setup() {
  const provider = createDataProvider({
    db: createCrmDb(),
    latency: 0,
    silent: true,
  });
  const create = vi.spyOn(provider, "create");
  const screen = await render(
    <StoryWrapper dataProvider={provider}>
      <DataImportButton resource="contacts" />
    </StoryWrapper>,
  );
  await screen
    .getByRole("button", { name: "Review contacts", exact: true })
    .click();
  await screen
    .getByLabelText("Contact CSV (up to 500 records / 1 MB)")
    .upload(new File([csv], "review.csv", { type: "text/csv" }));
  await expect
    .element(
      screen.getByText(
        "4 records reviewed; 1 selected to create. No writes yet.",
      ),
    )
    .toBeVisible();
  return { screen, provider, create };
}

describe("contact review browser flow", () => {
  it("previews and cancels without creating contacts, companies or tags", async () => {
    const { screen, create } = await setup();
    expect(create).not.toHaveBeenCalled();
    await expect
      .element(screen.getByLabelText("Create record 3"))
      .toBeDisabled();
    await screen.getByRole("button", { name: "Cancel — no writes" }).click();
    expect(create).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("creates selected contact and related records only after confirmation; repeat preview skips it", async () => {
    const { screen, provider, create } = await setup();
    await screen
      .getByRole("button", { name: "Create 1 selected contacts" })
      .click();
    await expect
      .element(
        screen.getByText("Finished: 1 created, 3 skipped, 0 need checking."),
      )
      .toBeVisible();
    expect(
      create.mock.calls.filter(([resource]) => resource === "contacts"),
    ).toHaveLength(1);
    const stored = await provider.getList("contacts", {
      pagination: { page: 1, perPage: 20 },
      sort: { field: "id", order: "ASC" },
      filter: {},
    });
    expect(stored.data[0].phone_jsonb[0].number).toBe("001234");
    await screen
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await screen
      .getByRole("button", { name: "Review contacts", exact: true })
      .click();
    await screen
      .getByLabelText("Contact CSV (up to 500 records / 1 MB)")
      .upload(new File([csv], "repeat.csv", { type: "text/csv" }));
    await expect
      .element(
        screen.getByText(
          "4 records reviewed; 0 selected to create. No writes yet.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Create 0 selected contacts" }),
      )
      .toBeDisabled();
  });
});

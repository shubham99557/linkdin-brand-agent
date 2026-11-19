// Agent workspace in the browser (mock specialists, mock publisher; no external calls).
import { expect, test, type Page } from "@playwright/test";
import { TEST_PASSWORDS } from "../helpers/db.ts";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as")).toBeVisible();
}
async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

test("owner edits an account's content pillars in the Brand Brain; editors see but cannot edit", async ({ page }) => {
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Brand Brain" }).click();
  const founder = page.getByTestId("pillars-founder_profile");
  await founder.getByRole("button", { name: "Edit pillars" }).click();
  const box = page.locator("#pillars-text-founder_profile");
  await box.fill(`${await box.inputValue()}\nHiring Stories`);       // keep existing pillars, add one in plain words
  await expect(founder).toContainText("Will be saved as:");
  await expect(founder).toContainText("hiring-stories");
  await founder.getByRole("button", { name: "Save pillars" }).click();
  await expect(page.getByRole("status")).toContainText("Saved content pillars");
  await expect(founder).toContainText("hiring-stories");
  await signOut(page);

  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByRole("link", { name: "Brand Brain" }).click();
  await expect(page.getByTestId("pillars-founder_profile")).toContainText("hiring-stories");
  await expect(page.getByTestId("pillars").getByRole("button", { name: "Edit pillars" })).toHaveCount(0);
  await page.getByRole("link", { name: "New post" }).click();
  const founderValue = await page.locator("#acct option", { hasText: "Founder" }).first().getAttribute("value");
  await page.locator("#acct").selectOption(founderValue!);
  await expect(page.locator("#pillar option", { hasText: "hiring-stories" })).toHaveCount(1);   // new pillar is usable at once
});

test("owner onboards a Brand Brain section; editor runs the Branding Agent; drafts land in review", async ({ page }) => {
  // Owner: guided onboarding for one section
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Brand Brain" }).click();
  await expect(page.getByTestId("brain-completeness")).toContainText("required sections complete");
  const positioning = page.getByTestId("section-positioning");
  await expect(positioning.getByText("missing")).toBeVisible();
  await positioning.getByRole("button", { name: "Fill in" }).click();
  await page.getByTestId("answer-positioning").fill("[SYNTHETIC] For UK SMEs that need practical security help without an in-house team.");
  await page.getByTestId("save-positioning").click();
  await expect(positioning.getByText("approved")).toBeVisible();
  await signOut(page);

  // Editor: run the agent with the example goal
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await expect(page.getByRole("link", { name: "Brand Brain" })).toBeVisible();
  await page.getByRole("link", { name: "Agent workspace" }).click();
  await page.getByTestId("run-agent").click();
  await expect(page.getByTestId("research")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("research")).toContainText("[MOCK SOURCE]");
  await expect(page.getByTestId("research")).toContainText("possible prompt injection");
  await expect(page.getByTestId("strategy")).toContainText("Content plan");
  const pairs = page.getByTestId("draft-pair");
  await expect(pairs).toHaveCount(4);
  await expect(pairs.first()).toContainText("Company page");
  await expect(pairs.first()).toContainText("Founder");
  await expect(page.getByTestId("claims-report")).toContainText("Submitted for review: 8");
  await signOut(page);

  // Approver: the agent's drafts are in the normal review flow (nothing auto-approved)
  await signIn(page, "marketing@lbe.test", TEST_PASSWORDS.approver);
  await page.getByRole("link", { name: "Agent workspace" }).click();
  await page.getByRole("row").filter({ hasText: "phishing awareness" }).first().click();
  await page.getByTestId("draft-pair").first().getByRole("link", { name: "Open for review →" }).first().click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("in review");
  await expect(page.getByTestId("review-panel")).toBeVisible();
});

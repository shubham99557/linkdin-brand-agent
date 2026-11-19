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

test("Creative Studio: owner sets brand colours; agent drafts show rendered visual previews and a PDF", async ({ page }) => {
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Brand Brain" }).click();
  const panel = page.getByTestId("visual-identity");
  await expect(panel).toContainText("placeholder colours");
  await panel.getByRole("button", { name: "Set brand colours" }).click();
  await page.locator("#vi-background").fill("#0b1f3a");
  await page.locator("#vi-accent").fill("#3fb4ff");
  await page.getByTestId("save-visual-identity").click();
  await expect(page.getByRole("status")).toContainText("Saved your visual identity");
  await expect(panel).toContainText("approved");
  // naturalWidth > 0 ⇒ the browser received and decoded a real image (the project's tsconfig has no DOM lib, hence the cast).
  const loadedWidth = (img: unknown) => (img as { naturalWidth: number }).naturalWidth;
  await expect.poll(() => page.getByTestId("visual-sample").evaluate(loadedWidth), { timeout: 20_000 }).toBeGreaterThan(0);

  await page.getByRole("link", { name: "Agent workspace", exact: true }).click();
  await page.getByLabel("Goal").fill("Visual preview test week on password hygiene");
  await page.getByTestId("run-agent").click();
  const preview = page.getByTestId("visual-preview").first();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const thumb = preview.locator("img").first();
  await expect.poll(() => thumb.evaluate(loadedWidth), { timeout: 20_000 }).toBeGreaterThan(0);
  const pdfLink = page.getByRole("link", { name: "Open the PDF carousel" }).first();
  if (await pdfLink.count()) {
    const href = await pdfLink.getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.headers()["content-type"]).toBe("application/pdf");
  }
});

test("guided setup: owner answers, skips (stays UNKNOWN), resumes, adds a draft claim and reviews", async ({ page }) => {
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Brand Brain" }).click();
  await page.getByTestId("start-onboarding").click();
  // Starts at the first missing step (the e2e database begins with an empty Brand Brain).
  await expect(page.getByTestId("onboarding-progress")).toContainText("Step 1 of 14: Brand identity");
  await expect(page.getByText("stays UNKNOWN", { exact: false }).first()).toBeVisible();
  await page.locator("#wiz-identity").fill("[SYNTHETIC] ActTrident helps UK organisations run practical security programmes.");
  await page.getByTestId("wizard-save").click();
  await expect(page.getByRole("status")).toContainText('Saved "Brand identity"');
  await expect(page.getByTestId("onboarding-progress")).toContainText("Step 2 of 14: Positioning");
  // Skip positioning: it stays missing.
  await page.getByRole("button", { name: "Skip for now (stays UNKNOWN)" }).click();
  await expect(page.getByTestId("onboarding-progress")).toContainText("Step 3 of 14: Ideal customer profiles");
  // Leave and come back: resumes at the first missing step (positioning), not at step 1.
  await page.getByRole("link", { name: "Brand Brain" }).click();
  await page.getByTestId("start-onboarding").click();
  await expect(page.getByTestId("onboarding-progress")).toContainText("Step 2 of 14: Positioning");
  // Jump to the claims step and add a draft claim.
  await page.getByRole("link", { name: "Proof (claims)" }).click();
  await page.locator("#wiz-claim").fill("[SYNTHETIC] ActTrident is registered in England and Wales.");
  await page.locator("#wiz-claim-note").fill("Companies House record");
  await page.getByRole("button", { name: "Add claim (draft)" }).click();
  await expect(page.getByRole("status")).toContainText("An approver must verify it");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("wizard-review")).toContainText("Still UNKNOWN");
  await expect(page.getByTestId("wizard-review")).toContainText("Positioning");
  await signOut(page);
  // Editors cannot use the wizard.
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.goto("/#/brain/onboarding");
  await expect(page.getByText("Only the owner (admin) can complete the Brand Brain")).toBeVisible();
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
  // Run history (P4-04): the finished run is listed; opening it shows its summary instead of jumping away.
  await page.getByRole("link", { name: "Agent workspace", exact: true }).click();
  const row = page.getByTestId("run-history").getByTestId("run-row").first();
  await expect(row).toContainText("phishing awareness");
  await expect(row).toContainText("done");
  await expect(row).toContainText("8 (8)");
  await row.click();
  await expect(page.getByTestId("job-summary")).toContainText("8 draft(s), 8 in review");
  await expect(page.getByRole("link", { name: "Open the results" })).toBeVisible();
  await signOut(page);

  // Approver: the agent's drafts are in the normal review flow (nothing auto-approved)
  await signIn(page, "marketing@lbe.test", TEST_PASSWORDS.approver);
  await page.getByRole("link", { name: "Agent workspace" }).click();
  await page.getByTestId("run-history").getByTestId("run-row").filter({ hasText: "phishing awareness" }).first().click();
  await page.getByRole("link", { name: "Open the results" }).click();
  await page.getByTestId("draft-pair").first().getByRole("link", { name: "Open for review →" }).first().click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("in review");
  await expect(page.getByTestId("review-panel")).toBeVisible();
});

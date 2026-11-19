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

test("rejects a wrong password", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("editor@lbe.test");
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("invalid email or password");
});

test("sign out everywhere ends other browser sessions, which then see the sign-in notice", async ({ page, browser }) => {
  const other = await (await browser.newContext()).newPage();
  await signIn(other, "editor@lbe.test", TEST_PASSWORDS.editor);
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page.getByRole("status")).toHaveText("Signed out on all devices.");
  await other.getByRole("link", { name: "Claims register" }).click();     // next request from the other browser → 401
  await expect(other.getByRole("status")).toContainText("Your session ended");
  await expect(other.getByRole("button", { name: "Sign in" })).toBeVisible();
  await other.context().close();
});

test("full mock vertical slice through the dashboard", async ({ page }) => {
  // Editor: create, draft, submit
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByRole("link", { name: "New post" }).click();
  await expect(page.getByRole("heading", { name: "New post" })).toBeVisible();
  await page.getByLabel("Account", { exact: true }).selectOption({ label: "ActTrident (company page) — DEV" });
  await page.getByLabel(/Content pillar/).selectOption("security-culture");
  await page.getByLabel(/Brief/).fill("Encourage staff to report suspicious emails quickly.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("generate-draft").click();
  await expect(page.getByRole("status")).toContainText("AI draft generated");
  await expect(page.getByTestId("post-body")).toHaveValue(/report suspicious emails/);
  await page.getByTestId("submit-review").click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("in review");
  const contentUrl = page.url();
  // An editor sees no decision controls
  await expect(page.getByTestId("review-panel")).toHaveCount(0);
  await signOut(page);

  // Approver: preview + evidence, approve, queue
  await signIn(page, "marketing@lbe.test", TEST_PASSWORDS.approver);
  await page.goto(contentUrl);
  await expect(page.getByTestId("publication-preview")).toContainText("report suspicious emails");
  await expect(page.getByText("Supporting evidence")).toBeVisible();
  await expect(page.getByText(/Verified by/).first()).toBeVisible();
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("approved");
  await page.getByTestId("enqueue").click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("queued");
  await signOut(page);

  // Admin: run the publisher, see the mock post and the audit trail
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Publishing outbox" }).click();
  await page.getByTestId("run-publisher").click();
  await expect(page.getByText(/succeeded 1/)).toBeVisible();
  await page.getByRole("link", { name: "Mock LinkedIn" }).click();
  await expect(page.getByTestId("mock-post").first()).toContainText("report suspicious emails");
  await page.goto(contentUrl);
  await expect(page.getByTestId("status-badge").first()).toHaveText("published");
  await expect(page.getByTestId("provider-ref")).toContainText("urn:li:share:mock-");
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByText("outbox.succeeded").first()).toBeVisible();
});

test("STOP all publishing from the dashboard; only admin can resume", async ({ page }) => {
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByTestId("stop-all").click();
  await expect(page.getByText("ALL PUBLISHING STOPPED")).toBeVisible();
  await expect(page.getByTestId("resume-all")).toHaveCount(0);   // editor cannot resume
  await signOut(page);
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await expect(page.getByText("ALL PUBLISHING STOPPED")).toBeVisible();
  await page.getByTestId("resume-all").click();
  await expect(page.getByText("Publishing: running")).toBeVisible();
});

test("editing approved content sends it back to draft", async ({ page }) => {
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByRole("link", { name: "New post" }).click();
  await expect(page.getByRole("heading", { name: "New post" })).toBeVisible();
  await page.getByLabel("Account", { exact: true }).selectOption({ label: "ActTrident (company page) — DEV" });
  await page.getByLabel(/Content pillar/).selectOption("threat-landscape");
  await page.getByLabel(/Brief/).fill("Short note on patching cadence.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("generate-draft").click();
  await page.getByTestId("submit-review").click();
  const url = page.url();
  await signOut(page);
  await signIn(page, "marketing@lbe.test", TEST_PASSWORDS.approver);
  await page.goto(url);
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("approved");
  await page.getByTestId("post-body").fill("Short note on patching cadence. Edited after approval.");
  await page.getByTestId("save").click();
  await expect(page.getByTestId("status-badge").first()).toHaveText("draft");
  await expect(page.getByTestId("enqueue")).toHaveCount(0);
});

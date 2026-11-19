// Stage 2.1 browser test of the live path — against the LOCAL FAKE LinkedIn started by tests/e2e/server.ts.
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

test("connect founder via OAuth, enable live, approve, Publish now with confirmation → posted to (fake) LinkedIn", async ({ page, request }) => {
  // Admin connects the founder profile and enables live publishing
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await expect(page.getByTestId("live-banner")).toBeVisible();
  await page.getByRole("link", { name: "Accounts & voices" }).click();
  const founderPanel = page.getByTestId("linkedin-founder_profile");
  await founderPanel.getByRole("button", { name: "Connect LinkedIn" }).click();
  await expect(page.getByRole("status")).toContainText("Connected as Test Profile at Example");
  await page.getByRole("link", { name: "Back to accounts" }).click();
  await founderPanel.getByRole("button", { name: "Enable LIVE publishing" }).click();
  await expect(founderPanel.getByText("LIVE · release: manual")).toBeVisible();
  await signOut(page);

  // Editor drafts a founder post
  await signIn(page, "editor@lbe.test", TEST_PASSWORDS.editor);
  await page.getByRole("link", { name: "New post" }).click();
  await expect(page.getByRole("heading", { name: "New post" })).toBeVisible();
  await page.getByLabel("Account", { exact: true }).selectOption({ label: "Founder profile — DEV" });
  await page.getByLabel(/Content pillar/).selectOption("founder-lessons");
  await page.getByLabel(/Brief/).fill("What I learned shipping a security product this year.");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("generate-draft").click();
  await expect(page.getByRole("status")).toContainText("AI draft generated");
  await page.getByTestId("submit-review").click();
  const url = page.url();
  await signOut(page);

  // Founder approves, queues, and releases with explicit confirmation
  await signIn(page, "founder@lbe.test", TEST_PASSWORDS.founder);
  await page.goto(url);
  await page.getByTestId("approve").click();
  await page.getByTestId("enqueue").click();
  await expect(page.getByTestId("release-panel")).toContainText("LIVE");
  await expect(page.getByTestId("publish-now")).toBeDisabled();
  await page.getByTestId("confirm-public").check();
  await page.getByTestId("publish-now").click();
  await expect(page.getByRole("status")).toContainText("sent to LinkedIn on the next publisher run");
  await signOut(page);

  // Admin runs the publisher → fake LinkedIn receives the post
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  await page.getByRole("link", { name: "Publishing outbox" }).click();
  await page.getByTestId("run-publisher").click();
  await expect(page.getByText(/succeeded 1/)).toBeVisible();
  await page.goto(url);
  await expect(page.getByTestId("status-badge").first()).toHaveText("published");
  await expect(page.getByTestId("provider-ref")).toContainText("urn:li:share:");
  const posts = await (await request.get("/__fake/posts")).json();
  expect(posts.some((p: { author: string; commentary: string }) =>
    p.author === "urn:li:person:abc123XYZ" && p.commentary.includes("What I learned shipping"))).toBe(true);
});

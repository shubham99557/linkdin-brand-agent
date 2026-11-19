// P5-06: accessibility — automated axe checks (WCAG 2.x A/AA rules) on the main pages, and keyboard-only use.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TEST_PASSWORDS } from "../helpers/db.ts";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as")).toBeVisible();
}

/** Serious and critical WCAG A/AA violations on the current page (summarised for a readable failure message). */
async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.help} — e.g. ${v.nodes[0]?.target.join(" ")}`);
}

test("keyboard only: sign in, skip the navigation, reach the main content", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();   // the app first checks for an existing session
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type("editor@lbe.test");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.type(TEST_PASSWORDS.editor);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Signed in as")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();                      // hidden until focused, then shown
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
});

test("no serious or critical accessibility violations on the sign-in page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("no serious or critical accessibility violations on the main dashboard pages", async ({ page }) => {
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  const pages: Array<[string, string]> = [
    ["Content calendar", "/"], ["Brand Brain", "/brain"], ["Agent workspace", "/agent"], ["Claims register", "/claims"],
    ["Accounts & voices", "/accounts"], ["Users", "/users"], ["New post", "/new"], ["Audit log", "/audit"],
  ];
  const found: string[] = [];
  for (const [name, route] of pages) {
    await page.goto(`/#${route}`);
    await expect(page.locator("main h2").first()).toBeVisible();
    for (const v of await seriousViolations(page)) found.push(`${name}: ${v}`);
  }
  expect(found).toEqual([]);
});

test("every image has a text alternative", async ({ page }) => {
  await signIn(page, "admin@lbe.test", TEST_PASSWORDS.admin);
  for (const route of ["/brain", "/agent"]) {
    await page.goto(`/#${route}`);
    await expect(page.locator("main h2").first()).toBeVisible();
    expect(await page.locator("img:not([alt])").count(), route).toBe(0);
  }
});

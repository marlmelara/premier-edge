import { expect, test, type Page } from "@playwright/test";

/**
 * M2 verification: sign in, then walk the three CRM lenses over the same
 * `deals` spine — Deal Room (with the Property Context Card), Seller 360,
 * Pipeline, Campaigns.
 *
 * The ship-milestone E2E (inbound → draft → approve → send) extends this file
 * once the agent lands in M3.
 */

const EMAIL = process.env.E2E_EMAIL ?? "";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/deal-room/);
}

test.beforeEach(() => {
  test.skip(!EMAIL || !PASSWORD, "set E2E_EMAIL and E2E_PASSWORD (see .env.local)");
});

test("unauthenticated visitors are redirected to login", async ({ page }) => {
  await page.goto("/deal-room");
  await expect(page).toHaveURL(/\/login/);
});

test("deal room lists conversations and opens a thread with the context card", async ({ page }) => {
  await signIn(page);

  // Left rail: conversation list with filters.
  await expect(page.getByRole("link", { name: "Needs reply", exact: true })).toBeVisible();
  const conversations = page.getByTestId("conversation-row");
  await expect(conversations.first()).toBeVisible();
  await conversations.first().click();

  // Center: the thread renders the seller's message.
  await expect(page.getByText("Yes what are you offering for the land")).toBeVisible();

  // Right rail: the Property Context Card. It renders in one of two states
  // depending on whether a parcel is linked yet, so assert on the card and
  // require one of them — this suite shares a database across runs.
  const card = page.getByTestId("context-card");
  await expect(card).toBeVisible();
  const unlinked = page.getByTestId("attach-parcel-form");
  const linked = card.getByText(/ALL BOXES CHECKED|FAILED:|PENDING/);
  await expect(unlinked.or(linked).first()).toBeVisible();
});

test("linking a real Lee County parcel runs eligibility and fills the numbers", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("conversation-row").first().click();

  // Wait for the card itself before probing its contents — the rail arrives
  // with the RSC navigation, and a non-waiting check would race it.
  await expect(page.getByTestId("context-card")).toBeVisible();

  // Idempotent: a previous run may have already linked this parcel.
  const attachForm = page.getByTestId("attach-parcel-form");
  if (await attachForm.isVisible()) {
    await page.getByPlaceholder(/Parcel ID/).fill("354426L3121060010");
    await page.getByRole("button", { name: /Verify & link parcel/ }).click();
  }

  // Verdict strip + badges from the live county/FEMA/NWI checks.
  await expect(page.getByText("ALL BOXES CHECKED ✅")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Owner of record: CASTILLO AGUSTIN PONCE")).toBeVisible();
  await expect(page.getByText("11,530 sqft").first()).toBeVisible();

  // Numbers are computed from criteria (32,000 buy − 8,000 fee = 24,000 max;
  // anchor = 78% → 18,700), never typed.
  await expect(page.getByText("$24,000")).toBeVisible();
  await expect(page.getByText("$18,700")).toBeVisible();
});

test("pipeline and seller 360 are lenses on the same deal", async ({ page }) => {
  await signIn(page);

  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Eligible · needs offer" })).toBeVisible();

  // Jump to Seller 360 from the pipeline row.
  await page.locator('a[href^="/sellers/"]').first().click();
  await expect(page.getByRole("heading", { name: "Activity timeline" })).toBeVisible();
  await expect(page.getByText("Linked parcels")).toBeVisible();
});

test("campaign dashboard renders live Sendivo metrics tiles", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "Campaigns" }).click();
  await expect(page.getByRole("heading", { name: "Campaigns" })).toBeVisible();
  await expect(page.getByText("Agent stats (autonomy evidence)")).toBeVisible();
  await expect(page.getByText("Delivery rate")).toBeVisible();
});

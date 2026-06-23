import { expect, test, type Page } from "@playwright/test";

// Regression guard for the reading-pane crash ("This page couldn't load"):
// the inline-reply auto-save useEffect was placed AFTER `if (!email) return`,
// so opening an email changed the hook count and React threw "rendered more
// hooks than during the previous render". This test opens an email and drives
// the reply auto-save end-to-end (APIs mocked) to prove the pane renders.

const ACCOUNT = {
  id: "acc1",
  provider: "microsoft",
  email_address: "me@fracktal.in",
  label: "Work",
  avatar_color: "#6366f1",
  unread_count: 1,
  sync_enabled: true,
  sync_status: "idle",
};

const FOLDERS = [
  { provider_folder_id: "inbox", name: "Inbox", type: "system", message_count: 1, unread_count: 1 },
];

const MSG = {
  id: "m1",
  provider_message_id: "pm1",
  thread_id: "t1",
  account_id: "acc1",
  from_address: { name: "Alice Example", email: "alice@example.com" },
  to_addresses: [{ name: "Me", email: "me@fracktal.in" }],
  cc_addresses: [],
  subject: "Quarterly report",
  body_text: "Here is the quarterly report body for review.",
  snippet: "Here is the quarterly report body for review.",
  is_read: false,
  is_starred: false,
  is_flagged: false,
  importance: "normal",
  folder: "inbox",
  has_attachments: false,
  categories: [],
  received_at: "2026-06-20T10:00:00Z",
  synced_at: "2026-06-20T10:00:00Z",
};

async function installEmailMocks(page: Page, draftCalls: unknown[]) {
  const json = (route: import("@playwright/test").Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route(/.*\/api\/integrations\/status.*/, (r) => json(r, []));
  await page.route("**/api/email/accounts", (r) => json(r, [ACCOUNT]));
  await page.route(/.*\/api\/email\/accounts\/[^/]+\/folders.*/, (r) => json(r, FOLDERS));
  await page.route(/.*\/api\/email\/accounts\/[^/]+\/labels.*/, (r) => json(r, []));

  // List + thread share /email/messages; the thread query carries thread_id.
  await page.route(/.*\/api\/email\/messages\?.*/, (r) => {
    const url = r.request().url();
    if (url.includes("thread_id=")) {
      return json(r, { emails: [MSG], total: 1, page: 1, page_size: 100 });
    }
    return json(r, { emails: [MSG], total: 1, page: 1, page_size: 100 });
  });
  await page.route(/.*\/api\/email\/messages\/m1(\?.*)?$/, (r) => json(r, MSG));

  // Reply auto-save → PUT /email/drafts returns the persisted draft.
  await page.route(/.*\/api\/email\/drafts$/, async (r) => {
    if (r.request().method() === "PUT") {
      draftCalls.push(r.request().postDataJSON());
      return json(r, {
        id: "draft1",
        provider_message_id: "pmd1",
        thread_id: "t1",
        account_id: "acc1",
        from_address: { name: "", email: "me@fracktal.in" },
        to_addresses: [{ name: "", email: "alice@example.com" }],
        subject: "Re: Quarterly report",
        body_text: "drafted",
        snippet: "drafted",
        folder: "drafts",
        is_read: true,
        received_at: "2026-06-20T11:00:00Z",
        synced_at: "2026-06-20T11:00:00Z",
      });
    }
    return json(r, { ok: true });
  });
}

test.describe("Email reading pane", () => {
  test("opens an email without crashing and auto-saves a reply draft", async ({ page }) => {
    const draftCalls: unknown[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await installEmailMocks(page, draftCalls);

    await page.goto("/email");

    // The message shows in the list (middle column).
    await expect(page.getByText("Alice Example").first()).toBeVisible();

    // Opening it must render the reading pane — this is what used to crash.
    await page.getByText("Quarterly report").first().click();
    await expect(
      page.getByRole("heading", { name: "Quarterly report" })
    ).toBeVisible();
    await expect(page.getByText("This page couldn't load")).toHaveCount(0);

    // No uncaught React error (e.g. the hooks-order invariant) on open.
    expect(pageErrors).toEqual([]);

    // Reply → type → the auto-save effect must run cleanly and persist a draft.
    // (The list toolbar's Reply opens the full composer — "Write your message".)
    await page.getByTitle("Reply", { exact: true }).first().click();
    const body = page.getByPlaceholder(/Write your message/i);
    await expect(body).toBeVisible();
    await body.click();
    await body.pressSequentially("Thanks, looks good to me.");

    await expect(page.getByText(/Draft saved/i)).toBeVisible({ timeout: 5_000 });
    expect(draftCalls.length).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
  });
});

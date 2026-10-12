import { expect, test, type BrowserContext, type Page, type Request, type Route } from "@playwright/test";
import { installOperatorApi, installSignedOutApi } from "./operator-api";

/**
 * Epic 0 S4 (#651): UI secret canary scan (Terry's no_secrets_in_responses,
 * ui part). Canary values for a local password, an MFA secret and a vault
 * credential secret are typed into (or served to) the forms that take them.
 * Afterwards none of them may appear, as a substring, base64 or URL-encoded,
 * in: the rendered DOM, local/session storage, IndexedDB, cookies, the page
 * URL or any request URL, any response the browser received (API mocks and
 * the Next server's own HTML/RSC), or any request body other than the one
 * POST that legitimately carries it.
 */

const uid = () => crypto.randomUUID();
const CANARY = {
  PW: `FFCANARY-PW-${uid()}`,
  TOTP: `FFCANARYTOTP${uid().replace(/-/g, "").toUpperCase()}`, // base32-ish MFA secret
  CRED: `FFCANARY-CRED-${uid()}`,
};

function forms(value: string): string[] {
  const b64 = Buffer.from(value).toString("base64");
  return [value, b64, b64.replace(/=+$/, ""), encodeURIComponent(value)];
}

type Seen = {
  urls: string[];
  bodies: { url: string; method: string; body: string }[];
  responses: { url: string; body: string }[];
};

function watch(page: Page): Seen {
  const seen: Seen = { urls: [], bodies: [], responses: [] };
  page.on("request", (request: Request) => {
    seen.urls.push(request.url());
    const body = request.postData();
    if (body) {
      seen.bodies.push({ url: request.url(), method: request.method(), body });
    }
  });
  page.on("response", async (response) => {
    try {
      seen.responses.push({ url: response.url(), body: await response.text() });
    } catch {
      // redirects and aborted responses have no body
    }
  });
  return seen;
}

async function browserState(page: Page, context: BrowserContext): Promise<string> {
  const inPage = await page.evaluate(async () => {
    const dump: Record<string, unknown> = {
      dom: document.documentElement.outerHTML,
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    };
    const idb: Record<string, unknown[]> = {};
    const dbs = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(info.name as string);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        idb[`${info.name}/${store}`] = rows;
      }
      db.close();
    }
    dump.indexedDB = idb;
    return JSON.stringify(dump);
  });
  const cookies = JSON.stringify(await context.cookies());
  return `${inPage}\n${cookies}`;
}

/** Fails with where a canary showed up. allowedBody names the one POST path that may carry it. */
async function expectNoCanary(
  page: Page,
  context: BrowserContext,
  seen: Seen,
  canary: string,
  allowedBody: RegExp,
): Promise<void> {
  const needles = forms(canary);
  const hits: string[] = [];
  const hay = (where: string, text: string) => {
    if (needles.some((n) => text.includes(n))) hits.push(where);
  };
  hay("browser state (DOM, storage, IndexedDB, cookies, URL)", await browserState(page, context));
  for (const url of seen.urls) hay(`request URL ${url}`, url);
  for (const r of seen.responses) hay(`response ${r.url}`, r.body);
  for (const b of seen.bodies) {
    if (!(b.method === "POST" && allowedBody.test(new URL(b.url).pathname))) {
      hay(`request body ${b.method} ${b.url}`, b.body);
    }
  }
  expect(hits, `canary found in: ${hits.join("; ")}`).toEqual([]);
}

function problem(route: Route, status: number, code: string, detail: string) {
  return route.fulfill({
    status,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: `urn:flowforge:problem:${code}`,
      title: "Error",
      status,
      detail,
      instance: new URL(route.request().url()).pathname,
      code,
      request_id: `req-${code}`,
    }),
  });
}

test.describe("S4 UI secret canary scan", () => {
  test("local password: login form", async ({ page, context }) => {
    await installSignedOutApi(page);
    let posted = "";
    await page.route(/\/api\/(?:v1|control-plane)\/login$/, async (route) => {
      posted = route.request().postData() ?? "";
      await problem(route, 401, "invalid-credentials", "Sign-in failed.");
    });
    const seen = watch(page);
    await page.goto("/login");
    await page.getByLabel("Email or username").fill("ada");
    await page.getByLabel("Password", { exact: true }).fill(CANARY.PW);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.poll(() => posted).toContain(CANARY.PW); // the canary really went out once
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expectNoCanary(page, context, seen, CANARY.PW, /\/login$/);
  });

  test("local password: change password form", async ({ page, context }) => {
    await installOperatorApi(page);
    let posted = "";
    await page.route(/\/api\/(?:v1|control-plane)\/session\/password$/, async (route) => {
      posted = route.request().postData() ?? "";
      await problem(route, 400, "invalid-request", "The password could not be changed.");
    });
    const seen = watch(page);
    await page.goto("/change-password");
    await expect(page.getByRole("heading", { name: "Change password", level: 1 })).toBeVisible();
    for (const label of ["Current password", "New password", "Confirm password"]) {
      await page.getByLabel(label, { exact: true }).fill(CANARY.PW);
    }
    await page.getByRole("button", { name: "Change password" }).click();
    await expect.poll(() => posted).toContain(CANARY.PW);
    await expectNoCanary(page, context, seen, CANARY.PW, /\/session\/password$/);
  });

  test("MFA secret: enrollment URI is not persisted and gone after leaving", async ({ page, context }) => {
    await installOperatorApi(page, { mfaEnforcement: "on" });
    const uri = `otpauth://totp/FlowForge:ada?secret=${CANARY.TOTP}&issuer=FlowForge`;
    await page.route(/\/api\/(?:v1|control-plane)\/session\/mfa\/enroll$/, (route) =>
      route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({
        method: "totp",
        enrolled: false,
        satisfied: false,
        applicable: true,
        privileged_permissions: ["credential.view"],
        enforcement: "on",
        otpauth_uri: uri,
      }) }),
    );
    await page.route(/\/api\/(?:v1|control-plane)\/session\/mfa\/verify$/, (route) =>
      problem(route, 400, "mfa-invalid", "The code was not accepted."),
    );
    const seen = watch(page);
    await page.goto("/account/mfa");
    await page.getByRole("button", { name: "Set up MFA" }).click();
    // The URI is shown once on purpose: it may be on screen, never stored.
    await expect(page.getByLabel("Authenticator setup link")).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(forms(CANARY.TOTP).some((n) => stored.includes(n)), "MFA secret in web storage").toBe(false);
    expect(page.url()).not.toContain(CANARY.TOTP);
    await page.goto("/workflows");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The enroll response itself is the one place the secret may travel.
    seen.responses = seen.responses.filter((r) => !/\/session\/mfa\/enroll$/.test(new URL(r.url).pathname));
    await expectNoCanary(page, context, seen, CANARY.TOTP, /^$/);
  });

  test("vault credential secret: wizard review, submit and list", async ({ page, context }) => {
    await installOperatorApi(page, {
      permissions: ["workflow.view", "credential.view", "credential.manage", "execution.view", "approval.view"],
      mfaEnforcement: "off",
    });
    await page.route(/\/api\/(?:v1|control-plane)\/credentials\/catalog$/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          types: [
            {
              type: "kubernetes",
              displayName: "Kubernetes",
              secretFields: [{ name: "kubeconfig", input: "password", required: true }],
              metadataFields: [],
            },
          ],
        }),
      }),
    );
    let posted = "";
    await page.route(/\/api\/(?:v1|control-plane)\/credentials$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      posted = route.request().postData() ?? "";
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: "99999999-9999-4999-8999-999999999999",
          type: "kubernetes",
          displayName: "S4 canary",
          tags: [],
          metadata: {},
          status: "active",
          createdAt: "2026-10-12T00:00:00Z",
          updatedAt: "2026-10-12T00:00:00Z",
          permittedActions: ["view"],
        }),
      });
    });
    const seen = watch(page);
    await page.goto("/credentials/new");
    await page.getByLabel("Display name").fill("S4 canary");
    await page.getByRole("button", { name: "Continue" }).click();
    // Shared mock catalog has no field schema; give kubernetes one masked secret field.
    await page.getByRole("radio").first().check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator('textarea, input[type="password"]').first().fill(CANARY.CRED);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    // Review step: the secret is still in memory but must not be rendered.
    await expect(page.getByRole("button", { name: "Create credential" })).toBeVisible();
    await expectNoCanary(page, context, seen, CANARY.CRED, /\/credentials$/);
    await page.getByRole("button", { name: "Create credential" }).click();
    await expect.poll(() => posted).toContain(CANARY.CRED);
    // SecretField: cleared from the page after a successful submit.
    const held = await page.evaluate(
      (needle) => Array.from(document.querySelectorAll("input, textarea")).some((el) => (el as HTMLInputElement).value.includes(needle)),
      CANARY.CRED,
    );
    expect(held, "secret still held in a form control after create").toBe(false);
    await page.goto("/credentials");
    await expectNoCanary(page, context, seen, CANARY.CRED, /\/credentials$/);
  });
});

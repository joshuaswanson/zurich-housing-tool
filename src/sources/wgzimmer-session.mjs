/**
 * A persistent WG-Zimmer browser profile shared by sign-in checks and sends.
 * WG-Zimmer signs in without a password: it emails a code to the address.
 * Signed-in accounts skip the email code on each listing's contact form.
 */
import fs from "fs";
import { launchPersistentContext } from "cloakbrowser";

const LOGIN_URL = "https://www.wgzimmer.ch/en/wgzimmer/account/login.html";
const ACCOUNT_URL = "https://www.wgzimmer.ch/en/wgzimmer/account.html";
const PAGE_TIMEOUT_MS = 30000;
const STEP_TIMEOUT_MS = 45000;
const POLL_MS = 500;
const CODE_FIELD = ".otp-code__input, input[autocomplete='one-time-code']";
const MESSAGE = ".ad-form__error, .notice, [role='alert'], .turnstile__status:not([hidden])";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function isWgzimmerAuthenticated(context) {
  const response = await context.request.get(ACCOUNT_URL, {
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: PAGE_TIMEOUT_MS,
  });
  const status = response.status();
  if (status >= 200 && status < 300) return true;
  if ([301, 302, 303, 307, 308].includes(status)) return false;
  throw new Error(`WG-Zimmer returned HTTP ${status} while checking sign-in.`);
}

export function persistentWgzimmerLauncher(
  userDataDir,
  launcher = launchPersistentContext,
) {
  return (options = {}) => launcher({ ...options, userDataDir });
}

export async function checkWgzimmerSession(
  userDataDir,
  { launcher = launchPersistentContext } = {},
) {
  if (!fs.existsSync(userDataDir)) return { connected: false };
  const context = await launcher({ userDataDir, headless: true, humanize: true });
  try {
    return { connected: await isWgzimmerAuthenticated(context) };
  } finally {
    await context.close();
  }
}

async function pageMessage(page) {
  const texts = await page
    .locator(MESSAGE)
    .allInnerTexts()
    .catch(() => []);
  return texts.map((t) => t.trim()).filter(Boolean).join(" ");
}

/**
 * One sign-in in progress. start() asks WG-Zimmer to email a code, submit()
 * enters it.
 */
export class WgzimmerLogin {
  constructor(
    userDataDir,
    { launcher = launchPersistentContext, timeoutMs = STEP_TIMEOUT_MS, sleep = delay } = {},
  ) {
    this.userDataDir = userDataDir;
    this.launcher = launcher;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.step = null;
  }

  async start(email) {
    this.context = await this.launcher({
      userDataDir: this.userDataDir,
      headless: true,
      humanize: true,
    });
    if (await isWgzimmerAuthenticated(this.context)) return { connected: true };

    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await this.page.locator(".fc-cta-consent").click({ timeout: 5000 }).catch(() => {});
    await this.page.fill("#anmelden-email", email);
    await this.page.click("form[data-test='code-anfordern'] button[type='submit']");

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (await this.page.locator(CODE_FIELD).first().isVisible().catch(() => false)) {
        this.step = "code";
        return { step: "code" };
      }
      if (!(await this.page.$("#anmelden-email"))) {
        const message = await pageMessage(this.page);
        if (message) throw new Error(message);
      }
      await this.sleep(POLL_MS);
    }
    const message = await pageMessage(this.page);
    throw new Error(message || "WG-Zimmer did not send a code. Check the email address and try again.");
  }

  async submit({ code }) {
    if (!this.page || this.step !== "code") throw new Error("Start again with your email.");
    const digits = String(code || "").replace(/\D/g, "");
    if (digits.length !== 6) throw new Error("Enter the six-digit code from WG-Zimmer's email.");

    const field = this.page.locator(CODE_FIELD).first();
    await field.fill(digits);
    await this.sleep(1000);
    if (await field.isVisible().catch(() => false)) {
      await field.press("Enter").catch(() => {});
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (await isWgzimmerAuthenticated(this.context)) return { connected: true };
      if (await this.page.locator(".otp-code--wrong").count().catch(() => 0)) {
        throw new Error("The code is wrong or has expired.");
      }
      await this.sleep(POLL_MS);
    }
    const message = await pageMessage(this.page);
    throw new Error(message || "WG-Zimmer did not finish signing in. Please try again.");
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

/**
 * A persistent Flatfox browser profile shared by login checks and sends.
 * Sign-in drives Flatfox's own login page in a hidden browser, so its bot
 * checks run as usual. The password is typed into that page and not kept.
 */
import fs from "fs";
import { launchPersistentContext } from "cloakbrowser";

const LOGIN_URL = "https://flatfox.ch/en/accounts/login/";
const ACCOUNT_MENU_URL = "https://flatfox.ch/en/accounts/menu/";
const PAGE_TIMEOUT_MS = 30000;
const STEP_TIMEOUT_MS = 45000;
const POLL_MS = 500;
const LOGIN_RESPONSE = "/api/v1/auth/login/";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function isFlatfoxAuthenticated(context) {
  const response = await context.request.get(ACCOUNT_MENU_URL, {
    failOnStatusCode: false,
    maxRedirects: 0,
    timeout: PAGE_TIMEOUT_MS,
  });
  const status = response.status();
  if (status >= 200 && status < 300) return true;
  if ([301, 302, 303, 307, 308].includes(status)) return false;
  throw new Error(`Flatfox returned HTTP ${status} while checking login.`);
}

export function persistentFlatfoxLauncher(
  userDataDir,
  launcher = launchPersistentContext,
) {
  return (options = {}) => launcher({ ...options, userDataDir });
}

export async function checkFlatfoxSession(
  userDataDir,
  { launcher = launchPersistentContext } = {},
) {
  if (!fs.existsSync(userDataDir)) return { connected: false };

  const context = await launcher({
    userDataDir,
    headless: true,
    humanize: true,
  });
  try {
    return { connected: await isFlatfoxAuthenticated(context) };
  } finally {
    await context.close();
  }
}

/** Every string inside a Flatfox error body, such as {"password": ["..."]}. */
export function errorMessages(body) {
  if (typeof body === "string") return [body];
  if (Array.isArray(body)) return body.flatMap(errorMessages);
  if (body && typeof body === "object") {
    return Object.entries(body)
      .filter(([key]) => key !== "code")
      .flatMap(([, value]) => errorMessages(value));
  }
  return [];
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

/** The field Flatfox's login form is asking for now, or null. */
async function formStep(page) {
  if (await visible(page, "input[name='fullName']")) return "signup";
  if (await visible(page, "input[name='otp']")) return "code";
  if (await visible(page, "input[name='password']:enabled")) return "password";
  return null;
}

const NO_ACCOUNT =
  "Flatfox has no account for this email. Create one on flatfox.ch first.";

/**
 * One sign-in in progress. start() takes the email and answers which field
 * Flatfox asks for next. submit() takes the password or the emailed code.
 */
export class FlatfoxLogin {
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
    if (await isFlatfoxAuthenticated(this.context)) return { connected: true };

    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    await this.page
      .locator("#onetrust-reject-all-handler")
      .click({ timeout: 5000 })
      .catch(() => {});
    await this.page.fill("#id_email", email);
    await this.page.click("form button[type='submit']");

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const step = await formStep(this.page);
      if (step === "signup") throw new Error(NO_ACCOUNT);
      if (step) {
        this.step = step;
        return { step };
      }
      await this.sleep(POLL_MS);
    }
    throw new Error("Flatfox did not answer. Check the email address and try again.");
  }

  async submit({ password, code }) {
    if (!this.page || !this.step) throw new Error("Start again with your email.");
    const field = this.step === "code" ? "input[name='otp']" : "input[name='password']";
    const value = this.step === "code" ? code : password;
    if (!value) {
      throw new Error(this.step === "code" ? "Enter the code from Flatfox's email." : "Enter your password.");
    }

    const answers = [];
    const onResponse = (response) => {
      if (response.url().includes(LOGIN_RESPONSE)) answers.push(response);
    };
    this.page.on("response", onResponse);
    try {
      await this.page.fill(field, value);
      await this.page.click("form button[type='submit']");

      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        for (const response of answers.splice(0)) {
          if (response.ok()) continue;
          const body = await response.json().catch(() => null);
          // The bot check answers 403 with a challenge URL and the page retries.
          if (!body || body.url) continue;
          if (String(body.code || "").includes("device-not-verified")) continue;
          const messages = errorMessages(body);
          if (messages.length) throw new Error(messages.join(" "));
        }
        if (await isFlatfoxAuthenticated(this.context)) return { connected: true };
        if (this.step === "password" && (await formStep(this.page)) === "code") {
          this.step = "code";
          return { step: "code", newDevice: true };
        }
        await this.sleep(POLL_MS);
      }
      throw new Error("Flatfox did not finish signing in. Please try again.");
    } finally {
      this.page.off("response", onResponse);
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

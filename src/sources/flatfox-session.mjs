/**
 * A persistent Flatfox browser profile shared by login checks and sends.
 * Credentials are entered only into Flatfox's own visible login page.
 */
import fs from "fs";
import { launchPersistentContext } from "cloakbrowser";

const LOGIN_URL = "https://flatfox.ch/en/accounts/login/";
const ACCOUNT_MENU_URL = "https://flatfox.ch/en/accounts/menu/";
const PAGE_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

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

export async function loginFlatfox(
  userDataDir,
  {
    launcher = launchPersistentContext,
    pollIntervalMs = 1000,
    timeoutMs = LOGIN_TIMEOUT_MS,
    sleep = delay,
  } = {},
) {
  const context = await launcher({
    userDataDir,
    headless: false,
    humanize: true,
  });

  try {
    if (await isFlatfoxAuthenticated(context)) return { connected: true };

    const page = context.pages()[0] || (await context.newPage());
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isFlatfoxAuthenticated(context)) return { connected: true };
      if (context.pages().length === 0) {
        throw new Error("The Flatfox login window was closed before sign-in.");
      }
      await sleep(pollIntervalMs);
    }

    throw new Error("Flatfox sign-in timed out. Please try again.");
  } finally {
    await context.close().catch(() => {});
  }
}

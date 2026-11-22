/** Send a message through the contact form on a WG-Zimmer listing. */
import { launch } from "cloakbrowser";

const WGZIMMER_HOSTS = new Set(["wgzimmer.ch", "www.wgzimmer.ch"]);
const UUID_PATTERN =
  /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const PAGE_TIMEOUT_MS = 30000;
const FORM_TIMEOUT_MS = 20000;
const SEND_TIMEOUT_MS = 60000;

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} is too long (maximum ${maxLength} characters).`);
  }
  return text;
}

function optionalPhone(value) {
  const phone = String(value ?? "").trim();
  if (phone.length > 30) throw new Error("Phone is too long (maximum 30 characters).");
  return phone;
}

/** Validate and normalize everything before starting a browser. */
export function validateWgzimmerApplication(application) {
  let parsed;
  try {
    parsed = new URL(application?.url);
  } catch {
    throw new Error("A valid WG-Zimmer listing URL is required.");
  }
  const uuid = parsed.pathname.match(UUID_PATTERN)?.[1];
  if (
    parsed.protocol !== "https:" ||
    !WGZIMMER_HOSTS.has(parsed.hostname) ||
    !parsed.pathname.startsWith("/wglink/") ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !uuid
  ) {
    throw new Error("A valid WG-Zimmer listing URL is required.");
  }
  parsed.hash = "";

  const name = requiredText(application.name, "Name", 100);
  if (name.length < 2) throw new Error("Name must contain at least 2 characters.");

  return {
    url: parsed.toString(),
    uuid: uuid.toLowerCase(),
    name,
    phone: optionalPhone(application.phone),
    message: requiredText(application.message, "Message", 3000),
  };
}

const SENT_MARKER = /setLocalStorageValueByKey\s*\(\s*["']contact-/i;

function pageText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * WGZimmer answers the form POST with another HTML page.  Do not treat a 200
 * as success: reCAPTCHA and validation errors are also rendered with 200.
 */
export function classifyWgzimmerSendResponse(html) {
  const source = String(html || "");
  const text = pageText(source);

  if (SENT_MARKER.test(source)) {
    return { ok: true };
  }

  const failure = text.match(
    /[^.]{0,100}(?:reCAPTCHA|captcha|spam|Fehler|error|konnte nicht|nicht (?:gesendet|versendet|verschickt)|not sent)[^.]{0,180}/i,
  )?.[0];
  if (failure) return { ok: false, error: failure.trim() };

  if (
    /(?:e-?mail|nachricht).{0,80}(?:erfolgreich\s+)?(?:gesendet|versendet|verschickt)/i.test(
      text,
    ) ||
    /(?:e-?mail|message).{0,80}(?:successfully\s+)?sent/i.test(text) ||
    /(?:e-?mail|message).{0,80}(?:envoy|inviat|enviad|verzond)/i.test(text)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    error: "WG-Zimmer did not confirm that the message was sent.",
  };
}

async function dismissCookieBanner(page) {
  try {
    const consent = await page.$(".fc-cta-consent");
    if (consent) await consent.click();
  } catch {}
}

export const NOT_SIGNED_IN = "Sign in to WG-Zimmer in the settings first.";

async function fillIfEditable(page, selector, value) {
  const field = page.locator(selector);
  if (!(await field.count())) return;
  if (await field.evaluate((el) => el.readOnly || el.disabled)) return;
  await field.fill(value);
}

/** Send through the listing's contact form with the signed-in WG-Zimmer account. */
export async function sendWgzimmerApplication(application, launcher = launch) {
  const data = validateWgzimmerApplication(application);
  const browser = await launcher({ headless: true, humanize: true });
  try {
    const page = await browser.newPage();
    const response = await page.goto(data.url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (response && !response.ok()) {
      throw new Error(`WG-Zimmer returned HTTP ${response.status()}.`);
    }
    await dismissCookieBanner(page);
    try {
      await page.waitForSelector("#kontakt form.contact-form__form", {
        state: "visible",
        timeout: FORM_TIMEOUT_MS,
      });
    } catch {
      throw new Error("This listing no longer has a WG-Zimmer contact form.");
    }
    // Signed in, the form shows the account's address locked and has no code step.
    const signedIn =
      (await page.$("#kontakt-email[readonly]")) &&
      !(await page.$("#kontakt [data-email-send]"));
    if (!signedIn) throw new Error(NOT_SIGNED_IN);
    await fillIfEditable(page, "#kontakt-name", data.name);
    await fillIfEditable(page, "#kontakt-phone", data.phone);
    await page.fill("#kontakt-text", data.message);
    const [sent] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: SEND_TIMEOUT_MS }),
      page.locator('#kontakt button[type="submit"]').click(),
    ]);
    if (sent && !sent.ok()) throw new Error(`WG-Zimmer returned HTTP ${sent.status()}.`);
    const html = await page.content();
    const form = await page.locator("#kontakt").innerHTML().catch(() => "");
    const result = SENT_MARKER.test(html) ? { ok: true } : classifyWgzimmerSendResponse(form);
    if (!result.ok) throw new Error(result.error);
    return result;
  } finally {
    await browser.close();
  }
}

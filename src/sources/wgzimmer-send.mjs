/** Open WGZimmer's contact form for email verification and sending. */
import { randomUUID } from "node:crypto";
import { launch } from "cloakbrowser";

const WGZIMMER_HOSTS = new Set(["wgzimmer.ch", "www.wgzimmer.ch"]);
const UUID_PATTERN =
  /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
const PAGE_TIMEOUT_MS = 30000;
const FORM_TIMEOUT_MS = 20000;

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
  const email = requiredText(application.email, "Email", 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email address is required.");
  }

  return {
    url: parsed.toString(),
    uuid: uuid.toLowerCase(),
    name,
    email,
    phone: optionalPhone(application.phone),
    message: requiredText(application.message, "Message", 3000),
  };
}

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

  if (/setLocalStorageValueByKey\s*\(\s*["']contact-/i.test(source)) {
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

/**
 * Request an email code using the site controls, then retain this browser
 * for the verification endpoint. A code request is not a sent application.
 */
const pending = new Map();

export async function completeWgzimmerApplication(id, code, cancel = false) {
  const session = pending.get(id);
  if (!session) throw new Error("Verification expired. Start sending again.");
  if (session.busy) throw new Error("Verification is already in progress.");
  session.busy = true;
  const { page, browser } = session;
  try {
    if (cancel) return { cancelled: true };
    if (!/^\d{6}$/.test(String(code))) throw new Error("Enter the six-digit email code.");
    await page.fill("#kontakt-code", String(code));
    await page.locator('#kontakt [data-email-check]').click();
    await page.waitForFunction(() => document.querySelector('#kontakt-email')?.readOnly, null, { timeout: 15000 });
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      page.locator('#kontakt button[type="submit"]').click(),
    ]);
    if (response && !response.ok()) throw new Error(`WG-Zimmer returned HTTP ${response.status()}.`);
    const result = classifyWgzimmerSendResponse(await page.locator('#kontakt').innerHTML());
    if (!result.ok) throw new Error(result.error + " Check WG-Zimmer before retrying.");
    return result;
  } finally {
    pending.delete(id);
    clearTimeout(session.timer);
    await browser.close();
  }
}

export async function sendWgzimmerApplication(application, launcher = launch) {
  const data = validateWgzimmerApplication(application);
  if ([...pending.values()].some(session => session.uuid === data.uuid)) {
    throw new Error("Finish or cancel the pending verification for this listing first.");
  }
  const browser = await launcher({ headless: false, humanize: true });
  let handedOver = false;
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
    await page.fill("#kontakt-name", data.name);
    await page.fill("#kontakt-email", data.email);
    await page.fill("#kontakt-phone", data.phone);
    await page.fill("#kontakt-text", data.message);
    await page.locator("#kontakt").scrollIntoViewIfNeeded();
    await page.bringToFront();
    await page.locator('#kontakt [data-email-send]').click();
    await page.waitForSelector('#kontakt [data-email-code]:visible', { timeout: 45000 });
    const verificationId = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(verificationId);
      void browser.close().catch(() => {});
    }, 10 * 60 * 1000);
    timer.unref();
    pending.set(verificationId, { page, browser, timer, uuid: data.uuid, busy: false });
    page.once("close", () => {
      pending.delete(verificationId);
      clearTimeout(timer);
      void browser.close().catch(() => {});
    });
    handedOver = true;
    return { ok: false, verificationId };

  } finally {
    if (!handedOver) await browser.close();
  }
}

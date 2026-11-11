/** Open WGZimmer's contact form for email verification and sending. */
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
    throw new Error("A valid WGZimmer listing URL is required.");
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
    throw new Error("A valid WGZimmer listing URL is required.");
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
    error: "WGZimmer did not confirm that the message was sent.",
  };
}

async function dismissCookieBanner(page) {
  try {
    const consent = await page.$(".fc-cta-consent");
    if (consent) await consent.click();
  } catch {}
}

/**
 * WGZimmer now requires an email OTP. Keep its visible browser open so the
 * applicant can verify their address and submit using the site's own controls.
 * A prepared form is deliberately not reported as a sent application.
 */
export async function sendWgzimmerApplication(application, launcher = launch) {
  const data = validateWgzimmerApplication(application);
  const browser = await launcher({ headless: false, humanize: true });
  let handedOver = false;
  try {
    const page = await browser.newPage();
    const response = await page.goto(data.url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (response && !response.ok()) {
      throw new Error(`WGZimmer returned HTTP ${response.status()}.`);
    }
    await dismissCookieBanner(page);
    try {
      await page.waitForSelector("#kontakt form.contact-form__form", {
        state: "visible",
        timeout: FORM_TIMEOUT_MS,
      });
    } catch {
      throw new Error("This listing no longer has a WGZimmer contact form.");
    }
    await page.fill("#kontakt-name", data.name);
    await page.fill("#kontakt-email", data.email);
    await page.fill("#kontakt-phone", data.phone);
    await page.fill("#kontakt-text", data.message);
    await page.locator("#kontakt").scrollIntoViewIfNeeded();
    await page.bringToFront();
    // Closing the window releases the browser process. Do not close the form
    // when this request returns: the user still needs to verify and send it.
    page.once("close", () => { void browser.close().catch(() => {}); });
    handedOver = true;
    return { ok: false, requiresCompletion: true };
  } finally {
    if (!handedOver) await browser.close();
  }
}

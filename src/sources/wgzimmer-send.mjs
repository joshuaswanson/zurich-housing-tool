/**
 * Send a message through wgzimmer.ch's own contact form.
 *
 * The form is loaded lazily and its submit handler obtains an invisible
 * reCAPTCHA v3 token before doing a normal POST.  Keeping the whole flow in a
 * real browser means the token is created for the right origin and action.
 */
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

  const name = requiredText(application.name, "Name", 200);
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
    phone: String(application.phone ?? "").trim().slice(0, 100),
    message: requiredText(application.message, "Message", 10000),
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
 * Submit one application. `launcher` is injectable so the browser workflow can
 * be tested without contacting WGZimmer.
 */
export async function sendWgzimmerApplication(application, launcher = launch) {
  const data = validateWgzimmerApplication(application);
  const browser = await launcher({ headless: true, humanize: true });

  try {
    const page = await browser.newPage();
    const listingResponse = await page.goto(data.url, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (listingResponse && !listingResponse.ok()) {
      throw new Error(`WGZimmer returned HTTP ${listingResponse.status()}.`);
    }

    await dismissCookieBanner(page);
    const contactLink = await page.$('a[onclick*="showContactDetail"]');
    if (!contactLink) {
      throw new Error("This listing no longer has a WGZimmer contact form.");
    }
    await contactLink.click();
    await page.waitForSelector("#searchMateContactMailForm", {
      state: "visible",
      timeout: FORM_TIMEOUT_MS,
    });

    await page.fill("#senderName", data.name);
    await page.fill("#senderEmail", data.email);
    await page.fill("#senderPhone", data.phone);
    await page.fill("#senderText", data.message);

    // Clicking the site's button runs its own submitSearchMateForm function,
    // including grecaptcha.execute with WGZimmer's configured action.
    const navigation = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: SEND_TIMEOUT_MS,
    });
    await page.click('#searchMateContactMailForm input[type="submit"]');
    const response = await navigation;
    if (response && !response.ok()) {
      throw new Error(`WGZimmer returned HTTP ${response.status()}.`);
    }

    const result = classifyWgzimmerSendResponse(await page.content());
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  } finally {
    await browser.close();
  }
}

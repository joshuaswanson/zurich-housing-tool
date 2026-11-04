/**
 * Send a message through the lightweight contact form on a Flatfox listing.
 *
 * This intentionally does not use Flatfox's `/submit/` rental dossier, which
 * asks for identity, employment, salary, references, and supporting files.
 */
import { launch } from "cloakbrowser";

const FLATFOX_HOSTS = new Set(["flatfox.ch", "www.flatfox.ch"]);
const LISTING_PATH = /^\/(?:en|de|it|fr)\/flat\/[^/]+\/(\d{5,})\/?$/i;
const PAGE_TIMEOUT_MS = 30000;
const VERIFY_TIMEOUT_MS = 45000;
const SEND_TIMEOUT_MS = 60000;

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) {
    throw new Error(`${label} is too long (maximum ${maxLength} characters).`);
  }
  return text;
}

export function validateFlatfoxApplication(application) {
  let parsed;
  try {
    parsed = new URL(application?.url);
  } catch {
    throw new Error("A valid Flatfox listing URL is required.");
  }
  const pk = parsed.pathname.match(LISTING_PATH)?.[1];
  if (
    parsed.protocol !== "https:" ||
    !FLATFOX_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443") ||
    !pk
  ) {
    throw new Error("A valid Flatfox listing URL is required.");
  }
  parsed.hash = "";

  const name = requiredText(application.name, "Name", 64);
  const email = requiredText(application.email, "Email", 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("A valid email address is required.");
  }

  return {
    url: parsed.toString(),
    pk,
    name,
    email,
    phone: requiredText(application.phone, "Phone", 63),
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

/** A successful Django form POST redirects back to the listing page. */
export function wasRedirectedFromPost(response) {
  let request = response?.request?.()?.redirectedFrom?.() || null;
  while (request) {
    if (request.method?.() === "POST") return true;
    request = request.redirectedFrom?.() || null;
  }
  return false;
}

export function classifyFlatfoxSendResponse(
  html,
  { redirectedFromPost = false } = {},
) {
  if (redirectedFromPost) return { ok: true };

  const text = pageText(html);
  const failure = text.match(
    /[^.]{0,100}(?:Turnstile|captcha|CSRF|spam|Fehler|error|konnte nicht|nicht (?:gesendet|versendet)|not sent)[^.]{0,180}/i,
  )?.[0];
  if (failure) return { ok: false, error: failure.trim() };

  if (
    /(?:request|message).{0,80}(?:successfully\s+)?sent/i.test(text) ||
    /(?:anfrage|nachricht).{0,80}(?:erfolgreich\s+)?(?:gesendet|versendet)/i.test(
      text,
    ) ||
    /(?:richiesta|messaggio).{0,80}inviat/i.test(text) ||
    /(?:demande|message).{0,80}envoy/i.test(text)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    error: "Flatfox did not confirm that the message was sent.",
  };
}

async function dismissCookieBanner(page) {
  try {
    const reject = await page.$("#onetrust-reject-all-handler");
    if (reject) await reject.click();
  } catch {}
}

async function fillIfPresent(page, selector, value) {
  if (await page.$(selector)) await page.fill(selector, value);
}

export async function sendFlatfoxApplication(application, launcher = launch) {
  const data = validateFlatfoxApplication(application);
  const browser = await launcher({ headless: true, humanize: true });
  let page;

  try {
    page = await browser.newPage();
    const listingResponse = await page.goto(data.url, {
      waitUntil: "networkidle",
      timeout: PAGE_TIMEOUT_MS,
    });
    if (listingResponse && !listingResponse.ok()) {
      throw new Error(`Flatfox returned HTTP ${listingResponse.status()}.`);
    }

    await dismissCookieBanner(page);
    await page.waitForSelector("#contact-request", {
      state: "visible",
      timeout: PAGE_TIMEOUT_MS,
    });
    // Signed-in accounts may already supply some contact fields and omit their
    // editable inputs. Anonymous forms expose all three.
    await fillIfPresent(page, "#id_name", data.name);
    await fillIfPresent(page, "#id_email", data.email);
    await fillIfPresent(page, "#id_phone_number", data.phone);
    await page.fill("#id_text", data.message);

    // Flatfox opts visitors into a search subscription by default. Sending a
    // housing enquiry should not create an unrelated subscription.
    if (await page.$("#id_create_subscription")) {
      await page.uncheck("#id_create_subscription");
    }

    try {
      await page.waitForFunction(
        () => {
          const form = document.querySelector("#contact-request");
          const csrf = form?.querySelector(
            'input[name="csrfmiddlewaretoken"]',
          )?.value;
          const captcha = form?.querySelector('input[name="captcha"]')?.value;
          const button = form?.querySelector('button[type="submit"]');
          return Boolean(csrf && captcha && button && !button.disabled);
        },
        null,
        { timeout: VERIFY_TIMEOUT_MS },
      );
    } catch {
      throw new Error(
        "Flatfox's security check requires interaction. Open the listing and send the message there.",
      );
    }

    const navigation = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: SEND_TIMEOUT_MS,
    });
    await page.click('#contact-request button[type="submit"]');
    const response = await navigation;
    if (response && !response.ok()) {
      throw new Error(`Flatfox returned HTTP ${response.status()}.`);
    }

    const result = classifyFlatfoxSendResponse(await page.content(), {
      redirectedFromPost: wasRedirectedFromPost(response),
    });
    if (!result.ok) throw new Error(result.error);
    return { ok: true };
  } finally {
    try {
      await page?.close?.();
    } catch {}
    await browser.close();
  }
}

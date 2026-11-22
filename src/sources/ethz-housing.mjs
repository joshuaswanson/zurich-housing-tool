/**
 * The Housing Office UZH/ETH portal. It signs in through ETH's own login page
 * in a hidden browser with a persistent profile, then reads the portal's JSON
 * API from inside that page so its session cookies apply.
 *
 * This uses the installed Google Chrome. The bundled stealth Chromium cannot
 * connect to idapps.ethz.ch or access.ethz.ch.
 */
import { chromium } from "playwright-core";

export function launchChrome({ userDataDir, headless = true }) {
  return chromium.launchPersistentContext(userDataDir, { channel: "chrome", headless });
}

export const PORTAL_URL = "https://idapps.ethz.ch/accommodation-web/";
export const SEARCH_URL = `${PORTAL_URL}search-advertisements/1`;
const API = "/accommodation-services/v2";
const LOGIN_HOST = "access.ethz.ch";
const USERNAME_FIELD =
  'input[name="com.siemens.dxa.applications.web.authn.challenging.username"]';
const PASSWORD_FIELD =
  'input[name="com.siemens.dxa.applications.web.authn.challenging.response"]';
const PAGE_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 30000;
const PAGE_SIZE = 100;

export const NOT_CONNECTED = "Sign in to ETH Housing under Accounts first.";

const onPortal = (page) => page.url().startsWith(PORTAL_URL);

/**
 * Open the portal, signing in with the credentials when ETH asks for them.
 * The portal page keeps loading its own data, which can hang when ETH's
 * services are slow, so only the page itself is waited for.
 */
async function openPortal(page, credentials) {
  await page.goto(`${PORTAL_URL}account`, {
    waitUntil: "domcontentloaded",
    timeout: PAGE_TIMEOUT_MS,
  });
  if (onPortal(page)) return;
  await page
    .waitForSelector(USERNAME_FIELD, { timeout: PAGE_TIMEOUT_MS })
    .catch(() => {});
  if (!new URL(page.url()).hostname.endsWith(LOGIN_HOST)) {
    throw new Error("ETH Housing did not open its login page.");
  }
  if (!credentials?.username || !credentials?.password) {
    throw new Error(NOT_CONNECTED);
  }
  await page.fill(USERNAME_FIELD, credentials.username);
  await page.fill(PASSWORD_FIELD, credentials.password);
  await Promise.all([
    page
      .waitForURL((url) => url.href.startsWith(PORTAL_URL), {
        timeout: LOGIN_TIMEOUT_MS,
      })
      .catch(() => {}),
    page.press(PASSWORD_FIELD, "Enter"),
  ]);
  if (!onPortal(page)) {
    const message = await page
      .locator(".alert, .error, [role=alert]")
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "");
    throw new Error(
      message.trim() || "ETH did not accept the user name or password.",
    );
  }
}

async function api(page, path) {
  const result = await page.evaluate(async (url) => {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }, `${API}${path}`);
  if (result.status !== 200) {
    throw new Error(`ETH Housing returned HTTP ${result.status}.`);
  }
  return result.body;
}

async function allAdvertisements(page) {
  const ads = [];
  for (let first = 0; ; first += PAGE_SIZE) {
    const body = await api(
      page,
      `/applicant/advertisements?rs-first=${first}&rs-size=${PAGE_SIZE}`,
    );
    const results = body["search-results"] || {};
    ads.push(...(results.advertisements || []));
    const total = results["total-count"] ?? ads.length;
    if (ads.length >= total || !(results.advertisements || []).length) break;
  }
  return ads;
}

/**
 * Run fn with a signed-in portal page. Throws NOT_CONNECTED when the session
 * has ended and no credentials are saved.
 */
export async function withEthzPortal(
  userDataDir,
  credentials,
  fn,
  { launcher = launchChrome } = {},
) {
  let context;
  try {
    context = await launcher({ userDataDir, headless: true });
  } catch (e) {
    if (/executable|chrome.*not found|distribution/i.test(e.message)) {
      throw new Error("ETH Housing needs Google Chrome installed.");
    }
    throw e;
  }
  try {
    const page = await context.newPage();
    await openPortal(page, credentials);
    return await fn(page);
  } finally {
    await context.close();
  }
}

export const fetchEthzAccount = (page) => api(page, "/accounts");
export const fetchEthzAdvertisements = allAdvertisements;

const swissDate = (iso) => {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
};

/** Profile fields taken from the portal account, in the app's profile shape. */
export function profileFromAccount(account) {
  const name = [account["given-name"], account.surname].filter(Boolean).join(" ");
  const languages = (account["communication-languages"] || [])
    .map((l) => l["communication-language-desc"])
    .filter(Boolean)
    .join(", ");
  return Object.fromEntries(
    Object.entries({
      name,
      email: account["e-mail-address"],
      phone: account.phone,
      dateOfBirth: swissDate(account["date-of-birth"]),
      affiliation: account.applicant?.["applicant-type-desc"],
      street: account["street-no"],
      postalCode: account["postal-code"],
      city: account.town,
      country: account["country-name"],
      languages,
    }).filter(([, value]) => value),
  );
}

const listText = (items) =>
  (items || []).map((item) => item.desc).filter(Boolean).join(", ");

const minutes = (value) => (value ? `${value} min` : null);

/** The detail sections the listing panel shows for one advertisement. */
export function ethzDetails(ad) {
  const facts = (pairs) =>
    pairs
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([label, value]) => `${label}: ${value}`)
      .join("\n");
  const household = facts([
    ["Women", ad["same-household-women"]],
    ["Men", ad["same-household-men"]],
    ["Children", ad["same-household-children"]],
    ["Pets", ad["same-household-pets"]],
    ["Instruments", ad["same-household-instruments"]],
  ]);
  return {
    sectionOrder: ["description", "livingspace", "facilities", "nearby", "lookingFor", "weAre"],
    description: ad["description-en"] || ad["description-de"] || "",
    livingspace: facts([
      ["Type", ad["accommodation-type-desc"]],
      ["Rooms", ad.rooms],
      ["Area", ad["living-space"] ? `${ad["living-space"]} m²` : null],
      ["Floor", ad["floor-desc"]],
      ["Net rent", ad["net-rent"] ? `CHF ${ad["net-rent"]}` : null],
      ["Additional costs", ad["additional-expenses"] ? `CHF ${ad["additional-expenses"]}` : null],
      ["Deposit", ad.deposit ? `CHF ${ad.deposit}` : null],
    ]),
    facilities: facts([
      ["Furnished", ad["furnished-desc"]],
      ["Kitchen", ad["kitchen-desc"]],
      ["Shower/bath", ad["shower-bath-desc"]],
      ["WC", ad["toilet-desc"]],
      ["Washing machine", ad["washing-machine-desc"]],
      ["Common rooms", listText(ad["common-rooms-array"])],
      ["Outdoor areas", listText(ad["outdoor-area-array"])],
      ["Vehicles", listText(ad["vehicles-array"])],
    ]),
    nearby: facts([
      ["To ETH Zentrum", minutes(ad["time-centre"])],
      ["To ETH Hönggerberg", minutes(ad["time-hoenggerberg"])],
      ["To UZH Irchel", minutes(ad["time-irchel"])],
    ]),
    lookingFor: facts([
      ["Gender", ad["searched-person-sex-desc"]],
      ["Smokers welcome", ad["smokers-welcome-desc"]],
    ]),
    weAre: household,
  };
}

/** One advertisement in the app's listing shape, without the shared fields. */
export function ethzListing(ad) {
  const gross = (ad["net-rent"] || 0) + (ad["additional-expenses"] || 0);
  const address = [ad["street-no"], [ad["postal-code"], ad.town].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const contact = [ad["contact-person-given-name"], ad["contact-person-surname"]]
    .filter(Boolean)
    .join(" ");
  return {
    id: `ethz-${ad["advertisement-id"]}`,
    type: ad["accommodation-type-code"],
    price: gross || null,
    lat: ad.latitude || null,
    lng: ad.longitude || null,
    address: address || null,
    description: [
      `Advertisement No. ${ad["advertisement-id"]}`,
      ad["description-en"] || ad["description-de"] || "",
    ]
      .filter(Boolean)
      .join("\n"),
    availableFrom: ad["available-by-arrangement"]
      ? "By agreement"
      : swissDate(ad["available-from"]),
    until: swissDate(ad["available-till"]),
    url: `${SEARCH_URL}?advertisement=${ad["advertisement-id"]}`,
    contactEmail: ad["contact-e-mail"] || null,
    contactName: contact || null,
    contactPhone: ad["contact-phone"] || null,
    wantedGender: { female: "female", male: "male" }[
      String(ad["searched-person-sex-desc"] || "").toLowerCase()
    ] || null,
    wholeFlat: [3, 4].includes(ad["accommodation-type-code"]),
    details: ethzDetails(ad),
  };
}

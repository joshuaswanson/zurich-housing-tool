const ROWS_PER_PAGE = 200;
let rowLimit = ROWS_PER_PAGE;
let filteredListings = [];
const SOURCE_SITES = [
  "wgzimmer.ch",
  "flatfox.ch",
  "ronorp.net",
  "students.ch",
];

let target = { lat: 47.3764, lng: 8.5483, label: "ETH Zentrum" };
let allListings = [];
let tracker = { applied: [], excluded: [], rejected: [], shortlisted: [] };
let appMessages = [];
let sortBy = "price";
let sortDescending = false;
const trackedStatus = new Map();
const TARGET_KEY = "zurich-housing-target";
const TARGET_PRESETS = [
  { label: "ETH Zentrum", lat: 47.3764, lng: 8.5483 },
  { label: "ETH Hönggerberg", lat: 47.4085, lng: 8.5075 },
  { label: "UZH Zentrum", lat: 47.3744, lng: 8.5508 },
  { label: "UZH Irchel", lat: 47.3975, lng: 8.5495 },
];
const WALKING_MINUTES_PER_KM = 12;
const DETAIL_SECTIONS = [
  "room",
  "weAre",
  "lookingFor",
  "nearby",
  "description",
  "facilities",
  "particulars",
  "livingspace",
  "floor",
];
const FETCHABLE_SOURCES = ["wgzimmer", "flatfox"];
const SHOW_FILTERS = {
  "f-gender": "genderRestricted",
  "f-student": "studentHousing",
  "f-short": "shortSublet",
  "f-bulk": "bulkPoster",
  "f-flats": "wholeFlat",
};
const CHECKBOX_FILTERS = [
  "f-tracked",
  "f-permanent",
  ...Object.keys(SHOW_FILTERS),
];

// Tracker entries and listings can use different URLs for one listing,
// so they are matched on the wgzimmer UUID or the flatfox number.
function listingKey(url) {
  return (
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] ||
    url.match(/\/(\d{5,})\/?$/)?.[1] ||
    url
  );
}

function statusOf(url) {
  return trackedStatus.get(listingKey(url));
}

const FILTERS_KEY = "zurich-housing-filters-3";

const $ = (id) => document.getElementById(id);

const LANGUAGE_KEY = "zurich-housing-language";
let language =
  localStorage.getItem(LANGUAGE_KEY) ||
  (navigator.language.startsWith("de") ? "de" : "en");

function t(key, values = {}) {
  return STRINGS[language][key].replace(
    /\{(\w+)\}/g,
    (_, name) => values[name],
  );
}

function counted(key, n) {
  return t(`${key}_${n === 1 ? "one" : "other"}`, { n });
}

function translatePage() {
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
}

function setLanguage(next) {
  language = next;
  localStorage.setItem(LANGUAGE_KEY, next);
  translatePage();
  applyFilters();
  renderApplications();
  renderProfile(readProfileForm());
  renderFlatfoxSession();
  loadScanStatus();
  if (apiSettings) showApiSettings(apiSettings);
}


function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function joinList(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${t("and")} ${items.at(-1)}`;
}

// Same key that track.js uses for notes.
function noteKey(url) {
  return (
    url.match(
      /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
    )?.[1] || url
  );
}

function noteFor(url) {
  return tracker.notes?.[noteKey(url)] || "";
}

function firstSeenWithin(l, hours) {
  return (
    !l.firstSeen ||
    Date.now() - new Date(l.firstSeen).getTime() < hours * 3600 * 1000
  );
}

function distanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function measureDistances() {
  for (const l of allListings) {
    l.dist =
      l.lat && l.lng
        ? Math.round(distanceKm(target, l) * 100) / 100
        : null;
  }
}

const LAST = Number.MAX_SAFE_INTEGER;

// Listings free now sort first, dated ones by date, and the rest last.
function availableTime(l) {
  if (l.availableFrom === "Immediately") return 0;
  const date = (l.availableFrom || "").match(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
  );
  if (!date) return LAST;
  return new Date(date[3], date[2] - 1, date[1]).getTime();
}

const SORT_COMPARATORS = {
  price: (a, b) => a.price - b.price,
  distance: (a, b) => (a.dist ?? LAST) - (b.dist ?? LAST),
  available: (a, b) =>
    availableTime(a) - availableTime(b) || a.price - b.price,
  source: (a, b) =>
    a.source.localeCompare(b.source) || a.price - b.price,
};

function matchesKeywords(l, keywords) {
  if (keywords.length === 0) return true;
  const text = `${l.address || ""} ${l.description}`.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword));
}

async function load() {
  try {
    const [listRes, trackRes] = await Promise.all([
      fetch("/api/listings"),
      fetch("/api/tracker"),
    ]);
    allListings = await listRes.json();
    tracker = await trackRes.json();
  } catch (e) {
    showEmpty(t("load_failed"));
    return;
  }

  trackedStatus.clear();
  for (const cat of ["shortlisted", "excluded", "rejected", "applied"]) {
    for (const e of tracker[cat] || []) {
      trackedStatus.set(listingKey(e.url), cat);
    }
  }

  // A price below 50 is a parsing error in the scraped listing.
  allListings = allListings.filter((l) => l.price >= 50);
  measureDistances();

  applyFilters();
  renderApplications();
}

function applyFilters() {
  const maxPrice = parseInt($("f-price").value);
  const maxDist = parseFloat($("f-dist").value);
  const newHours = parseInt($("f-new").value);
  const keywords = $("f-keyword")
    .value.toLowerCase()
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const checked = Object.fromEntries(
    CHECKBOX_FILTERS.map((id) => [id, $(id).checked]),
  );

  localStorage.setItem(
    FILTERS_KEY,
    JSON.stringify({
      maxPrice,
      maxDist,
      newHours,
      checked,
      sortBy,
      sortDescending,
    }),
  );

  const activeExtras =
    Object.values(checked).filter(Boolean).length + (newHours ? 1 : 0);
  $("more-filters-count").textContent = activeExtras || "";

  $("f-price-val").textContent = `CHF ${maxPrice}`;
  $("f-dist-val").textContent = `${maxDist} km`;

  const filtered = allListings.filter((l) => {
    if (l.price > maxPrice) return false;
    if (l.dist !== null && l.dist > maxDist) return false;
    if (!checked["f-tracked"] && statusOf(l.url)) return false;
    if (newHours && !firstSeenWithin(l, newHours)) return false;
    if (checked["f-permanent"] && l.hasEndDate) return false;
    if (!matchesKeywords(l, keywords)) return false;
    for (const [id, flag] of Object.entries(SHOW_FILTERS)) {
      if (!checked[id] && l[flag]) return false;
    }
    return true;
  });

  const compare = SORT_COMPARATORS[sortBy];
  filtered.sort((a, b) =>
    sortDescending ? compare(b, a) : compare(a, b),
  );

  $("tab-listings-count").textContent = filtered.length;
  filteredListings = filtered;
  rowLimit = ROWS_PER_PAGE;
  renderTable(filtered);
  setMapListings(filtered);
}

function selectTab(tab) {
  document.querySelectorAll(".tab").forEach((other) => {
    const selected = other === tab;
    other.setAttribute("aria-selected", selected);
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute("aria-controls")).hidden = !selected;
  });
}

function showEmpty(text) {
  $("listings-body").innerHTML = "";
  $("listings-table").hidden = true;
  $("listings-empty").hidden = false;
  $("listings-empty").textContent = text;
  $("listings-note").textContent = "";
  $("show-more").hidden = true;
}

function renderTable(listings) {
  if (allListings.length === 0) {
    showEmpty(
      t("empty_none", { sources: joinList(SOURCE_SITES) }),
    );
    return;
  }
  if (listings.length === 0) {
    showEmpty(t("empty_filtered"));
    return;
  }

  $("listings-table").hidden = false;
  $("listings-empty").hidden = true;
  renderShowMore(listings.length);

  const unmapped = listings.filter((l) => !l.lat || !l.lng).length;
  const notes = [
    listings.length > rowLimit
      ? t("showing_first", { max: rowLimit, total: listings.length })
      : t("showing_of", {
          shown: listings.length,
          total: allListings.length,
        }),
  ];
  if (unmapped > 0) {
    notes.push(t("unmapped", { n: unmapped }));
  }
  $("listings-note").textContent = notes.join(". ");

  $("listings-body").innerHTML = listings
    .slice(0, rowLimit)
    .map(
      (l) => `
        <tr class="listing-row" data-id="${esc(l.id)}" tabindex="0">
          <td class="rent">
            <div>${esc(l.price)}</div>
            ${l.pricePeriod ? `<div class="secondary">${t(`per_${l.pricePeriod}`)}</div>` : ""}
          </td>
          <td class="nowrap">
            ${l.dist !== null ? `<div>${l.approximate ? t("about", { value: `${l.dist.toFixed(1)} km` }) : `${l.dist.toFixed(1)} km`}</div><div class="secondary">${t("min_walk", { n: Math.round(l.dist * WALKING_MINUTES_PER_KM) })}</div>` : ""}
          </td>
          <td>
            <div>
              ${esc(l.address || t("address_missing"))}
              ${statusOf(l.url) ? `<span class="status">${t(`status_${statusOf(l.url)}`)}</span>` : ""}
              ${l.wholeFlat ? `<span class="status">${t("status_flat")}</span>` : ""}
            </div>
            ${summary(l) ? `<div class="description">${esc(summary(l))}</div>` : ""}
          </td>
          <td class="available">
            <div>${esc(availability(l))}</div>
            ${endDate(l) ? `<div class="secondary">${esc(t("until", { date: endDate(l) }))}</div>` : ""}
          </td>
          <td><span class="source"><i class="dot dot-${esc(l.source)}"></i>${esc(l.source)}</span></td>
          <td>
            <div class="row-actions">
              <a href="${esc(l.url)}" target="_blank" rel="noopener">${t("open")}</a>
            </div>
          </td>
        </tr>`,
    )
    .join("");
}

function renderShowMore(total) {
  const remaining = Math.max(0, total - rowLimit);
  $("show-more").hidden = remaining === 0;
  $("show-more").textContent = t("show_more", {
    n: Math.min(remaining, ROWS_PER_PAGE),
  });
}

      const AVAILABILITY_KEYS = {
  Immediately: "avail_immediately",
  "By agreement": "avail_agreement",
};

function availability(l) {
  const key = AVAILABILITY_KEYS[l.availableFrom];
  return key ? t(key) : l.availableFrom || "";
}

function endDate(l) {
  return /no time restriction/i.test(l.until || "") ? "" : l.until;
}

// wgzimmer descriptions are pipe-separated fields. Only the free-text
// fields are shown, since the rest repeat other columns.
function summary(l) {
  if (l.source !== "wgzimmer") return l.description;
  return l.description
    .split(" | ")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part &&
        part !== l.address &&
        !/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(part) &&
        !/^[\d,.']+$/.test(part) &&
        !/^until:/i.test(part) &&
        !/^zürich \(stadt\)$/i.test(part),
    )
    .join(", ");
}

function daysAgo(date) {
  if (!date) return "";
  const days = Math.floor(
    (Date.now() - new Date(date).getTime()) / 86400000,
  );
  if (days <= 0) return t("today");
  return counted("days_ago", days);
}

const APPLICATION_GROUPS = ["applied", "shortlisted", "rejected"];
const TRACKED_ACTIONS = {
  applied: [
    ["show-message", "act_show_message"],
    ["reject", "act_reject"],
    ["untrack", "act_remove"],
  ],
  shortlisted: [
    ["apply", "act_apply"],
    ["untrack", "act_remove"],
  ],
  rejected: [["untrack", "act_remove"]],
  excluded: [["untrack", "act_restore"]],
};

function actionButtons(actions) {
  return actions
    .map(
      ([action, label]) =>
        `<button class="button" type="button" data-action="${action}">${t(label)}</button>`,
    )
    .join("");
}

function trackedEntries(category) {
  return (tracker[category] || [])
    .map(
      (e) => `
        <div class="application" data-url="${esc(e.url)}">
          <a class="application-place" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.address || e.url.substring(0, 60))}</a>
          <span class="rent">${e.price ? "CHF " + esc(e.price) : ""}</span>
          <span class="secondary">${esc(e.reason || daysAgo(e.date))}</span>
          <span class="row-actions">${actionButtons(TRACKED_ACTIONS[category])}</span>
          ${noteFor(e.url) ? `<span class="application-note">${esc(t("note_prefix", { text: noteFor(e.url) }))}</span>` : ""}
        </div>`,
    )
    .join("");
}

function renderApplications() {
  $("tab-applications-count").textContent = (tracker.applied || []).length;
  $("tab-excluded-count").textContent = (tracker.excluded || []).length;

  $("excluded-list").innerHTML =
    trackedEntries("excluded") ||
    `<p class="empty">${t("nothing_excluded")}</p>`;

  const groups = APPLICATION_GROUPS.filter(
    (category) => (tracker[category] || []).length > 0,
  );
  $("applied-list").innerHTML =
    groups
      .map(
        (category) => `
          <h3 class="group-head">${t(`group_${category}`)} <span class="tab-count">${tracker[category].length}</span></h3>
          ${trackedEntries(category)}`,
      )
      .join("") || `<p class="empty">${t("nothing_tracked")}</p>`;
}

function detailSections(details) {
  const sections = DETAIL_SECTIONS.filter((key) => details?.[key]);
  if (sections.length === 0) return "";
  return `<dl class="detail-sections">${sections
    .map(
      (key) =>
        `<div><dt>${t(`sec_${key}`)}</dt><dd>${esc(details[key])}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailRow(l) {
  const status = statusOf(l.url);
  const actions = [["draft", "act_draft"]];
  if (status !== "applied") actions.push(["apply", "act_apply"]);
  if (!status) {
    actions.push(["shortlist", "act_shortlist"], ["exclude", "act_exclude"]);
  } else {
    actions.push(["untrack", "act_untrack"]);
  }
  const row = document.createElement("tr");
  row.className = "detail-row";
  row.dataset.url = l.url;
  row.dataset.id = l.id;
  row.innerHTML = `
    <td colspan="6">
      <div class="detail">
        <div data-role="sections"></div>
        <div class="detail-note">
          <input class="text-input" type="text" data-role="note" aria-label="${t("note_label")}" placeholder="${t("note_placeholder")}" value="${esc(noteFor(l.url))}" />
          <button class="button" type="button" data-action="save-note">${t("save_note")}</button>
        </div>
        <div class="row-actions" data-role="actions">
          ${actionButtons(actions)}
          <button class="button" type="button" data-action="fetch-details" hidden>${t("act_fetch")}</button>
        </div>
        <div class="row-actions" data-role="exclude-form" hidden>
          <input class="text-input" type="text" data-role="reason" aria-label="${t("reason_label")}" placeholder="${t("reason_placeholder")}" />
          <button class="button" type="button" data-action="confirm-exclude">${t("act_exclude")}</button>
          <button class="button" type="button" data-action="cancel-exclude">${t("cancel")}</button>
        </div>
      </div>
    </td>`;
  loadDetails(row, l);
  return row;
}

async function loadDetails(row, l) {
  let details = null;
  try {
    const res = await fetch(
      `/api/listing-details?url=${encodeURIComponent(l.url)}`,
    );
    details = await res.json();
  } catch {}
  const sections = detailSections(details);
  row.querySelector("[data-role='sections']").innerHTML = sections;
  row.previousElementSibling?.classList.toggle(
    "has-details",
    sections !== "",
  );
  row.querySelector("[data-action='fetch-details']").hidden =
    Boolean(details) || !FETCHABLE_SOURCES.includes(l.source);
}

async function fetchDetails(row, button) {
  button.disabled = true;
  button.textContent = t("fetching");
  try {
    const res = await fetch("/api/fetch-details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: row.dataset.url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const id = row.dataset.id;
    await load();
    selectListing(id);
  } catch (e) {
    openDialog(t("fetch_failed"), e.message);
    button.disabled = false;
    button.textContent = t("act_fetch");
  }
}

async function postJson(path, payload) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return true;
  } catch (e) {
    openDialog(t("save_failed"), e.message);
    return false;
  }
}

async function saveNote(row, button) {
  const url = row.dataset.url;
  const text = row.querySelector("[data-role='note']").value;
  if (!(await postJson("/api/note", { url, text }))) return;
  tracker.notes = tracker.notes || {};
  if (text.trim()) tracker.notes[noteKey(url)] = text.trim();
  else delete tracker.notes[noteKey(url)];
  renderApplications();
  button.textContent = t("saved");
}

function toggleExcludeForm(row, open) {
  row.querySelector("[data-role='actions']").hidden = open;
  row.querySelector("[data-role='exclude-form']").hidden = !open;
  if (open) row.querySelector("[data-role='reason']").focus();
}

function selectListing(id, { fromMap = false } = {}) {
  const listing = allListings.find((l) => l.id === id);
  if (fromMap) revealRow(id);
  const row = focusRow(id);
  document.querySelector("#listings-body .detail-row")?.remove();
  if (!listing || !row) return;
  row.after(detailRow(listing));
  if (fromMap) row.scrollIntoView({ block: "start", behavior: "smooth" });
  else flyToListing(id);
}

function revealRow(id) {
  selectTab($("tab-listings"));
  const index = filteredListings.findIndex((l) => l.id === id);
  if (index < rowLimit) return;
  rowLimit = Math.ceil((index + 1) / ROWS_PER_PAGE) * ROWS_PER_PAGE;
  renderTable(filteredListings);
}

async function track(url, action, reason) {
  const listing = allListings.find(
    (l) => listingKey(l.url) === listingKey(url),
  );
  const saved = await postJson("/api/track", {
    url,
    action,
    address: listing?.address,
    price: listing?.price,
    reason,
  });
  if (saved) await load();
}

      // Scan

function timeAgo(isoTime) {
  const minutes = Math.floor(
    (Date.now() - new Date(isoTime).getTime()) / 60000,
  );
  if (minutes < 1) return t("just_now");
  if (minutes < 60) return counted("minutes_ago", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return counted("hours_ago", hours);
  return counted("days_ago", Math.floor(hours / 24));
}

function renderScanStatus(scanStatus, newCount = 0) {
  const status = $("scan-status");
  if (!scanStatus) {
    status.textContent = "";
    return;
  }
  const failedSources = Object.entries(scanStatus.sources)
    .filter(([, result]) => !result.ok)
    .map(([source]) => source);
  status.classList.toggle("is-error", failedSources.length > 0);
  status.textContent =
    t("last_scan", { when: timeAgo(scanStatus.finishedAt) }) +
    (failedSources.length > 0
      ? ` ${t("sources_failed", { sources: joinList(failedSources) })}`
      : "") +
    (newCount > 0 ? ` ${counted("new_listings", newCount)}.` : "") +
    (scanStatus.fetchingDetails ? ` ${t("fetching_addresses")}` : "");
  watchDetailFetch(scanStatus.fetchingDetails);
  status.title =
    failedSources.length > 0
      ? t("sources_failed_detail", { sources: joinList(failedSources) })
      : "";
}

const DETAIL_POLL_MS = 20000;
let detailPollTimer = null;

// Addresses for wgzimmer listings arrive after the scan has answered.
function watchDetailFetch(fetching) {
  clearTimeout(detailPollTimer);
  if (!fetching) return;
  detailPollTimer = setTimeout(async () => {
    const status = await (await fetch("/api/scan-status")).json();
    if (!status.fetchingDetails) await load();
    renderScanStatus(status);
  }, DETAIL_POLL_MS);
}

async function loadScanStatus() {
  try {
    renderScanStatus(await (await fetch("/api/scan-status")).json());
  } catch {}
}

async function scan() {
  const button = $("scan-button");
  const status = $("scan-status");
  button.disabled = true;
  button.textContent = t("scanning");
  status.classList.remove("is-error");
  status.textContent = t("scan_wait");

  try {
    const res = await fetch("/api/scan", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const knownIds = new Set(allListings.map((l) => l.id));
    await load();
    const newCount = allListings.filter((l) => !knownIds.has(l.id)).length;
    renderScanStatus(data.status, newCount);
  } catch (e) {
    status.classList.add("is-error");
    status.textContent = t("scan_failed", { error: e.message });
  }

  button.disabled = false;
  button.textContent = t("scan");
}

// Messages

let dialogListingUrl = null;

// With a draftFor url the text is editable and can be saved for that listing.
function openDialog(title, body, { draftFor = null } = {}) {
  dialogListingUrl = draftFor;
  const isDraft = Boolean(draftFor);
  $("dialog-title").textContent = title;
  $("dialog-body").textContent = body;
  $("dialog-body").hidden = isDraft;
  $("dialog-editor").value = body;
  $("dialog-editor").hidden = !isDraft;
  $("dialog-copy").hidden = !isDraft;
  $("dialog-copy").textContent = t("copy_message");
  $("dialog-save").hidden = !isDraft;
  $("dialog-save").textContent = t("save_message");
  $("dialog-send").hidden = !isDraft;
  const listing = draftListing();
  const directSend = ["wgzimmer", "flatfox"].includes(listing?.source);
  $("dialog-send").textContent = t(
    directSend
      ? `send_${listing.source}`
      : listing?.contactEmail
        ? "send_mail"
        : "send_open",
  );
  $("dialog-send").disabled = false;
  $("dialog-applied").hidden = true;
  $("dialog-hint").hidden = true;
  $("message-dialog").showModal();
}

function draftListing() {
  return allListings.find((l) => l.url === dialogListingUrl);
}

function contactUrl(listing) {
  return listing.url;
}

async function sendDirectDraft(listing, message) {
  const source = listing.source;
  const button = $("dialog-send");
  button.disabled = true;
  button.textContent = t(`sending_${source}`);
  $("dialog-hint").hidden = true;
  try {
    const res = await fetch(`/api/send-${source}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: listing.url, message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    await saveDraft();
    if (data.requiresCompletion) {
      button.disabled = false;
      button.textContent = t(`send_${source}`);
      $("dialog-hint").textContent = t("wgzimmer_complete_in_browser");
      $("dialog-hint").hidden = false;
      $("dialog-applied").textContent = t("act_apply");
      $("dialog-applied").hidden = statusOf(listing.url) === "applied";
      return;
    }
    await track(listing.url, "apply");
    button.textContent = t(`sent_${source}`);
    $("dialog-hint").textContent = t(`sent_${source}`);
    $("dialog-hint").hidden = false;
    $("dialog-applied").hidden = true;
  } catch (e) {
    button.disabled = false;
    button.textContent = t(`send_${source}`);
    $("dialog-hint").textContent =
      `${t(`send_${source}_failed`)}: ${e.message}`;
    $("dialog-hint").hidden = false;
  }
}

// WGZimmer opens a visible form for email verification; Flatfox sends directly.
async function handOverDraft() {
  const listing = draftListing();
  const message = $("dialog-editor").value;
  if (["wgzimmer", "flatfox"].includes(listing.source)) {
    await sendDirectDraft(listing, message);
    return;
  }

  navigator.clipboard.writeText(message);
  if (listing.contactEmail) {
    const subject = listing.description.split("\n")[0].slice(0, 80);
    window.location.href =
      `mailto:${listing.contactEmail}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(message)}`;
  } else {
    window.open(contactUrl(listing), "_blank", "noopener");
  }
  const hint = listing.contactEmail ? "mail_hint" : "paste_hint";
  $("dialog-hint").textContent = t(hint);
  $("dialog-hint").hidden = false;
  $("dialog-applied").textContent = t("act_apply");
  $("dialog-applied").hidden = statusOf(listing.url) === "applied";
  saveDraft();
}

async function markDraftApplied() {
  await track(dialogListingUrl, "apply");
  $("message-dialog").close();
}

async function saveDraft() {
  const saved = await postJson("/api/application", {
    url: dialogListingUrl,
    message: $("dialog-editor").value,
  });
  if (!saved) return;
  await loadMessages();
  $("dialog-save").textContent = t("message_saved");
}

let profileFields = [];
let flatfoxSession = { checking: true, connected: false, busy: false };

function renderFlatfoxSession() {
  const button = $("flatfox-login");
  const status = $("flatfox-session-status");
  if (flatfoxSession.checking) {
    status.textContent = t("flatfox_checking");
  } else if (flatfoxSession.connecting) {
    status.textContent = t("flatfox_connecting");
  } else if (flatfoxSession.error) {
    status.textContent = `${t("flatfox_login_failed")}: ${flatfoxSession.error}`;
  } else {
    status.textContent = t(
      flatfoxSession.connected
        ? "flatfox_connected"
        : "flatfox_disconnected",
    );
  }
  button.disabled =
    flatfoxSession.checking ||
    flatfoxSession.connecting ||
    flatfoxSession.busy ||
    flatfoxSession.connected;
  button.textContent = t(
    flatfoxSession.connected
      ? "flatfox_connected_button"
      : "flatfox_connect",
  );
}

async function loadFlatfoxSession() {
  flatfoxSession = { checking: true, connected: false, busy: false };
  renderFlatfoxSession();
  try {
    const res = await fetch("/api/flatfox-session");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    flatfoxSession = { checking: false, ...data };
  } catch (e) {
    flatfoxSession = {
      checking: false,
      connected: false,
      error: e.message,
    };
  }
  renderFlatfoxSession();
}

async function connectFlatfox() {
  flatfoxSession = {
    checking: false,
    connecting: true,
    connected: flatfoxSession.connected,
  };
  renderFlatfoxSession();
  try {
    const res = await fetch("/api/flatfox-session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    flatfoxSession = { checking: false, ...data };
  } catch (e) {
    flatfoxSession = {
      checking: false,
      connected: false,
      error: e.message,
    };
  }
  renderFlatfoxSession();
}

function renderProfile(profile) {
  $("profile-fields").innerHTML = profileFields
    .map((field) => {
      const value = profile?.[field];
      const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
      return `
        <label class="profile-field">
          <span>${t(`pf_${field}`)}</span>
          <input class="text-input" type="${field === "age" ? "number" : "text"}" name="${field}" value="${esc(text)}" />
        </label>`;
    })
    .join("");
}

async function loadProfile() {
  try {
    const data = await (await fetch("/api/profile")).json();
    profileFields = data.fields;
    renderProfile(data.profile);
  } catch {}
}

function readProfileForm() {
  const profile = {};
  for (const input of $("profile-fields").querySelectorAll("input")) {
    const text = input.value.trim();
    if (input.name === "age") profile.age = text ? Number(text) : "";
    else if (input.name === "hobbies") {
      profile.hobbies = text
        ? text.split(",").map((hobby) => hobby.trim()).filter(Boolean)
        : "";
    } else profile[input.name] = text;
  }
  return profile;
}

async function saveProfile(e) {
  e.preventDefault();
  const saved = await postJson("/api/profile", readProfileForm());
  $("profile-status").textContent = saved ? t("profile_saved") : "";
}

async function loadMessages() {
  try {
    const res = await fetch("/api/applications");
    appMessages = await res.json();
  } catch {}
}

function showMessage(url) {
  const match = appMessages.find(
    (a) => a.content.includes(url) || url.includes(a.id.split("-")[0]),
  );
  openDialog(
    t("sent_message"),
    match ? match.content : t("no_saved_message"),
  );
}

async function draftMessage(url, button) {
  button.disabled = true;
  button.textContent = t("drafting");
  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, provider: llmProvider }),
    });
    const data = await res.json();
    if (data.error) {
      openDialog(t("draft_failed"), data.error);
    } else {
      openDialog(t("application_message"), data.message, {
        draftFor: url,
      });
    }
  } catch (e) {
    openDialog(t("draft_failed"), e.message);
  } finally {
    button.disabled = false;
    button.textContent = t("act_draft");
  }
}

// Map

const RING_KM = [0.5, 1, 1.5];
let map;
let listingsGeojson = { type: "FeatureCollection", features: [] };
let hoveredId = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function ringFeatures() {
  const kmPerDegLat = 111.32;
  const kmPerDegLng = kmPerDegLat * Math.cos((target.lat * Math.PI) / 180);
  const features = [];
  for (const km of RING_KM) {
    const coordinates = [];
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * 2 * Math.PI;
      coordinates.push([
        target.lng + (km * Math.sin(a)) / kmPerDegLng,
        target.lat + (km * Math.cos(a)) / kmPerDegLat,
      ]);
    }
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {},
    });
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: coordinates[0] },
      properties: { label: km < 1 ? `${km * 1000} m` : `${km} km` },
    });
  }
  return { type: "FeatureCollection", features };
}

function buildMapStyle() {
  const land = cssVar("--map-land");
  const label = cssVar("--map-label");
  const accent = cssVar("--accent");
  const isLine = [
    "match",
    ["geometry-type"],
    ["LineString", "MultiLineString"],
    true,
    false,
  ];
  const sourceColor = [
    "match",
    ["get", "source"],
    "flatfox",
    cssVar("--src-flatfox"),
    "wgzimmer",
    cssVar("--src-wgzimmer"),
    "students",
    cssVar("--src-students"),
    cssVar("--src-ronorp"),
  ];
  const placeLabel = (id, classes, minzoom, font, size) => ({
    id,
    type: "symbol",
    source: "basemap",
    "source-layer": "place",
    minzoom,
    filter: ["match", ["get", "class"], classes, true, false],
    layout: {
      "text-field": ["get", "name"],
      "text-font": [font],
      "text-size": size,
      "text-max-width": 8,
    },
    paint: {
      "text-color": label,
      "text-halo-color": land,
      "text-halo-width": 1.5,
    },
  });

  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      basemap: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      },
      rings: { type: "geojson", data: ringFeatures() },
      listings: {
        type: "geojson",
        data: listingsGeojson,
        promoteId: "id",
      },
    },
    layers: [
      {
        id: "land",
        type: "background",
        paint: { "background-color": land },
      },
      {
        id: "wood",
        type: "fill",
        source: "basemap",
        "source-layer": "landcover",
        filter: ["==", ["get", "class"], "wood"],
        paint: { "fill-color": cssVar("--map-green") },
      },
      {
        id: "park",
        type: "fill",
        source: "basemap",
        "source-layer": "park",
        paint: { "fill-color": cssVar("--map-green") },
      },
      {
        id: "water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": cssVar("--map-water") },
      },
      {
        id: "river",
        type: "line",
        source: "basemap",
        "source-layer": "waterway",
        filter: ["==", ["get", "class"], "river"],
        paint: { "line-color": cssVar("--map-water"), "line-width": 2 },
      },
      {
        id: "rail",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        minzoom: 12,
        filter: [
          "all",
          isLine,
          ["==", ["get", "class"], "rail"],
          ["!", ["has", "service"]],
        ],
        paint: { "line-color": cssVar("--map-rail"), "line-width": 1 },
      },
      {
        id: "road-minor",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        minzoom: 14,
        filter: ["all", isLine, ["==", ["get", "class"], "minor"]],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": cssVar("--map-road-minor"),
          "line-width": [
            "interpolate",
            ["exponential", 1.5],
            ["zoom"],
            14,
            0.8,
            18,
            7,
          ],
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        filter: [
          "all",
          isLine,
          [
            "match",
            ["get", "class"],
            ["motorway", "trunk", "primary", "secondary", "tertiary"],
            true,
            false,
          ],
          ["!=", ["get", "brunnel"], "tunnel"],
        ],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": cssVar("--map-road"),
          "line-width": [
            "interpolate",
            ["exponential", 1.4],
            ["zoom"],
            10,
            0.6,
            14,
            2.5,
            18,
            14,
          ],
        },
      },
      placeLabel(
        "label-district",
        ["suburb", "quarter", "neighbourhood"],
        12.5,
        "Noto Sans Regular",
        11.5,
      ),
      placeLabel(
        "label-town",
        ["city", "town", "village"],
        0,
        "Noto Sans Bold",
        13,
      ),
      {
        id: "ring",
        type: "line",
        source: "rings",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: {
          "line-color": accent,
          "line-opacity": 0.45,
          "line-width": 1,
          "line-dasharray": [3, 3],
        },
      },
      {
        id: "ring-label",
        type: "symbol",
        source: "rings",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-allow-overlap": true,
        },
        paint: {
          "text-color": accent,
          "text-halo-color": land,
          "text-halo-width": 2,
        },
      },
      {
        id: "listing",
        type: "circle",
        source: "listings",
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["feature-state", "hover"], false],
            9,
            5.5,
          ],
          "circle-color": [
            "case",
            ["get", "approximate"],
            cssVar("--surface"),
            sourceColor,
          ],
          "circle-stroke-color": [
            "case",
            ["get", "approximate"],
            sourceColor,
            cssVar("--surface"),
          ],
          "circle-stroke-width": ["case", ["get", "approximate"], 2, 1.5],
        },
      },
    ],
  };
}

const SPREAD_STEP_DEGREES = 0.0005;
const GOLDEN_ANGLE = 2.39996;

// Listings known only by postcode share one point. They are fanned out
// around it so that each dot can be seen and clicked.
function spreadSharedPoints(listings) {
  const groups = new Map();
  return listings.map((l) => {
    if (!l.approximate) return [l.lng, l.lat];
    const key = `${l.lat.toFixed(3)},${l.lng.toFixed(3)}`;
    if (!groups.has(key)) groups.set(key, { centre: l, count: 0 });
    const group = groups.get(key);
    const index = group.count++;
    const { lat, lng } = group.centre;
    const radius = SPREAD_STEP_DEGREES * Math.sqrt(index);
    const angle = index * GOLDEN_ANGLE;
    return [
      lng + (radius * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180),
      lat + radius * Math.sin(angle),
    ];
  });
}

function setMapListings(listings) {
  const mapped = listings.filter((l) => l.lat && l.lng);
  const positions = spreadSharedPoints(mapped);
  listingsGeojson = {
    type: "FeatureCollection",
    features: mapped
      .map((l, i) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: positions[i] },
        properties: {
          id: l.id,
          source: l.source,
          price: l.price,
          place: l.address || l.source,
          approximate: l.approximate,
          url: l.url,
        },
      })),
  };
  hoveredId = null;
  map?.getSource("listings")?.setData(listingsGeojson);
}

function setHovered(id) {
  if (!map?.getSource("listings")) return;
  if (hoveredId !== null) {
    map.setFeatureState(
      { source: "listings", id: hoveredId },
      { hover: false },
    );
  }
  hoveredId = id;
  if (id !== null) {
    map.setFeatureState({ source: "listings", id }, { hover: true });
  }
}

function listingPopup(properties) {
  const node = document.createElement("div");
  const rent = document.createElement("div");
  rent.className = "popup-rent";
  rent.textContent = `CHF ${properties.price}`;
  const place = document.createElement("div");
  place.className = "popup-place";
  place.textContent = properties.place;
  const link = document.createElement("a");
  link.href = properties.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = t("open_listing");
  node.append(rent, place);
  if (properties.approximate) {
    const note = document.createElement("div");
    note.className = "popup-place";
    note.textContent = t("approx_location");
    node.append(note);
  }
  node.append(link);
  return node;
}

let listingPopupOnMap = null;

function showListingPopup(lngLat, properties) {
  listingPopupOnMap?.remove();
  listingPopupOnMap = new maplibregl.Popup({
    offset: 10,
    focusAfterOpen: false,
  })
    .setLngLat(lngLat)
    .setDOMContent(listingPopup(properties))
    .addTo(map);
}

function flyToListing(id) {
  const feature = listingsGeojson.features.find(
    (f) => f.properties.id === id,
  );
  if (!feature) return;
  showListingPopup(feature.geometry.coordinates, feature.properties);
  map.flyTo({
    center: feature.geometry.coordinates,
    zoom: Math.max(map.getZoom(), 15.5),
    speed: 1.4,
  });
  if (matchMedia("(max-width: 900px)").matches) {
    $("map").scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function focusRow(id) {
  document
    .querySelectorAll("#listings-body tr.is-active")
    .forEach((tr) => tr.classList.remove("is-active"));
  const row = [...document.querySelectorAll("#listings-body tr")].find(
    (tr) => tr.dataset.id === id,
  );
  if (!row) return null;
  row.classList.add("is-active");
  return row;
}

const LLM_KEY = "zurich-housing-llm";
let llmProvider = localStorage.getItem(LLM_KEY);

function showLlmChoice(providers) {
  if (!providers.includes(llmProvider)) llmProvider = providers[0];
  $("llm-setting").hidden = providers.length < 2;
  document.querySelectorAll("input[name='llm']").forEach((radio) => {
    radio.closest("label").hidden = !providers.includes(radio.value);
    radio.checked = radio.value === llmProvider;
    radio.addEventListener("change", () => {
      llmProvider = radio.value;
      localStorage.setItem(LLM_KEY, radio.value);
      $("api-settings").hidden = llmProvider !== "api";
    });
  });
  $("api-settings").hidden = llmProvider !== "api";
}

let apiSettings = null;

function showApiSettings(settings) {
  apiSettings = settings;
  $("api-service").value = settings.service;
  $("api-model").value = settings.model;
  $("api-key").value = "";
  $("api-key").placeholder = settings.keyEnding
    ? t("api_key_saved", { ending: settings.keyEnding })
    : t("api_key_missing");
}

async function loadApiSettings() {
  try {
    showApiSettings(await (await fetch("/api/llm-api")).json());
  } catch {}
}

async function saveApiSettings(e) {
  e.preventDefault();
  const payload = {
    service: $("api-service").value,
    model: $("api-model").value,
  };
  if ($("api-key").value.trim()) payload.apiKey = $("api-key").value;
  try {
    const res = await fetch("/api/llm-api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    showApiSettings(body);
    $("api-status").textContent = t("api_saved");
  } catch (err) {
    $("api-status").textContent = err.message;
  }
}

$("api-settings").addEventListener("submit", saveApiSettings);
$("api-service").addEventListener("change", (e) => {
  const defaults = Object.values(apiSettings?.defaultModels || {});
  if (!$("api-model").value || defaults.includes($("api-model").value)) {
    $("api-model").value = apiSettings?.defaultModels[e.target.value] || "";
  }
});

const THEME_KEY = "zurich-housing-theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let themeChoice = localStorage.getItem(THEME_KEY) || "system";

function applyTheme() {
  const dark =
    themeChoice === "dark" ||
    (themeChoice === "system" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  map?.setStyle(buildMapStyle());
}

function setTheme(choice) {
  themeChoice = choice;
  localStorage.setItem(THEME_KEY, choice);
  applyTheme();
}

let targetMarker = null;

function setTarget(next) {
  target = next;
  localStorage.setItem(TARGET_KEY, next.label);
  measureDistances();
  map.getSource("rings")?.setData(ringFeatures());
  targetMarker.setLngLat([next.lng, next.lat]);
  targetMarker.getPopup().setText(next.label);
  map.flyTo({ center: [next.lng, next.lat], speed: 1.2 });
  applyFilters();
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: buildMapStyle(),
    center: [target.lng, target.lat],
    zoom: 13.5,
    minZoom: 11,
    maxZoom: 18,
    maxBounds: [
      [8.38, 47.29],
      [8.68, 47.46],
    ],
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "top-right",
  );
  map.addControl(
    new maplibregl.AttributionControl({ compact: true }),
    "bottom-right",
  );

  const pin = document.createElement("div");
  pin.className = "target-pin";
  targetMarker = new maplibregl.Marker({ element: pin })
    .setLngLat([target.lng, target.lat])
    .setPopup(new maplibregl.Popup({ offset: 14 }).setText(target.label))
    .addTo(map);

  map.on("style.load", () => {
    map.getSource("listings").setData(listingsGeojson);
  });

  map.on("mouseenter", "listing", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "listing", () => {
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "listing", (e) => {
    const feature = e.features[0];
    showListingPopup(feature.geometry.coordinates, feature.properties);
    selectListing(feature.properties.id, { fromMap: true });
  });

  systemDark.addEventListener("change", applyTheme);
}

// Events

$("scan-button").addEventListener("click", scan);

document.querySelectorAll(".tab").forEach((tab, index, tabs) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
});
$("filters").addEventListener("input", applyFilters);
$("target-select").addEventListener("change", (e) => {
  setTarget(TARGET_PRESETS.find((t) => t.label === e.target.value));
});
$("show-more").addEventListener("click", () => {
  rowLimit += ROWS_PER_PAGE;
  renderTable(filteredListings);
});
$("more-filters-toggle").addEventListener("click", (e) => {
  const panel = $("more-filters");
  panel.hidden = !panel.hidden;
  e.currentTarget.setAttribute("aria-expanded", !panel.hidden);
  const label = e.currentTarget.querySelector("[data-i18n]");
  label.dataset.i18n = panel.hidden ? "more_filters" : "fewer_filters";
  label.textContent = t(label.dataset.i18n);
});
document.querySelectorAll("input[name='theme']").forEach((radio) => {
  radio.checked = radio.value === themeChoice;
  radio.addEventListener("change", () => setTheme(radio.value));
});
document.addEventListener("click", (e) => {
  if (!$("settings").contains(e.target)) $("settings").open = false;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("settings").open = false;
});
document.querySelectorAll("input[name='language']").forEach((radio) => {
  radio.addEventListener("change", () => setLanguage(radio.value));
});
$("filters").addEventListener("submit", (e) => e.preventDefault());

function setSort(column, descending = false) {
  sortBy = column;
  sortDescending = descending;
  document.querySelectorAll("th[data-sort]").forEach((th) => {
    if (th.dataset.sort === column) {
      th.setAttribute(
        "aria-sort",
        descending ? "descending" : "ascending",
      );
    } else {
      th.removeAttribute("aria-sort");
    }
  });
}

document.querySelectorAll("th[data-sort]").forEach((th) => {
  th.querySelector("button").addEventListener("click", () => {
    const sameColumn = th.dataset.sort === sortBy;
    setSort(th.dataset.sort, sameColumn && !sortDescending);
    applyFilters();
  });
});

function restoreFilters() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
  } catch {}
  if (!saved) return;
  $("f-price").value = saved.maxPrice;
  $("f-dist").value = saved.maxDist;
  $("f-new").value = saved.newHours || 0;
  for (const [id, value] of Object.entries(saved.checked || {})) {
    if ($(id)) $(id).checked = value;
  }
  setSort(
    saved.sortBy in SORT_COMPARATORS ? saved.sortBy : "price",
    Boolean(saved.sortDescending),
  );
}

$("listings-body").addEventListener("click", (e) => {
  const button = e.target.closest("[data-action]");
  if (button) {
    const row = button.closest("tr");
    const url = row.dataset.url;
    const action = button.dataset.action;
    if (action === "draft") draftMessage(url, button);
    else if (action === "fetch-details") fetchDetails(row, button);
    else if (action === "save-note") saveNote(row, button);
    else if (action === "exclude") toggleExcludeForm(row, true);
    else if (action === "cancel-exclude") toggleExcludeForm(row, false);
    else if (action === "confirm-exclude") {
      track(url, "exclude", row.querySelector("[data-role='reason']").value);
    } else track(url, action);
    return;
  }
  const row = e.target.closest("tr.listing-row");
  if (row && !e.target.closest("a")) selectListing(row.dataset.id);
});
$("listings-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (!e.target.matches("tr.listing-row")) return;
  e.preventDefault();
  selectListing(e.target.dataset.id);
});
$("listings-body").addEventListener("mouseover", (e) => {
  const row = e.target.closest("tr.listing-row");
  if (row && row.dataset.id !== hoveredId) setHovered(row.dataset.id);
});
$("listings-body").addEventListener("mouseleave", () => setHovered(null));

for (const list of [$("applied-list"), $("excluded-list")]) {
  list.addEventListener("click", (e) => {
    const button = e.target.closest("[data-action]");
    if (!button) return;
    const url = button.closest(".application").dataset.url;
    if (button.dataset.action === "show-message") showMessage(url);
    else track(url, button.dataset.action);
  });
}

$("dialog-copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("dialog-editor").value);
  $("dialog-copy").textContent = t("copied");
});
$("dialog-save").addEventListener("click", saveDraft);
$("dialog-send").addEventListener("click", handOverDraft);
$("dialog-applied").addEventListener("click", markDraftApplied);
$("profile-form").addEventListener("submit", saveProfile);
$("flatfox-login").addEventListener("click", connectFlatfox);
$("message-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});

async function init() {
  try {
    showLlmChoice(await (await fetch("/api/llm-providers")).json());
  } catch {}
  loadApiSettings();
  target =
    TARGET_PRESETS.find((t) => t.label === localStorage.getItem(TARGET_KEY)) ||
    TARGET_PRESETS[0];
  document.querySelector(
    `input[name='language'][value='${language}']`,
  ).checked = true;
  translatePage();
  restoreFilters();
  $("target-select").innerHTML = TARGET_PRESETS
    .map((t) => `<option>${esc(t.label)}</option>`)
    .join("");
  $("target-select").value = target.label;
  initMap();
  loadMessages();
  loadProfile();
  loadFlatfoxSession();
  loadScanStatus();
  load();
}

init();

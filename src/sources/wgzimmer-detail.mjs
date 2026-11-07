/**
 * wgzimmer.ch listing detail pages, read as plain HTML.
 */
import { htmlToText } from "../lib.js";

function fact(html, label) {
  return html.match(
    new RegExp(`<dt>${label}</dt>\\s*<dd>([\\s\\S]*?)</dd>`),
  )?.[1];
}

function textSection(html, heading) {
  const match = html.match(
    new RegExp(
      `<h2>${heading}</h2>\\s*<p class="ad-page__text-body">([\\s\\S]*?)</p>`,
    ),
  );
  return htmlToText(match?.[1]?.replace(/\r\n?/g, "\n")) || undefined;
}

const OPEN_ENDED = /^(open-ended|unlimited|unbefristet)$/i;

export function parseWgzimmerListing(html, url) {
  const rent = html
    .match(/class="ad-page__rent-value">([^<]*)</)?.[1]
    .replace(/\D/g, "");
  const addressLines = htmlToText(fact(html, "Address"))
    .split("\n")
    .filter(Boolean);
  const until = htmlToText(fact(html, "Until"));
  const map = html.match(/data-lat="([\d.]+)"\s+data-lon="([\d.]+)"/);
  const data = {
    address: addressLines.length > 1 ? addressLines[0] : undefined,
    city: addressLines.at(-1),
    neighbourhood: htmlToText(fact(html, "District")) || undefined,
    nearby: textSection(html, "Nearby"),
    rent: rent ? parseInt(rent) : undefined,
    availableFrom: htmlToText(fact(html, "From")) || undefined,
    until: until && !OPEN_ENDED.test(until) ? until : undefined,
    furnished: htmlToText(fact(html, "Furnished")) || undefined,
    room: textSection(html, "The room"),
    lookingFor: textSection(html, "We are looking for"),
    weAre: textSection(html, "About us"),
    lat: map ? parseFloat(map[1]) : undefined,
    lng: map ? parseFloat(map[2]) : undefined,
    url,
  };
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

export async function fetchWgzimmerListing(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "zurich-housing-tool/2.0" },
  });
  if (!resp.ok) throw new Error(`wgzimmer ${resp.status}`);
  const data = parseWgzimmerListing(await resp.text(), url);
  if (!data.city && !data.room) {
    throw new Error("listing page had no details");
  }
  return data;
}

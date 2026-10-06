/**
 * wgzimmer.ch listing detail pages.
 * A detail page is plain HTML and needs no browser, unlike the search form.
 */
import { htmlToText } from "./lib.js";


/** The value in `<p><strong>Label</strong> value</p>`. */
function labelled(html, label) {
  const match = html.match(
    new RegExp(`<strong[^>]*>${label}</strong>([^<]*)`),
  );
  return htmlToText(match?.[1]) || undefined;
}

/** The text of the block that starts after `opening`, up to the end of its div. */
function section(html, opening) {
  const start = html.indexOf(opening);
  if (start === -1) return undefined;
  const from = start + opening.length;
  const end = html.indexOf("</div>", from);
  return htmlToText(html.slice(from, end === -1 ? undefined : end)) || undefined;
}

export function parseWgzimmerListing(html, url) {
  const rent = labelled(html, "Monthly rent")?.replace(/\D/g, "");
  // The page's own map is centred on the listing.
  const mapCentre = html.match(/fromLonLat\(\[([\d.]+),\s*([\d.]+)\]\)/);
  const data = {
    address: labelled(html, "Address"),
    city: labelled(html, "City"),
    neighbourhood: labelled(html, "Neighbourhood"),
    nearby: labelled(html, "Nearby"),
    rent: rent ? parseInt(rent) : undefined,
    availableFrom: labelled(html, "Starting from"),
    until: labelled(html, "Until"),
    room: section(html, "The room is</strong>"),
    lookingFor: section(html, ">We are looking for</h3>"),
    weAre: section(html, ">We are</h3>"),
    lng: mapCentre ? parseFloat(mapCentre[1]) : undefined,
    lat: mapCentre ? parseFloat(mapCentre[2]) : undefined,
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
  if (!data.address && !data.room) {
    throw new Error("listing page had no details");
  }
  return data;
}

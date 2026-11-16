/**
 * The track a tram, bus or train takes between two stops, cut out of the
 * line's OpenStreetMap route. Points are [lng, lat].
 */

// OpenStreetMap Switzerland's server holds only Swiss data and is rarely
// busy. The main server is the fallback.
const OVERPASS_SERVERS = [
  "https://overpass.osm.ch/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const ROUTE_TYPES = {
  tram: "tram",
  bus: "bus|trolleybus",
  train: "train|light_rail",
  strain: "train|light_rail",
  express_train: "train",
};
// A stop counts as on the route when the track passes this close to it.
const MAX_STOP_DISTANCE_M = 150;

const metres = ([lng1, lat1], [lng2, lat2]) => {
  const x = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(x, lat2 - lat1) * 111320;
};

/** The route's ways joined into one line, each way turned to fit the last. */
export function chainWays(ways) {
  const parts = ways.filter((w) => w.length > 1);
  if (!parts.length) return [];
  let line = [...parts[0]];
  for (const way of parts.slice(1)) {
    const start = line[0];
    const end = line[line.length - 1];
    const first = way[0];
    const last = way[way.length - 1];
    const options = [
      [metres(end, first), () => line.push(...way.slice(1))],
      [metres(end, last), () => line.push(...[...way].reverse().slice(1))],
      [metres(start, last), () => (line = [...way.slice(0, -1), ...line])],
      [metres(start, first), () => (line = [...[...way].reverse().slice(0, -1), ...line])],
    ];
    options.sort((a, b) => a[0] - b[0])[0][1]();
  }
  return line;
}

/** The closest point on the line to p, searching segments from fromSegment on. */
function nearest(line, p, fromSegment) {
  let best = null;
  for (let i = fromSegment; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq)) : 0;
    const point = [a[0] + t * dx, a[1] + t * dy];
    const distance = metres(point, p);
    if (!best || distance < best.distance) best = { segment: i, point, distance };
  }
  return best;
}

/**
 * The part of the line from the first stop to the last, passing every stop
 * in order. Null when the line misses a stop or runs the other way.
 */
export function sliceThroughStops(line, stops) {
  if (line.length < 2 || stops.length < 2) return null;
  const hits = [];
  let from = 0;
  for (const stop of stops) {
    const hit = nearest(line, stop, from);
    if (!hit || hit.distance > MAX_STOP_DISTANCE_M) return null;
    hits.push(hit);
    from = hit.segment;
  }
  const first = hits[0];
  const last = hits[hits.length - 1];
  const path = [first.point, ...line.slice(first.segment + 1, last.segment + 1), last.point];
  return { path, score: hits.reduce((sum, h) => sum + h.distance, 0) };
}

function boundingBox(points, pad = 0.01) {
  const lats = points.map((p) => p[1]);
  const lngs = points.map((p) => p[0]);
  return [
    Math.min(...lats) - pad,
    Math.min(...lngs) - pad,
    Math.max(...lats) + pad,
    Math.max(...lngs) + pad,
  ].map((n) => n.toFixed(4));
}

async function overpass(query, fetcher) {
  let lastError;
  for (const server of OVERPASS_SERVERS) {
    try {
      const resp = await fetcher(server, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "ZurichHousingTool",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) return await resp.json();
      lastError = new Error(`Overpass returned HTTP ${resp.status}.`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * The shape of one ride between its stops, or null when OpenStreetMap has no
 * route for the line that passes them. Throws when Overpass cannot be reached.
 */
export async function fetchRideShape({ type, line, stops }, fetcher = fetch) {
  const routes = ROUTE_TYPES[type];
  if (!routes || !line || stops.length < 2) return null;
  const ref = String(line).replace(/["\\]/g, "");
  const [s, w, n, e] = boundingBox(stops);
  const body = await overpass(
    `[out:json][timeout:25];relation["type"="route"]["route"~"^(${routes})$"]["ref"="${ref}"](${s},${w},${n},${e});out geom;`,
    fetcher,
  );
  let best = null;
  for (const relation of body.elements || []) {
    const ways = (relation.members || [])
      .filter((m) => m.type === "way" && !/platform/.test(m.role) && m.geometry)
      .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
    const slice = sliceThroughStops(chainWays(ways), stops);
    if (slice && (!best || slice.score < best.score)) best = slice;
  }
  return best?.path || null;
}

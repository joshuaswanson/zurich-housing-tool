/**
 * The path each part of a trip takes on the map, from OpenStreetMap: trams
 * along the tram tracks, buses and trains along their line's route or the
 * roads, and walks along footpaths. Points are [lng, lat].
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

/** The ride cut out of the line's OpenStreetMap route, or null. */
async function relationShape({ type, line, stops }, fetcher) {
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

// Stops lie within this distance of the tracks they are served from.
const MAX_SNAP_M = 120;

class Heap {
  constructor() {
    this.items = [];
  }
  push(item) {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

/** A graph of the track network, joined where ways share a point. */
export function trackGraph(ways) {
  const points = [];
  const index = new Map();
  const edges = [];
  const id = (p) => {
    const key = `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
    if (!index.has(key)) {
      index.set(key, points.length);
      points.push(p);
      edges.push([]);
    }
    return index.get(key);
  };
  for (const way of ways) {
    for (let i = 0; i < way.length - 1; i++) {
      const a = id(way[i]);
      const b = id(way[i + 1]);
      const length = metres(way[i], way[i + 1]);
      edges[a].push([b, length]);
      edges[b].push([a, length]);
    }
  }
  return { points, edges };
}

function shortestPath(graph, from, to) {
  const distance = new Map([[from, 0]]);
  const previous = new Map();
  const heap = new Heap();
  heap.push([0, from]);
  while (heap.size) {
    const [d, node] = heap.pop();
    if (node === to) break;
    if (d > distance.get(node)) continue;
    for (const [next, length] of graph.edges[node]) {
      const candidate = d + length;
      if (candidate < (distance.get(next) ?? Infinity)) {
        distance.set(next, candidate);
        previous.set(next, node);
        heap.push([candidate, next]);
      }
    }
  }
  if (!distance.has(to)) return null;
  const path = [to];
  while (path[0] !== from) path.unshift(previous.get(path[0]));
  return path.map((i) => graph.points[i]);
}

function snap(graph, stop) {
  let best = -1;
  let bestDistance = Infinity;
  graph.points.forEach((p, i) => {
    const d = metres(p, stop);
    if (d < bestDistance) [best, bestDistance] = [i, d];
  });
  return bestDistance <= MAX_SNAP_M ? best : -1;
}

/** The path along the tracks from stop to stop, or null when a stop is off the tracks. */
export function pathAlongTracks(ways, stops) {
  const graph = trackGraph(ways);
  const nodes = stops.map((stop) => snap(graph, stop));
  if (nodes.includes(-1)) return null;
  const path = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const part = shortestPath(graph, nodes[i], nodes[i + 1]);
    if (!part) return null;
    path.push(...(path.length ? part.slice(1) : part));
  }
  return path.length > 1 ? path : null;
}

async function trackShape(stops, railway, fetcher) {
  const [s, w, n, e] = boundingBox(stops, 0.005);
  const body = await overpass(
    `[out:json][timeout:25];way["railway"~"^(${railway})$"](${s},${w},${n},${e});out geom;`,
    fetcher,
  );
  const ways = (body.elements || [])
    .filter((el) => el.geometry)
    .map((el) => el.geometry.map((g) => [g.lon, g.lat]));
  return pathAlongTracks(ways, stops);
}

async function streetShape(profile, points, fetcher) {
  const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(";");
  const resp = await fetcher(
    `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    { headers: { "User-Agent": "ZurichHousingTool" }, signal: AbortSignal.timeout(20000) },
  );
  if (!resp.ok) throw new Error(`The street router returned HTTP ${resp.status}.`);
  const body = await resp.json();
  return body.routes?.[0]?.geometry?.coordinates || null;
}

const TRAIN_TYPES = new Set(["train", "strain", "express_train"]);

/**
 * The path one part of a trip takes, or null when OpenStreetMap has nothing
 * that fits. Throws when a server cannot be reached.
 */
export async function fetchLegShape({ type, line, stops }, fetcher = fetch) {
  if (stops.length < 2) return null;
  if (type === "walk") return streetShape("foot", stops, fetcher);
  if (type === "tram") {
    return (await trackShape(stops, "tram", fetcher)) || relationShape({ type, line, stops }, fetcher);
  }
  if (type === "bus") {
    return (await relationShape({ type, line, stops }, fetcher)) || streetShape("car", stops, fetcher);
  }
  if (TRAIN_TYPES.has(type)) {
    return (await relationShape({ type, line, stops }, fetcher)) || trackShape(stops, "rail|light_rail", fetcher);
  }
  return relationShape({ type, line, stops }, fetcher);
}

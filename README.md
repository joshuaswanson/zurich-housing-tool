# Zurich Housing Monitor

Find affordable WG rooms near ETH Zurich. Scrapes **flatfox.ch** (API) and **wgzimmer.ch** (headless browser with reCAPTCHA v3 bypass via [CloakBrowser](https://github.com/CloakHQ/CloakBrowser)).

## Setup

```bash
npm install
```

CloakBrowser downloads a custom Chromium binary on first run (~140 MB).

## Commands

### Scan for listings

```bash
node monitor.js scan                # All listings, default 5km radius
node monitor.js scan --radius 2     # Within 2km of ETH Zentrum
node monitor.js scan --all          # No distance filter
```

Refreshes both sources (flatfox API + wgzimmer scrape), writes data to `data/`, and updates `seen.json`. Flatfox pins are saved to `data/flatfox_cache.json` so `search.js` can use them offline.

### Watch for new listings

```bash
node monitor.js watch           # Poll every 15 minutes
node monitor.js watch 10        # Poll every 10 minutes
```

Sends a macOS desktop notification when new listings appear.

### Search & filter

```bash
node search.js                            # All cached listings (wgzimmer + flatfox)
node search.js --max-price 800            # Price filter
node search.js --near-eth                 # <15 min walk from ETH Zentrum
node search.js --max-dist 2               # Max 2 km from ETH (flatfox, precise)
node search.js --no-woko                  # Exclude WOKO/JUWO properties
node search.js --permanent                # Only unlimited duration
node search.js --not-tracked              # Exclude applied/excluded/rejected
node search.js --include-gendered         # Include gender-restricted listings
node search.js --include-short            # Include short sublets (<2 months)
node search.js --sort distance            # Sort by distance (default: price)
node search.js --limit 10                 # Max results (default 20)
node search.js --fetch 5                  # Fetch details for top 5 uncached results
```

Reads from cached data files only -- no network requests unless `--fetch` is used. By default, gender-restricted listings (female-only WGs) and short sublets (<2 months) are hidden.

Combine flags freely:

```bash
node search.js --near-eth --no-woko --not-tracked --sort distance --fetch 3
```

### Fetch full listing details

```bash
node fetch-listing.mjs <url>                # Fetch one listing
node fetch-listing.mjs <url1> <url2> ...    # Fetch multiple
node fetch-listing.mjs --from-file urls.txt # Fetch from file
node fetch-listing.mjs --summary <url>      # Compact summary from cache
node fetch-listing.mjs --all                # Summarize all cached listings
```

Scrapes the full listing page (address, room description, "We are", "We are looking for", etc). Results are **permanently cached** in `data/listings/` by listing UUID or flatfox PK.

### Track applications

```bash
node track.js                           # View all tracked
node track.js apply <url> [address]     # Mark as applied (auto-populates price/address from cache)
node track.js shortlist <url> [address] # Shortlist
node track.js exclude <url> <reason>    # Not interested
node track.js reject <url>              # They rejected you
node track.js note <url> <text>         # Add a note
node track.js check <url>              # Check status
node track.js backfill                  # Populate price/address for existing entries from cache
```

When tracking a URL, price and address are automatically looked up from `data/listings/` cache. The `backfill` command updates all existing entries that have null price or address.

### Useful links

```bash
node monitor.js links
```

## npm shortcuts

```bash
npm run scan        # node monitor.js scan
npm run watch       # node monitor.js watch
npm run fetch       # node fetch-listing.mjs
npm run search      # node search.js
npm run track       # node track.js
```

## File structure

```
lib.js                Shared utilities (distance, paths, cache helpers)
monitor.js            Data acquisition (flatfox API + wgzimmer scrape)
wgzimmer-scrape.mjs   CloakBrowser-based wgzimmer scraper (exports scrapeWgzimmer)
fetch-listing.mjs     Fetch & cache full listing details (exports fetch functions)
search.js             Search & filter cached listings with smart defaults
track.js              Application tracker (applied/shortlisted/excluded/rejected)
tracker.json          Tracker state
package.json          ESM ("type": "module")
data/
  flatfox_cache.json      Flatfox pin data (written by monitor refresh)
  wgzimmer_cache.json     Wgzimmer search results cache (30 min TTL)
  wgzimmer_listings.json  Raw scraped wgzimmer data
  seen.json               Seen listings (for watch mode dedup)
  listings/               Permanently cached individual listing details
```

## How it works

- **flatfox.ch** exposes a public pin API (`/api/v1/pin/`) that returns listing coordinates and prices. No authentication needed. Distance from ETH Zentrum (47.3764, 8.5483) is calculated via haversine. Pins are cached to `data/flatfox_cache.json` during monitor refresh, so `search.js` works offline.

- **wgzimmer.ch** uses reCAPTCHA v3 which blocks all standard headless browsers. We use [CloakBrowser](https://github.com/CloakHQ/CloakBrowser), a custom Chromium binary with source-level anti-detection patches, which passes reCAPTCHA v3 fully headless. The scraper is imported directly by `monitor.js` (no subprocess).

- **Gender filter**: Detects female-only listings ("Mitbewohnerin", "weiblich", "female only", "Girls-WG", "nur Frauen") while avoiding false positives on inclusive phrasing like "Mitbewohner oder Mitbewohnerin".

- **Short sublet filter**: Parses available-from and until dates to hide listings shorter than 2 months.

- **Auto-populate tracker**: When tracking a URL, price and address are looked up from the listing detail cache. Use `backfill` to update older entries retroactively.

- All modules use **ESM** (`"type": "module"` in package.json). CloakBrowser is ESM-only.

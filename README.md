<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

This tool scrapes the major Swiss housing platforms, filters the results, tracks your applications, and generates an application message for each listing from its description.

## What it does

- **LLM-generated application messages**: A local LLM (via [Ollama](https://ollama.com)) writes an application message per listing from your profile and the listing description. You enter your details once. Output is German or English, or both.
- **Scrapes 4 platforms**: [wgzimmer.ch](https://wgzimmer.ch) (reCAPTCHA v3 bypass via [CloakBrowser](https://github.com/CloakHQ/CloakBrowser)), [flatfox.ch](https://flatfox.ch) (public API), [ronorp.net](https://ronorp.net) (public API), and [students.ch](https://www.students.ch/wohnen) (public pages)
- **Filters**: Optionally hide WOKO/JUWO (age-restricted student housing), gender-restricted listings, short sublets (<2 months), and listings from bulk corporate posters (A/NTERIM, NextGen Properties, fake-address listings). All configurable.
- **Geocodes addresses** to compute walking distance from a target location (ETH Zentrum, UZH, or any coordinates)
- **Tracks applications** to prevent duplicate applications to the same listing
- **Web dashboard** with a map, a sortable and filterable listings table, and application tracking
- **Desktop notifications** when new listings appear (macOS)

## Setup

```bash
git clone https://github.com/joshuaswanson/zurich-housing-tool.git
cd zurich-housing-tool
./setup.sh
```

The setup script installs dependencies, creates the config files, pulls the LLM model (if Ollama is installed), and runs an initial scan. Then:

```bash
node server.js
```

The dashboard is at http://localhost:3456.

**Optional**: Install [Ollama](https://ollama.com) for message generation. Everything else works without it. Message generation reads your details from `profile.json`, which the setup script creates from `profile.example.json` and which the dashboard's Profile tab can edit. The model is `llm.model` in `config.json` (default `llama3.2`). When that model is not installed, the smallest installed Ollama model is used.

Edit `config.json` to set your target location:

```json
{
  "target": {
    "lat": 47.3764,
    "lng": 8.5483,
    "label": "ETH Zentrum"
  },
  "search": {
    "maxPrice": 2000,
    "region": "zurich-stadt",
    "minDuration": 60
  },
  "exclude": {
    "woko": true,
    "genderRestricted": true,
    "shortSublets": true,
    "overAge": 28,
    "spam": ["A/NTERIM", "NextGen Properties"]
  }
}
```

**Common target locations:**
| Location | Lat | Lng |
|----------|-----|-----|
| ETH Zentrum | 47.3764 | 8.5483 |
| ETH Honggerberg | 47.4085 | 8.5075 |
| UZH Zentrum | 47.3744 | 8.5508 |
| UZH Irchel | 47.3975 | 8.5495 |

## Commands

### Scan for listings

```bash
node monitor.js scan                 # Scan all sources
node monitor.js scan --fresh         # Force fresh scrape (ignore cache)
node monitor.js scan --radius 2      # Only show within 2 km
node monitor.js watch 15             # Auto-poll every 15 min + desktop notifications
```

### Search & filter

```bash
node search.js                                    # Everything from cache
node search.js --max-dist 1.5                     # Within 1.5 km of target
node search.js --max-price 1500                   # Price cap
node search.js --not-tracked                      # Hide applied/excluded
node search.js --sort distance                    # Sort by distance (default: price)
node search.js --keyword "Seefeld|Kreis 8"        # Regex filter on description
node search.js --new                              # Last 24 hours only
node search.js --new 48                           # Last 48 hours
node search.js --permanent                        # Unlimited duration only
node search.js --include-gendered                 # Include female-only WGs
node search.js --include-short                    # Include sublets < 2 months
node search.js --fetch 5                          # Auto-fetch details for top 5

# Combined:
node search.js --max-dist 2 --not-tracked --sort distance --new --fetch 3
```

### Fetch full listing details

```bash
node fetch-listing.mjs <url>                      # Fetch and cache one listing
node fetch-listing.mjs <url1> <url2> ...          # Multiple
node fetch-listing.mjs --from-file urls.txt       # From file
node fetch-listing.mjs --summary <url>            # Compact summary from cache
node fetch-listing.mjs --summary --all            # All cached listings
```

Fetched listings are auto-checked for WOKO/JUWO/spam and excluded from future searches.

### Track applications

```bash
node track.js                           # List all tracked
node track.js status                    # Dashboard with stats
node track.js apply <url> [address]     # Mark as applied
node track.js shortlist <url>           # Shortlist
node track.js exclude <url> <reason>    # Not interested
node track.js reject <url>              # Mark as rejected by the lister
node track.js note <url> <text>         # Add a note
node track.js check <url>              # Check if tracked
node track.js backfill                  # Populate price/address from cache
```

### Web dashboard

```bash
node server.js                          # Start dashboard at http://localhost:3456
npm run dashboard                       # Same thing
```

The dashboard follows the system light or dark setting and is available in English and German. The map sits on the left and the Listings, Applications, Excluded, and Profile tabs on the right. It covers nearly everything the command line tools do.

- **Listings tab**: A table sortable by rent or distance, showing the walking time next to each distance. A search box matches comma-separated words against the address and description. Sliders set the maximum rent and maximum distance. The remaining filters sit behind a "More filters" button, which shows how many of them are active. Switches control whether tracked, gender-restricted, WOKO/JUWO, short-sublet, and bulk-poster listings and whole flats are shown. Their defaults come from the `exclude` section of `config.json`. Further controls limit the list to permanent listings or to listings first seen in the last 24 hours, 48 hours, or 7 days.
- **Selecting a listing**: The map moves to the listing and a panel opens under the row. It shows the full details when they have been fetched, a field for a note, and buttons to draft a message, shortlist the listing, mark it as applied, or exclude it with an optional reason. A further button fetches the full details of a wgzimmer or flatfox listing.
- **Applications tab**: Listings you applied to, shortlisted, or were rejected for, with notes.
- **Excluded tab**: Excluded listings with the reason, each with a button to restore it.
- **Profile tab**: A form for the details the LLM uses to draft application messages. Saving it writes `profile.json`.
- **Drafting a message**: The draft opens in an editable dialog. It can be copied, or saved so that it shows up under "Show message" for that listing.
- **Map**: Listings with known coordinates appear as dots coloured by source, with rings at 500 m, 1 km, and 1.5 km around the target. A dropdown on the map switches the target between the configured location, ETH Zentrum, ETH Hönggerberg, UZH Zentrum, and UZH Irchel, and all distances update.
- **Scan for listings**: Runs a full scrape and batch-fetches listing details for geocoding. The header shows when the last scan finished and names any source that failed.
- **Auto scan**: Repeats the scan every 15, 30, or 60 minutes while the page is open, with a browser notification when new listings appear.

Filter, sort, target, and language settings are saved in the browser. The footer links to the search pages listed under `links` in `config.json`.

### Useful links

```bash
node monitor.js links                   # Housing search URLs for Zurich
```

## How it works

**flatfox.ch** has a public pin API (`/api/v1/pin/`) that returns listing coordinates and prices without authentication. The tool computes haversine distance from the target and caches pins locally. The pin API returns at most 1000 pins per request, so the scan splits the search area into quadrants whenever a response reaches that limit. A second public endpoint (`/api/v1/public-listing/`) returns the address, description, and move-in date for 50 listings per request, and the scan calls it for every pin.

**wgzimmer.ch** uses Google reCAPTCHA v3, which rejects the standard headless browsers (Playwright, Puppeteer, Firefox, WebKit, puppeteer-extra-stealth). The tool uses [CloakBrowser](https://github.com/CloakHQ/CloakBrowser), a Chromium build with source-level anti-detection patches that passes reCAPTCHA v3 fully headless. The reCAPTCHA library occasionally fails to download, so the scraper reloads the page once when that happens.

**ronorp.net** is a smaller Zurich classifieds site with lower listing volume. Its marketplace has a public JSON API with a category for shared flats, which the tool reads directly. Posts marked as "wanted" are dropped. A post whose price is a nightly or weekly rate is labelled as such and treated as a short sublet.

**students.ch** has a small housing board for students. The tool reads its public list page for the Zurich area and the detail page of each listing, then geocodes the address. It carries about 10 listings at a time.

**The dashboard map** uses [MapLibre GL JS](https://maplibre.org) with [OpenFreeMap](https://openfreemap.org) vector tiles, which need no API key.

**Geocoding** uses Nominatim (OpenStreetMap). Addresses are geocoded on fetch and cached permanently, so later distance calculations need no network calls.

**Spam detection** flags listings that give a city-center address but are located elsewhere (Ruschlikon, Wollishofen, and similar), a pattern common to bulk corporate posters.

## File structure

```
monitor.js            Scan all sources, watch mode, desktop notifications
search.js             Search & filter cached listings
fetch-listing.mjs     Fetch full listing details (wgzimmer + flatfox)
track.js              Application tracker + dashboard
server.js             Web dashboard server and API
public/index.html     Web dashboard page
wgzimmer-scrape.mjs   CloakBrowser wgzimmer scraper
ronorp-scrape.mjs     ronorp listings via its public API
students-scrape.mjs   students.ch listings from its public pages
lib.js                Shared utilities (config, distance, geocoding, cache, listing filters)
setup.sh              One-time setup
config.json           Your config (gitignored)
config.example.json   Config template
profile.json          Your details for message generation (gitignored)
profile.example.json  Profile template
tracker.json          Your application data (gitignored)
data/                 All cached data (gitignored)
```

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

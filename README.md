<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

This tool scrapes the major Swiss housing platforms, filters the results, tracks your applications, and generates an application message for each listing from its description.

## Features

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

- The filter switches start from the `exclude` section of `config.json`.
- After each scan, the server fetches the detail pages of up to 60 wgzimmer listings in the background, one per second. This gives them an address and a place on the map.
- A listing that gives only a postcode is placed at the centre of that postcode area.
- Auto scan runs while the page is open.

## File structure

```
monitor.js            Scan all sources, watch mode, desktop notifications
search.js             Search & filter cached listings
fetch-listing.mjs     Fetch full listing details (wgzimmer + flatfox)
track.js              Application tracker + dashboard
server.js             Web dashboard server and API
public/index.html     Web dashboard page
wgzimmer-scrape.mjs   CloakBrowser wgzimmer scraper
wgzimmer-detail.mjs   wgzimmer listing detail pages (plain HTML)
ronorp-scrape.mjs     ronorp listings via its public API
students-scrape.mjs   students.ch listings from its public pages
test/                 Tests (run with npm test)
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

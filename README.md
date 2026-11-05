<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

This tool scrapes the major Swiss housing platforms, filters the results, tracks your applications, and generates an application message for each listing from its description.

## Features

- **Listings from four sites**: [wgzimmer.ch](https://wgzimmer.ch), [flatfox.ch](https://flatfox.ch), [ronorp.net](https://ronorp.net), and [students.ch](https://www.students.ch/wohnen), in one list
- **Application messages**: A local LLM writes a message for each listing from your profile and the listing's description, in German or English
- **Direct applications**: Review the draft and send it to WGZimmer or Flatfox from the dashboard; the local server uses each site's own contact form and anti-abuse checks in a background browser
- **Filters**: Hide student-only housing, gender-restricted listings, short sublets, and bulk corporate posters
- **Distances**: Each listing shows its distance and walking time from a location you choose
- **Application tracking**: A record of where you applied, so you do not apply to the same listing twice
- **Web dashboard**: A map, a listings table, and application tracking in the browser

## Setup

```bash
git clone https://github.com/nurakawa/zurich-housing-tool.git
cd zurich-housing-tool
./setup.sh
```

The setup script installs dependencies, creates the config files, pulls the LLM model (if Ollama is installed), and runs an initial scan. Then:

```bash
node src/server.js
```

The dashboard is at http://localhost:3456. It only accepts connections from
this computer. It has no login and can send messages in your name, so set
`HOST=0.0.0.0` (for example `HOST=0.0.0.0 node src/server.js`) only on a
network you trust.

**Optional**: Install [Ollama](https://ollama.com), or use Apple Intelligence on macOS 26 or later with [uv](https://docs.astral.sh/uv/), for message generation. Everything else works without it.

To send WGZimmer or Flatfox messages from the dashboard, save your name, email,
and phone in the Profile tab. Contact details stay in `profile.json` on this
computer and are only submitted to a listing's contact form when you click its
send button.

You can also connect your Flatfox account from the Profile tab. The button opens
Flatfox's own login page in a visible browser, so credentials never pass through
the dashboard. Its cookies are kept in the gitignored
`data/flatfox-browser-profile/` directory and reused for Flatfox messages.

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

### Searching for an apartment instead of a room

The defaults look for rooms in shared flats near ETH. To search for whole
apartments, change these keys in `config.json`:

```json
{
  "target": { "lat": 47.3650, "lng": 8.5250, "label": "Office" },
  "search": {
    "maxPrice": 3500,
    "objectCategory": "APARTMENT",
    "maxDistanceKm": 8
  },
  "sources": {
    "flatfox": true,
    "wgzimmer": false,
    "ronorp": true,
    "students": false
  },
  "exclude": {
    "woko": false,
    "genderRestricted": false,
    "shortSublets": true
  }
}
```

- `search.objectCategory`: the Flatfox categories to search, `SHARED`,
  `APARTMENT` or `HOUSE`, or a list such as `["APARTMENT", "HOUSE"]`. With
  anything other than `SHARED` alone, generated messages are written to a
  landlord or property manager instead of a WG.
- `search.maxDistanceKm`: the default radius in km for the scan summary
  (default 5).
- `sources`: turn a site off with `false`. wgzimmer and students.ch list
  mostly rooms. The ronorp URL in `search.ronorpUrl` points at its WG category;
  replace it with the apartment category page from ronorp.net if you keep it on.

Homegate, ImmoScout24, Comparis and Newhome are not covered.

## Commands

### Scan for listings

```bash
node src/monitor.js scan                 # Scan all sources
node src/monitor.js scan --fresh         # Force fresh scrape (ignore cache)
node src/monitor.js scan --radius 2      # Only show within 2 km
```

### Search & filter

```bash
node src/search.js                                    # Everything from cache
node src/search.js --max-dist 1.5                     # Within 1.5 km of target
node src/search.js --max-price 1500                   # Price cap
node src/search.js --not-tracked                      # Hide applied/excluded
node src/search.js --sort distance                    # Sort by distance (default: price)
node src/search.js --keyword "Seefeld|Kreis 8"        # Regex filter on description
node src/search.js --new                              # Last 24 hours only
node src/search.js --new 48                           # Last 48 hours
node src/search.js --permanent                        # Unlimited duration only
node src/search.js --include-gendered                 # Include female-only WGs
node src/search.js --include-short                    # Include sublets < 2 months
node src/search.js --fetch 5                          # Auto-fetch details for top 5

# Combined:
node src/search.js --max-dist 2 --not-tracked --sort distance --new --fetch 3
```

### Fetch full listing details

```bash
node src/fetch-listing.mjs <url>                      # Fetch and cache one listing
node src/fetch-listing.mjs <url1> <url2> ...          # Multiple
node src/fetch-listing.mjs --from-file urls.txt       # From file
node src/fetch-listing.mjs --summary <url>            # Compact summary from cache
node src/fetch-listing.mjs --summary --all            # All cached listings
```

Fetched listings are auto-checked for WOKO/JUWO/spam and excluded from future searches.

### Track applications

```bash
node src/track.js                           # List all tracked
node src/track.js status                    # Dashboard with stats
node src/track.js apply <url> [address]     # Mark as applied
node src/track.js shortlist <url>           # Shortlist
node src/track.js exclude <url> <reason>    # Not interested
node src/track.js reject <url>              # Mark as rejected by the lister
node src/track.js note <url> <text>         # Add a note
node src/track.js check <url>              # Check if tracked
node src/track.js backfill                  # Populate price/address from cache
```

### Web dashboard

```bash
node src/server.js                          # Start dashboard at http://localhost:3456
npm run dashboard                       # Same thing
```

## File structure

```
src/
  monitor.js          Scan all sources
  search.js           Search and filter cached listings
  fetch-listing.mjs   Fetch full listing details
  track.js            Application tracker
  server.js           Web dashboard server
  listings.js         Combine the source caches into one listing list
  lib.js              Shared utilities
  apple-llm.py        Message drafting with Apple Intelligence
  sources/            One module per housing site
public/               Web dashboard
test/                 Tests
assets/               Images for the README
setup.sh              One-time setup
config.example.json   Config template (copy to config.json)
profile.example.json  Profile template (copy to profile.json)
data/                 Caches, tracked applications and saved messages (gitignored)
```

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

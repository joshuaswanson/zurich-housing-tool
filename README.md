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
- **Notifications** when new listings appear

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

**Optional**: Install [Ollama](https://ollama.com) for message generation. Everything else works without it.

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

## File structure

```
monitor.js            Scan all sources, watch mode, desktop notifications
search.js             Search & filter cached listings
fetch-listing.mjs     Fetch full listing details (wgzimmer + flatfox)
track.js              Application tracker + dashboard
server.js             Web dashboard server and API
public/index.html     Web dashboard page
wgzimmer-scrape.mjs   wgzimmer.ch search
wgzimmer-detail.mjs   wgzimmer.ch listing details
ronorp-scrape.mjs     ronorp.net listings
students-scrape.mjs   students.ch listings
test/                 Tests
lib.js                Shared utilities
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

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
- **Direct applications**: Review the draft and send it to WGZimmer or Flatfox from the app; the app uses each site's own contact form and anti-abuse checks in a background browser
- **Filters**: Hide student-only housing, gender-restricted listings, short sublets, and bulk corporate posters
- **Distances**: Each listing shows its distance and walking time from a location you choose
- **Application tracking**: A record of where you applied, so you do not apply to the same listing twice
- **macOS app**: A map, a listings table, and application tracking in one window

## Setup

The tool is a macOS app. Building it needs [Node.js](https://nodejs.org) and Xcode:

```bash
git clone https://github.com/joshuaswanson/zurich-housing-tool.git
cd zurich-housing-tool
npm install
npm run app
```

This creates `build/Zurich Housing Tool.app`, which carries its own Node runtime. Move it to Applications and open it.

**Optional**: Install [Ollama](https://ollama.com), or turn on Apple Intelligence on macOS 26 or later, for message generation. Everything else works without it.

To send WGZimmer or Flatfox messages from the app, save your name, email,
and phone in the Profile tab. Contact details stay on this computer and are
only submitted to a listing's contact form when you click its send button.

You can also connect your Flatfox account from the Profile tab. The button opens
Flatfox's own login page in a visible browser, so credentials never pass through
the app. Its cookies are kept in the app's data folder and reused for Flatfox
messages.

The app keeps its data in `~/Library/Application Support/Zurich Housing Tool`, which the app menu opens with Show Data Folder. A `config.json` there sets the target location and the filters:

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

## File structure

```
macos/                The app window, the Apple Intelligence helper, the icon and the build script
src/
  server.js           Background process behind the app window
  scan.js             Scan all sources
  details.mjs         Fetch full listing details
  listings.js         Combine the source caches into one listing list
  lib.js              Shared utilities
  sources/            One module per housing site
public/               The app's interface
test/                 Tests
assets/               Images for the README
config.example.json   Default config
profile.example.json  Profile template
```

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

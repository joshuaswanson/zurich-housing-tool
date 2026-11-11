<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

This tool scrapes the major Swiss housing platforms, filters the results, tracks your applications, and generates an application message for each listing from its description.

## Features

- **Listings from four sites**: [wgzimmer.ch](https://wgzimmer.ch), [flatfox.ch](https://flatfox.ch), [ronorp.net](https://ronorp.net), and [students.ch](https://www.students.ch/wohnen), in one list
- **Application messages**: A language model writes a message for each listing from your profile and the listing's description, in German or English, on your Mac or through OpenAI or OpenRouter
- **Direct applications**: Review the draft and open a prefilled WGZimmer form to verify your email and send, or send directly to Flatfox from the app
- **Filters**: Hide student-only housing, gender-restricted listings, short sublets, and bulk corporate posters
- **Distances**: Each listing shows its distance and walking time from a location you choose
- **Application tracking**: A record of where you applied, so you do not apply to the same listing twice
- **macOS app**: A map, a listings table, and application tracking in one window

## Install

1. Download `Zurich-Housing-Tool.dmg` from the [latest release](https://github.com/joshuaswanson/zurich-housing-tool/releases/latest) and open it.
2. Drag Zurich Housing Tool onto the Applications folder, then open it from Applications.
3. If macOS says it cannot check the app, open System Settings, go to Privacy & Security, and click Open Anyway.

The app needs a Mac with Apple silicon and macOS 14 or later.

## Getting started

Click Scan to collect listings from all four sites. Fill in the Profile tab once so the app can write application messages and send them for you. Your profile, notes and applications stay on your Mac.

Message writing uses Apple Intelligence on macOS 26 or later. You can also install [Ollama](https://ollama.com), or add an OpenAI or OpenRouter API key under Drafting in the settings. Everything else works without any of them.

To send Flatfox messages from your own account, connect it in the Profile tab. Flatfox's own login page opens, so your password never passes through the app.

## Building from source

Building the app needs [Node.js](https://nodejs.org) and Xcode:

```bash
git clone https://github.com/joshuaswanson/zurich-housing-tool.git
cd zurich-housing-tool
npm install
npm run app
```

This creates `build/Zurich Housing Tool.app`.

### File structure

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
```

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

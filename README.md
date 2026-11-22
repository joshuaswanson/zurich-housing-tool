<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

A macOS app that scrapes the major Swiss housing platforms, filters and maps the results, and writes and sends application messages en masse.

## Features

- **Listings from five sources**: [ETH Housing](https://idapps.ethz.ch/accommodation-web/) for ETH and UZH members, [Flatfox](https://flatfox.ch), [Ron Orp](https://ronorp.net), [Students.ch](https://www.students.ch/wohnen), and [WG-Zimmer](https://wgzimmer.ch), in one list
- **Rooms or apartments**: Look for a room in a shared flat, or for a whole apartment or house
- **Application messages**: A language model writes a message for each listing from your profile and the listing's description, in German or English, on your Mac or through OpenRouter
- **Templates**: Write one message and pick it for any listing, with the address filled in
- **Direct applications**: Review the draft and send it to Flatfox or WG-Zimmer straight from the app
- **Send to many at once**: Select any number of listings and send your template to all of them. Flatfox and WG-Zimmer go out automatically, 20 at a time. The other sites open their contact page or email one by one
- **Filters**: Hide student-only housing, gender-restricted listings, short sublets, and bulk corporate posters
- **Distances and directions**: Each listing shows its distance from an ETH or UZH location you choose, and the tram and bus connection there, drawn on the map
- **Application tracking**: A record of where you applied, so you do not apply to the same listing twice
- **macOS app**: A map, a listings table, and application tracking in one window

## Install

1. Download `Zurich-Housing-Tool.dmg` from the [latest release](https://github.com/joshuaswanson/zurich-housing-tool/releases/latest) and open it.
2. Drag Zurich Housing Tool onto the Applications folder, then open it from Applications.
3. If macOS says it cannot check the app, open System Settings, go to Privacy & Security, and click Open Anyway.

The app needs a Mac with Apple silicon and macOS 14 or later. It checks for new versions and updates itself.

## Getting started

Click Scan to collect WG rooms and apartments from every source. Fill in the Profile tab once so the app can write application messages and send them for you. Your profile, notes and applications are stored on your Mac. When OpenRouter writes a message, it receives your profile and the listing.

Message writing uses Apple Intelligence on macOS 26 or later. You can also install [Ollama](https://ollama.com), or add an OpenRouter API key in the settings, and pick which one writes each message. Everything else works without any of them.

To send WG-Zimmer messages, sign in to WG-Zimmer under Accounts. WG-Zimmer emails you a code once, and after that the app sends from your account without asking again.

To send Flatfox messages from your own account, sign in to Flatfox under Accounts. Your password goes only to Flatfox and is not saved.

To include ETH Housing, sign in with your ETH account under Accounts. The app fills in your profile from your ETH Housing account. Your password is kept in the macOS Keychain so scans can sign in again, and ETH Housing needs Google Chrome installed.

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

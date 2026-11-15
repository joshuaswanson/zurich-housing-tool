<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="zurich-housing-tool" width="372">
  </picture>
</h1>

This tool scrapes the major Swiss housing platforms, filters the results, tracks your applications, and generates an application message for each listing from its description.

## Features

- **Listings from four sites**: [wgzimmer.ch](https://wgzimmer.ch), [flatfox.ch](https://flatfox.ch), [ronorp.net](https://ronorp.net), and [students.ch](https://www.students.ch/wohnen), in one list
- **Rooms or apartments**: Look for a room in a shared flat on all four sites, or for a whole apartment or house on Flatfox and ronorp
- **Application messages**: A language model writes a message for each listing from your profile and the listing's description, in German or English, on your Mac or through OpenAI or OpenRouter
- **Your own message**: Write one message in your profile and use it for every listing, with the address and title filled in
- **Direct applications**: Review the draft and open a prefilled WGZimmer form to verify your email and send, or send directly to Flatfox from the app
- **Send to many at once**: Send your message to up to 20 new Flatfox listings that match your filters in one go
- **Filters**: Hide student-only housing, gender-restricted listings, short sublets, and bulk corporate posters
- **Distances**: Each listing shows its distance and walking time from a location you choose
- **Application tracking**: A record of where you applied, so you do not apply to the same listing twice
- **macOS app**: A map, a listings table, and application tracking in one window

## Install

1. Download `Zurich-Housing-Tool.dmg` from the [latest release](https://github.com/joshuaswanson/zurich-housing-tool/releases/latest) and open it.
2. Drag Zurich Housing Tool onto the Applications folder, then open it from Applications.
3. If macOS says it cannot check the app, open System Settings, go to Privacy & Security, and click Open Anyway.

The app needs a Mac with Apple silicon and macOS 14 or later. It checks for new versions and updates itself.

## Getting started

Click Scan to collect listings from all four sites. Fill in the Profile tab once so the app can write application messages and send them for you. Your profile, notes and applications stay on your Mac.

Message writing uses Apple Intelligence on macOS 26 or later. You can also install [Ollama](https://ollama.com), or add an OpenAI or OpenRouter API key in the settings, and pick which one writes each message. Everything else works without any of them.

To send Flatfox messages from your own account, sign in to Flatfox in the Profile tab. Your password goes only to Flatfox and is not saved.

## Support

If you find this useful, [buy me a coffee](https://buymeacoffee.com/swanson).

<img src="assets/bmc_qr.png" alt="Buy Me a Coffee QR" width="200">

## License

MIT

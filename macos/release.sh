#!/bin/bash
# Builds the app, signs the DMG for Sparkle and publishes it with its appcast
# as the GitHub release for the version in package.json.
# Usage: npm run release
# The Sparkle signing key lives in the login Keychain (bin/generate_keys).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first" >&2
  exit 1
fi

macos/build.sh

VERSION="$(node -p 'require("./package.json").version')"
TAG="v$VERSION"
REPO="joshuaswanson/zurich-housing-tool"
DMG="build/Zurich-Housing-Tool.dmg"
APPCAST="build/appcast.xml"
SPARKLE_BIN="$(ls -d macos/.cache/Sparkle-*/bin | tail -1)"

SIGNATURE="$("$SPARKLE_BIN/sign_update" "$DMG")"
cat > "$APPCAST" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Zurich Housing Tool</title>
    <item>
      <title>$VERSION</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$VERSION</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>https://github.com/$REPO/releases/tag/$TAG</sparkle:releaseNotesLink>
      <enclosure url="https://github.com/$REPO/releases/download/$TAG/Zurich-Housing-Tool.dmg" type="application/octet-stream" $SIGNATURE />
    </item>
  </channel>
</rss>
EOF

NOTES="Open Zurich-Housing-Tool.dmg and drag the app onto the Applications folder. Needs a Mac with Apple silicon and macOS 14 or later. If macOS says it cannot check the app, open System Settings, go to Privacy & Security, and click Open Anyway. Installed copies update themselves."
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "$DMG" "$APPCAST" --repo "$REPO" --clobber
else
  git push origin HEAD
  gh release create "$TAG" "$DMG" "$APPCAST" --repo "$REPO" --title "Zurich Housing Tool $VERSION" --notes "$NOTES" --target "$(git rev-parse HEAD)"
fi
echo "Released $TAG"

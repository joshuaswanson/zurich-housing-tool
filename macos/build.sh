#!/bin/bash
# Builds "build/Zurich Housing Tool.app" with its own Node runtime.
# Usage: npm run app
# Requires rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_VERSION=26.13.0
SPARKLE_VERSION=2.10.1
SPARKLE_SHA256=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
case "$(uname -m)" in
  arm64) ARCH=arm64; NODE_ARCH=arm64 ;;
  x86_64) ARCH=x86_64; NODE_ARCH=x64 ;;
  *) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

APP="build/Zurich Housing Tool.app"
CACHE="macos/.cache"
NODE_DIR="node-v$NODE_VERSION-darwin-$NODE_ARCH"
NODE_TARBALL="$CACHE/$NODE_DIR.tar.gz"
VERSION="$(node -p 'require("./package.json").version')"

mkdir -p "$CACHE"
if [ ! -f "$NODE_TARBALL" ]; then
  echo "Downloading Node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIR.tar.gz" -o "$NODE_TARBALL.part"
  expected="$(curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | awk -v f="$NODE_DIR.tar.gz" '$2 == f { print $1 }')"
  actual="$(shasum -a 256 "$NODE_TARBALL.part" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "$NODE_TARBALL.part"
    echo "Node download failed its checksum" >&2
    exit 1
  fi
  mv "$NODE_TARBALL.part" "$NODE_TARBALL"
fi

SPARKLE="$CACHE/Sparkle-$SPARKLE_VERSION"
if [ ! -d "$SPARKLE/Sparkle.framework" ]; then
  echo "Downloading Sparkle $SPARKLE_VERSION"
  curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" -o "$SPARKLE.tar.xz"
  if [ "$(shasum -a 256 "$SPARKLE.tar.xz" | awk '{ print $1 }')" != "$SPARKLE_SHA256" ]; then
    rm -f "$SPARKLE.tar.xz"
    echo "Sparkle download failed its checksum" >&2
    exit 1
  fi
  mkdir -p "$SPARKLE"
  tar -xJf "$SPARKLE.tar.xz" -C "$SPARKLE"
fi

rm -rf "$APP"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Frameworks" "$RESOURCES/bin" "$RESOURCES/node/bin" "$RESOURCES/app"

echo "Compiling"
cp -R "$SPARKLE/Sparkle.framework" "$CONTENTS/Frameworks/"
swiftc -O -parse-as-library -target "$ARCH-apple-macos14.0" \
  -F "$SPARKLE" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  macos/App.swift -o "$CONTENTS/MacOS/ZurichHousing"
swiftc -O -parse-as-library -target "$ARCH-apple-macos26.0" macos/AppleLLM.swift -o "$RESOURCES/bin/apple-llm"

echo "Bundling Node and the dashboard"
tar -xzf "$NODE_TARBALL" -C "$RESOURCES/node/bin" --strip-components 2 "$NODE_DIR/bin/node"
cp -R src public package.json package-lock.json "$RESOURCES/app/"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent --prefix "$RESOURCES/app"

echo "Icon"
ICONSET="$CACHE/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
# AppKit drops SVG filters, so the baked shadows need rsvg-convert.
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" macos/AppIcon.svg -o "$ICONSET/icon_${size}x${size}.png"
  rsvg-convert -w "$((size * 2))" -h "$((size * 2))" macos/AppIcon.svg -o "$ICONSET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"

sed "s/VERSION/$VERSION/g" macos/Info.plist > "$CONTENTS/Info.plist"
codesign --force --deep --sign - "$APP"
DMG="build/Zurich-Housing-Tool.dmg"
STAGING="$CACHE/dmg"
rm -rf "$STAGING" "$DMG"
mkdir -p "$STAGING"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -quiet -volname "Zurich Housing Tool" -srcfolder "$STAGING" -fs HFS+ -format UDZO "$DMG"
rm -rf "$STAGING"
echo "Built $APP and $DMG"

#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: scripts/package-macos.sh must be run on macOS (Darwin)." >&2
  exit 1
fi

for tool in go lipo codesign plutil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool '$tool' was not found in PATH." >&2
    exit 1
  fi
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_DIR="$ROOT_DIR/.build"
APP_DIR="$BUILD_DIR/ProPresenter Remote.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
APP_BINARY="$MACOS_DIR/ProPresenter Remote"
ARCH_BUILD_DIR="$BUILD_DIR/.package-macos"
ARM64_BINARY="$ARCH_BUILD_DIR/arm64/ProPresenter Remote"
AMD64_BINARY="$ARCH_BUILD_DIR/amd64/ProPresenter Remote"

rm -rf "$APP_DIR" "$ARCH_BUILD_DIR"
mkdir -p "$MACOS_DIR" "$(dirname -- "$ARM64_BINARY")" "$(dirname -- "$AMD64_BINARY")"

build_architecture() {
  architecture=$1
  output=$2

  printf 'Building darwin/%s...\n' "$architecture"
  if ! (
    cd "$ROOT_DIR"
    CGO_ENABLED=1 GOOS=darwin GOARCH="$architecture" go build -o "$output" ./cmd/propresenter-remote
  ); then
    echo "error: failed to build darwin/$architecture." >&2
    exit 1
  fi
}

build_architecture arm64 "$ARM64_BINARY"
build_architecture amd64 "$AMD64_BINARY"

if ! lipo -create "$ARM64_BINARY" "$AMD64_BINARY" -output "$APP_BINARY"; then
  echo "error: failed to create the Universal 2 executable." >&2
  exit 1
fi

lipo -info "$APP_BINARY"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>ProPresenter Remote</string>
	<key>CFBundleExecutable</key>
	<string>ProPresenter Remote</string>
	<key>CFBundleIdentifier</key>
	<string>com.dltkddnr.propresenter-remote</string>
	<key>CFBundleName</key>
	<string>ProPresenter Remote</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>CFBundleShortVersionString</key>
	<string>0.1.0</string>
	<key>CFBundleVersion</key>
	<string>0.1.0</string>
</dict>
</plist>
PLIST

if ! plutil -lint "$CONTENTS_DIR/Info.plist"; then
  echo "error: Info.plist validation failed." >&2
  exit 1
fi

if ! codesign --force --deep --sign - --timestamp=none "$APP_DIR"; then
  echo "error: ad-hoc code signing failed for $APP_DIR." >&2
  exit 1
fi

if ! codesign --verify --deep --strict --verbose=2 "$APP_DIR"; then
  echo "error: code signature verification failed for $APP_DIR." >&2
  exit 1
fi

rm -rf "$ARCH_BUILD_DIR"
echo "Created $APP_DIR"

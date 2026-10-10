#!/bin/sh
# Renders extension/icons/icon.svg to the PNG sizes the manifest uses, with headless Chrome (macOS: sips resizes).
#   CHROME=/path/to/chrome scripts/render-icons.sh
set -e
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
DIR=$(cd "$(dirname "$0")/../extension/icons" && pwd)
TMP=$(mktemp -d)
printf '<html><body style="margin:0"><img src="file://%s/icon.svg" width="512" height="512"></body></html>' "$DIR" > "$TMP/icon.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=512,512 --screenshot="$TMP/icon.png" "file://$TMP/icon.html" >/dev/null 2>&1
for n in 16 32 48 128; do sips -z $n $n "$TMP/icon.png" --out "$DIR/icon-$n.png" >/dev/null; done
rm -rf "$TMP"

#!/usr/bin/env bash
# Builds a signed Derelict.apk from ./web and ./android using Ubuntu's Android tools.
#   sudo apt-get install -y aapt apksigner zipalign dalvik-exchange android-sdk-platform-23 openjdk-21-jdk-headless
#   KS_FILE=my.jks KS_PASS=yourpassword ./build.sh
set -euo pipefail
: "${KS_FILE:?set KS_FILE to your keystore path}"
: "${KS_PASS:?set KS_PASS to your keystore password}"
AJ=/usr/lib/android-sdk/platforms/android-23/android.jar
DX=/usr/lib/android-sdk/build-tools/debian/dx
VER=${VERSION_NAME:-1.0}
CODE=${VERSION_CODE:-1}

rm -rf build && mkdir -p build/classes build/assets
cp -r web/* build/assets/
aapt package -f -M android/AndroidManifest.xml -S android/res -A build/assets -I "$AJ" \
  -F build/unsigned.apk --min-sdk-version 21 --target-sdk-version 34 \
  --version-code "$CODE" --version-name "$VER"
javac --release 8 -Xlint:-options -cp "$AJ" -d build/classes android/src/com/zach/derelict/MainActivity.java
"$DX" --dex --output=build/classes.dex build/classes
(cd build && aapt add unsigned.apk classes.dex >/dev/null && zipalign -f -p 4 unsigned.apk aligned.apk)
export KS_PASS
apksigner sign --ks "$KS_FILE" --ks-pass env:KS_PASS --key-pass env:KS_PASS --out build/Derelict.apk build/aligned.apk
apksigner verify build/Derelict.apk
echo "Built build/Derelict.apk (version $VER, code $CODE)"

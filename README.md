# Derelict

Free, open-source app that finds abandoned places near you on an interactive map. Check in on site to confirm a place is really abandoned, level up, and get directions or hand off to your maps app. Places you report as not abandoned are removed from your list.

Data: OpenStreetMap (places tagged `abandoned`, ruins, disused buildings). It is crowd-sourced, so some spots are out of date, which is why check-ins exist.

**Safety:** look from the outside, respect private property, never enter unsafe buildings.

## Use it
- **Android:** download `Derelict.apk` from the Releases page and install it (allow installs from your browser/Files app).
- **Any phone:** open the website (GitHub Pages) and use "Add to Home screen".

## Run the website locally
`cd web && python3 -m http.server 8000` then open http://localhost:8000 (GPS needs https or localhost).

## Build the APK yourself
```
sudo apt-get install -y aapt apksigner zipalign dalvik-exchange android-sdk-platform-23 openjdk-21-jdk-headless
keytool -genkeypair -keystore my.jks -alias derelict -keyalg RSA -keysize 2048 -validity 10000
KS_FILE=my.jks KS_PASS='your password' ./build.sh
```

## Publish (maintainers)
1. Create a public GitHub repo, push this folder to `main`.
2. Settings → Pages → Source: **GitHub Actions**. The website deploys on every push touching `web/`.
3. Make your own signing key (command above, strong password, back it up, never commit it).
4. Settings → Secrets and variables → Actions → add `KEYSTORE_B64` (output of `base64 -w0 my.jks`) and `KEYSTORE_PASSWORD`.
5. Tag a release: `git tag v1.0.0 && git push --tags`. The APK is built and attached to a GitHub Release.

## Fair use of free map services
This app calls free community services (OSM tiles, Overpass, Nominatim, FOSSGIS routing). They are fine for personal and small-community use but their policies forbid heavy traffic. If Derelict gets popular, switch to providers you have permission to use: change `TILE_URL`, `ENDPOINTS` and `ROUTERS` at the top of `web/app.js`.

## Licence
MIT. Leaflet (BSD-2) is bundled in `web/vendor`. © OpenStreetMap contributors.

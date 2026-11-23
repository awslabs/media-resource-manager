#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Download the Amazon DCV Web Client SDK (it includes the Web UI SDK, dcv-ui),
# verify it, and unpack it into frontend/public/dcvsdk/ for the console's
# in-browser viewer (/connect/:instanceId).
#
# The SDK is licensed under the Amazon DCV EULA, so it is fetched at build time
# and not stored in this repository. deploy.sh runs this script before
# `npm run build`; the CodeBuild pipeline runs deploy.sh.
#
# The build fails unless:
#   - the archive's GPG signature verifies with the NICE signing key, and that
#     key has the fingerprint pinned below, and
#   - the archive's SHA-256 matches the pinned value.
#
# To move to a new SDK release: update SDK_VERSION and SDK_SHA256 from
# https://www.amazondcv.com/webclientsdk.html (the .sha256sum file), run this
# script, and test the viewer.
#
# Output layout (all gitignored):
#   frontend/public/dcvsdk/dcvjs/         Web Client SDK, ESM build (dcv.js, workers, libs)
#   frontend/public/dcvsdk/dcv-ui/        Web UI SDK (dcv-ui.js, bundled into the app by Vite)
#   frontend/public/dcvsdk/EULA.txt       Amazon DCV EULA
#   frontend/public/dcvsdk/third-party-licenses.txt
#   frontend/public/connect/EULA.txt, third-party-licenses.txt
#       The viewer's About dialog loads these two files relative to the page
#       URL (/connect/<id>), so they are also served from /connect/.

set -euo pipefail

SDK_VERSION="1.15.5-1190"
SDK_SHA256="a6c21c0091576c0e670c43a1fd30a26a1dc3e5a164ae423bf28bce45017370fb"
# NICE s.r.l. <support@nice-software.com>, the key that signs Amazon DCV downloads.
NICE_KEY_FINGERPRINT="5B9EEBC864449701F6CE566A11B5C70A170C6114"
# The Amazon DCV download CDN (the same one the gateway install script uses).
# DCV_SDK_DOWNLOAD_BASE points at a mirror with the same layout; the signature
# and checksum checks still apply.
DOWNLOAD_BASE="${DCV_SDK_DOWNLOAD_BASE:-https://d1uj6qtbmh3dt5.cloudfront.net}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUBLIC_DIR="$ROOT_DIR/frontend/public"
DEST_DIR="$PUBLIC_DIR/dcvsdk"
CONNECT_DIR="$PUBLIC_DIR/connect"
ARCHIVE="nice-dcv-web-client-sdk-${SDK_VERSION}.zip"

fail() {
  echo "fetch-dcv-web-sdk: $*" >&2
  exit 1
}

for tool in curl gpg unzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required (install it, then run deploy again)"
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "fetch-dcv-web-sdk: downloading Amazon DCV Web Client SDK ${SDK_VERSION}"
fetch() {
  curl -fsSL --retry 3 --retry-delay 2 -o "$WORK_DIR/$2" "$DOWNLOAD_BASE/$1" \
    || fail "could not download $DOWNLOAD_BASE/$1 (the build host needs HTTPS access to $DOWNLOAD_BASE)"
}
fetch NICE-GPG-KEY NICE-GPG-KEY
fetch "webclientsdk/$ARCHIVE" "$ARCHIVE"
fetch "webclientsdk/$ARCHIVE.sign" "$ARCHIVE.sign"

# Verify with a throwaway keyring that holds only the NICE key, so no key from
# the user's own keyring can satisfy the check. gpg needs no agent for this.
export GNUPGHOME="$WORK_DIR/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --dearmor <"$WORK_DIR/NICE-GPG-KEY" >"$WORK_DIR/nice.gpg" || fail "could not read the NICE GPG key"
STATUS="$(gpg --batch --no-default-keyring --keyring "$WORK_DIR/nice.gpg" --status-fd 1 \
  --verify "$WORK_DIR/$ARCHIVE.sign" "$WORK_DIR/$ARCHIVE" 2>/dev/null || true)"
# VALIDSIG <signing key fpr> ... <primary key fpr>: require the pinned primary key.
if ! grep -qE "^\[GNUPG:\] VALIDSIG [0-9A-F]+ .* ${NICE_KEY_FINGERPRINT}\$" <<<"$STATUS"; then
  fail "GPG signature check failed for $ARCHIVE (expected a valid signature from key $NICE_KEY_FINGERPRINT)"
fi

ACTUAL_SHA256="$(sha256_of "$WORK_DIR/$ARCHIVE")"
[[ "$ACTUAL_SHA256" == "$SDK_SHA256" ]] \
  || fail "SHA-256 mismatch for $ARCHIVE: expected $SDK_SHA256, got $ACTUAL_SHA256"
echo "fetch-dcv-web-sdk: signature and checksum verified"

unzip -q "$WORK_DIR/$ARCHIVE" -d "$WORK_DIR/unpacked"
SDK_DIR="$WORK_DIR/unpacked/nice-dcv-web-client-sdk"
[[ -f "$SDK_DIR/dcvjs-esm/dcv.js" && -f "$SDK_DIR/dcv-ui/dcv-ui.js" ]] \
  || fail "unexpected archive layout in $ARCHIVE"

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR" "$CONNECT_DIR"
cp -R "$SDK_DIR/dcvjs-esm" "$DEST_DIR/dcvjs"
cp -R "$SDK_DIR/dcv-ui" "$DEST_DIR/dcv-ui"
cp "$SDK_DIR/dcv-ui/EULA.txt" "$DEST_DIR/EULA.txt"
# The Web UI SDK asks for its third-party notices to be combined with the Web
# Client SDK's.
{
  cat "$SDK_DIR/dcv-ui/third-party-licenses.txt"
  printf '\n\n'
  cat "$SDK_DIR/dcvjs-esm/third-party-licenses.txt"
} >"$DEST_DIR/third-party-licenses.txt"
cp "$DEST_DIR/EULA.txt" "$DEST_DIR/third-party-licenses.txt" "$CONNECT_DIR/"
echo "$SDK_VERSION" >"$DEST_DIR/VERSION"

echo "fetch-dcv-web-sdk: unpacked into ${DEST_DIR#"$ROOT_DIR"/}"

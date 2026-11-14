#!/usr/bin/env bash
# Regenerate every brand asset from brand/icon-source.png.
#
# The source mark is the only hand-drawn (well, generated) thing here; everything else is
# derived, so a new mark is a one-line change and a re-run rather than a redesign afternoon.
# The icon's black, the splash's black and the social card's black are all read off the art
# itself — see ICONBG below — so no asset can end up one value off from another.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=brand/icon-source.png
OUT=brand
RES=android/app/src/main/res
[ -f "$SRC" ] || { echo "missing $SRC — drop the picked mark there first"; exit 1; }

# ── palette ─────────────────────────────────────────────────────────────────
# Sampled, not assumed. The art's background is a hair off the app's --surface, and "a hair
# off" is exactly what shows up as a square seam inside a round icon, or a lighter box
# behind the mark on the card. One value for all of them, taken from pixel 8,8.
ICONBG=$(convert "$SRC" -crop 1x1+8+8 +repage txt:- | grep -oE '#[0-9A-Fa-f]{6}' | head -1)
[ -n "$ICONBG" ] || { echo "could not read a pixel from $SRC"; exit 1; }
echo "▸ sampled mark background: $ICONBG"
INK='#eef1f8'       # --ink
INK2='#a3abc4'      # --ink-2
LIGHTBG='#f6f7fb'   # --surface under prefers-color-scheme: light
MONO='DejaVu-Sans-Mono'   # the face the UI uses for numbers, meters and rows
SANS='DejaVu-Sans'        # the face it uses for prose

# Every generated asset goes through this. An all-zero image is not a viewer bug, it is a
# compose step that ate the frame — and a silent blank is the worst failure a brand script
# can have: the file exists, the build passes, and the icon is empty.
nonblank() { # $1 file  $2 what it is
  local m
  m=$(identify -format '%[mean]' "$1" 2>/dev/null || echo 0)
  awk -v v="$m" 'BEGIN { exit (v+0 > 1) ? 0 : 1 }' \
    || { echo "   ! $2 came out blank (mean=$m) — a compose step ate the frame" >&2; exit 1; }
}

# The mark, knocked out of its own background and cropped to its bounding box. Needed where
# the art has to sit on a colour that is NOT its own — the adaptive foreground layer, whose
# background is a separate drawable the launcher composites over.
knockout() { # $1 size  $2 out
  convert "$SRC" -fuzz 14% -transparent "$ICONBG" -trim +repage \
    -filter Lanczos -resize "$1x$1" "$2"
}

echo "▸ legacy + round launcher icons"
# 48/72/96/144/192 are the buckets a launcher actually asks for. The legacy tile is the
# source resized to fill it, because the art already carries its own padding — scaling it
# down again would shrink the mark twice and leave a 48px icon with a 22px scribble in it.
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d=${pair%%:*}; s=${pair##*:}
  mkdir -p "$RES/mipmap-$d"
  convert "$SRC" -filter Lanczos -resize "${s}x${s}" "PNG32:$RES/mipmap-$d/ic_launcher.png"
  nonblank "$RES/mipmap-$d/ic_launcher.png" "$d launcher tile"
  # Round variant: the same tile through a circular mask. DstIn keeps the destination only
  # where the mask is opaque, which is the one composition that truly crops to a circle —
  # pasting a negated disc over the top just paints over it.
  c=$(( s / 2 ))
  convert "PNG32:$RES/mipmap-$d/ic_launcher.png" \
    \( -size "${s}x${s}" xc:none -fill white -draw "circle ${c},${c} ${c},0" \) \
    -compose DstIn -composite "PNG32:$RES/mipmap-$d/ic_launcher_round.png"
done
echo "  5 densities, square + round, full-bleed art"

echo "▸ adaptive icon layers (API 26+: the launcher owns the mask, we own the safe zone)"
# 108dp canvas with the mark inside the central 72dp, which is the adaptive spec's own safe
# zone. Anything outside it can be cut by a mask, so the mark never goes there even though
# filling the tile would look better. That trade is the launcher's to make, not ours.
for pair in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  d=${pair%%:*}; s=${pair##*:}
  mkdir -p "$RES/mipmap-$d"
  inner=$(( s * 62 / 100 ))
  knockout "$inner" /tmp/fg-mark.png
  convert /tmp/fg-mark.png -background none -gravity center -extent "${s}x${s}" \
    "PNG32:$RES/mipmap-$d/ic_launcher_foreground.png"
done

echo "▸ wordmark lockups"
mkdir -p "$OUT"
knockout 620 brand/mark-transparent.png
nonblank brand/mark-transparent.png "knocked-out mark"
# Name and tagline are set as a column, then pinned beside the tile. Two hand-placed
# annotates on one canvas need offsets that break the moment a string changes length;
# -append does the measuring, and -trim takes the slack out.
wordmark() { # $1 bg  $2 ink  $3 tagline ink  $4 out
  local bg=$1 ink=$2 tag=$3 out=$4
  local S=420
  # The mark goes into a rounded tile in both lockups, because the tile IS the app icon —
  # a wordmark that shows a different shape than the launcher does reads as two brands. The
  # dark tile is kept rather than knocked out: on the light background a cut-out mark picks
  # up a dark fringe wherever an edge had been anti-aliased against the black.
  #
  # Four separate commands, each written to a file, instead of one chained pipeline: IM6
  # silently produced an all-zero frame when the mask was composited in the same statement,
  # and a blank asset is exactly the failure a brand script must not be able to hide.
  convert -size "${S}x${S}" "xc:$bg" /tmp/wm-tile.png
  convert "$SRC" -filter Lanczos -resize "${S}x${S}" /tmp/wm-art.png
  convert /tmp/wm-tile.png /tmp/wm-art.png -gravity center -composite /tmp/wm-flat.png
  convert -size "${S}x${S}" xc:none -fill white \
    -draw "roundrectangle 0,0 $(( S - 1 )),$(( S - 1 )) $(( S / 5 )),$(( S / 5 ))" /tmp/wm-mask.png
  convert /tmp/wm-flat.png /tmp/wm-mask.png -compose DstIn -composite /tmp/wm-round.png
  convert /tmp/wm-round.png -background none -gravity center \
    -extent "$(( S + 96 ))x$(( S + 96 ))" /tmp/wm-mark.png
  nonblank /tmp/wm-mark.png "wordmark tile"
  # Canvas far larger than the text, then trim: label: and tight canvases clip descenders.
  convert -size 2200x400 xc:none -background none -fill "$ink" -font "$SANS-Bold" \
    -pointsize 116 -gravity center -annotate +0+0 "Aryan's AI Call" -trim +repage /tmp/wm-name.png
  convert -size 2200x400 xc:none -background none -fill "$tag" -font "$MONO" \
    -pointsize 46 -gravity center -annotate +0+0 "one row hears, thinks and speaks" \
    -trim +repage /tmp/wm-tag.png
  # A spacer image, not -splice: splice re-adds a page offset, and -append honours page
  # offsets, which is how the tagline ended up printed on top of the name.
  convert -size 1x44 xc:none -background none /tmp/wm-gap.png
  convert /tmp/wm-name.png /tmp/wm-gap.png /tmp/wm-tag.png -background none -gravity west \
    -append +repage /tmp/wm-text.png
  convert \( /tmp/wm-mark.png \) \( /tmp/wm-text.png \) -background "$bg" -gravity center \
    +append -trim +repage -bordercolor "$bg" -border 72 "PNG32:$out"
}
wordmark "$ICONBG" "$INK" "$INK2" "$OUT/wordmark-dark.png"
wordmark "$LIGHTBG" '#0b0e17' '#5b6480' "$OUT/wordmark-light.png"
wordmark "$LIGHTBG" '#0b0e17' '#5b6480' "$OUT/wordmark-light.png"

echo "▸ social card (1200x630 — what a link to this repo unfurls to)"
# Each line of type is its own trimmed image composited at an explicit +x+y, rather than a
# -annotate with a gravity: annotate's offset is measured from the anchor, so "west +114+168"
# means 168px BELOW THE VERTICAL CENTRE, and three of those in one canvas is a layout you
# cannot predict from the source, let alone maintain.
card_text() { # $1 text  $2 font  $3 pointsize  $4 fill  $5 out
  convert -size 2200x500 xc:none -background none -fill "$4" -font "$2" -pointsize "$3" \
    -gravity center -annotate +0+0 "$1" -trim +repage "$5"
}
card_text "Aryan's AI Call" "$SANS-Bold" 74 "$INK" /tmp/card-title.png
card_text "₹0 · Gemini Live · no build step" "$MONO" 31 "$INK2" /tmp/card-sub.png
card_text "a phone call that runs on one WebSocket — in a browser tab, or in this APK" \
  "$SANS" 27 "$INK2" /tmp/card-foot.png
convert brand/mark-transparent.png -filter Lanczos -resize 300x300 /tmp/card-mark.png
convert -size 1200x630 "xc:$ICONBG" \
  /tmp/card-title.png -gravity north-west -geometry +112+196 -composite \
  /tmp/card-sub.png -gravity north-west -geometry +114+296 -composite \
  /tmp/card-foot.png -gravity south-west -geometry +112+88 -composite \
  /tmp/card-mark.png -gravity north-east -geometry +104+164 -composite \
  -stroke "$INK2" -strokewidth 1 -draw "line 112,404 1088,404" +stroke \
  "PNG32:$OUT/og-cover.png"
nonblank "$OUT/og-cover.png" "social card"

# Nothing may touch the frame: art that bleeds off the right edge reads as a deliberate
# full-bleed design for ten seconds, then as a bug in a screenshot. Each edge is sampled as
# a 6px band and must be flat — maxima-minima is zero only when every pixel in the band is
# the background. No bounding-box arithmetic, so nothing to get wrong.
edgeclear() { # $1 file  $2 label
  local f=$1 lbl=$2 g W H band bad
  g=$(identify -format '%wx%h' "$f"); W=${g%%x*}; H=${g##*x}
  bad=""
  for band in "north:${W}x6+0+0:top" "south:${W}x6+0+$(( H - 6 )):bottom" \
              "west:6x${H}+0+0:left" "east:6x${H}+$(( W - 6 ))+0:right"; do
    local geo=${band#*:}; geo=${geo%%:*}; local name=${band##*:}
    local v
    v=$(convert "$f" -gravity none -crop "$geo" +repage -colorspace Gray \
      -format '%[fx:(maxima-minima)*255]' info:)
    awk -v v="$v" 'BEGIN { exit (v+0 < 1.5) ? 0 : 1 }' || bad="$bad $name"
  done
  [ -z "$bad" ] && return 0
  echo "   ! $lbl has content touching the${bad} edge — something is cropped" >&2
  return 1
}
edgeclear "$OUT/og-cover.png" "social card"
edgeclear "$OUT/wordmark-dark.png" "wordmark (dark)"
edgeclear "$OUT/wordmark-light.png" "wordmark (light)"

echo "▸ app splash (API 31+ centres a 200dp drawable on the window background)"
mkdir -p "$RES/drawable-nodpi"
knockout 300 /tmp/splash-mark.png
convert -size 432x432 xc:none /tmp/splash-mark.png -gravity center -composite \
  "PNG32:$RES/drawable-nodpi/app_splash_icon.png"

echo "▸ icon + splash wiring (the XML is generated, so the colour cannot drift from the PNGs)"
# Writing these from the same script that writes the bitmaps is the point: an adaptive icon
# whose <color> background is hand-typed a value away from the legacy tile gives you two
# icons — one before API 26 and one after — and nobody notices until a screenshot does.
mkdir -p "$RES/values" "$RES/values-v31" "$RES/mipmap-anydpi-v26"
cat > "$RES/values/colors.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <!-- Generated by scripts/brand.sh from brand/icon-source.png. Do not hand-edit. -->
  <color name="icon_background">$ICONBG</color>
  <color name="surface">$ICONBG</color>
</resources>
EOF
for n in ic_launcher ic_launcher_round; do
  cat > "$RES/mipmap-anydpi-v26/$n.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/icon_background" />
  <foreground android:drawable="@mipmap/${n%_round}_foreground" />
</adaptive-icon>
EOF
done
# The round variant gets its own foreground so a circular mask never has to guess: it is the
# same artwork, and duplicating the file is cheaper than a conditional in a drawable XML.
cp "$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" "$RES/mipmap-xxxhdpi/ic_launcher_round_foreground.png"
cp "$RES/mipmap-xxhdpi/ic_launcher_foreground.png" "$RES/mipmap-xxhdpi/ic_launcher_round_foreground.png"
cp "$RES/mipmap-xhdpi/ic_launcher_foreground.png" "$RES/mipmap-xhdpi/ic_launcher_round_foreground.png"
cp "$RES/mipmap-hdpi/ic_launcher_foreground.png" "$RES/mipmap-hdpi/ic_launcher_round_foreground.png"
cp "$RES/mipmap-mdpi/ic_launcher_foreground.png" "$RES/mipmap-mdpi/ic_launcher_round_foreground.png"
sed -i 's|@mipmap/ic_launcher_foreground|@mipmap/ic_launcher_round_foreground|' "$RES/mipmap-anydpi-v26/ic_launcher_round.xml"
cat > "$RES/values/styles.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <!-- A plain theme, deliberately: the page draws its own chrome and the app has no
       ActionBar to want. windowBackground matching the icon's black is what makes a cold
       launch read as one continuous surface instead of a white flash before the WebView
       paints — which on a slow connection is the whole first impression. -->
  <style name="AppTheme" parent="android:Theme.Material.NoActionBar">
    <item name="android:windowBackground">@color/surface</item>
    <item name="android:statusBarColor">@color/surface</item>
    <item name="android:navigationBarColor">@color/surface</item>
  </style>
</resources>
EOF
cat > "$RES/values-v31/styles.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<resources>
  <!-- API 31+ draws the system splash itself. Telling it the icon and the colour is two
       lines; shipping a hand-made splash Activity would be a layout, a timer and a
       race with the page's own first paint, all to draw something the OS now does. -->
  <style name="AppTheme" parent="android:Theme.Material.NoActionBar">
    <item name="android:windowBackground">@color/surface</item>
    <item name="android:statusBarColor">@color/surface</item>
    <item name="android:navigationBarColor">@color/surface</item>
    <item name="android:windowSplashScreenBackground">@color/surface</item>
    <item name="android:windowSplashScreenAnimatedIcon">@drawable/app_splash_icon</item>
  </style>
</resources>
EOF
echo "  colors.xml, styles.xml (+ v31), 2 adaptive icons"

echo "▸ README header"
convert "$OUT/og-cover.png" -filter Lanczos -resize 1200x630 "PNG32:$OUT/readme-header.png"

# Strip metadata from everything, on a second pass over the files rather than on each command:
# a few hundred bytes per PNG of software tags that no launcher reads, and this repo carries
# the PNGs.
#
# The tIME exclusion is the part that actually matters. ImageMagick writes a creation timestamp
# chunk into every PNG it saves, so two runs of this script produced files with identical pixels
# and 17 differing bytes — which makes `npm run brand` look as though it changed the artwork, and
# makes any "regenerate and diff the tree" check impossible to write. Pixels are the thing under
# version control here, so pixels are the only thing the bytes may depend on.
for f in "$OUT"/*.png "$RES"/mipmap-*/*.png "$RES"/drawable-nodpi/*.png; do
  convert "$f" -strip -define png:exclude-chunk=tIME "PNG32:$f"
done

echo
for f in "$OUT"/*.png; do
  printf '  %-26s %s\n' "$(basename "$f")" "$(identify -format '%wx%h' "$f")"
done
echo "  $(ls "$RES"/mipmap-*/ic_launcher.png | wc -l) launcher tiles, \
$(ls "$RES"/mipmap-*/ic_launcher_foreground.png | wc -l) adaptive foregrounds"

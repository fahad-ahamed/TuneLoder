#!/bin/bash
# Engine E2E: 4 concurrent downloads from the user's problem playlist.
# Old code failed after ~2 ("cookies load error"); the serialized engine
# must complete ALL of them.
set -u
BASE=http://localhost:3000
IDS=("8of5w7RgcTc" "iCQ1MfeI2d0" "2OGc4VWQZ0Q" "-2RAq5o5pwc")
BR=128
mkdir -p /tmp/eng
echo "firing 4 concurrent downloads at ${BR}kbps..."
for v in "${IDS[@]}"; do
  ( curl -s -m 290 -X POST $BASE/api/download \
      -H "Content-Type: application/json" \
      -d "{\"videoId\":\"$v\",\"bitrate\":$BR,\"title\":\"T-$v\",\"author\":\"E2E\"}" \
      -o "/tmp/eng/$v.mp3" -w "$v %{http_code} %{size_download}bytes %{time_total}s\n" ) &
done
wait
echo "--- results ---"
for v in "${IDS[@]}"; do
  f="/tmp/eng/$v.mp3"
  if [ -s "$f" ]; then
    # is it an mp3 (ID3) or a JSON error body?
    if head -c 3 "$f" | grep -q "ID3"; then
      echo "$v: OK $(du -h "$f" | cut -f1) mp3"
    else
      echo "$v: FAILED -> $(head -c 200 "$f")"
    fi
  else
    echo "$v: EMPTY"
  fi
done
echo "--- engine cache ---"
ls -la /home/z/my-project/data/audio/ | head -8

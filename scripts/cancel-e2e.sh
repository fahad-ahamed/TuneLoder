#!/bin/bash
# Cancel E2E: start a 320kbps download, cancel it mid-flight, verify clean cancel.
set -u
BASE=http://localhost:3000
V="Fp1Ea6LcMwk"   # track #6 from the playlist (not yet downloaded)
BR=320
echo "1) starting download (background)..."
curl -s -m 200 -X POST $BASE/api/download \
  -H "Content-Type: application/json" \
  -d "{\"videoId\":\"$V\",\"bitrate\":$BR,\"title\":\"cancel-test\",\"author\":\"E2E\"}" \
  -o /tmp/eng/cancel-test.out -w "dl_http=%{http_code}\n" &
DLPID=$!

sleep 4
echo "2) progress before cancel:"
curl -s -m 5 "$BASE/api/progress?key=$V:$BR"; echo
echo "3) cancelling..."
curl -s -m 10 -X POST $BASE/api/cancel -H "Content-Type: application/json" -d "{\"videoId\":\"$V\",\"bitrate\":$BR}"; echo
sleep 3
echo "4) progress after cancel:"
curl -s -m 5 "$BASE/api/progress?key=$V:$BR"; echo
wait $DLPID
echo "5) download result body (first 200 chars):"
head -c 200 /tmp/eng/cancel-test.out; echo
echo "6) leftover yt-dlp processes (should be none):"
ps aux | grep yt-dlp | grep -v grep | wc -l
echo "7) leftover cache file (should be none):"
ls /home/z/my-project/data/audio/ | grep "$V" || echo "  none — clean"

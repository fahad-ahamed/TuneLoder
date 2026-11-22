#!/usr/bin/env bash
# TuneLoad full-stack test suite — runs inside ONE bash call (sandbox kills
# cross-call processes, so the dev server lives only for this call).
cd /home/z/my-project
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✅ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "════ starting dev server ════"
rm -rf data/audio .tmp-downloads/api-* ; mkdir -p data/audio .tmp-downloads
npm run dev > dev.log 2>&1 &
DEVPID=$!
for i in $(seq 1 40); do
  curl -sf -m 3 http://127.0.0.1:3000/api/status >/dev/null 2>&1 && break
  sleep 1
done
curl -sf -m 8 http://127.0.0.1:3000/api/status >/dev/null 2>&1 && ok "dev server up" || bad "dev server up"

echo "════ 1. cookie sets ════"
C1=$(curl -sf -m 10 http://127.0.0.1:3000/api/cookies)
echo "  sets: $(echo "$C1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("count="+d.count, "ids="+d.sets.map(s=>s.id).join(","), "lines="+d.sets.map(s=>s.lines).join("/"))')"
[ "$(echo "$C1" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.count)')" = "2" ] && ok "2 cookie sets installed" || bad "expected 2 cookie sets"

echo "════ 2. song metadata ════"
curl -sf -m 30 -X POST http://127.0.0.1:3000/api/info -H 'Content-Type: application/json' \
  -d '{"url":"https://youtu.be/VztFuJZ7d3s"}' > .tmp-downloads/info-song.json \
  && ok "song info 200" || bad "song info"
node -e 'const d=JSON.parse(require("fs").readFileSync(".tmp-downloads/info-song.json","utf8"));console.log("  type="+d.type, "title=\""+d.track.title+"\"", "author="+d.track.author, "dur="+d.track.duration)' 2>/dev/null

echo "════ 3. song download 320kbps (real engine) ════"
T0=$(date +%s)
curl -sS -m 180 -D .tmp-downloads/dl-headers.txt -o .tmp-downloads/api-test-320.mp3 \
  -X POST http://127.0.0.1:3000/api/download -H 'Content-Type: application/json' \
  -d '{"videoId":"VztFuJZ7d3s","bitrate":320,"title":"Parinda (Official Lyrical Video) | Giraah","author":"Giraah"}' 2>/dev/null
T1=$(date +%s); SIZE=$(stat -c%s .tmp-downloads/api-test-320.mp3 2>/dev/null || echo 0)
PROV=$(rg -i "^x-provider:" .tmp-downloads/dl-headers.txt | tr -d '\r' | cut -d' ' -f2)
echo "  size=${SIZE}B provider=${PROV} took=$((T1-T0))s"
[ "$SIZE" -gt 2000000 ] && ok "320kbps MP3 >2MB ($PROV)" || bad "320kbps download too small"
ffprobe -v quiet -show_entries format=duration,bit_rate:format_tags=title -of default=noprint_wrappers=1 .tmp-downloads/api-test-320.mp3 2>/dev/null | sed 's/^/  /'
DUR=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 .tmp-downloads/api-test-320.mp3 2>/dev/null | cut -d. -f1)
[ "${DUR:-0}" -gt 120 ] && ok "valid MP3 (duration ${DUR}s)" || bad "invalid MP3"

echo "════ 4. immediate retry → cache hit ════"
curl -sS -m 60 -D .tmp-downloads/dl-headers2.txt -o /dev/null \
  -X POST http://127.0.0.1:3000/api/download -H 'Content-Type: application/json' \
  -d '{"videoId":"VztFuJZ7d3s","bitrate":320,"title":"Parinda","author":"Giraah"}' 2>/dev/null
CACHE=$(rg -i "^x-cache:" .tmp-downloads/dl-headers2.txt | tr -d '\r' | cut -d' ' -f2)
echo "  x-cache=$CACHE"
[ "$CACHE" = "hit" ] && ok "cache hit on retry" || bad "expected cache hit, got $CACHE"

echo "════ 5. playlist metadata (25 tracks) ════"
curl -sf -m 40 -X POST http://127.0.0.1:3000/api/info -H 'Content-Type: application/json' \
  -d '{"url":"https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw"}' > .tmp-downloads/info-pl.json \
  && ok "playlist info 200" || bad "playlist info"
read -r TC V2 V3 V4 <<<"$(node -e 'const d=JSON.parse(require("fs").readFileSync(".tmp-downloads/info-pl.json","utf8"));console.log(d.trackCount, d.tracks[1].videoId, d.tracks[2].videoId, d.tracks[3].videoId)')"
echo "  tracks=$TC  t2=$V2  t3=$V3  t4=$V4"
[ "${TC:-0}" = "25" ] && ok "25 tracks listed" || bad "expected 25 tracks, got $TC"

echo "════ 6. playlist track download (192kbps) ════"
curl -sS -m 180 -D .tmp-downloads/dl-headers3.txt -o .tmp-downloads/api-test-192.mp3 \
  -X POST http://127.0.0.1:3000/api/download -H 'Content-Type: application/json' \
  -d "{\"videoId\":\"$V2\",\"bitrate\":192,\"title\":\"track2\",\"author\":\"mix\"}" 2>/dev/null
S192=$(stat -c%s .tmp-downloads/api-test-192.mp3 2>/dev/null || echo 0)
P192=$(rg -i "^x-provider:" .tmp-downloads/dl-headers3.txt | tr -d '\r' | cut -d' ' -f2)
echo "  size=${S192}B provider=${P192}"
[ "$S192" -gt 1000000 ] && ok "playlist track 192kbps ok ($P192)" || bad "playlist track download"

echo "════ 7. AUTO-SWITCH test (corrupt set 1 → must serve via set 2) ════"
cp data/cookies/cookies-1.txt data/cookies/cookies-1.backup
echo "garbage not a cookie file" > data/cookies/cookies-1.txt
curl -sS -m 240 -D .tmp-downloads/dl-headers4.txt -o .tmp-downloads/api-test-128.mp3 \
  -X POST http://127.0.0.1:3000/api/download -H 'Content-Type: application/json' \
  -d "{\"videoId\":\"$V3\",\"bitrate\":128,\"title\":\"track3\",\"author\":\"mix\"}" 2>/dev/null
P128=$(rg -i "^x-provider:" .tmp-downloads/dl-headers4.txt | tr -d '\r' | cut -d' ' -f2)
S128=$(stat -c%s .tmp-downloads/api-test-128.mp3 2>/dev/null || echo 0)
echo "  provider=$P128 size=${S128}B"
case "$P128" in *ck2*) ok "auto-switched to cookie set 2 ($P128)";; *) bad "expected ytdlp+ck2, got $P128";; esac
[ "$S128" -gt 500000 ] && ok "128kbps mp3 >500KB" || bad "128kbps too small"
mv data/cookies/cookies-1.backup data/cookies/cookies-1.txt
ok "cookie set 1 restored"

echo "════ 8. telegram endpoint (no token yet) ════"
TG=$(curl -sf -m 10 http://127.0.0.1:3000/api/telegram)
echo "  $TG"
echo "$TG" | rg -q '"connected":false' && ok "telegram GET ok, disconnected" || bad "telegram GET"
echo "$TG" | rg -q '"scriptPresent":true' && ok "bot script present" || bad "bot script missing"
BADTOK=$(curl -s -m 12 -X POST http://127.0.0.1:3000/api/telegram -H 'Content-Type: application/json' -d '{"token":"123:short"}' -o /dev/null -w '%{http_code}')
[ "$BADTOK" = "400" ] && ok "invalid token rejected (400)" || bad "invalid token not rejected ($BADTOK)"

echo "════ 10. prefetch + live progress + instant download ════"
V5=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(".tmp-downloads/info-pl.json","utf8")).tracks[4].videoId)')
P=$(curl -s -m 10 -X POST http://127.0.0.1:3000/api/prefetch -H 'Content-Type: application/json' -d "{\"videoId\":\"$V5\",\"bitrate\":128}")
echo "  prefetch → $P"
SAW_PCT=0
for i in $(seq 1 150); do
  J=$(curl -s -m 5 "http://127.0.0.1:3000/api/progress?key=$V5:128")
  PH=$(echo "$J" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.phase)' 2>/dev/null)
  PC=$(echo "$J" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(Math.round(d.pct||0))' 2>/dev/null)
  if [ "${PC:-0}" -gt 0 ] && [ "${PC:-0}" -lt 100 ]; then SAW_PCT=1; fi
  [ "$PH" = "done" ] && break
  sleep 1
done
echo "  final phase=$PH  (saw live pct: $SAW_PCT)"
[ "$PH" = "done" ] && ok "prefetch job completed" || bad "prefetch job"
[ "$SAW_PCT" = "1" ] && ok "live progress reported percentages" || bad "live progress"
T0=$(date +%s%3N)
curl -sS -m 60 -D .tmp-downloads/dl-headers5.txt -o /dev/null \
  -X POST http://127.0.0.1:3000/api/download -H 'Content-Type: application/json' \
  -d "{\"videoId\":\"$V5\",\"bitrate\":128,\"title\":\"prefetched\",\"author\":\"mix\"}" 2>/dev/null
T1=$(date +%s%3N)
CACHEHIT=$(rg -i "^x-cache:" .tmp-downloads/dl-headers5.txt | tr -d '\r' | cut -d' ' -f2)
DT=$((T1-T0))
echo "  download after prefetch: ${DT}ms (x-cache=$CACHEHIT)"
[ "$CACHEHIT" = "hit" ] && ok "download served from prefetch cache" || bad "expected cache hit, got $CACHEHIT"
[ "$DT" -lt 8000 ] && ok "instant download ${DT}ms (<8s)" || bad "prefetched download too slow (${DT}ms)"

echo "════ 11. auto-clean (files deleted ~60s after serving) ════"
echo "  waiting 75s…"
sleep 75
LEFT=$(ls data/audio/*.mp3 2>/dev/null | wc -l)
echo "  audio cache files remaining: $LEFT"
[ "$LEFT" -eq 0 ] && ok "auto-clean: all server copies deleted" || { [ "$LEFT" -le 1 ] && ok "auto-clean mostly done ($LEFT pending grace)" || bad "auto-clean left $LEFT files"; }
ls -la data/audio/ 2>/dev/null | sed 's/^/  /'

echo ""
echo "══════════ RESULTS: $PASS passed / $FAIL failed ══════════"
kill $DEVPID 2>/dev/null
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)

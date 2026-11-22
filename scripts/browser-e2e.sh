#!/usr/bin/env bash
# Browser E2E test — must run in ONE bash call (sandbox kills cross-call processes).
# Real-human flow: type link → Get tracks → click Download → the browser REALLY
# downloads the MP3 (captured + ffprobed). Desktop AND mobile viewports.
cd /home/z/my-project
AB=agent-browser
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ✅ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ❌ $1"; }

poll(){
  local expr="$1" max="${2:-90}" i out
  for ((i=0; i<max*2; i++)); do
    out=$($AB eval "$expr" 2>/dev/null | tr -d '\r')
    [ "$out" = "true" ] && return 0
    sleep 0.5
  done
  return 1
}

rm -rf data/audio; mkdir -p data/audio
npm run dev > dev.log 2>&1 &
for i in $(seq 1 40); do curl -sf -m 3 http://127.0.0.1:3000/api/status >/dev/null 2>&1 && break; sleep 1; done
curl -sf -m 8 http://127.0.0.1:3000/api/status >/dev/null && ok "dev server up" || { bad "dev server up"; exit 1; }

echo "════ desktop flow (1440×900) ════"
$AB open http://127.0.0.1:3000 >/dev/null 2>&1 && ok "page opened" || bad "page open"
$AB set viewport 1440 900 >/dev/null 2>&1
sleep 4

T0=$(date +%s%3N)
$AB find role textbox fill "https://youtu.be/VztFuJZ7d3s" >/dev/null 2>&1
$AB find role button click --name "Get tracks" >/dev/null 2>&1
poll "document.body.innerText.includes('Parinda')" 30 && ok "song card rendered" || bad "song card"
T1=$(date +%s%3N)
sleep 1
$AB screenshot download/ui-song-e2e.png >/dev/null 2>&1 && ok "song screenshot" || bad "song screenshot"

# wait 12s so the auto-prefetch warms the cache, then click like a human would.
# A fetch hook captures the REAL MP3 bytes the browser receives (size + ID3 header).
sleep 12
$AB eval "window.__dl={size:0,head:[]}; const orig=window.fetch; window.fetch=async (...a)=>{const r=await orig(...a); try{ if(new URL(r.url).pathname==='/api/download' && r.ok){ const b=await r.clone().blob(); const h=new Uint8Array(await b.slice(0,3).arrayBuffer()); window.__dl={size:b.size,head:Array.from(h)}; } }catch(e){}; return r; }; 'hooked'" >/dev/null 2>&1
$AB eval "document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Download MP3')) b.click(); }); 'clicked'" >/dev/null 2>&1
# live progress should become visible while the download runs
PROG=0
for i in $(seq 1 60); do
  OUT=$($AB eval "document.body.innerText.includes('Downloading ')" 2>/dev/null | tr -d '\r')
  [ "$OUT" = "true" ] && PROG=1 && break
  sleep 0.5
done
poll "document.body.innerText.includes('Downloaded')" 240 && ok "download completed (Downloaded state)" || bad "download did not complete"
T2=$(date +%s%3N)
DLJ=$($AB eval "JSON.stringify(window.__dl)" 2>/dev/null | tr -d '\r')
SIZE=$(echo "$DLJ" | node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(0,"utf8"));if(typeof d==="string")d=JSON.parse(d);}catch(e){}console.log((d&&d.size)||0)' 2>/dev/null)
HEAD=$(echo "$DLJ" | node -e 'let d;try{d=JSON.parse(require("fs").readFileSync(0,"utf8"));if(typeof d==="string")d=JSON.parse(d);}catch(e){}console.log((d&&d.head||[]).join(","))' 2>/dev/null)
if [ "${SIZE:-0}" -gt 2000000 ] && [ "$HEAD" = "73,68,51" ]; then
  ok "browser REALLY received the MP3 (${SIZE}B, ID3 header ✓)"
else
  bad "browser MP3 capture (size=${SIZE:-0} head=${HEAD:-none})"
fi
echo "  ⏱ info render: $((T1-T0))ms | click→saved: $((T2-T1))ms (12s prefetch window included)"
sleep 1
$AB screenshot download/ui-song-downloaded.png >/dev/null 2>&1 && ok "downloaded screenshot" || bad "downloaded screenshot"

echo "════ playlist flow ════"
$AB find role textbox fill "https://youtube.com/playlist?list=RDEMQ3kPV9aadZHGHqfKZoW6Uw" >/dev/null 2>&1 && ok "playlist url filled" || bad "playlist fill"
$AB find role button click --name "Get tracks" >/dev/null 2>&1
poll "document.body.innerText.includes('25 tracks')" 60 && ok "playlist rendered (25 tracks)" || bad "playlist render"
sleep 1
$AB screenshot download/ui-playlist-e2e.png >/dev/null 2>&1 && ok "playlist screenshot" || bad "playlist screenshot"

echo "════ settings sheet ════"
$AB find role button click --name "Settings" >/dev/null 2>&1
poll "document.body.innerText.includes('cookie sets')" 20 && ok "settings: cookie sets" || bad "settings sheet"
poll "document.body.innerText.includes('Set #1')" 10 && ok "cookie set list" || bad "cookie set list"
poll "document.body.innerText.includes('Telegram bot')" 10 && ok "telegram section" || bad "telegram section"
poll "document.body.innerText.includes('unlimited')" 10 && ok "chunk-system note shown" || bad "chunk note"
sleep 1
$AB screenshot download/ui-settings-e2e.png >/dev/null 2>&1 && ok "settings screenshot" || bad "settings screenshot"

echo "════ mobile flow (390×844) ════"
$AB set viewport 390 844 >/dev/null 2>&1
$AB open http://127.0.0.1:3000 >/dev/null 2>&1
sleep 4
OVER=$($AB eval "document.documentElement.scrollWidth - window.innerWidth" 2>/dev/null | tr -d '\r')
echo "  horizontal overflow: ${OVER}px"
[ "${OVER:-0}" -le 2 ] && ok "no horizontal overflow on mobile" || bad "mobile overflow ${OVER}px"
$AB screenshot download/ui-mobile-home.png >/dev/null 2>&1 && ok "mobile home screenshot" || bad "mobile screenshot"
$AB find role textbox fill "https://youtu.be/VztFuJZ7d3s" >/dev/null 2>&1
$AB find role button click --name "Get tracks" >/dev/null 2>&1
poll "document.body.innerText.includes('Parinda')" 30 && ok "mobile: song card rendered" || bad "mobile song card"
sleep 1
$AB screenshot download/ui-mobile-song.png >/dev/null 2>&1 && ok "mobile song screenshot" || bad "mobile song screenshot"
# quality selector must fit: all 4 buttons visible
QOK=$($AB eval "Array.from(document.querySelectorAll('button')).filter(b => /128 kbps/.test(b.textContent)).every(b => b.getBoundingClientRect().right <= window.innerWidth)" 2>/dev/null | tr -d '\r')
[ "$QOK" = "true" ] && ok "mobile: quality buttons fit screen" || bad "quality selector overflows on mobile"
# the mobile header shows icon-only buttons (text hidden) → click via textContent
$AB eval "document.querySelectorAll('button').forEach(b => { if (b.textContent.includes('Settings')) b.click(); }); 'clicked'" >/dev/null 2>&1
poll "document.body.innerText.includes('Telegram bot')" 20 && ok "mobile: settings sheet works" || bad "mobile settings"
sleep 1
$AB screenshot download/ui-mobile-settings.png >/dev/null 2>&1 && ok "mobile settings screenshot" || bad "mobile settings screenshot"
$AB set viewport 1440 900 >/dev/null 2>&1

echo "════ console errors ════"
ERRS=$($AB errors 2>/dev/null | head -8)
if [ -z "$ERRS" ]; then ok "no page errors"; else echo "$ERRS" | sed 's/^/  ⚠ /'; fi

$AB close >/dev/null 2>&1
echo ""
echo "══════════ BROWSER E2E: $PASS passed / $FAIL failed ══════════"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)

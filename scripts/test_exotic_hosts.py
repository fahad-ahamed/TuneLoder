#!/usr/bin/env python3
"""Test exotic innertube frontend hosts + /next endpoint gating."""
import json, urllib.request

VID = "VztFuJZ7d3s"
UA_TV = "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15"
UA_ANDROID = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
UA_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def call(url, body, ua, extra=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": ua, **(extra or {})}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def summarize(name, d):
    ps = d.get("playabilityStatus", {})
    sd = d.get("streamingData", {})
    af = sd.get("adaptiveFormats", [])
    audio = [f for f in af if "audio" in f.get("mimeType", "")]
    print(f"[{name}] {ps.get('status','?')} reason={ps.get('reason','')[:40]} | title={(d.get('videoDetails') or {}).get('title','')[:30]} | audio={len(audio)}")
    if audio:
        for f in audio[:3]:
            print(f"    itag={f.get('itag')} br={f.get('averageBitrate') or f.get('bitrate')} url={'YES' if f.get('url') else ('CIPHER' if f.get('signatureCipher') else '?')}")
        with open(f"/tmp/OK_{name}.json", "w") as fp: json.dump(sd, fp)
    return audio

tests = [
    ("TV-host-TVHTML5", "https://tv.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KUQ-vV2k6q5EoA&prettyPrint=false",
     {"context": {"client": {"clientName": "TVHTML5", "clientVersion": "7.20250312.10.00", "hl": "en", "gl": "US"}},
      "videoId": VID, "contentCheckOk": True, "racyCheckOk": True}, UA_TV, {}),
    ("KIDS-host", "https://kids.youtube.com/youtubei/v1/player?key=AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc&prettyPrint=false",
     {"context": {"client": {"clientName": "WEB_KIDS", "clientVersion": "2.20250101.00.00", "hl": "en", "gl": "US"}},
      "videoId": VID, "contentCheckOk": True, "racyCheckOk": True}, UA_CHROME, {"Origin": "https://kids.youtube.com", "Referer": "https://kids.youtube.com/"}),
    ("M-host-MWEB", "https://m.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlhyUg5NrbX5ERFxO4Z-vwFdxzM&prettyPrint=false",
     {"context": {"client": {"clientName": "MWEB", "clientVersion": "2.20261119.01.00", "hl": "en", "gl": "US"}},
      "videoId": VID, "contentCheckOk": True, "racyCheckOk": True}, UA_CHROME, {"Origin": "https://m.youtube.com", "Referer": "https://m.youtube.com/"}),
    ("NEXT-endpoint", "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
     {"context": {"client": {"clientName": "WEB", "clientVersion": "2.20261119.01.00", "hl": "en", "gl": "US"}},
      "videoId": VID}, UA_CHROME, {"Origin": "https://www.youtube.com"}),
    ("TIMEDTEXT-get", "https://www.youtube.com/api/timedtext?v=" + VID + "&lang=en&type=list", None, None, {}),
]

for name, url, body, ua, extra in tests:
    if body is None:
        import urllib.request as ur
        try:
            req = ur.Request(url, headers={"User-Agent": UA_CHROME})
            with ur.urlopen(req, timeout=20) as r:
                t = r.read(200)
            print(f"[{name}] HTTP:{r.status} body[:120]: {t[:120]}")
        except Exception as e:
            print(f"[{name}] FAIL: {str(e)[:80]}")
        continue
    try:
        d = call(url, body, ua, extra)
        if "playabilityStatus" in d or "streamingData" in d:
            summarize(name, d)
        else:
            keys = list(d.keys())[:10]
            print(f"[{name}] OK-ish keys={keys}")
    except urllib.error.HTTPError as e:
        print(f"[{name}] HTTP {e.code}: {e.read(120).decode('utf-8','ignore')[:100]}")
    except Exception as e:
        print(f"[{name}] FAIL: {str(e)[:90]}")

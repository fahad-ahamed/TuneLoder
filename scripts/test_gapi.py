#!/usr/bin/env python3
"""Test youtubei.googleapis.com (different frontend host) + no-key innertube + header-based client ID."""
import json, urllib.request

VID = "VztFuJZ7d3s"
UA_ANDROID = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
UA_IOS = "com.google.ios.youtube/20.10.2 (iPhone16,2; U; CPU iOS_18_0 like Mac OS X)"
UA_TV = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"

def call(host_url, body, headers):
    req = urllib.request.Request(host_url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def summarize(name, d):
    try:
        ps = d.get("playabilityStatus", {})
        vd = d.get("videoDetails", {})
        sd = d.get("streamingData", {})
        af = sd.get("adaptiveFormats", [])
        audio = [f for f in af if "audio" in f.get("mimeType", "")]
        status = ps.get("status", "?")
        print(f"[{name}] {status} reason={ps.get('reason','')[:35]} | title={vd.get('title','')[:30]} | audio={len(audio)}")
        for f in audio[:3]:
            print(f"    itag={f.get('itag')} br={f.get('averageBitrate') or f.get('bitrate')} url={'YES' if f.get('url') else ('CIPHER' if f.get('signatureCipher') else '?')}")
        if audio and (audio[0].get("url") or audio[0].get("signatureCipher")):
            with open(f"/tmp/STREAMS_{name}.json", "w") as fp:
                json.dump(sd, fp)
            print(f"    *** SAVED /tmp/STREAMS_{name}.json ***")
        return True
    except Exception as e:
        print(f"[{name}] parse-err: {e}")
        return False

tests = [
    # 1. youtubei.googleapis.com with ANDROID client + key
    ("GAPI-ANDROID", f"https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KUQ-vV2k6q5EoA&prettyPrint=false",
     {"context": {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 30, "hl": "en", "gl": "US"}}, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
     {"User-Agent": UA_ANDROID}),
    # 2. youtubei.googleapis.com with IOS client + IOS key
    ("GAPI-IOS", f"https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc&prettyPrint=false",
     {"context": {"client": {"clientName": "IOS", "clientVersion": "20.10.2", "deviceMake": "Apple", "deviceModel": "iPhone16,2", "osName": "iPhone", "osVersion": "18.0.0.0", "hl": "en", "gl": "US"}}, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
     {"User-Agent": UA_IOS}),
    # 3. youtube.com no-key with X-YouTube-Client headers (ANDROID)
    ("NOKEY-HDR-ANDROID", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
     {"context": {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38", "androidSdkVersion": 30, "hl": "en", "gl": "US"}}, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
     {"User-Agent": UA_ANDROID, "X-YouTube-Client-Name": "3", "X-YouTube-Client-Version": "20.10.38"}),
    # 4. youtube.com no-key TVHTML5_SIMPLY_EMBEDDED_PLAYER
    ("NOKEY-HDR-TVSIMPLE", "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
     {"context": {"client": {"clientName": "TVHTML5_SIMPLY_EMBEDDED_PLAYER", "clientVersion": "2.1", "hl": "en", "gl": "US"}}, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
     {"User-Agent": UA_TV, "X-YouTube-Client-Name": "85", "X-YouTube-Client-Version": "2.1"}),
    # 5. youtubei.googleapis.com ANDROID_MUSIC
    ("GAPI-ANDROIDMUSIC", f"https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KUQ-vV2k6q5EoA&prettyPrint=false",
     {"context": {"client": {"clientName": "ANDROID_MUSIC", "clientVersion": "8.10.51", "androidSdkVersion": 30, "hl": "en", "gl": "US"}}, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
     {"User-Agent": "com.google.android.apps.youtube.music/8.10.51 (Linux; U; Android 13; US) gzip", "X-YouTube-Client-Name": "21", "X-YouTube-Client-Version": "8.10.51"}),
]

for name, url, body, headers in tests:
    try:
        d = call(url, body, headers)
        summarize(name, d)
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read(150).decode("utf-8", "ignore")
        except Exception:
            pass
        print(f"[{name}] HTTP {e.code}: {body_txt[:100]}")
    except Exception as e:
        print(f"[{name}] FAIL: {str(e)[:100]}")

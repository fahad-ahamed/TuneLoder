#!/usr/bin/env python3
"""Test multiple YouTube innertube client contexts against the player API."""
import json, urllib.request, ssl, sys

VID = "VztFuJZ7d3s"
ANDROID_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KUQ-vV2k6q5EoA"
WEB_KEY = "AIzaSyAO_FJ2SlhyUg5NrbX5ERFxO4Z-vwFdxzM"

clients = [
    ("TVHTML5", "7.20250312.10.00", ANDROID_KEY, "com.google.android.youtube/7.20250312.10.00 (Linux; U; Android 11) gzip", {}),
    ("TVHTML5_SIMPLY_EMBEDDED_PLAYER", "2.1", ANDROID_KEY, "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version", {}),
    ("MWEB", "2.20250101.00.00", WEB_KEY, "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", {}),
    ("WEB_EMBEDDED_PLAYER", "1.20250101.01.00", WEB_KEY, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", {}),
    ("ANDROID_VR", "1.62.44", ANDROID_KEY, "com.google.android.apps.youtube.vr.oculus/1.62.44 (Linux; U; Android 12; eureka-user Build/SQ3A.220705.004.A1) gzip", {}),
    ("ANDROID_MUSIC", "8.10.51", ANDROID_KEY, "com.google.android.apps.youtube.music/8.10.51 (Linux; U; Android 13; US) gzip", {}),
    ("ANDROID_TESTSUITE", "1.9", ANDROID_KEY, "com.google.android.youtube/1.9 (Linux; U; Android 11) gzip", {}),
    ("ANDROID_CREATOR", "22.45.100", ANDROID_KEY, "com.google.android.apps.youtube.creator/22.45.100 (Linux; U; Android 13; US) gzip", {}),
    ("IOS_MUSIC", "8.10.5", ANDROID_KEY, "com.google.ios.youtubemusic/8.10.5 (iPhone15,2; U; CPU iOS_18)"),
    ("MEDIA_CONNECT_FRONTEND", "0.1", ANDROID_KEY, "Mozilla/5.0", {}),
    ("WEB_REMIX", "1.20250101.00.00", WEB_KEY, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", {}),
    ("WEB_SPORTS", "1.20250101.00.00", WEB_KEY, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", {}),
]

def test_client(name, ver, key, ua, extra):
    url = f"https://www.youtube.com/youtubei/v1/player?key={key}&prettyPrint=false"
    ctx = {"client": {"clientName": name, "clientVersion": ver, "hl": "en", "gl": "US", **extra}}
    body = json.dumps({"context": ctx, "videoId": VID, "contentCheckOk": True, "racyCheckOk": True}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": ua,
        "Origin": "https://www.youtube.com" if "WEB" in name or "MWEB" in name else "com.google.android.",
    }, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.loads(r.read())
        ps = d.get("playabilityStatus", {})
        status = ps.get("status", "?")
        title = d.get("videoDetails", {}).get("title", "")
        sd = d.get("streamingData", {})
        nfmt = len(sd.get("adaptiveFormats", [])) + len(sd.get("formats", []))
        audio = [f for f in sd.get("adaptiveFormats", []) if "audio" in f.get("mimeType", "")]
        url_direct = sum(1 for f in sd.get("adaptiveFormats", []) + sd.get("formats", []) if f.get("url"))
        print(f"[{name}] {status} | fmts:{nfmt} audio:{len(audio)} directURL:{url_direct} | {title[:40]}")
        if audio:
            for f in audio[:3]:
                print(f"    audio itag={f.get('itag')} {f.get('mimeType','')[:45]} bitrate={f.get('averageBitrate') or f.get('bitrate')} url={'YES' if f.get('url') else 'cipher'}")
        return d
    except Exception as e:
        print(f"[{name}] FAIL: {str(e)[:90]}")
        return None

results = {}
for name, ver, key, ua, extra in clients:
    if "IOS_MUSIC" in name:
        extra = {"deviceMake": "Apple", "deviceModel": "iPhone15,2", "osName": "iOS", "osVersion": "18.0.0"}
    results[name] = test_client(name, ver, key, ua, extra)

# save any working response for inspection
for name, d in results.items():
    if d and d.get("playabilityStatus", {}).get("status") == "OK" and d.get("streamingData", {}).get("adaptiveFormats"):
        with open(f"/tmp/working_{name}.json", "w") as f:
            json.dump(d, f)
        print(f"\n*** WORKING CLIENT: {name} — saved /tmp/working_{name}.json ***")

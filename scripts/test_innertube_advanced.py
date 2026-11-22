#!/usr/bin/env python3
"""Advanced innertube tests: visitorData pairing + PO tokens + more clients."""
import json, urllib.request

VID = "VztFuJZ7d3s"
ANDROID_KEY = "AIzaSyA8eiZmM1FaDVjRy-df2KUQ-vV2k6q5EoA"
WEB_KEY = "AIzaSyAO_FJ2SlhyUg5NrbX5ERFxO4Z-vwFdxzM"

def call(url, body, ua, extra_headers=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
        "Content-Type": "application/json",
        "User-Agent": ua,
        "Origin": "https://www.youtube.com",
        **(extra_headers or {}),
    }, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def get_po_token(context="gvs"):
    """Fetch PO token + visitorData from bgutil server."""
    req = urllib.request.Request(
        "http://127.0.0.1:4416/get_pot",
        data=json.dumps({"context": context, "contentBinding": ""}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    return d.get("poToken", ""), d.get("contentBinding", "")

def summarize(name, d):
    ps = d.get("playabilityStatus", {})
    vd = d.get("videoDetails", {})
    sd = d.get("streamingData", {})
    af = sd.get("adaptiveFormats", [])
    audio = [f for f in af if "audio" in f.get("mimeType", "")]
    print(f"[{name}] {ps.get('status','?')} reason={ps.get('reason','')[:40]} | title={vd.get('title','')[:30]} | audio={len(audio)}")
    for f in audio[:4]:
        print(f"    itag={f.get('itag')} {f.get('mimeType','')[:48]} br={f.get('averageBitrate') or f.get('bitrate')} url={'YES' if f.get('url') else ('CIPHER' if f.get('signatureCipher') else '?')}")
    return d

# --- Test 1: WEB + PO token (gvs) + matching visitorData ---
try:
    print("== WEB + PO(gvs) ==")
    pot, visitor = get_po_token("gvs")
    print(f"   pot: {pot[:18]}... visitor: {visitor[:18]}...")
    d = call(
        f"https://www.youtube.com/youtubei/v1/player?key={WEB_KEY}&prettyPrint=false",
        {
            "context": {
                "client": {
                    "clientName": "WEB", "clientVersion": "2.20261119.01.00",
                    "hl": "en", "gl": "US", "visitorData": visitor,
                },
            },
            "videoId": VID,
            "contentCheckOk": True, "racyCheckOk": True,
            "serviceIntegrityDimensions": {"poToken": pot},
        },
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    summarize("WEB+PO", d)
except Exception as e:
    print("WEB+PO FAIL:", str(e)[:120])

# --- Test 2: WEB_EMBEDDED_PLAYER + PO + visitor ---
try:
    print("\n== WEB_EMBEDDED_PLAYER + PO ==")
    pot, visitor = get_po_token("player")
    d = call(
        f"https://www.youtube.com/youtubei/v1/player?key={WEB_KEY}&prettyPrint=false",
        {
            "context": {
                "client": {
                    "clientName": "WEB_EMBEDDED_PLAYER", "clientVersion": "1.20261119.01.00",
                    "hl": "en", "gl": "US", "visitorData": visitor,
                },
                "thirdParty": {"embedUrl": "https://www.youtube.com/watch?v=" + VID},
            },
            "videoId": VID,
            "contentCheckOk": True, "racyCheckOk": True,
            "serviceIntegrityDimensions": {"poToken": pot},
        },
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    summarize("EMBED+PO", d)
except Exception as e:
    print("EMBED+PO FAIL:", str(e)[:120])

# --- Test 3: MWEB with 2-step visitorData session ---
try:
    print("\n== MWEB visitor-session trick ==")
    d1 = call(
        f"https://www.youtube.com/youtubei/v1/player?key={WEB_KEY}&prettyPrint=false",
        {"context": {"client": {"clientName": "MWEB", "clientVersion": "2.20261119.01.00", "hl": "en", "gl": "US"}}},
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    ) if False else call(
        f"https://www.youtube.com/youtubei/v1/player?key={WEB_KEY}&prettyPrint=false",
        {"context": {"client": {"clientName": "MWEB", "clientVersion": "2.20261119.01.00", "hl": "en", "gl": "US"}},
         "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    vis = d1.get("responseContext", {}).get("visitorData", "")
    print("   got visitor:", vis[:24], "...")
    d2 = call(
        f"https://www.youtube.com/youtubei/v1/player?key={WEB_KEY}&prettyPrint=false",
        {"context": {"client": {"clientName": "MWEB", "clientVersion": "2.20261119.01.00", "hl": "en", "gl": "US", "visitorData": vis}},
         "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    summarize("MWEB+visitor", d2)
except Exception as e:
    print("MWEB FAIL:", str(e)[:120])

# --- Test 4: ANDROID with PO + visitor ---
try:
    print("\n== ANDROID + PO(gvs) ==")
    pot, visitor = get_po_token("gvs")
    d = call(
        f"https://www.youtube.com/youtubei/v1/player?key={ANDROID_KEY}&prettyPrint=false",
        {
            "context": {"client": {"clientName": "ANDROID", "clientVersion": "20.10.38",
                        "androidSdkVersion": 30, "hl": "en", "gl": "US", "visitorData": visitor}},
            "videoId": VID, "contentCheckOk": True, "racyCheckOk": True,
            "serviceIntegrityDimensions": {"poToken": pot},
        },
        "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    )
    summarize("ANDROID+PO", d)
except Exception as e:
    print("ANDROID+PO FAIL:", str(e)[:120])

# --- Test 5: exotic clients ---
for cname, cver, key, ua, extra in [
    ("ANDROID_LITE", "3.29.53", ANDROID_KEY, "com.google.android.apps.youtube.lite/3.29.53 (Linux; U; Android 11) gzip", {}),
    ("IOS_MESSAGES_EXTENSION", "8.10.5", ANDROID_KEY, "com.google.ios.youtubemusic/8.10.5 (iPhone15,2; U; CPU iOS_18)", {}),
    ("WEB_KIDS", "2.20250101.00.00", WEB_KEY, "Mozilla/5.0", {}),
    ("IOS_UNPLUGGED", "8.10.5", ANDROID_KEY, "com.google.ios.youtubemusic/8.10.5", {}),
]:
    try:
        print(f"\n== {cname} ==")
        d = call(
            f"https://www.youtube.com/youtubei/v1/player?key={key}&prettyPrint=false",
            {"context": {"client": {"clientName": cname, "clientVersion": cver, "hl": "en", "gl": "US", **extra}},
             "videoId": VID, "contentCheckOk": True, "racyCheckOk": True},
            ua,
        )
        summarize(cname, d)
    except Exception as e:
        print(f"[{cname}] FAIL: {str(e)[:100]}")

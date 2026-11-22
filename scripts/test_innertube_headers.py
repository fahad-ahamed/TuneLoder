#!/usr/bin/env python3
"""Test WEB client with X-Goog-Visitor-Id header + PO token combos."""
import json, urllib.request

VID = "VztFuJZ7d3s"
WEB_KEY = "AIzaSyAO_FJ2SlhyUg5NrbX5ERFxO4Z-vwFdxzM"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def get_po_token(context="gvs", binding=""):
    req = urllib.request.Request(
        "http://127.0.0.1:4416/get_pot",
        data=json.dumps({"context": context, "contentBinding": binding}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    return d.get("poToken", ""), d.get("contentBinding", "")

def call(key, body, ua, extra_headers=None):
    req = urllib.request.Request(
        f"https://www.youtube.com/youtubei/v1/player?key={key}&prettyPrint=false",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": ua,
                 "Origin": "https://www.youtube.com", "Referer": "https://www.youtube.com/",
                 **(extra_headers or {})}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def summarize(name, d):
    ps = d.get("playabilityStatus", {})
    vd = d.get("videoDetails", {})
    sd = d.get("streamingData", {})
    af = sd.get("adaptiveFormats", [])
    audio = [f for f in af if "audio" in f.get("mimeType", "")]
    print(f"[{name}] {ps.get('status','?')} | title={vd.get('title','')[:35]} | audio={len(audio)}")
    for f in audio[:4]:
        print(f"    itag={f.get('itag')} br={f.get('averageBitrate') or f.get('bitrate')} url={'YES' if f.get('url') else ('CIPHER' if f.get('signatureCipher') else '?')}")
    if audio and (audio[0].get("url") or audio[0].get("signatureCipher")):
        with open(f"/tmp/streams_{name}.json", "w") as fp:
            json.dump(sd, fp)
    return d

# Test: WEB + gvs PO token + visitor header
print("== WEB + gvs PO + X-Goog-Visitor-Id header ==")
pot, visitor = get_po_token("gvs")
d = call(WEB_KEY, {
    "context": {"client": {"clientName": "WEB", "clientVersion": "2.20261119.01.00",
                            "hl": "en", "gl": "US", "visitorData": visitor}},
    "videoId": VID, "contentCheckOk": True, "racyCheckOk": True,
    "serviceIntegrityDimensions": {"poToken": pot},
}, UA, {"X-Goog-Visitor-Id": visitor})
summarize("WEB-visitor-hdr", d)

# Test: WEB + player PO token + visitor header
print("\n== WEB + player PO + visitor header ==")
pot2, visitor2 = get_po_token("player")
d = call(WEB_KEY, {
    "context": {"client": {"clientName": "WEB", "clientVersion": "2.20261119.01.00",
                            "hl": "en", "gl": "US", "visitorData": visitor2}},
    "videoId": VID, "contentCheckOk": True, "racyCheckOk": True,
    "serviceIntegrityDimensions": {"poToken": pot2},
}, UA, {"X-Goog-Visitor-Id": visitor2})
summarize("WEB-player-pot", d)

# Test: TVHTML5 + PO + visitor
print("\n== TVHTML5 + gvs PO + visitor ==")
pot3, visitor3 = get_po_token("gvs")
d = call(WEB_KEY, {
    "context": {"client": {"clientName": "TVHTML5", "clientVersion": "7.20250312.10.00",
                            "hl": "en", "gl": "US", "visitorData": visitor3}},
    "videoId": VID, "contentCheckOk": True, "racyCheckOk": True,
    "serviceIntegrityDimensions": {"poToken": pot3},
}, UA, {"X-Goog-Visitor-Id": visitor3})
summarize("TVHTML5-pot", d)

# Test: MWEB + gvs PO + visitor
print("\n== MWEB + gvs PO + visitor ==")
pot4, visitor4 = get_po_token("gvs")
d = call(WEB_KEY, {
    "context": {"client": {"clientName": "MWEB", "clientVersion": "2.20261119.01.00",
                            "hl": "en", "gl": "US", "visitorData": visitor4}},
    "videoId": VID, "contentCheckOk": True, "racyCheckOk": True,
    "serviceIntegrityDimensions": {"poToken": pot4},
}, UA, {"X-Goog-Visitor-Id": visitor4})
summarize("MWEB-pot", d)

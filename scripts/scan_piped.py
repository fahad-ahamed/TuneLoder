#!/usr/bin/env python3
"""Parallel scan of Piped + Cobalt instances."""
import concurrent.futures, urllib.request, socket, json

VID = "VztFuJZ7d3s"
socket.setdefaulttimeout(12)

PIPED = [
    "pipedapi.kavin.rocks", "pipedapi.tokhmi.xyz", "api.piped.privacydev.net",
    "pipedapi.reallyaweso.me", "piped-api.lunar.icu", "pipedapi.leptons.xyz",
    "pipedapi.xiriathnoun.i2p", "pipedapi.orangenet.cc", "pipedapi.phoenixthrush.com",
    "pipedapi.ducks.party", "pipedapi.drgns.space", "api.piped.projectsegfau.lt",
    "pipedapi.nosebs.ru", "pipedapi.kozow.dev", "pipedapi.deepum.ca",
    "pipedapi.coomotor.com", "pipedapi.shortis.gq", "api.piped.privacydev.net",
    "pipedapi.the职能dev", "pipedapi.eBackend.tech", "pipedapi.15318.xyz",
    "pipedapi.borg-media.de", "piapi.ggtylr.dev",
]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

def check_piped(host):
    url = f"https://{host}/streams/{VID}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=14) as r:
            body = r.read(2048).decode("utf-8", "ignore")
            return host, r.status, body[:100].replace("\n", " ")
    except urllib.error.HTTPError as e:
        try:
            body = e.read(300).decode("utf-8", "ignore")
        except Exception:
            body = ""
        return host, e.code, body[:100].replace("\n", " ")
    except Exception:
        return host, 0, ""

with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    print("=== PIPED ===")
    for host, code, preview in ex.map(check_piped, PIPED):
        if code != 0:
            print(f"{code:5d} {host:35s} {preview[:70]}")

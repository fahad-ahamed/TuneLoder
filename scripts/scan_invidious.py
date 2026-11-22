#!/usr/bin/env python3
"""Parallel scan of all known Invidious instances for a working /api/v1/videos response."""
import concurrent.futures, urllib.request, ssl, socket

VID = "VztFuJZ7d3s"
INSTANCES = [
    "invidious.nerdvpn.de", "iv.ggtylr.dev", "invidious.flokinet.to",
    "inv.us.projectsegfau.lt", "invidious.privacyredirect.com", "iv.melmac.space",
    "invidious.materialio.us", "invidious.jing.rocks", "iv.datura.network",
    "invidious.lunivers.trade", "id.420129.xyz", "invidious.reallyaweso.me",
    "yt.artemislena.eu", "invidious.esmailelbcp.xyz", "vid.puffyan.us",
    "inv.vern.cc", "invidious.fdn.fr", "invidious.perennialte.ch",
    "yt.drgnz.club", "invidious.schenkel.eti.br", "iv.duti.dev",
    "invidious.adminleague.tech", "inv.us-netzwerg.de", "yt.fun4me.nl",
    "invidious.dhusch.de", "iv.catgirl.cloud", "inv.perditum.me",
    "yt.thechangebook.org", "iv.mrtopia.nl", "invidious.private.coffee",
    "invidious.leodic.net", "invidious.catspeed.cc", "yt.funami.tech",
    "invidious.darkness.services", "invidious.lilystream.de", "invidious.baczek.me",
    "invidious.fdn.fr", "yt.drgns.space", "inv.invidious.pt", "invidious.grke.one",
    "iv.duti.dev", "invidious.io", "yt.chocolatemoo53.com", "inv.nadeko.net",
    "invidious.tiekoetter.com", "iv.nboeck.de", "invidious.frostyyi.net",
    "invidious.privacydev.net", "invidious.beep2b.xyz", "yt.dluxlem.org",
]

socket.setdefaulttimeout(12)

def check(host):
    url = f"https://{host}/api/v1/videos/{VID}"
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=14) as r:
            body = r.read(4096).decode("utf-8", "ignore")
            code = r.status
        is_json = body.strip().startswith("{")
        audio = body.count('"audio/mp4"') + body.count('"audio/webm"')
        return host, code, is_json, audio, body[:80].replace("\n", " ")
    except urllib.error.HTTPError as e:
        return host, e.code, False, 0, ""
    except Exception:
        return host, 0, False, 0, ""

with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
    for host, code, is_json, audio, preview in ex.map(check, INSTANCES):
        if code != 0:
            mark = "  *** WORKING ***" if (is_json and audio > 0) else ("  [json!]" if is_json else "")
            print(f"{code:5d} {host:38s} audio:{audio}{mark}")

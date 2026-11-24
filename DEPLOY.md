# TuneLoad — AWS EC2 Ubuntu ডিপ্লয় গাইড (any VPS-এও একই নিয়ম)

BasicDeploy-এর মতো 250 MB RAM lock, forced reverse proxy, HTML injection — কিছুই নেই
আর। এই version টা plain Node.js app — যেকোনো VPS-এ full performance-এ চলে।

## ১. EC2 instance তৈরি

- **AMI:** Ubuntu 22.04 / 24.04 LTS (64-bit x86)
- **Instance type:** `t3.small` (2 GB RAM) বা `t3.medium` (4 GB) — 250 MB-র মতো কোনো
  limit নেই; যত RAM অর্ডার করবেন ততটাই engine পাবে। `t2.micro`/free-tier-এও চলবে
  (1 GB RAM — একসাথে ২-৩টা download ঠিকঠাক)।
- **Storage:** 16–30 GB gp3 (MP3 cache রাখার জায়গা; চাইলে `.env`-এ `AUDIO_CACHE_GB`
  দিয়ে cap বাড়ান/কমান)।
- **Security group:** inbound খুলুন — `TCP 22` (SSH, শুধু আপনার IP), `TCP 3000`
  (ওয়েবসাইট)। HTTPS নিলে `TCP 80` + `TCP 443`-ও।

## ২. এক কমান্ডে ইনস্টল (recommended)

```bash
# আপনার লোকাল মেশিন থেকে কোড আপলোড করুন (zip হলে):
scp TuneLoder-v0.3.0-VPS-clean-source.zip ubuntu@<EC2_PUBLIC_IP>:~ 
ssh ubuntu@<EC2_PUBLIC_IP>

# EC2-তে:
cd ~ && unzip TuneLoder-v0.3.0-VPS-clean-source.zip -d tuneload && cd tuneload
sudo bash scripts/setup-ubuntu.sh
```

`setup-ubuntu.sh` যা যা করে (সব automatic):

1. ffmpeg + python3-pip ইনস্টল
2. Node.js 22 (NodeSource LTS)
3. `yt-dlp` + `yt-dlp-ejs` (JS-challenge solver)
4. `.env` তৈরি — র‍্যান্ডম `ADMIN_PASSWORD` জেনারেট করে দেখায় (নোট করে নিন)
5. `npm install` + production build (standalone)
6. **systemd service** (`tuneload.service`) — boot-এ auto-start, crash হলে auto-restart
7. Status + পরবর্তী নির্দেশনা প্রিন্ট করে

শেষ হলে ওয়েবসাইট: `http://<EC2_PUBLIC_IP>:3000` — অ্যাডমিন: `/admin`।

## ৩. Telegram bot চালু

1. `/admin`-এ login (setup-এ পাওয়া password) → **Telegram bot**
2. @BotFather-এর token পেস্ট → **Connect bot**
3. Bot আলাদা process হিসেবে চলবে, supervisor একা রেখে দিলেও crash-এ auto-restart
   করবে — VPS reboot হলেও systemd + supervisor দুই লেভেলে সব আবার চালু করবে।

## ৪. দরকারি কমান্ড

| কাজ | কমান্ড |
|---|---|
| লাইভ লগ | `journalctl -u tuneload -f` |
| Restart | `sudo systemctl restart tuneload` |
| বট লগ | `tail -f data/tgbot.log` |
| নতুন version ডিপ্লয় | কোড আপলোড → `npm run build` → `sudo systemctl restart tuneload` |
| Engine বন্ধ/চালু | `sudo systemctl stop tuneload` / `start` |

## ৫. পোর্ট 80/443-এ সরাসরি দিতে চাইলে (ঐচ্ছিক)

```bash
# সহজ উপায়: .env-এ PORT=80 দিয়ে restart
echo "PORT=80" | sudo tee -a /home/ubuntu/tuneload/.env
sudo systemctl restart tuneload
```

HTTPS চাইলে Nginx/Caddy reverse proxy + Let's Encrypt (certbot) — সাধারণ VPS
পদ্ধতি; কোনো প্ল্যাটফর্ম-নির্দিষ্ট কিছু লাগে না।

## ৬. YouTube datacenter-IP নোট

AWS-এর IP থেকে YouTube মাঝে মাঝে "Sign in to confirm you're not a bot" বলে।
সমাধান ৩০ সেকেন্ডের: ব্রাউজারে YouTube-এ login → cookies.txt export →
`/admin → Cookie sets`-এ পেস্ট। Engine auto-switch বাকিটা সামলায়।

## ৭. Fresh git history (ঐচ্ছিক)

`.gitignore` অন্তর্ভুক্ত — পুরনো কোনো history নেই। নতুন repo হিসেবে শুরু করতে:

```bash
git init && git add -A && git commit -m "TuneLoad v0.3.0 — VPS edition"
git remote add origin <your-repo-url> && git push -u origin main
```

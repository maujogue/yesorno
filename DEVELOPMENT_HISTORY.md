# yesorno.site — how we built it

A duck that answers your question with **YES** or **NO**. Built in one day (2026-11-19) across
nine T3 Code threads. This file walks through it in order, from the idea to the live site, including the
dead ends. Times are UTC; the machines and git commits run on CET (UTC+1).

Live: https://yesorno.site · Repo: https://github.com/maujogue/yesorno (public, branch `main`)

---

## 1. The idea (08:57–09:18)

- **Pitch:** a free, non-technical "crystal ball" for parties and everyday choices. You ask, it says
  yes or no, and it never explains. Working title: "should I".
- **Product rules set on day one:**
  - strictly yes or no, never "it depends"
  - the same question always gets the same answer (cache)
  - voice input
  - a third, non-negotiable **SERIOUS** route for self-harm, medical and crisis questions, which shows
    a helpline (findahelpline.com) instead of an answer
  - short input cap
  - a share link as the way to grow
- **Name:** "Yes or No", chosen over clever options (Orbi, Because I Said So…) because it's explicit.
- **Domain:** `yesorno.site` over `yes-or-no.site`, since nobody says "dash" and hyphens are awkward on
  phones. Bought on Namecheap.

## 2. First build: crystal ball + Gemini (09:18–09:31)

- Stack chosen by the user: Google's `gemini-decision-1`, plain HTML, self-hosted on the homelab behind a
  Cloudflare Tunnel.
- First version:
  - `public/index.html`: glowing ball, voice, share, sound
  - `server.js`: zero-dependency Node; the key stays server-side
  - per-IP rate limit and an answer cache
- **Dead end:** the first call treated `gemini-decision-1` as a chat model (`generateContent`), so it
  looked like the model didn't exist. The user pasted a working curl call. The right endpoint is
  `POST /v1beta/decisions`, which takes typed `questions` (`noul` = yes/no score, `choice` + `criteria`).
- One call now asks two things: a `serious` score (threshold 0.5) and a yes/no verdict "like a wise,
  practical friend". About 210 tokens per call.

## 3. Redesign: the duck (09:31–09:42)

- The user called the first design "terribly AI" and asked for something very simple with personality,
  in the hand-drawn style of the YouTube channel @monkebiznis, with a cute duck.
- Result:
  - cream paper background, wobbly "boiling" black outlines, flat pastel fills
  - an original duck with a state for each answer: idle bob, thinking sweat, YES hop, NO head-shake,
    SERIOUS worried
  - green background for YES, peach for NO
  - deadpan lowercase copy
- **Font:** Gluten was dropped because its m and u looked broken. **Sniglet** (Google Fonts) stayed.

## 4. Voice in, then out (09:42–10:38)

- `gemini-decision-1` accepts audio input (`{type:"audio", mime_type, data:<base64>}`) and detects the
  language. The page switched from the browser's speech recognition to **MediaRecorder**:
  - recording stops after about 1.2 s of silence or 10 s at most
  - uploads are capped at 1.5 MB
- **Voice output** was tried with Gemini TTS pre-generated clips. Problems:
  - it read stage directions aloud
  - the free tier allowed 3 requests per minute, plus a hidden daily cap
  
  Then the user ruled: **"it's a duck, it's not speaking."** All voices were deleted and replaced with
  quacks synthesized in the browser with Web Audio:
  - YES: two bright quacks
  - NO: one low, grumpy quack
  - SERIOUS: silent
- **Cost and speech-to-text research** compared Gemini Transcribe, Live Translate, Groq, Deepgram and
  others. Live Translate was rejected: it's a preview model, it's expensive and it gives no transcript.
  The user picked **Cloudflare Workers AI Whisper** for transcripts and **`clef-flash`** (Workers AI) as
  the fallback decision model when Gemini is rate limited.
- The fallback runs on 429, 5xx, timeouts and network errors. Gemini threw real "high demand" errors
  during testing, and `clef-flash` took over.

## 5. Languages and UI polish (10:27–10:45)

- **Languages:** EN, FR, ES, DE.
  - The site switches automatically to the language of the question.
  - Flag buttons sit at the bottom.
  - The first visit follows the browser language.
- **Input:** a full-width textarea that grows (Enter submits), with the ask button under it. After an
  answer the button becomes "ask again", which clears the box and opens the phone keyboard.
- **Title:** must fit on one line in every language. It shrinks to fit, measured with left alignment
  because centered text reports overflow wrongly.
- Removed: the subtitle, the duplicate "ask again" button and the visible transcript line (the
  transcript fills the input box instead).
- **Answer dictionary:** saved to `data/answers.json` with up to `CACHE_MAX` entries. The key ignores
  case, accents, spaces and punctuation.
- **Questions in the URL:**
  - `yesorno.site/should-i-go-to-the-gym` asks on load.
  - `/`, `.`, `-`, `_` and `+` all count as spaces, and a question with no spaces at all works too.
  - The address bar is rewritten to a clean hyphenated link.
  - Bot probes (`.php`, `/wp-`, `/.env`…) get a 404.

## 6. Domain and Cloudflare (10:59–11:05)

- The domain stays registered at Namecheap. Its nameservers point to Cloudflare
  (`algin` / `shubhi.ns.cloudflare.com`), which is all a tunnel needs. Transferring it to Cloudflare
  Registrar is optional: it means cheaper renewals, and it's only possible 60 days after purchase.

## 7. First deploy to Dokploy (10:51–12:12)

The hard part of the day.

- **Zip "drop" deploy:** `application.dropDeployment` returned a 500 every time. Abandoned.
- **Image pull failed** because of a DNS lookup error.
  - Cause: Tailscale's `accept-dns` on the Proxmox host leaked into the containers' DNS settings when
    they booted.
  - Fix: turn off `accept-dns` on the host, then reboot the containers.
- Another container had changed IP through DHCP. Updated in Dokploy, and DHCP reservations were
  recommended.
- **Where it runs:** on the Dokploy container itself, not another project's container and not a new
  one. An app's server can't be changed after creation, so the app was deleted and recreated.
- **Temporary setup:** a stock `node:22-alpine` image with the three code files pasted in as Dokploy
  file mounts, plus the `yesorno-data` volume on `/app/data`.
- **Swarm ingress hung** in the container, so the port was switched to host mode `8787`. That needed
  `docker service rm` plus a redeploy, because the rolling update couldn't take over the port.
- **Routing**, matching the user's house convention: Cloudflare tunnel → Caddy (in its own
  container) → the app's port on the Dokploy container. The Caddy block was added and Let's Encrypt issued a
  certificate (DNS-01 challenge through Cloudflare).
- **502 `tls: internal error`:** the tunnel route was missing **Origin Server Name = yesorno.site**. The
  user set it in the dashboard.
- The site was then live. The Mac kept showing the Namecheap parking page because of its local DNS
  cache, so a cache flush was needed.

## 8. Code review, SQLite, GitHub, auto-deploy (12:11–13:14)

- **`/code-review` found 10 issues.** Among them:
  - a malformed URL crashed the process
  - a spoofable `cf-connecting-ip` header let anyone bypass the rate limit
  - identical questions racing each other each made their own model call
  - voice questions called the model before checking the cache
  - one generic error message for every failure
  - a double mic start
  - a weak path-traversal check
  - no persistent volume
  - a blocking JSON save
- **Fixes:**
  - The cache moved to built-in **`node:sqlite`** (`data/answers.db`; the first answer stored wins).
    Requires Node ≥ 22.13, so the image is now `node:24-alpine`.
  - Simultaneous identical questions share one model call.
  - The old JSON file is imported once.
  - Voice now waits for the transcript and checks the dictionary before calling the model.
  - Errors carry a `code` that the page translates.
- **Rate limit removed** entirely, by user choice. Cloudflare edge rate limiting is the option if it's
  ever needed.
- **GitHub:** `git init`, the branch renamed to `main`, pushed over HTTPS with the `gh` login (there's
  no SSH key).
- **Dokploy switched to GitHub + Dockerfile build + autoDeploy.** File mounts and the command override
  were removed; the volume was kept.
- **Volume ownership:** the old root-run container left `/app/data` root-owned. The Dockerfile now
  `chown`s it and drops to the `node` user with `su-exec`.
- **Webhook never arrived** until the Dokploy dashboard got a public address through the tunnel. The empty commit `7071182` proved push → deploy works.
- **Layout:** the duck block is centered vertically. Screenshots came from Playwright Chromium installed
  in the scratchpad; T3's html_preview can't render full-height pages.
- Removed the "you already asked" message.
- Added the T3 project script **"Run locally"** (`npm start`).

## 9. Share button, tickling, open questions, mic (13:26–15:00)

- **Share button:**
  - It said "screenshot it instead!" because the clipboard API needs HTTPS. Now there's an
    `execCommand` fallback, and the button animates to "✓ copied".
  - Then it was relabelled "share answer", turns light blue, and stays for 4 s.
- **HTTPS only:** the tunnel doesn't force it. The user turned on Cloudflare **Always Use HTTPS**, and
  the server-side redirect we had added was removed again.
- **`npm start`** now runs `scripts/start.sh`, which stops a stale Node server on the port first
  (`EADDRINUSE` fix).
- **New features:**
  - **Stand-up mic:** an SVG vintage mic next to the duck replaces the small mic button.
  - **Duck tickling:** tap the duck and it giggles. One tap in four, it gets annoyed and says one of 12
    native-language brush-offs.
  - **OPEN answer:** a second `noul` score catches what-, which- and either-or questions. The duck says
    "yes or no questions only."
  - Sound toggle as a speaker icon.
- **Language priority:** `?lang=` in the URL, then a flag tapped earlier, then the browser language,
  then English. Only a tapped flag is remembered.
- **Share** now copies only the link, which carries `?lang=`. Commits `1113067` and `2ddb831`.

## 10. Faster voice: ElevenLabs Scribe v2 (17:15–17:53)

- Voice took 4–12 s because of Whisper, and Whisper also got words wrong. Benchmarked Cloudflare's
  speech-to-text models; Deepgram nova-3 was the fastest of those.
- The user dropped Cloudflare speech-to-text altogether for **ElevenLabs Scribe v2**: 0.6–1 s and
  accurate in all four languages.
- Gemini now decides on the transcript text, with the audio as the fallback.
- The key was added to Dokploy with a script that never prints secret values. Commit `7bfe5c5`,
  auto-deployed.

## 11. Stats, analytics, privacy (17:53–18:33)

- **Traffic:** the free Cloudflare dashboard already shows it. Cloudflare Web Analytics (cookieless) was
  suggested.
- **`asks` table:** one row per ask for stats, with no IP or user agent. Commit `a021b78`. No stats page
  yet.
- **Privacy:** the app does store question text and logs every ask, so "nothing is stored" would be
  false. A draft notice was written with the key line "don't type anything private". Nothing was added
  to the site yet.

## 12. Zero-downtime deploys (18:04–18:12)

- Dokploy's Traefik had never existed on this server: "Reload" did nothing and "Enable dashboard"
  failed. It was created by hand with `docker run … traefik:v3.5.0` and attached to
  `dokploy-network`.
- **Traefik → app gave fast 502s** because the Swarm VIP doesn't work inside the container. Fix: the service
  endpoint mode is now **`dnsrr`**.
- Added the domain `yesorno.site` in Dokploy (port 8787) and a wget health check.
- Caddy now points to Traefik on port 80. The published port 8787 was removed, and the update
  order is **start-first** with rollback on failure.
- Verified: 120 of 120 requests returned 200 during a redeploy, twice.

---

## Where it ended up

```
browser → Cloudflare (Always Use HTTPS) → Cloudflare tunnel → Caddy :443
        → Dokploy's Traefik :80 → Swarm service :8787 (dnsrr)
        → server.js → Gemini decisions (fallback: Cloudflare clef-flash) / ElevenLabs Scribe v2
                    → SQLite on volume yesorno-data (/app/data/answers.db)
```

Push to `main` → Dokploy webhook → Dockerfile build (about 25 s) → start-first rollout, no downtime.

## Open items

- Add the privacy notice, plus a publisher/contact line (French LCEN rule).
- No stats page yet; the `asks` table is ready for one.
- Cloudflare Web Analytics and HSTS: suggested; the threads don't say whether they were turned on.
- DHCP reservations for the homelab containers.
- The open-question filter, the quacks and recording were never tested in a real browser with the real
  model.
- Existing dictionary rows keep their old answers: questions cached before OPEN existed can't become
  OPEN unless their rows are deleted.

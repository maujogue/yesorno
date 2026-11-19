---
name: yesorno
description: Everything needed to work on yesorno.site (the duck that answers YES / NO) without re-reading the repo - what it is, the code layout, the AI and speech services and their API formats, env vars, the SQLite data, how to run locally, how deploys work (GitHub push → Dokploy → Traefik → Caddy → Cloudflare tunnel), and the mistakes already made. Use for any change, deploy, debugging or stats question about yesorno, the duck, server.js, public/index.html, or the yesorno.site domain.
---

> Hosts, IPs, Dokploy IDs, ssh access and ops commands are kept out of this public repo, in the
> user-level skill **`yesorno-infra`** (`~/.claude/skills/yesorno-infra/SKILL.md`). Load it for any
> deploy, production check or server work.

# yesorno.site

A free toy site: you ask a question, a hand-drawn duck answers **YES** or **NO**, without explaining.
Typed or spoken questions in EN, FR, ES and DE. The same question always gets the same answer.
Live at https://yesorno.site. Repo `maujogue/yesorno` (public, branch `main`). Full build story:
`DEVELOPMENT_HISTORY.md`.

## Product rules (don't break these)

- **Answers.** Every answer is one of:
  - `YES` or `NO`
  - `SERIOUS`: self-harm, harming others, medication changes, abuse or a crisis. The page shows a
    helpline (findahelpline.com) and never a yes or no.
  - `OPEN`: questions a yes or no can't answer. The duck says "yes or no questions only."
- **No explanations**, ever.
- **Determinism.** A question already in the dictionary is answered from SQLite, and the first stored
  answer wins.
- **The duck doesn't talk.** Sound is synthesized quacks only (Web Audio): two bright quacks for YES, one
  grumpy quack for NO, nothing for SERIOUS. Don't add TTS.
- **Style.** Hand-drawn and simple (wobbly black outlines, cream paper, pastel fills, Sniglet font).
  Copy is lowercase and deadpan. The user hates "AI-looking" design.
- **Languages.** Every UI string exists in **all four languages** (`I18N` in `public/index.html`).
  Use native idioms, not literal translations.
- **Typography.** French strings use a narrow no-break space (U+202F) before `?` and `!`. Edits that
  type a normal space or ` ` won't match. The title must fit on one line in every language.
- **Mobile first.** Hyphens are hard to type on phones, so URL questions accept `/`, `.`, `-`, `_`,
  `+` or no separators at all.
- **No dependencies.** Plain Node with no npm packages, and plain HTML with no framework or build step.
  Keep it that way.

## Code layout

| File | What it is |
|---|---|
| `server.js` | All of the backend (~450 lines): `node:http`, `node:sqlite`, static files, `POST /api/ask` |
| `public/index.html` | All of the frontend (~930 lines): HTML, CSS, JS, `I18N`, duck SVG, mic, quacks, share |
| `scripts/start.sh` | `npm start`: kills a stale *node* listener on `PORT`, then `node --env-file=.env server.js` |
| `Dockerfile` | `node:24-alpine`, `HOST=0.0.0.0 PORT=8787 DB_FILE=/app/data/answers.db`, chown + `su-exec node` |
| `.env` / `.env.example` | Local secrets (gitignored) / placeholder template |
| `data/` | Local SQLite DB (gitignored). Production uses its own volume. |

### `POST /api/ask`

**Request.** JSON `{question, from?}`, where `from: "link"` means the question came from the URL.
A raw audio body works too (`audio/webm|ogg|mp4|mpeg|wav|aac`, at most 1.5 MB).

**Response.** `{answer, lang, again?, transcript?}`, or an error `{error, code}`. The page translates
errors from `code`:
- `idle`: empty question
- `tooLong`: more than 200 characters, or audio too big
- `nothing`: no audio
- `confused`: model failure or bad format

**Flow:**
1. `questionKey()` normalizes the text: NFKD, no accents, lowercase, ß → ss, letters and digits only.
2. A dictionary hit returns `again: true` with no model call.
3. Otherwise `answerOnce()` shares one in-flight call among identical simultaneous questions.
4. `decide()` asks Gemini and falls back to `clef-flash` on 429, 5xx, timeouts or network errors.
5. Voice: transcribe with ElevenLabs first, check the dictionary, then decide on the **text**. If there's
   no transcript, Gemini decides on the audio itself, and nothing is cached.

**Every reply goes through `reply()`**, which logs a row to `asks`. Keep that invariant when you add
branches.

**Other routes.** Any other non-file path serves `index.html`, which reads the question from the path.
File-like or scanner paths (`FILE_LIKE`), `/api/*` and paths over 600 characters get a 404.

### Frontend notes

- **Language priority:** `?lang=` in the URL, then a flag tapped earlier (`localStorage` key
  `yesorno-lang`), then the browser language, then `en`. Only a tapped flag is saved.
- **Share** copies only the link, `/<hyphenated-ascii-slug>?lang=xx`. On touch devices it uses
  `navigator.share`. If the copy fails it falls back to `execCommand`, then to a prompt.
- **Recording** stops after about 1.2 s of silence or 10 s. "Thinking" shows for at least 1.6 s.
- **Tapping the duck** tickles it: it giggles, and one tap in four it gets annoyed and says one of 12
  native brush-off lines per language.
- **`hidden` vs CSS display.** A global `[hidden]{display:none !important}` exists because
  `.share { display:inline-grid }` would otherwise beat `hidden`.
- **Browsers block audio until the visitor taps**, so a question asked from the URL animates without
  quacking. That's expected.

## External services

| Service | Use | Endpoint and format | Env |
|---|---|---|---|
| Google Gemini | Main decision model | `POST https://generativelanguage.googleapis.com/v1beta/decisions`, header `x-goog-api-key`, body `{model, input:[{type:"text",text}\|{type:"audio",mime_type,data}], questions}`, reply `answers` | `GEMINI_API_KEY` (required, or the server exits), `GEMINI_MODEL` (default `gemini-decision-1`) |
| Cloudflare Workers AI | Fallback decision model, text only | `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef-flash`, Bearer token, body `{model, state:text, questions}`, reply `result.answers` | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_FALLBACK_MODEL` (`clef-flash` or `clef`) |
| ElevenLabs Scribe v2 | Speech-to-text, ~1 s | `POST https://api.elevenlabs.io/v1/speech-to-text`, header `xi-api-key`, multipart `model_id=scribe_v2`, `tag_audio_events=false`, `file`, reply `text` | `ELEVENLABS_API_KEY`, `STT_MODEL` |
| Google Fonts | Sniglet | stylesheet link | none |
| Cloudflare zone | DNS, tunnel, Always Use HTTPS, analytics | dashboard (the user's account; agents have no access) | none |

**`DECISION_QUESTIONS`** (in `server.js`) is one call with four questions:
- `serious` (`noul` score, threshold 0.5)
- `open` (`noul` score, threshold 0.5)
- `verdict` (`choice`: yes or no)
- `lang` (`choice`: en, fr, es, de or other)

`lang` must stay in sync with `I18N` in the page.

**`gemini-decision-1` is not a chat model.** It doesn't appear in model lists and fails on
`generateContent`. Only `/v1beta/decisions` works.

**Other env vars:** `PORT` (8787), `HOST` (defaults to `127.0.0.1`; Docker sets `0.0.0.0`), `DB_FILE`,
`CACHE_MAX` (100 000). Retired, ignore if still in `.env`: `RATE_LIMIT_PER_MIN`, `TRUST_CF_IP`,
`CF_STT_MODEL`, `TTS_MODEL`.

## Data (SQLite, `node:sqlite`, Node ≥ 22.13)

- **`answers`**: `id, key UNIQUE, answer, lang, q, at`. This is the dictionary. When it passes
  `CACHE_MAX` rows, the oldest are trimmed. Rows cached before a rule existed keep their old answer;
  delete them to have them re-evaluated.
- **`asks`**: `id, at, via (typed|link|voice), lang, answer (YES/NO/OPEN/SERIOUS or an error code),
  cached, ms, key`. One row per request. It stores **no IP or user agent**, and it must stay that way.
  `asks.key` joins `answers.key`.
- **Database settings:** WAL mode with `busy_timeout`. During start-first deploys, two containers
  briefly share the file, which is fine.
- **Legacy import:** `data/answers.json` is imported once, only if the table is empty.
- **Production DB:** `/app/data/answers.db` on the Docker volume `yesorno-data`.

Stats examples:

```sql
SELECT date(at), count(*) FROM asks GROUP BY 1;
SELECT via, answer, count(*) FROM asks GROUP BY 1, 2;
SELECT a.q, count(*) n FROM asks s JOIN answers a USING(key) GROUP BY 1 ORDER BY n DESC LIMIT 20;
```

## Run locally

- **Start:** `npm start`, or the T3 project script **"Run locally"**. The app is at
  http://127.0.0.1:8787. HTML is read from disk on every request, so a page reload picks up frontend
  changes. Server changes need a restart.
- **Throwaway servers.** For UI tests that shouldn't touch real data or spend API money, use a
  throwaway server:

  ```
  GEMINI_API_KEY=dummy DB_FILE=<scratch>/t.db PORT=381xx node server.js
  ```

  The variable is `DB_FILE`, not `DB_PATH`. Real-key tests also go to a scratch DB.
- **Checks:**
  - There's no test suite. Check syntax with `node --check server.js`, or extract the page's
    `<script>` and run `node --check` on it.
  - There's no Chrome or Docker on the Mac. For screenshots, install Playwright Chromium into the
    scratchpad (`PLAYWRIGHT_BROWSERS_PATH`) and serve the page over HTTP. Don't use `file://`: the page
    reads the path as a question.
  - T3's `html_preview` can't render this full-height page.
  - Match the user's window size and zoom when comparing layouts.
- **Test clips for STT:** macOS `say -v <Samantha|Thomas|Anna|Paulina>`, then
  `afconvert -f WAVE -d LEI16@16000`. Synthetic voices are not a real-world accuracy test.

## Deploy

**Pushing to `main` deploys to production.** Always ask the user before committing or pushing, and show
visual changes, with screenshots, before pushing.

1. `git status`. Grep the diff for keys. Never commit `.env`, `data/` or secrets: the repo is public.
   Commits end with the org's `Co-Authored-By` trailer.
2. `git push origin main`. This goes over HTTPS with the `gh` login; there's no SSH key.
3. The GitHub App webhook triggers Dokploy, which builds the `Dockerfile` (~25 s) and rolls out
   start-first. The health check is `wget -q -O /dev/null http://127.0.0.1:8787/`, and a failed
   rollout rolls back.
4. **Verify:**
   - Poll `deployment-all` (applicationId in `yesorno-infra`) until the newest deployment's
     `description` contains the commit hash and its status is `done`. The first poll often shows the
     previous deployment.
   - Foreground `sleep` is blocked, so poll in a script loop.
   - Check `application-readLogs` for
     `yesorno on http://0.0.0.0:8787 (model: gemini-decision-1, fallback: clef-flash, stt: scribe_v2)`
     and `N known answers in /app/data/answers.db`. If `since` returns nothing, call it without
     `since`. If it errors, use `deployment-readLogs`.
   - `curl -s -o /dev/null -w '%{http_code}' https://yesorno.site/`.
   - **Don't send real questions to production to test.** They spend API money and get written into
     the dictionary.
5. **Manual deploy:** Dokploy MCP `application-deploy` (applicationId in `yesorno-infra`).

**Production env vars:** follow the procedure in `yesorno-infra`. Get values with `request_secret`,
never in chat. Dokploy REST `.one` calls return secrets unredacted, so never print their output. Also
add a placeholder to `.env.example`.

## Infrastructure (overview)

```
browser → Cloudflare (Always Use HTTPS) → Cloudflare tunnel → Caddy (TLS)
  → Dokploy's Traefik → Docker Swarm service :8787 (dnsrr) → server.js → SQLite volume
```

Self-hosted on a homelab: Proxmox containers, with Dokploy deploying from GitHub. Hosts, IPs, IDs,
ssh access, Caddy and log commands are in the private `yesorno-infra` skill.

## Mistakes already made (don't repeat them)

**Models and APIs**
- Calling `gemini-decision-1` through `generateContent`. It only works on `/decisions`.
- Feeding `clef-flash` text without spaces: it answered YES to `should.i.text.my.ex`. Turn separators
  into spaces before any model call.
- Cloudflare Whisper and other Cloudflare speech-to-text models: slow (4–12 s) and inaccurate. The user
  rejected them. Don't bring them back.
- Gemini TTS: it read stage directions aloud and hit hidden daily quotas. Voices were removed for good.

**Shell and editing**
- zsh: `$M:generateContent` is a variable modifier, so write `${M}`. Quote URLs with `?`; globs that
  match nothing fail with "no matches found".
- Multi-line `sed` edits on the page failed. Use a Python replace that asserts `count(old)==1`, and
  watch for global replaces that hit the helper you just inserted.

**Dokploy and Swarm**
- `application.dropDeployment` (zip upload) always returns a 500.
- An app's server can't be changed after creation.
- A host-mode published port combined with start-first leaves the new task Pending ("port already in
  use"). The service now has no published ports. Swarm ingress and VIP don't work on this host, which
  is why the service uses `dnsrr`.
- A volume created by a root-run container needs the `chown` in the Dockerfile `CMD`. Keep it.
- More infra pitfalls (Traefik, DNS, restarts) are in `yesorno-infra`.

**Cloudflare and HTTPS**
- The Cloudflare tunnel does **not** force HTTPS. "Always Use HTTPS" (Edge Certificates) does. The
  tunnel's origin TLS dialog is the wrong place. The user prefers Cloudflare settings over app code for
  this, so the server has no redirect and no HSTS.
- `navigator.clipboard` needs HTTPS or localhost. Keep the `execCommand` fallback.

**Privacy**
- Saying "nothing is stored": wrong. Question text and ask logs are stored, and questions go to
  Google, Cloudflare and ElevenLabs. A privacy notice is still to do.

## How the user works

- **Requests:** short, terse, often several changes in one message, often with screenshots. Do all of
  them.
- **Iteration:** fast UI iteration. They want to *see* visual changes before a push.
- **Pushes:** they approve each push explicitly ("go ahead", "push them"). Always ask first.
- **Infra:** they prefer that the agent acts on infra directly over ssh and the Dokploy MCP. They handle
  the Cloudflare dashboard and Namecheap themselves.
- **Before deciding:** they want options with cost and speed compared, then they pick the provider.
- **Copy:** playful, irreverent, with easter eggs.
- **Secrets:** always through `request_secret`, never in chat, files or commits.

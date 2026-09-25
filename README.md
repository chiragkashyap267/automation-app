# JD Mailer

Paste job descriptions — as screenshots, as text, or both, several at a time — and get a tailored
application email written for each one from your resume. Review, edit, tap send. The mail goes out
from your own Gmail.

Built mobile-first: paste a screenshot, thumb through the drafts, send.

---

## Setup (5 minutes)

### 1. Install

```bash
npm install
```

### 2. Get AI keys

The app runs in two stages, and they have different needs:

| Stage | What it does | Needs vision? | Providers |
|---|---|---|---|
| **Read a screenshot** | image → job facts | yes | Gemini (free) or Claude (paid) — or on-device OCR |
| **Read pasted text** | text → job facts | no | Groq (free), Gemini, or Claude |
| **Write** | job facts → the email | no | Groq (free), Claude, or Gemini |

Vision reader: Claude if `ANTHROPIC_API_KEY` is set, else Gemini.
Text reader: the vision reader if there is one, else Groq.
Writer: Groq if set, else Claude, else Gemini.

**A Groq-only setup works.** Pasted job descriptions go end to end through Groq. Screenshots are
the one thing it cannot see — switch to **Local first** and they are read on your device with OCR
instead, or add a free Gemini key for them.

| Provider | Free | Get a key |
|---|---|---|
| **Gemini** | yes, ~250 req/day | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Groq** | yes, fast | [console.groq.com/keys](https://console.groq.com/keys) |
| **Claude** | no, ~$0.01–0.02/job | [console.anthropic.com](https://console.anthropic.com/settings/keys) |

Adding a Groq key is worth it even though Gemini can write: Groq is faster, and it
is a **separate quota**, so reading and writing stop competing for the same limit.

Copy the template and fill in what you have:

```bash
cp .env.example .env.local
```

#### Using several keys per provider

Both free providers have numbered slots — `GEMINI_API_KEY_1` … `_11` and
`GROQ_API_KEY_1` … `_3`. Fill as many as you have; empty slots are ignored and the
same key in two slots is counted once.

Keys are used **round-robin**, so load spreads evenly instead of burning through slot 1.
When a key fails, [lib/llm/keyPool.ts](lib/llm/keyPool.ts) benches it and the request
retries on the next key immediately — one request still returns one result, it just
quietly took a different key. How long a key stays benched depends on why it failed:

| Failure | Benched for |
|---|---|
| Per-minute rate limit (429) | 65s, or the provider's own `retryDelay` |
| Daily quota exhausted | 6 hours |
| Invalid or revoked key | 24 hours |
| Provider 5xx | 15s |

A 400 about the prompt or schema is **not** treated as a key problem — it fails once
instead of burning every key on an error that would repeat identically.

The header shows live pool health for both providers. Each has its own pool, so a
spent Gemini quota never benches a Groq key.

Note that Google's terms prohibit using multiple accounts to exceed free-tier quotas.

### 3. Get a Gmail App Password

This is what actually sends the mail. It is **not** your Gmail password.

1. Turn on 2-Step Verification: [myaccount.google.com/security](https://myaccount.google.com/security)
2. Create an App Password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Copy the 16 characters — you will paste it into the app's **Details** screen, not into a file.

An App Password can only send mail. You can revoke it any time from that same page.

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>, go to **⚙ Details**, and fill it in once: your name, contact info,
resume text, and the Gmail App Password. That is the whole setup.

---

## Using it on your phone

While `npm run dev` is running, find your PC's local IP (`ipconfig` on Windows, look for IPv4) and
open `http://<that-ip>:3000` on your phone. Both devices need to be on the same Wi-Fi.

For a permanent URL, deploy (below).

---

## How a run goes

1. **Add the jobs.** Paste a screenshot anywhere on the page, tap **🖼 Screenshots** to pick several
   from your gallery, or paste the job text and tap **Add text**. Add as many as you like.
2. **Group multi-page posts.** Each thing you add becomes its own job by default. If two screenshots
   are the top and bottom of the *same* posting, tap **Merge ↑** on the second one. (The reverse also
   works: if one pasted block contains three postings, the model splits it into three.)
3. **Pick a mode** (see below), then tap **Write N emails**.
4. **Preview all.** The bottom bar goes to a review screen showing every email exactly as it will be
   sent — recipient, subject, body, signature, attachment. Untick any you want to skip, and tap
   **✎ Edit this email** on any one to fix it, then **Save**.
5. **Send all.** One tap fires the whole batch, one at a time with a short gap, each with your resume
   attached and your links in the signature. Progress and failures are shown per email.

---

## Doing the work locally

Three modes, on the main screen:

| Mode | Reads with | Writes with | API calls |
|---|---|---|---|
| **Auto** | AI | AI, or a saved recipe | fewest that still guarantee a good result |
| **Local first** | on-device OCR, AI if OCR is unclear | recipe, AI if none matches | only when local fails |
| **Local only** | on-device OCR / text rules | recipe only | none, ever |

Three things make this work:

**On-device OCR.** [lib/ocr.ts](lib/ocr.ts) runs Tesseract as WebAssembly in the browser. A clean
screenshot is turned into text without an API call. It is lazily loaded — nothing downloads until the
first time you use a local mode — and OCR output is only trusted when Tesseract is confident
(≥72%) and produced enough text. A blurry or dark-mode screenshot scores badly and falls back to the
vision model rather than feeding it garbage.

**The recipe layer.** [lib/recipes.ts](lib/recipes.ts) remembers the shape of every email the model
writes, with the company, role, location and contact swapped out for slots. Postings are grouped into
families by role type, tech stack and seniority — so once one "mid-level React frontend" email has
been written, the next one in that family is rendered locally and instantly. Recipes refresh whenever
the model writes a new email for that family, and **Rewrite** on any draft forces a fresh AI version.

**The input cache.** Re-processing the exact same screenshot or text costs nothing — the extracted
facts are cached against a hash of the input for 30 days.

The line under the button reports what each run actually cost, e.g.
`6 drafted · read on device · 4 from cache or recipe · 2 API calls`.

Local modes are fast and free, but they guess more. That is what the preview screen is for — nothing
sends until you have looked at it.

---

## Recipes that learn from you

A recipe is not frozen when the model writes it — it is rewritten by what you actually send.

- Send an email **unchanged** and the recipe's clean streak grows.
- **Edit it before sending** and your wording replaces the template. The next posting in that family
  starts from your version, not the model's.
- **Three clean sends in a row** and the recipe is marked **settled** — it has stopped needing
  corrections.

The comparison is a word-level diff ([`editRatio`](lib/recipes.ts)), so reflowing a line does not
count as an edit; rewriting a paragraph does.

Open **Recipes** from the header to see every one: how often it has been used, how many of its
emails went out untouched, how much you rewrote last time, progress towards settled, and the
template itself. You can forget any single recipe or reset them all.

---

## Validation before anything sends

Every draft is checked as you look at it, in [lib/validate.ts](lib/validate.ts).

**Errors block Send all.** These are the ones that would embarrass you:

- no recipient, empty subject or body
- a leftover `[Company]` placeholder or an unfilled `{{slot}}`
- **a link that is not yours** — any URL whose host is not one of your fixed links is treated as
  invented and blocked

**Warnings are advisory** and most can be repaired in one tap with **Fix N**:

- misspellings from a curated list (`recieve`, `oppurtunity`, `definately`, …)
- lower-case technology names (`javascript` → `JavaScript`, `github` → `GitHub`) — never inside a
  URL or address
- doubled words, excluding grammatical ones like "had had"
- a space before punctuation, `!!`, a sentence starting lower case, unbalanced brackets
- "Hiring Team" when the posting actually named someone
- the email never mentioning the company; a subject too long for mobile; a body too thin or too long

---

## Fixed details and the signature

**Details → Fixed details** holds the things that must be identical in every email: your name,
designation, email, phone, LinkedIn, GitHub and portfolio. They are still ordinary variables —
change one and every unsent draft updates — but they are the only links validation will allow
through, and the section shows a live preview of the signature they produce.

The model is told **not** to write a sign-off. [lib/signature.ts](lib/signature.ts) appends one
built from your Details: sign-off, name, phone, email, and your LinkedIn, GitHub and portfolio links
(bare domains get `https://` added). If the model writes one anyway, it is stripped first, so you
never get two.

This means editing your links in Details updates every unsent draft immediately, with no regeneration.

---

## Deploying to Vercel

```bash
git init && git add -A && git commit -m "JD Mailer"
npm i -g vercel
vercel
```

Then in the Vercel dashboard, **Settings → Environment Variables**, add the keys you filled into
`.env.local` — `GEMINI_API_KEY_1`, `GROQ_API_KEY_1`, and any further numbered slots — and redeploy.
`.env.local` is gitignored, so nothing is uploaded with the code.

The free Hobby tier is enough. Your Gmail App Password is **not** an environment variable: it lives
in your browser and is posted only for the moment a send or a reply check is in flight.

### What to know before you deploy

- **Request bodies cap at 4.5 MB.** Screenshots are downscaled and quality-stepped in the browser to
  stay at or under ~320 KB each ([lib/image.ts](lib/image.ts)), and a group that would still be too
  large is refused with a message telling you to split it, rather than failing with an opaque 413.
- **Functions are capped at 60s** (`maxDuration`). A full read-and-write on one screenshot takes
  about 17 seconds, and each job is its own request, so batches do not accumulate against the limit.
- **Key cooldowns live in function memory.** A cold instance starts with a fresh pool, so a benched
  key may be retried once more than it would be locally. It costs one wasted attempt, nothing else.
- **On-device OCR downloads its WASM and language data from a CDN** the first time you use a local
  mode — a few MB, cached afterwards.
- **Reply checking opens an IMAP connection** to Gmail from the serverless function. This works on
  Vercel but is the least-exercised path in the app.

## Where your data lives

- **Your details and resume** are in your browser's `localStorage`. They never touch a database.
- **The Gmail App Password** is stored the same way, and is posted to the server only while a send is
  in flight. It is never logged or persisted server-side.
- **Screenshots** are downscaled in the browser, sent to the AI provider to be read, and not stored.
- On Gemini's **free tier**, Google may use submitted content to improve their models — your resume
  would be part of that. The paid Claude path does not train on your data. If that matters to you,
  use Claude.

Because everything is in `localStorage`: clearing site data wipes your details, and a different
browser or phone starts empty.

---

## Notes and limits

- **Gmail sends ~500 emails/day** on a free account. Past that it refuses until the next day.
- **Gemini's free tier is rate limited** (roughly 10 requests/minute). The app reads 3 jobs at a time
  to stay under it; if you hit the limit, wait a minute and retry.
- **Always read the draft before sending.** The model writes from your resume and is told never to
  invent experience, but you are the one whose name is on the email.
- Cold applications to an address scraped off a job post are ordinary job-seeking. Sending the same
  mail to addresses that did not advertise a role is spam, and Gmail will suspend the account for it.

---

## Layout

```
app/
  page.tsx              capture, group, run
  review/page.tsx       bulk preview, per-email edit, send all
  profile/page.tsx      one-time details
  api/config/route.ts   which providers are live, and key-pool health
  api/process/route.ts  screenshots + text → job facts (+ email, in full mode)
  api/write/route.ts    job facts → one email
  api/send/route.ts     Gmail SMTP delivery
lib/
  pipeline.ts           cache → OCR/rules → recipe → AI, in that order
  ocr.ts                on-device Tesseract
  localExtract.ts       rule-based reader for pasted text
  recipes.ts            email templates by job family + input cache
  signature.ts          the signature block, built locally
  llm/index.ts          reader/writer provider selection
  llm/keyPool.ts        per-provider key rotation and benching
  llm/claude.ts         Anthropic SDK, structured output via Zod
  llm/gemini.ts         Gemini REST, structured output via responseSchema
  llm/groq.ts           Groq REST, the free writer
  llm/prompt.ts         prompts and schemas for both stages
  image.ts              browser-side downscaling
  store.ts              localStorage
components/
  PasteZone.tsx  SourceList.tsx  DraftCard.tsx
tests/
  suite.test.mjs        54 tests, no API key needed — npm test
```

To change how the emails read, edit `SYSTEM_PROMPT` in [lib/llm/prompt.ts](lib/llm/prompt.ts) — that
one string controls tone, length, and the rules about not inventing experience.

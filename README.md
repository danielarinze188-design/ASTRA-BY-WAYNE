# Astra (Gemini + Vercel)

Chat app with Google login and name/password login. Ash and dark green theme.

## Deploy
1. Push this folder to GitHub and import it into Vercel.
2. Vercel → Storage / Marketplace → add **Upstash Redis** (stores name/password accounts). It adds the REST env vars automatically.
3. Vercel → Settings → Environment Variables:
   - `GEMINI_API_KEY` – from https://aistudio.google.com/apikey
   - `AUTH_SECRET` – any long random string (e.g. run `openssl rand -hex 32`)
   - `GOOGLE_CLIENT_ID` – see below
   - `UPGRADE_URL` (optional) – link the Upgrade button opens (e.g. a Stripe Payment Link)
   - `GEMINI_MODEL` (optional) – default `gemini-2.5-flash`
4. Redeploy.

## Google login
Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → **Web application**.
Add your Vercel URL (e.g. `https://your-app.vercel.app`) under **Authorized JavaScript origins**. Copy the Client ID into `GOOGLE_CLIENT_ID`.
If the variable is empty, the Google button is hidden and only name/password login shows.

## Files
- `index.html` – interface and login screen
- `logo.png` – your logo as a mask (recolours for light/dark)
- `api/auth.js`, `api/_lib.js` – login, sessions, password hashing
- `api/chat.js` – streams Gemini replies (login required)

## Android APK
The app is a PWA (`manifest.json`, `sw.js`, `icon-*.png`). After deploying to Vercel:
1. Open pwabuilder.com and paste your Vercel URL.
2. Package for Stores → Android → download the zip (contains `.apk` to install and `.aab` for Play Store).
3. Keep the signing key from the zip for future updates.

## Documents (answer from your own material)
Settings → My documents (or the sidebar button) lets each account upload PDF, DOCX, TXT, MD, CSV, JSON or image files.
Files are split into passages, embedded with Gemini (`gemini-embedding-001`) and stored privately per account in Redis.
When "Answer from my documents" is on, the most relevant passages are added to the question and the reply lists its sources.
Limits: 20 files and ~800 passages per account; PDFs/images/DOCX up to 3 MB, text up to 2 MB.
Optional env vars: `RAG_MIN_SCORE` (default 0.5, raise for stricter matching), `EMBED_MODEL`.

## Business assistant, memory and briefings
- Astra is tuned as a small-business assistant (customer replies, emails, promo posts, planning).
- First login runs a short onboarding (business, offer, goal, tone). Edit it any time in Settings → Memory & data.
- Memory: Astra saves lasting facts, reminders and follow-ups it hears about, shows "Memory updated" under the reply, and lists everything in Memory & data where each item can be deleted. "Delete all memory" and "Delete memory and documents" are there too.
- Morning briefing: the first time the app opens each day (after 5am) Astra starts a new chat with today's focus, due reminders and "how did it go?" follow-ups.
- Reminders fire as an in-app alert (and a notification if enabled) while the app is open or running in the background. True background push is not built.
- Web answers use Gemini Google Search grounding and list their sources. Toggle in Settings.

## Background push (reminders + morning briefing when the app is closed)
1. In Vercel add env vars: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:you@example.com`), `CRON_SECRET` (see `astra-secrets.txt`).
2. Redeploy (this installs the `web-push` package).
3. Make something call `https://YOUR-APP.vercel.app/api/cron?key=YOUR_CRON_SECRET` every minute. Free option: cron-job.org → create a job with that URL, schedule "every minute".
   (Vercel Pro users can use a Vercel Cron instead; Hobby plans only allow daily crons, so don't put a per-minute cron in vercel.json.)
4. In the app: Settings → Notifications → on. Briefings are pushed around 8:00 in the user's local time.
5. APK: in PWABuilder's Android options, enable **notification delegation**, then rebuild.

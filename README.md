# Read Aloud

A reading app for people who find reading hard. Open a **PDF** (even a scanned one), **EPUB** or **TXT** book and it reads to you out loud, highlighting each word as it's spoken, a bit like Speechify.

It's a web app, so it runs on iPhone, iPad, Android, Mac and Windows. You can add it to your home screen and it opens like a normal app.

## Features

- **Word-by-word highlighting** with a softer highlight on the whole sentence being read
- **Tap any word** to start reading from there
- **Natural voices**
  - *Device voices* (free, work offline). The app lists the best-sounding ones first.
  - *AI voices* from [ElevenLabs](https://elevenlabs.io), which sound very human
  - **Copy your own voice:** record about a minute of yourself reading and the app makes an AI version of your voice (needs ElevenLabs)
- **Scanned PDFs work:** pages that are only pictures get their text recognised (OCR) on your device
- **AI audio is saved on your device**, so listening to a part again doesn't use ElevenLabs credits (up to ~500 MB, oldest deleted first, and you can clear it in Settings)
- Speed from 0.5× to 3×
- Easy-to-read fonts (Atkinson Hyperlegible, Lexend), adjustable text size and line spacing
- Light, sepia and dark themes. Four highlight colours, and an option to fade the text that isn't being read
- Remembers where you stopped in every book
- Table of contents, skip back/forward by sentence, keyboard shortcuts (Space, ← →)
- Books stay on your device. Nothing is uploaded, except the text sent to ElevenLabs when you use AI voices.

## Try it on your computer

You need any simple web server. Opening the file directly won't work.

```bash
cd book-reader-please
python3 -m http.server 8000
```

Then open http://localhost:8000

## Put it on your phone (free)

1. Push this repo to GitHub.
2. On GitHub, go to **Settings → Pages**, set *Source* to "Deploy from a branch", choose `main` and `/ (root)`, and save.
3. After a minute your app is live at `https://<your-username>.github.io/book-reader-please/`.
4. **iPhone:** open that link in Safari, tap **Share → Add to Home Screen**.
   **Android:** open it in Chrome, tap **⋮ → Add to Home screen / Install app**.

Netlify or Vercel also work. It's a plain static site with no build step.

## Getting the best voices

**Free device voices**

- **iPhone/iPad:** Settings → Accessibility → Spoken Content → Voices → English. Download a voice marked **Premium** or **Enhanced** (for example "Ava (Premium)"). Then reopen the app and choose it in Settings. (Siri voices can't be used: Apple keeps them for Siri and its own apps, and doesn't let any other app or website use them.)
- **Mac:** System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.
- **Windows/any computer:** use **Microsoft Edge** and pick a voice with "Online (Natural)" in its name.

**AI voices and your own voice (ElevenLabs)**

1. Make an account at elevenlabs.io and copy your API key (Profile → API Keys).
2. In the app: Settings → **AI voices** → paste the key → **Load my voices**.
3. To copy your voice, open **Make a copy of my voice**, record yourself reading the passage for 1+ minute in a quiet room, then tap **Save my voice**. Voice cloning needs a paid ElevenLabs plan (Starter or higher).

ElevenLabs charges by the number of characters read, so check their pricing for how many hours of listening your plan covers. *Fast* quality uses fewer credits than *Best*.

## Limitations

- **Scanned PDFs** take a few seconds per page to import, and recognition is English-only for now. A few words may come out wrong on blurry scans.
- PDFs with complex layouts (two columns, footnotes) may read in a slightly odd order.
- DRM-protected EPUBs (bought from Apple Books, Kindle, etc.) can't be opened. DRM-free EPUBs, such as those from Project Gutenberg and Standard Ebooks, work.
- On iPhone, device voices stop when the screen locks. The app keeps the screen awake while it reads.

## How it's built

Plain HTML/CSS/JavaScript, with no build step.

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | Layout and look |
| `js/app.js` | Library, reader, highlighting, playback, settings |
| `js/parsers.js` | Pulls text out of PDF (via pdf.js) and EPUB (via JSZip) |
| `js/voices.js` | Device speech (Web Speech API) and ElevenLabs voices with word timings |
| `js/storage.js` | Saves books, reading positions and AI audio in the browser (IndexedDB) |
| `sw.js`, `manifest.webmanifest` | Lets it install to the home screen and open offline |
| `vendor/` | pdf.js 4.10.38 (legacy build) and JSZip 3.10.1 |
| `vendor/ocr/` | Tesseract.js 6 with English data, used for scanned PDFs and only downloaded when needed |

<div align="center">

# 学 LyricMandarin

**Learn Mandarin from the songs you love.**

A Chrome extension that turns any Chinese song on YouTube or NetEase Cloud Music into an interactive lesson — real-time pinyin, HSK-graded vocabulary, AI cultural insights, and a flashcard deck you can export to Anki.

`v1.0.0` · Chrome (Manifest V3) · Free

**[→ Website & live demo](https://annabelleonardi.github.io/lyric-mandarin/)**

</div>

---

## Why

Listening practice is the most natural way to acquire a language — but song lyrics are fast, colloquial, and hard to look up mid-song. LyricMandarin closes that gap inside the player you already use: no copying, no pasting, no tab-switching.

## Features

- **Synced lyrics, automatically** — fetches official timed lyrics from NetEase (by song ID on NetEase, or by title match on YouTube) and highlights each line in sync with the music.
- **HSK color grading** — every word is graded on the HSK 1–9 scale: green (HSK 1–3), amber (HSK 4–5), purple (HSK 6+ / slang).
- **Instant word lookup** — click any colored word for pinyin, its HSK level, and a context-aware definition.
- **AI cultural insights** — one click explains the slang, idioms, and metaphors behind a line.
- **Flashcard deck + Anki export** — save words as you listen, then export the deck as a CSV that imports straight into Anki.
- **Two display modes** — Karaoke (overlay on the page) and Breakdown (full lyric list) layouts.
- **Works out of the box** — no API key needed to start; without one, the extension runs with built-in sample content.

## Install

1. **Download** the latest `LyricMandarin-Chrome-v1.0.0.zip` from [GitHub Releases](../../releases/latest) and unzip it.
2. Open `chrome://extensions` in Chrome and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped `build/chrome-mv3-prod` folder.
4. Pin LyricMandarin to your toolbar, open any Chinese song, and press play.

## Build from source

```bash
git clone https://github.com/annabelleonardi/lyric-mandarin.git
cd lyric-mandarin
npm install
npm run build
```

Then load `build/chrome-mv3-prod` via `chrome://extensions` → **Load unpacked**.

## Using AI lookups

LyricMandarin ships with a built-in sample dataset so you can try it immediately. To unlock unlimited AI-powered word lookups and cultural explanations:

1. Open the extension popup → **Settings**.
2. Choose a provider — **DeepSeek** or **OpenAI** — and paste your API key.
3. The key is stored locally in your browser and sent only to the provider you choose.

## Privacy

- Lyrics, saved words, and your API key live in `chrome.storage.local` on your device.
- Nothing is sent anywhere except the AI provider you choose (and NetEase's public lyric API).
- Without an API key, the extension needs no network access at all beyond fetching lyrics.

## Tech stack

Built with [Plasmo](https://docs.plasmo.com/), React 18, and TypeScript. Data source: NetEase Cloud Music public timed-lyrics API.

## Disclaimer

LyricMandarin is not affiliated with YouTube, NetEase Cloud Music, or Anki. Lyrics are provided via NetEase Cloud Music's public API for personal, educational use.

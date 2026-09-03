# Prompt Wars – Fable51

A live "prompt battle" for events. Players scan a QR code, type a prompt on their phone, and an LLM turns it into a
website that appears on the big **arena** screen. When the 5-minute timer ends, every site is screenshotted and an LLM
judges creativity + accuracy to the round's idea (plus a speed bonus for early submissions).

## Setup

```bash
cd Fable51
cp .env.example .env      # fill in OPENAI_APIKEY, OPENAI_MODEL_OPEN, OPENAI_MODEL_INTERACT
npm install               # also downloads Chromium for Playwright screenshots
npm run dev               # or: npm run build && npm start
```

- Players: `http://localhost:3000/`
- Arena (big screen): `http://localhost:3000/arena`

## How a round works

1. A random idea from `src/ideas.ts` is broadcast over WebSocket; the timer starts (`ROUND_SECONDS`, default 300).
2. A player submits a prompt → it's screened (local word/hack filters → OpenAI moderation → LLM screen).
3. The prompt alone is used as the instructions to build a single self-contained HTML page (`src/builder.ts`), which is
   sanitized, written to `data/sites/<round>/<submission>/index.html` and shown in the arena inside a sandboxed iframe.
   Player status updates: *Prompt Submitted → Processing → Website Built → Display it live*.
4. When the timer ends (plus a short grace for in-flight builds), Playwright screenshots every site; the judge LLM scores
   creativity (1-10) and accuracy (1-10) from the screenshots only. Speed bonus: 1st +10, 2nd +8, 3rd +6, …
5. Results show on the arena for `RESULTS_SECONDS` (default 60), then all sites are deleted and a new round begins.

Max 6 sites per round; the arena grid adapts (1 → full screen, 2–3 → one row, 4–6 → two rows of up to 3).

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_APIKEY` | OpenAI API key |
| `OPENAI_MODEL_OPEN` | Model that builds the websites |
| `OPENAI_MODEL_INTERACT` | Model that screens prompts and judges screenshots (needs vision) |
| `PORT` | HTTP/WS port (default 3000) |
| `ROUND_SECONDS` / `RESULTS_SECONDS` | Timer lengths |
| `PUBLIC_URL` | URL in the QR code (default `https://PromptWars.AIWeek.fun`) |

# Prompt Wars

Prompt Wars is a real-time TypeScript web app where players submit prompts to build themed mini-websites while the arena screen displays a rotating challenge and live competition.

## Features

- Mobile player flow at `/` with player name + prompt submission
- Arena view at `/arena` with challenge countdown and live submission cards
- Real-time updates through Socket.IO
- Backend prompt safety checks and website generation from player prompts
- Playwright-assisted screenshot capture and judging at round boundaries
- LLM scoring via the OpenAI model configured in `.env`

## Run locally

1. Create a `.env` file with your OpenAI config if you want LLM validation/judging enabled:
   - `OPENAI_APIKEY=...`
   - `OPENAI_MODEL_OPEN=gpt-5.6-terra`
   - `OPENAI_MODEL_INTERACT=gpt-5.6-luna`
2. Install dependencies:
   - `npm install`
3. Start the app in network-listening mode:
   - `npm run dev`
4. Open the app from your machine or another device on the same network using:
   - `http://<your-ip>:3000/`
   - `http://<your-ip>:3000/arena`

The server binds to `0.0.0.0` by default so it is reachable by your machine’s LAN IP address. If needed, you can override the public URL with `PUBLIC_BASE_URL=http://<your-ip>:3000` before starting.

## Notes

- The backend stores generated sites in `generated-sites/` and screenshots in `screenshots/`.
- If the OpenAI API is unavailable, the app falls back to local safety and heuristic judging logic.

# Prompt Wars

Prompt Wars is a two-screen TypeScript app: players submit one prompt from `/`, while `/arena` displays up to six generated websites in a live grid.

## Run locally

1. Copy the existing `GPT56/.env` configuration into the app folder (it already contains `OPENAI_APIKEY` and a configured model in this workspace).
2. Install dependencies with `npm install`.
3. Install the Playwright browser once with `npx playwright install chromium`.
4. Start development mode with `npm run dev`.

Open `http://localhost:3000/` on phones and `http://localhost:3000/arena` on the display. The server rotates ideas every five minutes, generates each accepted site with the configured OpenAI model, captures temporary screenshots for judging, shows results briefly, and resets the generated sites for the next round.

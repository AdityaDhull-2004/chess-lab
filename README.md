# Chess Lab

A free chess site for you and your friends: **play human-like Stockfish bots**, **analyse any position at any depth**, **review your games** (chess.com-style move grades and accuracy), **play friends through a shareable link**, and — on the server version — **accounts, friends, challenges, ratings and saved game history**.

**Live demo (bots, analysis, review): https://adityadhull-2004.github.io/chess-lab/**

Stockfish runs **inside the browser (WebAssembly, on the CPU)** – no GPU, no API keys, no subscription.

| Where it runs | What works |
| --- | --- |
| **GitHub Pages** (static, free, automatic) | Play bots · analysis · game review · import from chess.com/Lichess *by PGN/FEN* · piece sets/board colours/sounds |
| **Node server** (your PC, Render, Docker, any VPS) | everything above **plus** accounts, friends, challenges, online games with clocks, rating, history synced across devices, chess.com/Lichess username import |

GitHub itself cannot run a server (Pages is static hosting), so accounts and real-time games need the Node server – see *Deploy* below.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Node 18+. Data (accounts, history) is stored in `data/db.json`.

## Deploy so your friends can use it

1. **Same Wi-Fi** – `npm start` prints a `http://192.168.x.x:3000` address.
2. **Quick tunnel** – `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) gives a public https link while your PC is on.
3. **Always-on (free)** – click *Deploy to Render* in your fork (`render.yaml` is included) or use the `Dockerfile` on Fly.io / Railway / any VPS. Free hosts have no persistent disk, so create a free Postgres (Neon, Supabase, Render) and set `DATABASE_URL`; accounts and history then survive restarts. HTTPS (automatic on those hosts) also enables the multi-threaded engine.

Environment variables: `PORT`, `DATABASE_URL` (optional Postgres), `DATA_FILE` (JSON file path when not using Postgres).

The **static site** is built by `npm run build:static` and published by `.github/workflows/pages.yml` on every push to `main`.

## Features

* **Play a bot** – 14 bots (300–3200) plus a custom-rating slider, clocks, hints, takebacks, eval bar, **multiple premoves**.
* **Play a friend** – invite link, server-enforced rules/clocks, premoves, draw offers, rematch (colours swap), chat, spectators, reconnect.
* **Accounts** – register/sign in/out (no email), hashed passwords (scrypt), 30-day session cookie, brute-force throttling. Guests can still join a link.
* **Friends** – add by username, accept/decline, online dot, **challenge** a friend (they get an accept/decline pop-up), browse a friend's online games.
* **History & rating** – every online game and every bot game you finish while signed in is saved; click one to analyse it. Online games between accounts update a simple Elo rating (K=32) and W/L/D.
* **Analysis** – eval bar, 1–5 lines, depth 6–40/∞, Lite or Full-NNUE Stockfish 19, multi-threaded when the page is cross-origin-isolated, arrows, variation tree, ECO opening names, PGN/FEN in and out.
* **Game Review** – grades every move (Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder), accuracy for both players, eval graph, key moments, best-move suggestions.
* **Look & feel** – full-screen board (`Z`), 10 piece sets, 8 board colour themes + custom colours, 6 move-sound styles, dark/light theme.

## How the bots match real ratings

Stockfish's built-in `UCI_Elo` limiter produces random piece-dropping blunders (and in testing lost to my own 1100 bot), so it is **not** used. Each bot combines: an opening book; a depth-limited search (weak bots see only 1–4 plies, so they miss 2–3 move tactics like people do); a softmax choice among the engine's best candidates; a cap on how much any chosen move may lose; and, for beginners, an occasional genuine "slip".

The knobs were **tuned against real-player error levels**, not guessed: each bot plays itself and every move is graded against a depth-12 Stockfish search (`npm run calibrate -- <elo> <games>`). Target average centipawn loss (ACPL) per rating was taken from public figures — a chess.com forum sample of ~1000-rated games (ACPL ≈ 82), anecdotal ~1950 players (ACPL ≈ 40), "master ≈ 30", and the widely quoted `rating ≈ 3100·e^(−0.01·ACPL)` rule of thumb. Those are rough community numbers (no official per-rating table exists), so treat the ladder as approximate.

| Bot rating | 300 | 500 | 800 | 1100 | 1400 | 1700 | 2000 | 2300 | 2600 | 2900 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Target ACPL | 170 | 140 | 105 | 85 | 68 | 54 | 42 | 30 | 20 | 11 |
| Measured ACPL | ~190 | ~140 | ~100 | ~90 | ~76 | ~42 | ~44 | ~27 | ~18 | ~7 |

Measurements are noisy (a few hundred moves each, ±20 %). Bot-vs-bot matches (`scripts/pair.mjs`) confirm the ladder is monotonic: a bot 300 points weaker scores only ~10–25 %. Weak bots really do blunder: roughly 1 move in 7 loses 20 %+ of the win chance at 300, about 1 in 20 at 1100, and almost never above 2000.

## How the review works (the research)

* chess.com's in-browser engine is [Stockfish.js](https://github.com/nmrugg/stockfish.js) (its README says it was written for chess.com). Chess Lab uses the same package, Stockfish 19.
* Evaluations become a win chance with Lichess' open logistic, `1/(1+e^(−0.00368208·cp))`. A move is graded by how much win chance the mover gave up versus the best move: Excellent ≤ 2 %, Good ≤ 5 %, Inaccuracy ≤ 10 %, Mistake ≤ 20 %, Blunder > 20 % (the thresholds chess.com documents). Great / Brilliant / Miss are not published by chess.com, so those are my reconstruction.
* Accuracy uses Lichess' published formula; chess.com's CAPS score is proprietary, so numbers differ from theirs.

## Project layout

```
server.js                   static files, WebSocket games, chess.com/lichess import proxy
server/store.js             JSON-file or Postgres document store
server/accounts.js          accounts, sessions, friends, challenges, history, ratings (REST)
public/js/core/             DOM-free logic: engine wrapper, bots, review, openings
public/js/ui/               views: play, online, analysis, social, account, settings
scripts/                    selftest, calibrate, pair/league (bot matches), build-static, build-openings
.github/workflows/          CI + GitHub Pages deploy
```

## Notes

* Passwords are hashed with scrypt; sessions are random tokens (stored hashed) in an HttpOnly, SameSite=Lax cookie; state-changing API calls must be JSON; WebSocket origin is checked. It is meant for a group of friends – there is no email recovery, so a forgotten password cannot be reset (an admin can delete the user in the database).
* Online games in progress live in server memory; finished games are stored.
* Licences: the project is GPL-3.0-or-later. Stockfish and chessground are GPL-3.0. Piece sets (from the Lichess repository): Cburnett GPL-2.0+, Merida GPL-2.0+, Chessnut Apache-2.0, Pirouetti AGPL-3.0+, Letter AGPL-3.0+, MP Chess GPL-3.0+, Fantasy and Celtic MIT (Maurizio Monge), RhosGFX CC0, Pixel AGPL-3.0+. Opening data: Lichess chess-openings (CC0).

# Chess Server — System Design

---

## 1. Requirements

### Functional
- Lobby: players connect, see who's online, challenge each other or join a queue
- Human vs. Human: real-time move sync, clocks optional
- Human vs. Computer: existing JS engine moved server-side
- LLM eval bar: per-move natural-language commentary + numeric evaluation
- Game history: replay any completed game move-by-move
- Promotion, premoves, en passant — all existing rules carried forward

### Non-functional
- Move latency: < 100 ms round-trip on local/cloud
- Concurrency: 10–100 simultaneous games initially; horizontally scalable later
- Durability: games survive server restart
- Cost: cheap — single VPS or free tier (Render/Railway/Fly.io)

### Constraints
- Solo developer, hobby project
- Existing chess logic is pure JS — reusable server-side with zero changes
- No existing backend or database

---

## 2. High-Level Design

```
Browser Clients
      │  WebSocket (Socket.io)
      ▼
┌─────────────────────────────────────────┐
│           Node.js / Express             │
│                                         │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │  Lobby  │  │  Game    │  │  Auth  │ │
│  │ Manager │  │ Manager  │  │(simple)│ │
│  └─────────┘  └────┬─────┘  └────────┘ │
│                    │                    │
│          ┌─────────┴──────────┐         │
│          │                    │         │
│   ┌──────▼──────┐   ┌─────────▼──────┐ │
│   │ Chess Engine│   │  LLM Analysis  │ │
│   │   (JS lib)  │   │  (Claude API)  │ │
│   └─────────────┘   └────────────────┘ │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │         SQLite (via              │   │
│  │         better-sqlite3)          │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### Data flow for a human move
1. Client emits `make_move {gameId, from, to, promo}`
2. Server validates move against canonical game state
3. Server applies move, persists new position
4. Server broadcasts `move_made` to both players
5. Server triggers LLM analysis (async, non-blocking)
6. LLM result emitted as `analysis_update` when ready

---

## 3. Deep Dive

### 3a. Data Model (SQLite)

```sql
CREATE TABLE players (
  id          TEXT PRIMARY KEY,   -- uuid
  name        TEXT NOT NULL,
  created_at  INTEGER DEFAULT (unixepoch())
);

CREATE TABLE games (
  id           TEXT PRIMARY KEY,
  white_id     TEXT REFERENCES players(id),
  black_id     TEXT REFERENCES players(id),  -- NULL = computer
  status       TEXT DEFAULT 'playing',        -- playing | checkmate | stalemate | abandoned
  pgn          TEXT DEFAULT '',               -- full PGN, appended after each move
  result       TEXT,                          -- '1-0' | '0-1' | '1/2-1/2'
  created_at   INTEGER DEFAULT (unixepoch()),
  ended_at     INTEGER
);

CREATE TABLE moves (
  id           INTEGER PRIMARY KEY,
  game_id      TEXT REFERENCES games(id),
  move_number  INTEGER,
  color        TEXT,                -- 'w' | 'b'
  from_sq      TEXT,               -- 'e2'
  to_sq        TEXT,               -- 'e4'
  promo        TEXT,               -- 'q' | null
  fen_after    TEXT,               -- position after move
  san          TEXT,               -- 'e4', 'Nf3', 'O-O'
  eval_score   REAL,               -- static eval in pawns (from existing engine)
  llm_comment  TEXT,               -- Claude's commentary, filled async
  created_at   INTEGER DEFAULT (unixepoch())
);
```

### 3b. WebSocket Events

| Direction | Event | Payload | Notes |
|---|---|---|---|
| Client → Server | `join_lobby` | `{ name }` | Assigns player ID, joins lobby room |
| Server → Client | `lobby_state` | `{ players[], games[] }` | Full lobby snapshot on join |
| Server → All | `lobby_update` | `{ type, player/game }` | Delta updates (join/leave/new game) |
| Client → Server | `create_game` | `{ opponent: 'human'\|'computer', color: 'w'\|'b'\|'r' }` | Returns game ID |
| Client → Server | `join_game` | `{ gameId }` | Second human joins |
| Server → Client | `game_start` | `{ gameId, white, black, fen }` | Sent to both players |
| Client → Server | `make_move` | `{ gameId, from, to, promo? }` | Server validates |
| Server → Both | `move_made` | `{ from, to, promo, san, fen, eval }` | After successful move |
| Server → Both | `game_over` | `{ result, reason }` | checkmate/stalemate/resign/timeout |
| Server → Client | `analysis_update` | `{ moveId, comment, evalBar }` | Async, after LLM responds |
| Client → Server | `resign` | `{ gameId }` | |
| Client → Server | `request_analysis` | `{ gameId, moveIndex? }` | Manual LLM trigger for a position |

### 3c. Server-Side Game State

Each live game is held in memory as a `GameSession` object:

```js
{
  id: 'uuid',
  white: { playerId, socketId },
  black: { playerId, socketId } | null,   // null = computer
  board: [...],         // 64-element array — canonical truth
  turn: 'w' | 'b',
  castling: 'KQkq',
  enPassant: null | idx,
  halfMove: 0,
  fullMove: 1,
  history: [],          // array of FENs + moves for replay
  status: 'playing'
}
```

The existing `chess.html` JS engine is extracted into `engine.js` — a pure CommonJS/ESM module with zero DOM dependencies. `legalMoves`, `applyMove`, `computerMove`, etc. are imported unchanged.

### 3d. LLM Analysis Integration

```
After each move:
  1. Build prompt:
     - Last 5 moves in SAN
     - Current FEN
     - Who just moved and what
     - Static eval score from engine
  2. Call Claude API (claude-haiku-4-5 for speed/cost)
  3. Ask for: one sentence of commentary + suggested continuation
  4. Store result in moves.llm_comment
  5. Emit analysis_update to both players' sockets
```

**Rate limiting:** Only trigger LLM analysis if the last analysis finished (no queue pile-up). Skip analysis during time pressure (clock < 30s). Offer an explicit "Analyze this position" button for on-demand full analysis.

**Post-game analysis:** After game ends, batch-analyze all moves to identify blunders (eval swing > 2 pawns), best moves, and produce a full game report.

### 3e. Computer Player

`computerMove()` runs in a **Worker thread** (Node.js `worker_threads`) so the event loop is never blocked. The 500ms budget already in the engine becomes the worker's time cap. The worker posts back `{from, to, promo}` and the main thread applies the move.

---

## 4. Scale & Reliability

| Concern | Approach |
|---|---|
| 100 concurrent games | Node.js single process handles this easily; each game is just in-memory state + WebSocket events |
| Computer move blocking | Worker thread per game (or a pool of 4 workers) |
| Server restart | Reload active games from SQLite on startup; reconnect players by session cookie |
| LLM cost | claude-haiku-4-5 at ~$0.80/M tokens; a 60-move game ≈ 60 API calls × ~200 tokens = $0.01/game |
| Horizontal scale | When needed: move game state to Redis, use Socket.io Redis adapter for pub/sub across instances |

**Deployment (Day 1):** Single Node.js process on Fly.io free tier or Railway. SQLite lives on a persistent volume. No reverse proxy needed (Fly handles TLS).

---

## 5. Trade-off Analysis

| Decision | Choice | Alternative | Why this wins |
|---|---|---|---|
| WebSocket library | **Socket.io** | raw `ws` | Rooms, reconnection, namespaces built in; saves a week of plumbing |
| Database | **SQLite** | PostgreSQL | Zero setup, no separate service, plenty for 10K games; migrate to Postgres if needed later |
| LLM analysis | **Async, non-blocking** | Synchronous per move | Move latency stays < 100ms; commentary can arrive 1-2s later |
| LLM model | **claude-haiku-4-5** | claude-sonnet-4-6 | 10× cheaper, fast enough for single-move commentary; use Sonnet for post-game report only |
| Engine location | **Server-side + worker thread** | Client-side (current) | Server is authoritative; prevents cheating; existing code reused unchanged |
| Auth | **Ephemeral session (cookie)** | Full accounts | No signup friction for a chess prototype; add accounts later if needed |

**What to revisit as the system grows:**
- Add Elo ratings once you have enough game history
- Add clocks (increment timing) — straightforward to layer in
- Replace SQLite with Postgres + Prisma when you want to deploy on multiple instances
- Consider Stockfish (WASM or native) if you want stronger computer play

---

## 6. Suggested Build Order

| Week | Focus |
|---|---|
| 1 | Extract `engine.js` from `chess.html`, set up Node.js + Socket.io skeleton, get two browser tabs playing each other |
| 2 | Lobby UI, matchmaking, persistence (SQLite), game reconnection |
| 3 | Computer player via worker thread, human-vs-computer mode |
| 4 | Claude API integration, eval bar, per-move commentary |
| 5 | Post-game analysis report, polish, deploy to Fly.io |

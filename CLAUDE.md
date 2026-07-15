# Chess Project

## Project Goal

The long-term plan is to grow this into a multi-client chess server where users can play each other or a computer, with an evaluation bar driven by an LLM that analyzes their played games. The CPU-only single-file prototype still exists unchanged; a Node.js + WebSocket server now adds optional human-vs-human play alongside it.

## Repository Layout

```
Chess/
├── chess.html      ~7700 lines, the entire app (UI + engine + multiplayer client)
├── server.js       Node.js + ws WebSocket server for human-vs-human play
└── package.json    single dep on `ws`
```

The browser app remains a single self-contained HTML file — open `chess.html` in any modern browser and CPU mode works with **no build step, no package manager, no server**. The Web Worker is still built at runtime from a `Blob` URL.

**Multiplayer is opt-in.** To play human-vs-human, the user (or a friend on the same LAN) needs to run the server:

```
npm install
node server.js     # listens on :8080
```

Then both players open `chess.html` in their browsers, click the **vs Human** tab in the new-game modal, and use Create/Join.

Fonts are pulled from Google Fonts (`Playfair Display` and `IBM Plex Mono`). Everything else is local.

## Architecture

The file has three parts in order:

1. **`<style>` block** — CSS variables in `:root`, then component styles. Theme is dark: black background `#0e0e0e`, cream board squares `#d4b483` / brown `#8b6343`, gold accent `#c8a96e`.
2. **`<body>` markup** — header, board container with eval bar + rank/file labels, side panel (turn/status display, scrollable move list, new-game button), three overlay modals (color picker, game over, promotion). The eval bar's container has `display: none` by default and only gets `.visible` toggled on when analysis mode is entered. A `#commentary-box` div below the move list shows per-move analysis text in analysis mode.
3. **`<script>` block** — chess engine, evaluation, search, Web-Worker bootstrap, game state, UI logic, premove system, analysis variation tree, move commentary system.

There's no module system, no classes — just top-level functions and a single global `G` object holding the live game state. The Web Worker is created once at script load and reused for the rest of the session.

## Coordinate System

The board is a flat 64-element array.

- **Index** = `rank * 8 + file`
- `rank 0` = white's back rank (the 1st rank in algebraic). `rank 7` = black's back rank.
- `file 0` = a-file. `file 7` = h-file.
- `a1` = index 0, `h1` = index 7, `a8` = index 56, `h8` = index 63.
- Pieces are single-character codes. **Uppercase = white**, **lowercase = black**: `K Q R B N P` for white, `k q r b n p` for black. Empty squares are `null`.
- Conversion helpers: `algebraicToIndex(alg)`, `indexToAlgebraic(idx)`.

## Game State (`G`)

`G` is a single mutable object reassigned by `newGame()`. Fields:

| Field | Purpose |
|---|---|
| `board` | Array(64) of piece codes or null. The **real** position — never mutated by premoves. |
| `turn` | `'w'` or `'b'`. |
| `enPassant` | Index of EP target square, or `null`. |
| `castling` | String like `"KQkq"`. Letters removed as rights are lost. |
| `halfMove`, `fullMove` | Move counters. |
| `selected` | Square index of the human's currently selected piece (real-move mode), or `null`. |
| `legalFromSelected` | Array of legal destination indices for `selected`. |
| `status` | `'playing'` \| `'checkmate'` \| `'stalemate'` \| `'draw'`. |
| `lastFrom`, `lastTo` | The most recent move (for the yellow last-move highlight). |
| `awaitingPromotion` | `{from, to}` while the promotion dialog is open. |
| `history` | Array of snapshots, one per move, for jump-to-position navigation. |
| `viewingSnap` | Node ID of the analysis node currently being viewed (set by `_jumpToAnalysisNode`), or `null` during live play. |
| `positionCounts` | Map of position keys → count, for threefold-repetition detection. |
| `premoves` | Queue of `{from, to, promo}` entries (see Premove System). |
| `premoveSelected` | Square index of the piece currently being composed into a premove. |
| `premoveTargets` | Array of valid premove destination indices for `premoveSelected`. |

Module-level state outside `G`:
- `humanColor` (`'w'` or `'b'`).
- `analysisMode` — toggled true when the user clicks **Analyze** after a game ends.
- `drag` — active drag-and-drop state.
- `lastSearchScore`, `lastSearchDepth` — the most recent worker-returned search score (white POV, centipawns) and the depth that produced it. The eval bar reads these in analysis mode.
- `_searchGeneration` — bumped on every `startGame()` so stale Worker responses from a previous game can be discarded.
- `_analysisTree`, `_analysisCurrent` — root TreeNode and currently-viewed TreeNode for the analysis variation tree.
- `_nextNodeId` — monotonically-increasing integer used to assign unique IDs to tree nodes.
- `_commentaryCache`, `_evalScores`, `_commentaryTimer`, `_commentaryCurrentNode` — commentary system state (see Move Commentary System section).

## Engine (pure move-generation core)

Pure functions, all side-effect free except where noted. These live in the main thread AND are duplicated (via `.toString()`, not copy-paste) into the Web Worker.

- **`parseFen(fen)`** — turns a FEN string into a game state. Used only to set up the initial position.
- **`pseudoMoves(board, from, turn, enPassant, castling)`** — generates all moves a piece *could* make from `from`, ignoring whether the move leaves the king in check. Returns a **plain array of integer square indices** (not objects). Sliders for R/B/Q stop at blockers and at the first enemy piece. Handles castling (path empty in `board`, rook present) and pawn moves (forward needs empty square, diagonal needs enemy or EP target). **Pawn diagonal captures are only added when `isEnemy(board[to], turn)` is true** — this matters when using `pseudoMoves` to test pawn attack coverage.
- **`isSquareAttacked(board, sq, byColor)`** — reverse attack detection: scans outward from `sq` itself (pawn/knight/king fixed offsets plus 8 slider rays that stop at the first occupied square) instead of generating every `byColor` piece's moves. Roughly an order of magnitude faster than the old pseudoMoves-based version — this is the hottest function in the search (check detection + per-move legality filtering). Pawn semantics are correct chess: pawns attack diagonally only (the old version also counted a pawn's forward-push square as "attacked", which wrongly forbade castling in rare cases). The same implementation is duplicated in `server.js` for move-legality validation — keep the two in sync. Used for check detection and castling legality.
- **`isInCheck(board, color)`**, **`findKing(board, color)`** — standard.
- **`applyMove(board, from, to, promo, enPassant, castling)`** — returns `{board, newEP, newCastling}`. Does **not** mutate the input. Handles EP captures, castling rook movement, and updates castling rights when kings or rooks move or rooks are captured.
- **`legalMoves(board, turn, ep, castling)`** — full legality: filters out moves leaving the king in check, expands pawn-to-last-rank into four promotion options, blocks castling through attacked squares.
- **`moveToNotation(...)`** — SAN-ish notation for the move list. `+` / `#` suffixes are added in `executeMove` after computing the next side's legal moves.

## Evaluation — Stockfish-style tapered eval

The evaluator is structured around Stockfish's `main_evaluation` pattern. All scores are **centipawns from White's perspective**. See the `EVALUATION ENGINE` and `MAIN EVALUATION` sections in the script.

### Top-level recipe (`evaluateBoard(board, turn)`)

```js
const { mg, eg } = evaluateMGEG(board);           // single pass → (mg, eg) totals
const p   = phase128(board);                       // 0..128 (128 = pure middlegame)
const sf  = scaleFactor(board, eg);                // 0..64  (64 = no scaling)
const scaledEG = Math.trunc(eg * sf / 64);
let v = Math.trunc((mg * p + scaledEG * (128 - p)) / 128);
if (turn) v += turn === 'w' ? TEMPO_BONUS : -TEMPO_BONUS;  // ~28 cp side-to-move bonus
return v;
```

The `turn` argument is optional. When omitted (eval-bar paths that don't know who's to move), the tempo step is skipped so the bar doesn't oscillate.

### Phase

`gamePhase(board)` weights pieces N=1, B=1, R=2, Q=4 with max=24. `phase128(board)` rescales that to Stockfish's 0..128 scale. The phase value is shared by the entire eval — every term gets the same blend.

### MG/EG accumulation (`evaluateMGEG`)

One pass over the board accumulates parallel MG and EG totals. Each term contributes to both unless it's known to be phase-only. Per-piece additions read PSTs at the two phase extremes explicitly (`getPST(t, white, i, MAX_PHASE)` for MG, `getPST(t, white, i, 0)` for EG).

Components and where they're defined:

| Term | Function | MG / EG behavior |
|---|---|---|
| Material + PSTs | inline in `evaluateMGEG` | Per-piece tapered values + position tables. |
| Bishop pair | inline (`wB >= 2`) | +22 MG / +30 EG. |
| Pawn structure | `pawnStructureMGEG` | Doubled (−11/−56), isolated (−5/−15), passed (rank-scaled `PASSED_MG` / `PASSED_EG`), connected (+8/+3 per connected pawn). |
| Mobility | `mobilityMGEG` | Per-piece move-count weighted by piece type. MG weights N=4 B=5 R=2 Q=1; EG weights N=3 B=5 R=4 Q=2 (rooks matter more in EG). |
| Rooks on files | `evalRooksMGEG` | Open file +25/+18, semi-open +10/+5, rook on relative 7th rank +16/+30. |
| Knight outposts | `evalKnightOutpostsMGEG` | +22/+10 in enemy territory (+10/+5 in own half), +12/+5 bonus if supported by a friendly pawn. The "safe outpost" test checks enemy pawns *ahead* of the knight in its advancing direction. |
| Threats | `evalThreatsMGEG` | Pawn-only threats: enemy non-pawn attacked by our pawn earns 48–90 MG / 38–60 EG depending on victim type. Computed via two O(N) pawn-attack passes — no `pseudoMoves` calls. |
| Space | `evalSpaceMG` | Safe central squares (files c–f) in our half not attacked by enemy pawns, weighted by friendly-minor count. MG only. |
| King safety | `kingZoneSafety` | Pawn shelter + open-file penalty + zone-attack-units. Returns `{mg, eg}` per color; main eval diffs `w - b`. EG contribution halved (`>> 1`). |

### King-zone attack units

`kingZoneSafety` builds a Set of the 8 squares surrounding the king plus the 3 squares two ranks in front. For each enemy non-pawn non-king piece, `pseudoMoves` is called and the result intersected with the king zone; if non-empty, the attacker contributes `ATTACK_UNIT[type]` (N/B=20, R=40, Q=80). The total is non-linearly scaled by attacker count (`1 + (n-2)*0.3` for `n >= 2`) then divided by 4 to produce the centipawn penalty.

### Scale factor

`scaleFactor(board, egScore)` returns a value in `[0, 64]` (`64` = no scaling). It detects two drawish material configurations:

- **Opposite-coloured bishops, no other minors/majors** — return `min(36, 16 + 4*|wPawns - bPawns|)`. Heavily scales the EG down.
- **Side with material advantage but no pawns** — `K + minor vs K` returns `8` (dead draw); a small advantage with no pawns returns `24`.

The scale only affects the EG side of the taper, so middlegame play is unaffected.

### Tempo

`TEMPO_BONUS = 28`. Applied at the very end of `evaluateBoard` as `±28` cp depending on whose turn it is. This compensates for the natural side-to-move advantage and (critically) **prevents the bar from biasing toward one side just because of evaluation odd-depth artifacts**.

## Search — Stockfish-style negamax (in a Web Worker)

The search lives in the worker, not the main thread. The main thread's negamax/quiesce functions are still defined (they're what get stringified into the worker), but the UI never calls them synchronously. See `SEARCH — negamax with Stockfish-style enhancements` in the script.

### Search architecture

- **`negamax(board, turn, ep, castling, depth, alpha, beta, ply, allowNull)`** — fail-soft negamax with the full enhancement stack below. Scores are from the side-to-move's perspective.
- **`quiesce(board, turn, ep, castling, alpha, beta, qdepth, ply)`** — captures + promotions when quiet (`QMAX = 6` plies); **all evasions when in check** (standing pat while in check isn't legal, so in-check nodes search every legal move; check sequences stay finite because the checking side can only continue with captures; no legal evasions = mate score). Stand-pat uses `evaluateBoardLazy`. Delta pruning (200-cp margin) and **SEE pruning** (`seeCapture < 0` captures skipped, promotions always searched).
- **`seeCapture(board, from, to, ep)` / `leastValuableAttacker(board, sq, byColor)`** — static exchange evaluation via the standard swap algorithm: alternate cheapest-attacker recaptures on a scratch board, then negamax the gain list. X-rays emerge naturally from removing each attacker before rescanning. Promotions mid-exchange ignored.
- **`fastEval(board, turn)` / `evaluateBoardLazy(board, turn, alpha, beta)`** — lazy evaluation. `fastEval` is material + PST + tempo only (single O(64) pass, no pseudoMoves). `evaluateBoardLazy` returns the **side-to-move POV** score: the fast estimate directly when it's ≥ `LAZY_MARGIN` (380 cp) outside (alpha, beta), the full `evaluateBoard` otherwise. Used for quiesce stand-pat and negamax's shared static eval; skips the expensive mobility/king-safety/threats/pawn-structure terms at the large majority of q-nodes.
- **`computerMove(gameState)`** — iterative deepening from depth 1 to `MAX_DEPTH` with a wall-clock budget. Aspiration windows around the previous iteration's score (±50 cp). Best move from the deepest *fully completed* iteration is returned; a partial deeper iteration is discarded. Budget and depth vary by difficulty — see DIFFICULTY object below. Optional `gameState` extras: `prevKeys` (array of `positionHash` values for every position reached in the game — the search scores any return to one of them as a repetition draw) and `softMs` (don't *start* a new iteration past this point; the hard `searchMs` deadline still aborts mid-iteration). **The TT persists across moves of the same game** (killers reset per move, history halves) — it's only cleared by worker restart (new game) or `searchEval`.
- **`searchEval(board, turn, ep, castling)`** — analysis-mode wrapper: iterative deepening to depth 10, 1500 ms budget. Used by the eval bar and move commentary system.

### DIFFICULTY object

Per-difficulty search parameters live in the `DIFFICULTY` object:

| Difficulty | `maxDepth` | `searchMs` | `thinkMs` | `randomPct` |
|---|---|---|---|---|
| easy | 2 | 400 | 3000 | 80 |
| medium | 5 | 1200 | 3000 | 20 |
| hard | 14 | 4500 | 3000 | 0 |

`thinkMs` is the minimum wall-clock delay before the CPU move plays (the premove window). `searchMs` is the worker's actual search budget. The move plays at `max(search_done, thinkMs)` via `Promise.all`. Hard mode's generous 4500 ms budget paired with depth 14 significantly exceeds the old 2200 ms / depth 10 limits.

### Enhancement stack (and the Elo ballpark each is worth in real engines)

| Enhancement | Where | Notes |
|---|---|---|
| Transposition table | `positionHash`, `ttProbe`, `ttStore`, `ttClear` | FNV-1a 32-bit hash of (board, turn, castling, ep). 256k entries (`TT_SIZE = 1 << 18`). Three bound types: `TT_EXACT`, `TT_LOWER`, `TT_UPPER`. Always-replace-by-depth. Persists across moves of the same game. ~80–150 Elo. |
| Repetition detection | top of `negamax` (`_prevKeys`, `_pathKeys`) | Any position whose hash is already on the current search path (`_pathKeys` stack, unwound via `finally`) or in the played game (`_prevKeys`, from `gameState.prevKeys`) scores 0 at ply > 0. Checked before the TT probe so a cached score can't mask a threefold. |
| Null-move pruning | inside `negamax` | Skips our turn at reduced depth (R=2 at depth ≥ 3, R=3 at depth ≥ 6). Disabled in check, when the side-to-move has only K + pawns (`hasNonPawnMaterial`), and when `staticEval < beta` (eval guard — the null search would almost never fail high). ~50–80 Elo. |
| SEE pruning (qsearch) | `seeCapture` inside `quiesce` | Captures whose swap-off ends negative are skipped entirely instead of searched. ~30 Elo. |
| Lazy evaluation | `evaluateBoardLazy` | Material+PST-only eval returned directly when ≥ 380 cp outside the window; full eval (mobility, king safety, …) only near the window. Large NPS gain. |
| Reverse futility pruning | inside `negamax` | At depth ≤ 4 and not in check: if `staticEval − 120*depth ≥ beta`, return `staticEval` immediately (the position is so good we don't need to search further). ~30–50 Elo. |
| Futility pruning | inside `negamax` move loop | At depth 1–2, quiet moves are skipped when `staticEval + margin ≤ alpha` (margin = 300 cp at depth 1, 500 cp at depth 2). Only applied after the first move and when not in check. ~20–30 Elo. |
| Check extension | top of `negamax` | If side-to-move is in check, `depth += 1` before the depth-0 short-circuit. ~20–30 Elo. |
| Late-move reductions | quiet-move branch in `negamax` | After 3 moves, quiet moves are searched at depth `1 + floor(log2(depth) * log2(moveIdx) / 2.5)` less. Re-searched at full depth if they raise alpha. ~40–70 Elo. |
| Principal-variation search | `negamax` and root `computerMove` | First move gets full (α, β) window; subsequent moves get a zero-width "scout" window. Re-search on a fail-high. |
| Aspiration windows | root iterative-deepening loop in `computerMove` | First iteration uses ±∞; subsequent iterations use `prevScore ± 50`. Widens to ±∞ on fail-high / fail-low. |
| Mate-distance pruning | top of `negamax` | Never reports a mate worse than the one we already have, so deeper mates get found faster. |
| Killer moves | `_killers[ply]`, ordering inside `moveOrderScoreEx` | Two quiet moves per ply that produced a β-cutoff. Score boost +80,000 / +90,000. |
| History heuristic | `_history[piece * 64 + to]` | Quiet β-cutoff moves get `+depth²` to their history bucket. Used as a tiebreaker after killers. |
| MVV-LVA + promotions | `moveOrderScoreEx` | Captures first (most-valuable-victim / least-valuable-attacker), then promotions, then quiet ordering. TT move always first (score 1e9). |

### RFP, Futility, and NMP-guard implementation details

All three share a single lazy static eval computed once per node when not in check (any depth — the null-move guard needs it at depth ≥ 3 too):

```js
let staticEval = null;
if (!inCheck) staticEval = evaluateBoardLazy(board, turn, alpha, beta); // STM POV
// Reverse Futility Pruning (depth <= 4)
if (staticEval !== null && depth <= 4 && Math.abs(beta) < MATE_SCORE - 100) {
  if (staticEval - 120 * depth >= beta) return staticEval;
}
// Null-move pruning gains an eval guard: `staticEval >= beta` required.
// ...
// Futility pruning setup (before move loop)
const fpEval = (depth <= 2 && staticEval !== null) ? staticEval : -Infinity;
// ...
// Inside move loop, after isQuiet computed, before applyMove:
if (fpEval !== -Infinity && isQuiet && moveIdx > 0) {
  const fpMargin = depth === 1 ? 300 : 500;
  if (fpEval + fpMargin <= alpha) continue;
}
```

`negamax`'s body (from the `_pathKeys.push(hash)` after the repetition check to the final `ttStore`) is wrapped in `try { … } finally { _pathKeys.pop(); }` so the path stack stays consistent on every return path, including the `'timeout'` throw.

### Eval-bar score comes from the search

`computerMove` ends with `lastSearchScore = turn === 'w' ? bestScoreSTM : -bestScoreSTM`, so the white-POV minimax score is exposed alongside the best move. The worker posts both back to the main thread. In analysis mode `searchEval` does the same conversion. Old behavior — calling `evaluateBoard(G.board) / 100` for the bar — has been replaced; the bar now reflects what the engine actually thinks the position is worth.

## Web Worker integration

The search runs in a dedicated Web Worker so the UI thread is **never** blocked by negamax, regardless of how deep the search goes. See the `ENGINE WORKER` section in the script.

### How the worker source is assembled

Rather than duplicating the engine in two places, the worker source is **built at script load from the already-defined main-thread functions**:

```js
function _makeEngineWorker() {
  const consts = { PHASE_WEIGHTS, MAX_PHASE, PV_MG, PV_EG, ...all PSTs..., TEMPO_BONUS, ... };
  const constSrc = Object.entries(consts)
    .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n');

  // Mutable per-worker state + TT helpers (declared inside the worker, NOT shared
  // with the main thread).
  const stateSrc = `
    const PIECE_VALUES = PV_MG;
    let _tt = new Array(TT_SIZE).fill(null);
    function ttProbe(hash) { ... }
    function ttStore(...) { ... }
    function ttClear()    { _tt = new Array(TT_SIZE).fill(null); }
    let _killers = ...;
    let _history = new Int32Array(64 * 12);
    function clearHistory() { ... }
    let _searchDeadline = Infinity;
    let _nodeCount = 0;
    let lastSearchScore = 0;
    let lastSearchDepth = 0;
    let _prevKeys = new Set();
    let _pathKeys = [];
  `;

  // Stringify all engine functions that the search needs.
  const funcs = [
    pieceColor, pieceType, isEnemy, isFriend,
    pseudoMoves, isSquareAttacked, findKing, isInCheck,
    applyMove, legalMoves,
    gamePhase, taper, mirrorSq, getPST,
    evalRooksMGEG, evalKnightOutpostsMGEG, evalThreatsMGEG, evalSpaceMG, kingZoneSafety,
    phase128, scaleFactor, pawnStructureMGEG, mobilityMGEG, evaluateMGEG, evaluateBoard,
    fastEval, evaluateBoardLazy, leastValuableAttacker, seeCapture,
    positionHash, historyIdx,
    moveOrderScoreEx, orderMovesEx,
    quiesce, negamax, hasNonPawnMaterial,
    computerMove, searchEval,
  ];
  const funcSrc = funcs.map(f => f.toString()).join('\n\n');

  // Message dispatcher.
  const handlerSrc = `self.onmessage = (e) => { ... };`;

  const src  = constSrc + '\n' + stateSrc + '\n' + funcSrc + '\n' + handlerSrc;
  const blob = new Blob([src], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}
```

This pattern relies on the fact that **every engine function is a pure top-level function with no closure captures over UI state**. `Function.prototype.toString()` faithfully reproduces them, and the worker's global scope holds the same names so calls between them resolve correctly. Constants are serialised via `JSON.stringify`. Mutable state (TT, killers, history, deadline, node count) is declared fresh inside the worker so the two contexts never share memory.

### Request / response protocol

The main thread sends one of two commands:

```js
worker.postMessage({ id, cmd: 'move',    state: {board, turn, enPassant, castling} });
worker.postMessage({ id, cmd: 'analyze', board, turn, ep, castling });
```

The worker handler dispatches to `computerMove` or `searchEval` and replies:

```js
{ id, ok: true, cmd: 'move',    move: {from, to, promo}, score, depth }
{ id, ok: true, cmd: 'analyze', score }
{ id, ok: false, error: '<string>' }
```

The main thread's promise infrastructure:

```js
const _engineWaiters = new Map();        // id → {resolve, reject}
let   _engineReqId   = 0;
_engineWorker.onmessage = (e) => {
  const w = _engineWaiters.get(e.data.id);
  if (!w) return;
  _engineWaiters.delete(e.data.id);
  if (e.data.ok) w.resolve(e.data);
  else           w.reject(new Error(e.data.error || 'worker error'));
};
function askEngineMove(state)                       { return new Promise(...); }
function askEngineAnalyze(board, turn, ep, castling){ return new Promise(...); }
```

### `triggerComputerMove` — keeping the 3-second premove window with off-thread search

The original 3-second "Thinking…" delay was load-bearing UX (it's what gives the user time to queue premoves on the CPU's turn). The naïve port to a Worker would just await the search, but a sub-second worker response would break the premove window. So the trigger uses `Promise.all` of the search promise and a 3-second timer:

```js
const myGen   = _searchGeneration;
const tWait   = new Promise(r => setTimeout(r, 3000));
const tSearch = askEngineMove({ board: liveBoard, turn: liveTurn, ... });

Promise.all([tSearch, tWait]).then(([result]) => {
  if (myGen !== _searchGeneration) return;        // game was reset while waiting
  if (G.status !== 'playing')      return;
  if (G.turn === humanColor)       return;        // safety: not our turn anymore
  lastSearchScore = result.score;
  lastSearchDepth = result.depth;
  // ... snap G back to live state if user navigated to a past snapshot ...
  executeMove(result.move.from, result.move.to, result.move.promo);
}).catch(err => { ... });
```

This gives us **`max(search_done, 3 s)`**: the search runs in parallel with the 3-second timer, and the move plays whenever both are done. The user enjoys the full 3 s premove window AND the engine gets up to its full search budget. During this entire interval the UI is fully interactive — clicks, drags, premoves, history navigation all work.

### `_searchGeneration` — discarding stale responses

`startGame()` increments `_searchGeneration` so any worker request already in flight from a previous game gets ignored when its response eventually arrives. Without this guard, you could click "New Game", start a fresh position, and have the previous game's CPU move land 2 seconds later on the new board.

## UI Flow

On load, the color picker overlay is shown. `startGame(color)` is called from the buttons:
- `'w'` → human plays white
- `'b'` → human plays black (board flips via `isBoardFlipped()` → `humanColor === 'b'`; coords flip too)
- `'r'` → coin flip

`startGame` also bumps `_searchGeneration` to invalidate any in-flight worker requests from a previous game. If `humanColor !== 'w'`, `triggerComputerMove()` fires for white's first move.

**Input** — both click-to-move and drag-and-drop work, on both the human's turn and the opponent's turn (the latter goes into premove mode). The piece-level `mousedown` handler starts a drag with a free-floating ghost glyph that follows the cursor. The document-level `mouseup` resolves it.

**Move list** — in analysis mode this renders a full variation tree (`_renderAnalysisMoveList`). Main-line moves use the existing `.move-pair` structure; branches appear as horizontally-scrollable `.branch-row` divs after their fork point. Left/right arrow keys navigate the tree.

**Eval bar — analysis mode only.** The `.eval-bar-container` is `display: none` by default and only gets `.visible` toggled on when the user clicks **Analyze** from the game-over overlay. `updateEvalBar(score)` accepts a value in pawns from white's perspective, clamped to `[-10, +10]`, and updates the white/black fill heights. The score is fed asynchronously from the worker via `askEngineAnalyze`.

## Sound System

All audio is routed through `playSound(type)` which uses the Web Audio API. Two audio paths:

- **File-based** (`move`, `capture`) — base64-encoded OGG data URLs embedded in `_AUDIO_DATA`, decoded once at script load into `_audioBuffers`. Played via `createBufferSource()`.
- **Synthesised** (everything else) — generated on the fly using oscillators (`_osc`) and low-pass filtered noise bursts (`_noize`).

### Sound types and when they fire

Sound priority in `executeMove`: `checkmate → check → castle → promotion → capture → move`. The `isCastleMove` flag (king moved exactly 2 squares horizontally, detected before `applyMove`) gates the castle branch. In analysis mode, the same priority is baked into each tree node's `sound` field at creation time and replayed on navigation.

| Type | Trigger | Synthesis |
|---|---|---|
| `move` | Quiet non-castle move | OGG file (wooden piece) |
| `capture` | Any capture | OGG file (harder wooden thud) |
| `castle` | King castles (either side, either color) | Two low-pass noise bursts 140 ms apart — king slides, rook follows |
| `check` | Move gives check | Two rising oscillator tones (660 Hz → 880 Hz) |
| `checkmate` | Move delivers checkmate | Three descending oscillator tones (494 → 392 → 294 Hz) |
| `promotion` | Pawn promotes (dialog confirmed) | Rising five-note arpeggio (C5–E5–G5–B5–E6) |
| `premove` | Premove queued | Single short noise burst (750 Hz LP) |
| `win` | Game won | Four ascending tones |
| `loss` | Game lost | Four descending tones |
| `draw` | Game drawn | Two equal tones |

The `AudioContext` is created eagerly at script load (suspended by browser policy) and resumed in `_unlockAudio()` which fires from the `startGame()` button click. Chrome's auto-suspend after ~3 s of silence is handled by a `statechange` listener that immediately calls `resume()`. A silent keep-alive oscillator node prevents re-suspension during long CPU think-times.

## Multiplayer (Human vs. Human)

Opt-in mode, gated entirely on a single `gameMode` flag (`'cpu' | 'human'`, default `'cpu'`). When `gameMode === 'cpu'` the entire CPU code path is **bit-for-bit identical** to the original — multiplayer code is invisible. Verify with `grep gameMode chess.html`: hits appear only at the three integration seams and inside the new multiplayer client block.

### Three integration seams in `chess.html`

| Seam | Function | Change |
|---|---|---|
| 1 | `executeMove` tail | Adds optional `_fromRemote = false` 4th parameter. In human mode, sends the just-played move to the server (when `!_fromRemote`) and runs `tryExecutePremove` if it's now the human's turn. CPU branch is untouched. |
| 2 | `triggerComputerMove` top | `if (gameMode === 'human') return;` — the function is otherwise unchanged. The Web Worker is still loaded for post-game analysis. |
| 3 | `startGame` head | Adds optional `multiplayerCtx = null` 2nd parameter. When supplied, sets `gameMode = 'human'`, persists `_gameCode`/`_playerToken`. When null, resets to CPU defaults. The remaining body (which still ends with `triggerComputerMove()`) is unchanged — Seam 2 makes that call a no-op in human mode. |

Additional small `if (gameMode === 'human')` branches: `confirmResign` (sends `resign` to server), `offerDraw` (sends `offerDraw`, or `acceptDraw` if recipient), `tickClock` (suppresses local `handleTimeout` — server is the authority), `resetGame` (closes WS, clears multiplayer state, resets to CPU tab), `updateStatus` and `showGameOver` (say "Opponent" instead of "(CPU)" and route resignation/forfeit text by `G.resignedColor` / `G.forfeitColor`).

### Server (`server.js`)

In-memory only, single-file Node.js script. Listens on `:8080`. One `rooms: Map<code, GameRoom>` keyed by a 6-char alphanumeric join code. Each room holds the **authoritative** game state (board mirror, clocks, history, status, drawOffer, rematchOffer, disconnect timers). Server does **no chess-legality validation** — clients are trusted; the server only checks turn ownership, game status, and identity (the message must come from the socket registered as the active player). The server's board mirror exists solely to populate `stateSnapshot` for reconnect.

**Server-authoritative clocks** are event-driven, not tick-based: when `activeColor` is set, the server records `activeStartedAt = Date.now()` and `setTimeout(timeoutFire, remainingMs)`. On any state-mutating event (move, resign, accept-draw, forfeit) it deducts elapsed time, applies increment, clears the timeout, and re-arms for the new active color. If the timeout fires before any event, the server broadcasts `gameOver { status: 'timeout', winner }`.

### Wire protocol (JSON over WebSocket)

| Direction | Type | Payload |
|---|---|---|
| C→S | `create` | `{ timeSec, incSec, colorChoice: 'w'|'b'|'r' }` |
| C→S | `join` | `{ code }` |
| C→S | `move` | Full post-move client history entry: `{ from, to, promo, notation, sound, terminalStatus, drawBy, capturedPiece, boardAfter, enPassantAfter, castlingAfter, halfMoveAfter, turnAfter, fullMoveAfter, capturedByWhiteAfter, capturedByBlackAfter, clockWhite, clockBlack, moveTime }`. Server stores this so reconnect snapshots match the client's `G.history` shape exactly. |
| C→S | `resign`, `offerDraw`, `acceptDraw`, `declineDraw` | `{}` |
| C→S | `reconnect` | `{ code, token }` |
| C→S | `cancelCreate` | `{}` |
| C→S | `rematchOffer` | `{ settings: { timeSec, incSec, offererColor } }` |
| C→S | `rematchAccept`, `rematchDecline`, `rematchCancel` | `{}` |
| S→C | `created` | `{ code, token, color, settings }` (just to the creator; modal switches to Waiting pane) |
| S→C | `start` | `{ color, settings, code, token, gameCount }` (broadcast to both at game start and after rematch acceptance) |
| S→C | `move` | Lightweight: `{ from, to, promo, clockWhiteMs, clockBlackMs, activeColor, ... }` — sent to **opponent only**. Opponent's client recomputes notation/sound/captures via its local executeMove call. |
| S→C | `moveAck` | `{ clockWhiteMs, clockBlackMs, activeColor }` — sent to **mover only** for clock-resync. |
| S→C | `gameOver` | `{ status, drawBy?, winner, resignedColor?, timeoutColor?, forfeitColor?, clockWhiteMs, clockBlackMs }` |
| S→C | `drawOffered`, `drawDeclined`, `rematchOffered`, `rematchAccepted`, `rematchDeclined`, `rematchCancelled` | event broadcasts |
| S→C | `opponentDisconnected` | `{ graceMs }` |
| S→C | `opponentReconnected` | `{}` |
| S→C | `stateSnapshot` | Full state for reconnect: position, history array (in the client's exact shape), clocks, captures, status, drawOfferFromColor, rematchOffer. |
| S→C | `error` | `{ code, msg }` |

### Module-level multiplayer state in `chess.html`

```js
let gameMode               = 'cpu';   // 'cpu' | 'human' — gate flag
let _ws                    = null;
let _gameCode              = null;
let _playerToken           = null;
let _drawOfferFromColor    = null;    // 'w' | 'b' | null
let _opponentConnected     = true;
let _disconnectGraceUntil  = 0;
let _disconnectCountdownTimer = null;
let _multiplayerWaiting    = false;
let _rematchOfferFromColor = null;
let _rematchOfferSettings  = null;
let _originalGameSettings  = null;
let _gameOverShown         = false;   // dedupes the result sound when local detection and server broadcast both fire
const HUMAN_WS_URL         = 'ws://localhost:8080';
```

Per-player status fields added to `G` (only set in multiplayer game-over paths): `G.resignedColor`, `G.forfeitColor`. The existing `G.timeoutColor` is reused.

### Color-picker modal — tabs

The existing `#color-overlay .modal` now starts with a tab bar:

- **vs CPU** (default active) — pane `#cpu-tab-content` wraps the original time/increment/difficulty/color UI literally. Existing `selectTime`/`selectIncrement`/`selectDifficulty`/`startGame` onclick handlers untouched.
- **vs Human** — pane `#human-tab-content` with sub-tabs Create / Join / Waiting:
  - `#mp-create-pane`: separate time/inc/color buttons using `data-mp-seconds` / `data-mp-inc` / `data-mp-color` attributes (no global selector collisions with the CPU pane). Driven by `selectMpTime`, `selectMpIncrement`, `selectMpColor`. Submit via `mpCreateClick`.
  - `#mp-join-pane`: 6-char code input (`#mp-join-code`) + Join button (`mpJoinClick`).
  - `#mp-waiting-pane`: shows the assigned code (`#mp-share-code`), the assigned color, a Cancel button (`mpCancelWaiting`). Tab buttons are hidden while waiting.

The tab-switch helpers are `switchModeTab('cpu'|'human')` and `switchMpTab('create'|'join'|'waiting')`.

### Move flow in human mode

1. **Local user moves.** `onSquareClick` or drag-drop or `tryExecutePremove` calls `executeMove(from, to, promo)`. At the tail (Seam 1), because `gameMode === 'human'` and `_fromRemote` is undefined, it sends the full post-move state to the server via `sendMoveToServer`.
2. **Server processes.** Stops the mover's clock (deducting elapsed), applies increment, broadcasts a lightweight `move` to the opponent and a `moveAck` (clocks only) to the mover.
3. **Mover receives `moveAck`.** `applyServerClocks(clockWhiteMs, clockBlackMs, activeColor)` re-anchors clocks to the server's truth. This erases RTT drift.
4. **Opponent receives `move`.** Their client calls `executeMove(msg.from, msg.to, msg.promo, true)` (the 4th arg is `_fromRemote`). The local executeMove computes its own notation, sound, capture lists, and terminal-state detection — they match the mover's because both clients ran the same engine code on the same board. Then `applyServerClocks` re-anchors clocks.
5. **Premoves still work.** Inside `executeMove`'s human-mode tail, `tryExecutePremove` fires when it's the human's turn again — exactly as in CPU mode. The `_fromRemote` flag is a parameter (not a global), so it doesn't leak into the recursive premove invocation; the premove fire is correctly identified as "my move" and sent to the server.

### Resign

`confirmResign` sends `{ cmd: 'resign' }`. Server sets `status = 'resignation'`, `winner = opposite`, broadcasts `gameOver { status, resignedColor, winner }`. Both clients run `handleMpGameOver` → set `G.status`, `G.resignedColor`, call `updateStatus` + `showGameOver`. The text routing in `showGameOver`/`updateStatus`/`getResultDisplayText`/`getResultString` selects the winner from `G.resignedColor` and adds a "(You)" suffix for the winner if it's the local player.

### Draw flow

Server holds a single `drawOfferFromColor: 'w' | 'b' | null`. State machine:

| Event | Server | Both clients |
|---|---|---|
| A sends `offerDraw` | `drawOfferFromColor = A`. Broadcast `drawOffered { fromColor: A }`. | A's `#draw-btn` disabled with label "Draw Offered". B sees `#draw-btn` with `.btn-draw-accept` class (inverted color) labelled "Accept Draw" + a new `#draw-decline-btn` next to it. |
| B sends `acceptDraw` | Status = `'draw'`, `drawBy = 'agreement'`. Broadcast `gameOver { status, drawBy }`. | Modal shows "Draw by agreement". |
| B sends `declineDraw` | `drawOfferFromColor = null`. Broadcast `drawDeclined`. | Both buttons reset; brief "Draw offer declined" in status. |
| A or B sends a `move` | `drawOfferFromColor = null` silently. Move broadcasts go out as normal. | Each client's `move` / `moveAck` handler resets `_drawOfferFromColor = null` and calls `updateDrawButtonUI()`. |

`updateDrawButtonUI()` is the single source of truth for the three-button state — it reads `gameMode`, `G.status`, and `_drawOfferFromColor` and toggles classes/labels/visibility accordingly.

### Disconnect + reconnect

- **On disconnect** (WS close from a player in a live game): server arms `setTimeout(forfeit, 30000)`, broadcasts `opponentDisconnected { graceMs: 30000 }` to the other player. **Clocks keep running normally during the grace** (no pause — user's design choice).
- **If grace expires:** server stops clocks, sets `status = 'forfeit'`, broadcasts `gameOver { status: 'forfeit', forfeitColor, winner }`.
- **Reconnect:** client persists `{ code, token, color }` in `sessionStorage` after Create/Join. On page load, an IIFE (`tryAutoReconnect`) checks sessionStorage and sends `reconnect { code, token }`. Server validates the token, cancels the forfeit timer, sends `stateSnapshot` with the full history array (in the client's exact `G.history` shape) plus clocks, captures, status, draw/rematch offers. Client's `handleMpStateSnapshot` rebuilds `G.history`, `G.positionCounts`, the move list, captures, clocks, and renders. Server broadcasts `opponentReconnected` to the other player, which dismisses their disconnect banner.

The banner element is `#mp-banner` (above the board). A 1s `setInterval` updates the countdown text.

### Rematch flow

The game-over modal grows a multiplayer-only `#rematch-section` (hidden via the `.visible` class). It contains:
- Two default buttons: **Rematch — Same Settings** and **Rematch — Different Settings**.
- A `#rematch-different-pane` with time / increment / color pickers (`data-rmtime` / `data-rminc` / `data-rmcolor`) + Send Offer / Back.
- A `#rematch-pending-pane` ("Rematch offer sent… [Cancel Offer]") shown when the local player has an outstanding offer.
- A `#rematch-incoming-pane` (Accept / Decline) shown when the opponent has offered.

`refreshRematchUI()` is the single state-machine driver, keyed on `_rematchOfferFromColor` and `_rematchOfferSettings`.

**Same Settings** sends `{ timeSec: clockTimeControl, incSec: clockIncrementMs/1000, offererColor: opposite(humanColor) }` — swaps colors, keeps the just-played time control.

**Different Settings** sends whatever the user picked in the sub-panel.

**Compatibility race:** when both players click Same Settings within milliseconds of each other, the server processes the first offer normally, then sees the second offer arrives with identical settings + compatible colors → treats it as an `rematchAccept` and broadcasts `rematchAccepted` + fresh `start { color, settings }` to both. If the second offer is incompatible (different time, or incompatible colors), the server sends `error { code: 'OFFER_EXISTS' }` to the second player.

**On `rematchAccept`,** the server resets the room's game state (board, clocks, history, captures, status, drawOffer, rematchOffer), increments `gameCount`, re-assigns `players.w` / `players.b` based on the offer's resolved colors, and broadcasts `start` to both. The client's `handleMpStart` calls `startGame(assignedColor, multiplayerCtx)` — the same code path used at initial start, so the existing cleanup (clears analysis tree, eval bar, history, captures) runs unchanged.

### Analysis after game ends

Each player can click **Analyze** on the game-over modal and get a completely independent local tree — `enterAnalysisMode()` reads `G.history` (which is fully populated on both sides because both clients ran `executeMove` for every move). Branching, eval bar, and commentary all work without any server interaction. The Web Worker (still loaded since startup) drives the eval bar.

### Important multiplayer functions — where to look

| What | Function | Lives at roughly |
|---|---|---|
| Three integration seams | `executeMove` / `triggerComputerMove` / `startGame` | search the file for "Multiplayer Seam" |
| Tab switching | `switchModeTab`, `switchMpTab` | bottom multiplayer block |
| Settings selection | `selectMpTime`, `selectMpIncrement`, `selectMpColor`, `selectRmTime`, `selectRmIncrement`, `selectRmColor` | bottom multiplayer block |
| Connection lifecycle | `connectWS`, `sendWS`, `_mpCleanupConnection`, `tryAutoReconnect` IIFE | bottom multiplayer block |
| Dispatch | `onWSMessage` | bottom multiplayer block |
| Server-message handlers | `handleMpCreated` / `handleMpStart` / `handleMpRemoteMove` / `handleMpMoveAck` / `handleMpGameOver` / `handleMpDrawOffered` / `handleMpDrawDeclined` / `handleMpOpponentDisconnected` / `handleMpOpponentReconnected` / `handleMpStateSnapshot` / `handleMpRematchOffered` / `handleMpRematchAccepted` / `handleMpRematchDeclined` / `handleMpRematchCancelled` / `handleMpError` | bottom multiplayer block |
| Outgoing move | `sendMoveToServer` | bottom multiplayer block |
| Server-clock helper | `applyServerClocks` | bottom multiplayer block |
| Draw-button state | `updateDrawButtonUI`, `mpDeclineDraw` | bottom multiplayer block |
| Banner | `_showMpBanner`, `_hideMpBanner` | bottom multiplayer block |
| Rematch UI | `showRematchSection`, `refreshRematchUI`, `mpRematchOfferSame`, `mpRematchOpenDifferent`, `mpRematchOfferDifferent`, `mpRematchAccept`, `mpRematchDecline`, `mpRematchCancelOwn`, `formatRematchSettings` | bottom multiplayer block |

## Analysis Variation Tree

When the user clicks **Analyze**, `enterAnalysisMode()` converts `G.history` into a branching `TreeNode` structure. Each node stores the position after its move plus `parent`/`children` references so alternative continuations can be explored at any depth.

### Tree node structure

```js
{
  id,           // unique integer (from _nextNodeId++)
  parent,       // parent TreeNode or null for root
  children,     // array of child TreeNodes
  board,        // Array(64) — position AFTER this move
  turn,         // 'w'|'b' — side to move AFTER this move
  enPassant, castling, fullMove,
  lastFrom, lastTo, promo, notation, sound,
  capturedByWhite, capturedByBlack,
  clockWhite, clockBlack, moveTime,
  terminal,     // true when this is where the live game ended
}
```

**Key invariant**: `node.turn` is the side to move *after* the move that created this node, so `moverColor = node.turn === 'w' ? 'b' : 'w'`. The commentary system uses this to identify which player made the move leading to `node`.

### Navigation

`_jumpToAnalysisNode(node)` is the single entry point. It:
1. Sets `G.board/turn/enPassant/castling` from the node (or from `parseFen(INIT_FEN)` for root).
2. Sets `G.viewingSnap = node.id` — every other system uses this as the "current position" key.
3. Triggers a debounced (120 ms) `_submitAnalyze` call for the eval bar.
4. Calls `scheduleCommentaryForNode(node)` for move commentary.

### Eval submission — serialized last-value queue

`_submitAnalyze(board, turn, ep, castling, snapIdx)` sends a position to the worker via `askEngineAnalyze`. Only one analysis request runs at a time (`_analyzeRunning` flag). A second call while one is in flight stores itself in `_pendingAnalyze` (last-value queue — only the most recent request is kept). When the running request completes it dispatches `_pendingAnalyze` if set.

**Parent-eval auto-fetch**: when a node's eval arrives and commentary is still waiting for the parent's eval (common when clicking any arbitrary move directly), `_submitAnalyze` automatically queues a fetch for the parent node's position before dispatching `_pendingAnalyze`. This guarantees both `evalKeyBefore` and `evalKeyAfter` arrive without requiring the user to navigate in sequence.

## Move Commentary System

After entering analysis mode, clicking any move in the tree shows a natural-language analysis of that move in the `#commentary-box`. The system is entirely rule-based — no LLM involved. It runs on the main thread using the same engine helper functions (`pseudoMoves`, `isSquareAttacked`, `legalMoves`, etc.).

### State variables

```js
// Cache: node.id → { rating, text, hasEval }
// hasEval: true  = computed with actual engine scores (authoritative, shown immediately)
// hasEval: false = computed from pattern fallback only (stale; discarded when eval arrives)
const _commentaryCache = new Map();

// Engine scores: node.id → centipawns (white POV) — filled by _submitAnalyze
const _evalScores = new Map();

let _commentaryTimer = null;           // active dwell-time timeout handle
let _commentaryCurrentNode = null;     // node whose commentary is currently displayed
```

Both maps are cleared in `startGame()`.

### Flow: `scheduleCommentaryForNode(node, immediate)`

This is the single entry point for displaying commentary. Called by `_jumpToAnalysisNode`.

1. **Cache hit with `hasEval !== false`** → show immediately, return.
2. **No valid cache hit** → call `_setCommentaryUI('pending')` to show "Analyzing…" right away (prevents stale prior commentary from remaining visible).
3. Start a `COMMENTARY_DWELL_MS` (600 ms) dwell timer. When it fires:
   - Bail if the user navigated away (`G.viewingSnap !== cacheKey`).
   - Compute `hasEvalNow = _evalScores.has(evalKeyBefore) && _evalScores.has(evalKeyAfter)`.
   - Run `_analyzeMoveCore(...)` to get `{rating, text}`.
   - Store in cache with `hasEval: hasEvalNow`.
   - **Only call `_setCommentaryUI('result', ...)` when `hasEvalNow` is true.** If eval hasn't arrived yet, leave "Analyzing…" showing — the eval-arrival path in `_submitAnalyze` will call `scheduleCommentaryForNode(cn, true)` (immediate=true, skips the 600 ms delay) once both scores land.

### Eval-arrival refresh (inside `_submitAnalyze`)

When the engine posts back a score for `snapIdx`:
1. `_evalScores.set(snapIdx, r.score)`.
2. Check if `_commentaryCurrentNode` uses this eval (`cn.id === snapIdx` OR `cn.parent.id === snapIdx`).
3. If so, and if the cached entry has `hasEval: false` (or no cache), delete the cache and call `scheduleCommentaryForNode(cn, true)` — the immediate re-run will have both scores available and will show the final result.

### `_setCommentaryUI(state, rating?, text?)`

Three states:
- `'idle'` — "Navigate to a move to see analysis." (shown at root or no move selected)
- `'pending'` — "Analyzing…" (shown while waiting for eval or dwell timer)
- `'result'` — shows the rating badge + text

### `_analyzeMoveCore(boardBefore, boardAfter, moverColor, epAfter, castAfter, san, evalKeyBefore, evalKeyAfter)`

The main analysis function. Returns `{rating, text}` or `null`. Steps:
1. Detect tactical/strategic patterns (see Pattern Detection below).
2. Call `_computeRating(evalKeyBefore, evalKeyAfter, moverColor, patterns)`.
3. Call `_generateText(rating, patterns, san, moverColor, evalBefore, evalAfter)`.

### Pattern Detection

Patterns detected in `_analyzeMoveCore` (stored in a `patterns` object):

| Pattern | Detection method |
|---|---|
| `isCheckmate` | `legalMoves` returns empty on `boardAfter` |
| `isCheck` | `isInCheck(boardAfter, oppColor)` |
| `discoveredCheck` | The moved piece's source square was blocking a friendly slider's attack line on the enemy king. Stored as `{ sliderPiece, sliderSq }` for use in text. |
| `fork` | The landed piece attacks ≥2 enemy pieces each worth ≥150 cp. Stored as array of `{ piece, sq }` objects. |
| `pin` | `_detectPin(boardAfter, to, moverColor)` — see Pin Detection below. Stored as `{ pinned, pinnedSq, behind, behindSq, absolute }`. |
| `discovery` | Moved piece unblocks a friendly slider that now attacks an enemy. Stored as `{ sliderPiece, sliderSq, targetPiece, targetSq }`. |
| `winningCapture` | Captured piece worth > mover + 50 cp, **or** same value but undefended (`freeCapture: true`). Stored as `{ captured, capturedBy, capturedSq, freeCapture, capturedWasDefended }`. |
| `equalCapture` | Same value (within 50 cp) and captured piece was defended. Stored as `{ captured, capturedBy, capturedSq }`. |
| `losingCapture` | Captured piece worth < mover − 50 cp. Stored as `{ captured, capturedBy, capturedSq }`. |
| `hangingOwn` | Most valuable hanging piece of `moverColor` after the move (from `_hangingPieces`) |
| `promotion` | Pawn reached last rank |
| `castling` | King moved 2 squares |
| `development` | Minor piece moved off back rank for the first time (fullMove ≤ 15) |
| `passedPawn` | Pawn landed in a position where `_isPassedPawn` returns true |
| `outpost` | Knight or bishop landed in enemy half with `_isOutpost` true AND not hanging (see Outpost Guard) |
| `openFile` | Rook moved to a file with no pawns |

All piece-referencing patterns include the square index so `_generateText` can call `indexToAlgebraic(sq)` to produce human-readable square names (e.g. "knight on f6", "rook on c1").

**Capture classification (`capturedWasDefended`)**: To check if the captured piece was defended, `defCheck` is constructed by setting `defCheck[from] = null` and `defCheck[to] = movedPiece` (the capturing piece, NOT null). Placing the mover's piece on `to` is critical — `pseudoMoves` for pawns only generates diagonal captures when an enemy piece occupies the target square. Setting `to` to null would make pawn defenders invisible.

### Pin Detection (`_detectPin`)

The moved slider (R/B/Q) shoots a ray from `to` in each legal direction. When the ray hits a first enemy and then a more-valuable enemy (or king), a pin is reported — subject to these filters:

1. **Value threshold**: only absolute pins (king behind) or pins against R/Q (≥500 cp). Pins of minor pieces against other minors are not reported.
2. **Queen-behind filter**: if the piece behind is a queen and our slider is ≥ queen value, skip (equal trade, not a real pin).
3. **Pawn-on-file filter**: if the pinned piece is a pawn and the ray is along a file (d = ±8), only report if the pawn has an enemy piece it can diagonally capture (pawns can always leave a file via capture, so a file pin on a pawn with no capture target isn't real).
4. **Relative pin practicality filter**: for non-absolute pins, only report if (a) the pinner is cheaper than the pinned piece (profitable to capture), OR (b) the pinned piece is completely undefended (check by removing it and testing `isSquareAttacked`).

### Outpost Guard

Before flagging a knight/bishop as an outpost:
1. `_isOutpost(boardAfter, to, moverColor)` — no enemy pawn on adjacent files that could ever advance to attack `to`. **Direction**: for white pieces, checks ranks above (black pawns advance downward, attacking from above); for black pieces, checks ranks below (white pawns advance upward, attacking from below). `const dir = color === 'w' ? 1 : -1`.
2. Scan all enemy pieces: `pseudoMoves(boardAfter, s, oppColor, ...).some(m => m === to)` — note: `pseudoMoves` returns plain integers so comparison is `m === to`, NOT `m.to === to`.
3. `outpostHangs = minEnemyAtk < Infinity && (minEnemyAtk < pieceVal || undefended)`.
4. Only set `patterns.outpost` when `!outpostHangs`.

### Rating System (`_computeRating`)

**Eval-based (when both scores are cached):**

| Centipawn diff (mover's POV) | Rating |
|---|---|
| ≥ +150 or checkmate | Best |
| ≥ −20 | Excellent |
| ≥ −80 | Good |
| ≥ −200 | Ok |
| < −200 | Bad |

**Rating cap** — prevents "Bad" when still clearly winning after the move:
- `meEvalAfter ≥ 700 cp`: Bad or Ok → Good
- `meEvalAfter ≥ 150 cp`: Bad → Ok

**Pattern-based fallback** (when engine score not yet cached): ordered priority — checkmate → promotion (unless `netNegative`) → high-value fork (unless `netNegative`) → `netNegative` override → discoveredCheck → fork → absolute pin → winningCapture → check → relative pin → discovery → equalCapture → castling → passedPawn → outpost → openFile → losingCapture → development → Ok.

`netNegative = hangingOwn ≥ 500 cp AND hangingOwn > captureVal + 50 cp` — forces Bad even if a positive pattern was found.

### Text Generation (`_generateText`)

Context flags computed from `meEvalBefore`/`meEvalAfter` (mover's POV):

| Flag | Condition |
|---|---|
| `wasWinning` | meEvalBefore > 250 |
| `wasUp` | meEvalBefore > 60 |
| `wasEqual` | neither wasUp nor wasDown |
| `wasDown` | meEvalBefore < −60 |
| `wasLosing` | meEvalBefore < −250 |
| `nowWinning` | meEvalAfter > 250 |
| `nowUp` | meEvalAfter > 60 |
| `nowEqual` | neither nowUp nor nowDown |
| `nowDown` | meEvalAfter < −60 |
| `nowLosing` | meEvalAfter < −250 |

Composite flags: `gaveUpWin`, `gaveUpEdge`, `heldWin`, `gainedWin`, `heldEquality`, `stillLosing`, `inTough`.

**Bad moves always return early** before positive patterns are considered. The `gaveUpWin` branch distinguishes four severity levels based on `meEvalAfter`:
- `nowLosing` → "catastrophic blunder / complete reversal"
- `nowDown && !nowLosing` → "throws away winning advantage / fighting from behind"
- `nowEqual` → "squanders the winning advantage / now equal"
- fallthrough (still `nowUp`) → "reduces the advantage / still holds an edge"

**"Clear/decisive advantage" language** is gated on `nowLosing` (≥250 cp swing). A position that only swings to +2.0 uses softer language ("takes the initiative", "gains the upper hand").

**Exchange detection in `winningCapture` text** — the raw pattern classification (`winningCapture`) only looks at piece values, not at whether the move was a recapture in an ongoing exchange. Text generation applies a second proportional-threshold check:

```js
const isExchangeContext = meEvalAfter != null && (
  freeCapture
    ? (nowEqual || nowDown)                                   // equal-value pieces: eval near zero
    : meEvalAfter < _pVal(captured) - _pVal(capturedBy) - 50 // e.g. pawn×bishop: threshold 175 cp
);
```

If `isExchangeContext`, the text says "recaptures … completing the exchange" instead of "wins material". This catches recaptures even when the capturing piece delivered check (which inflates eval by 70–100 cp, bypassing a simpler `nowEqual` check), and is independent of `capturedWasDefended`.

**Piece references** — all commentary text that mentions a specific piece includes its current board square via `indexToAlgebraic(sq)`, e.g.:
- Pins: "pins the **knight on f6** against the more valuable **queen on d8**"
- Forks: "forks the **rook on a8** and the **queen on e5**"
- Discoveries: "reveals the **bishop on b2** bearing down on the **queen on g7**"
- Captures: "the pawn takes the **bishop on c3**"

## Premove System

The user can queue moves on the opponent's turn. The data side of the game state stays clean (no extra pieces, real `G.board` untouched until premoves actually execute); only the rendered view shifts pieces around to preview where they'll end up.

**Queue** — `G.premoves` is an ordered array of `{from, to, promo}`. Promotion premoves auto-default to queen.

**Display board** — `getDisplayBoard()` returns a copy of `G.board` with all queued premoves applied in order. The renderer reads from this, so a knight at f3 with a queued Nf3-Nd4 *appears* on d4. Castling premoves move the rook in the display too, so chained king-rook sequences work visually.

**Move pattern generation** — `premoveTargetsFor(displayBoard, from)` is intentionally permissive: it returns every square the piece *could* theoretically reach on an empty board.
- Sliders (R/B/Q) include all squares along their rays, ignoring blockers.
- Knights get all 8 jumps.
- Kings get their 8 surrounding squares plus both castling squares (g-file and c-file) whenever the king is on its starting square — castling premoves are always offered.
- Pawns get single push, double push from starting rank, and both diagonals — diagonals are included even if no enemy is present (premove captures-of-future-pieces and en-passant setups).

The actual legality (rights, path-clear, not through check, etc.) is verified **only at execution time**.

**Execution** — at the tail of `executeMove`, when control just returned to the human and the queue is non-empty, `tryExecutePremove` is called. It pops the first entry, validates against the **real** post-opponent board via `legalMoves`, and either executes it (which then triggers the next 3-second computer move) or — if illegal — calls `cancelPremoves()` to clear the **entire** queue per spec.

**Visuals** — each queued premove gets a distinct color from a 6-step palette (`premoveColorFor`): red → orange → gold → green → blue → purple. Red is the next one to fire. The `renderBoard` builds a `premoveIndexFor` map keyed by square; for chained premoves where one's destination equals the next's source, the earlier premove's color wins on the bridge square. Colors are applied via inline `style.setProperty('background', ..., 'important')` so they beat the default `.sq.premove` class background.

The square currently being composed (between mousedown and queue) gets a `.premove-selected` orange outline.

**Cancellation**
- **Right-click anywhere on the board** cancels all queued premoves.
- **Holding a piece across the turn flip** (you started a drag during the computer's think-time, but the computer's move landed before you released) cancels cleanly on release — no premove queued, no real move attempted.
- An **illegal premove** cancels every subsequent queued premove.
- `executeMove` clears the in-progress selection state (`premoveSelected` / `premoveTargets`) so stale highlights don't linger after a turn flip.

## Anti-Drag Hardening

Browsers will happily start native HTML5 drag operations on board elements if not stopped. To prevent the "phantom hollow board image being dragged" bug:
- `#board`, `.sq`, `.piece` all carry `-webkit-user-drag: none` and `user-select: none`.
- `mousedown` on an empty square calls `e.preventDefault()` so the browser never enters drag-detection mode.
- A document-level `dragstart` listener calls `preventDefault()` on anything inside `.board-container, #board, .sq, .piece`.

## Color-Picker Modal Layout

The color-picker overlay has its own `max-width: 400px` override (`#color-overlay .modal`) so all three buttons (White / Black / Random) fit on one centered row. The buttons themselves carry `flex: 0 0 auto` and the row has `flex-wrap: wrap` as a safety net.

## Important Functions — Where to Look

| What | Function | Lives at roughly |
|---|---|---|
| Engine — move generation | `pseudoMoves` | early in the script |
| Engine — legality + check filter | `legalMoves` | mid-engine section |
| Engine — apply a move | `applyMove` | mid-engine section |
| Initial state | `newGame` | start of GAME STATE section |
| Premove queue helpers | `getDisplayBoard`, `premoveTargetsFor`, `addPremove`, `tryExecutePremove`, `cancelPremoves`, `premoveColorFor` | PREMOVE HELPERS section |
| Static eval (tapered, white POV) | `evaluateBoard`, `evaluateMGEG` | EVALUATION ENGINE / MAIN EVALUATION |
| Phase, scale factor, tempo | `gamePhase`, `phase128`, `scaleFactor`, `TEMPO_BONUS` | MAIN EVALUATION |
| Pawn structure / threats / space / king safety | `pawnStructureMGEG`, `evalThreatsMGEG`, `evalSpaceMG`, `kingZoneSafety` | EVALUATION ENGINE |
| Transposition table | `positionHash`, `ttProbe`, `ttStore`, `ttClear` | SEARCH section |
| Move ordering (killers + history + TT) | `moveOrderScoreEx`, `orderMovesEx`, `_killers`, `_history` | SEARCH section |
| Negamax with TT/NMP/RFP/FP/LMR/PVS/CE | `negamax`, `quiesce`, `hasNonPawnMaterial` | SEARCH section |
| Iterative deepening + aspiration | `computerMove` | COMPUTER PLAYER section |
| Difficulty settings | `DIFFICULTY` object | COMPUTER PLAYER section |
| Worker source assembly | `_makeEngineWorker` | ENGINE WORKER section |
| Async wrappers | `askEngineMove`, `askEngineAnalyze` | ENGINE WORKER section |
| Trigger CPU move (UX) | `triggerComputerMove` | UI section |
| Render the board | `renderBoard` | UI section |
| Mouseup → resolve drag/drop | bottom of the document-level listeners | UI section |
| Click input router | `onSquareClick` | UI section |
| Move execution + premove trigger | `executeMove` | UI section |
| Sound dispatch | `playSound` | AUDIO section |
| Analysis tree — build | `_buildAnalysisTree`, `_mkAnalysisNode` | ANALYSIS TREE section |
| Analysis tree — navigate | `_jumpToAnalysisNode` | ANALYSIS TREE section |
| Analysis tree — render move list | `_renderAnalysisMoveList` | ANALYSIS TREE section |
| Enter analysis mode | `enterAnalysisMode` | UI section |
| Eval submission (serialized) | `_submitAnalyze` | ANALYSIS TREE section |
| Commentary — entry point | `scheduleCommentaryForNode` | MOVE COMMENTARY section |
| Commentary — UI update | `_setCommentaryUI` | MOVE COMMENTARY section |
| Commentary — core analysis | `_analyzeMoveCore` | MOVE COMMENTARY section |
| Commentary — rating | `_computeRating` | MOVE COMMENTARY section |
| Commentary — text generation | `_generateText` | MOVE COMMENTARY section |
| Commentary — pin detection | `_detectPin` | MOVE COMMENTARY section |
| Commentary — outpost check | `_isOutpost` | MOVE COMMENTARY section |
| Commentary — passed pawn check | `_isPassedPawn` | MOVE COMMENTARY section |
| Commentary — hanging pieces | `_hangingPieces` | MOVE COMMENTARY section |
| Eval bar (analysis mode only) | `updateEvalBar`, `enterAnalysisMode` | end of script |

## Known Extension Points (next steps)

The full project goal (multi-client server, LLM eval bar) is not yet started — the file is still a self-contained, client-only prototype.

### Engine — remaining improvements

- **Zobrist hashing** — the current TT uses an FNV-1a hash of the FEN-like string. It works fine at our search scale but isn't incrementally updatable. Switching to Zobrist keys (XOR'd into a single 64-bit number on each move) would make `positionHash` essentially free (it's now also computed per node for repetition detection).
- ✓ **Static-exchange evaluation (SEE)** — done. `seeCapture` prunes losing captures in quiescence and is available for move ordering.
- **Incremental / make-unmake board** — `applyMove` copies the 64-element board array at every node. A make/unmake scheme (or typed-array board) is the next big NPS lever after the isSquareAttacked and lazy-eval rewrites.
- **Better king-safety zone** — Stockfish's attack-units use per-piece attack-zone weights (different for N/B/R/Q) and a quadratic combined-attacker scaling. We approximate it; a fuller implementation would help.
- **Tapered piece-bonus tables for threats** — current threat bonuses are single-pair constants per victim type. Real Stockfish has richer tables.

### Commentary — remaining improvements

- **Fork detection for more piece types** — currently forks are detected for the landing piece; discovered attacks (e.g. a bishop revealed to attack two pieces) are not yet modeled.
- **Zwischenzug / in-between moves** — no model for intermediate tactics that avoid losing material by inserting a stronger threat.
- **LLM analysis hook** — the commentary system's `_generateText` is the natural seam for adding LLM-powered natural language. The pattern/rating output from `_analyzeMoveCore` could be fed as structured input to an LLM prompt.

### Broader project

- ✓ **Multi-client server (Node.js + WebSockets) so two humans can play each other** — done. See the Multiplayer section above. CPU mode is preserved bit-for-bit; multiplayer is opt-in via the "vs Human" tab.
- Lobby / matchmaking UI (currently only direct code-based join is supported).
- Persistent server (current implementation is in-memory only — server restart loses all live games).
- Server-side legality enforcement (currently the server trusts clients for move legality; only turn-ownership and identity are validated).
- LLM-based natural-language game analysis panel.

## Recent Fixes Worth Knowing

- **Search engine substantially strengthened (July 2026)** — motivated by UCI gauntlet testing (see the separate `chess-bot-uci` repo) that showed the engine reaching only median depth 3 at blitz vs Stockfish's 14. Changes: (1) `isSquareAttacked` rewritten as reverse attack detection (~10x faster; also fixes pawn forward-push squares wrongly counting as attacked for castling-path checks — same fix ported to `server.js`); (2) lazy evaluation (`fastEval` + `evaluateBoardLazy`) — material+PST-only when ≥380 cp outside the window; (3) quiescence searches all evasions when in check (stand-pat in check was unsound) and prunes SEE-negative captures (`seeCapture`/`leastValuableAttacker`); (4) repetition detection in search (`_prevKeys` game hashes + `_pathKeys` path stack, draw score at ply>0, checked before TT); (5) TT persists across moves of a game (killers reset, history halves; cleared on worker restart/new game); (6) null-move pruning gains a `staticEval >= beta` guard; (7) `MAX_PLY` 64→128 with a killers-table guard; (8) `computerMove` accepts `prevKeys` and `softMs` (soft iteration-start deadline); `triggerComputerMove` passes game-history hashes. Browser CPU behavior otherwise unchanged (same difficulty budgets).

- **Hard mode engine significantly strengthened** — `maxDepth` raised from 10 to 14, `searchMs` from 2200 to 4500. Quiescence depth (`QMAX`) raised from 4 to 6. Added Reverse Futility Pruning (RFP: static eval − 120×depth ≥ beta → prune) and Futility Pruning (at depth 1–2, skip quiet moves where static eval + margin ≤ alpha). Both pruning techniques allow more effective use of the larger budget by cutting branches that cannot improve the result. Analysis eval bar search (`searchEval`) also upgraded: budget 600 ms → 1500 ms, depth cap 6 → 10.
- **Castle sound effect added** — `playSound('castle')` synthesizes two low-pass filtered noise bursts 140 ms apart (king slides into position, rook follows). Sound priority in `executeMove`: `checkmate → check → castle → promotion → capture → move`. `isCastleMove` is detected before `applyMove` while `G.board[from]` is still the king (`pieceType === 'k' && |to%8 − from%8| === 2`). Fires in all contexts: live CPU, live human-vs-human, and analysis navigation.
- **Commentary "wins material" false positive fixed** — capture text now applies a proportional threshold to distinguish genuine material gains from recaptures in exchange sequences. For an unequal capture (e.g. pawn×bishop), if `meEvalAfter < _pVal(captured) − _pVal(capturedBy) − 50`, the position improved by much less than the raw piece-value difference — indicating the prior move already offset the gain — and the text reads "recaptures … completing the exchange" instead of "wins material". This handles check-forcing recaptures (where a check bonus inflates eval by 70–100 cp, defeating simpler `nowEqual` checks) and is independent of `capturedWasDefended`.
- **Board square locations added to all commentary piece references** — pins, forks, discoveries, and captures all include `indexToAlgebraic(sq)` in the generated text. `_detectFork` returns `{ piece, sq }` objects; pin/discovery patterns store `pinnedSq`, `behindSq`, `sliderSq`, `targetSq`; capture patterns store `capturedSq`. Example output: "pins the **knight on f6** against the **queen on d8**", "forks the **rook on a8** and the **bishop on c6**".
- **Human-vs-human multiplayer added** — Node.js + `ws` WebSocket server in `server.js` + `package.json`. Browser-side, the new-game modal grew tabs (`vs CPU` / `vs Human`); the vs Human pane has Create / Join / Waiting sub-tabs. Three integration seams in `chess.html` (`executeMove`, `triggerComputerMove`, `startGame`) plus thin gameMode-branches in `confirmResign` / `offerDraw` / `tickClock` / `resetGame`. Everything else (engine, search, eval, premove queue, drag/drop, analysis tree, commentary, audio) is untouched and CPU mode is bit-for-bit identical. Server is authoritative for clocks and game-end conditions; trusts clients for move legality. 6-character alphanumeric codes; 30-second disconnect grace with `sessionStorage`-backed reconnect; full state-snapshot rebuild on reconnect; draw offer/accept/decline with auto-cancel-on-move; rematch (Same Settings / Different Settings) with first-to-server compatibility check. See the **Multiplayer (Human vs. Human)** section above.
- **Evaluation rewritten Stockfish-style** — tapered MG/EG accumulator, phase 0..128, scale factor, tempo, pawn-threat term, space, king-zone attack units. Knight-outpost rank-comparison bug fixed (was inverted for both colors, causing a consistent black-favored bias). Missing tempo bonus added.
- **Search rewritten with the Stockfish enhancement stack** — transposition table, null-move pruning, late-move reductions, principal-variation search, check extensions, mate-distance pruning, aspiration windows, killer & history move ordering. Quiescence depth bumped to 6 with delta pruning.
- **Search now runs in a Web Worker** — assembled from the same engine functions via `Function.prototype.toString()` (no code duplication). UI thread is never blocked, even during multi-second searches.
- **Eval bar restricted to analysis mode** — no longer shown during live play. Updated asynchronously via `askEngineAnalyze` when navigating snapshots in analysis mode.
- **Eval bar now reflects search score, not leaf static eval** — `computerMove` exposes `lastSearchScore` (white POV, centipawns) and the worker posts it back to the main thread.
- **Move commentary system added** — rule-based per-move analysis shown in `#commentary-box` during analysis mode. Detects checkmate, check, discovered check, forks, pins, winning/equal/losing captures, hanging pieces, promotions, castling, development, passed pawns, outposts, and open files. Rating (Best/Excellent/Good/Ok/Bad) and text are both calibrated against actual engine centipawn differentials.
- **Analysis variation tree** — history navigation upgraded from a flat snapshot array to a branching `TreeNode` structure supporting alternative continuations.
- **Commentary caching with `hasEval` flag** — entries computed without engine scores are marked stale (`hasEval: false`) and silently replaced when the eval arrives, preventing the wrong rating from appearing.
- **Commentary eval-arrival auto-fetch** — `_submitAnalyze` automatically queues a fetch for a node's parent eval when it arrives, so clicking any arbitrary move in the tree produces commentary without requiring sequential navigation from the start.
- **`_setCommentaryUI('pending')` state** — shows "Analyzing…" immediately on navigation instead of letting a stale prior message linger while the dwell timer runs.
- **Timer fires only when eval is ready** — `scheduleCommentaryForNode` only calls `_setCommentaryUI('result', ...)` when `hasEvalNow` is true, preventing a pattern-only flash before the real eval-based result.
- **`capturedWasDefended` fix** — the defense check now sets `defCheck[to] = movedPiece` (not null) so pawn defenders are correctly detected (pawns only generate diagonal captures when an enemy piece occupies the target).
- **`_isOutpost` direction fixed** — was completely inverted for both colors. White pieces now check ranks above (black pawns attack downward); black pieces check ranks below (white pawns attack upward).
- **Outpost guard `pseudoMoves` fix** — the hanging-piece scan used `.some(m => m.to === to)` but `pseudoMoves` returns plain integers; fixed to `.some(m => m === to)`.
- **Pin filters** — pawn-on-file pins only reported when a diagonal capture exists; relative pins only reported when pinner is cheaper than pinned piece OR pinned piece is undefended; queen-behind-queen pins excluded (equal trade, not a real pin).
- **Rating cap** — Bad→Ok threshold lowered from 300 cp to 150 cp so borderline wins aren't over-protected.
- **gaveUpWin severity sub-cases** — distinguishes catastrophic (winning→losing), bad (winning→behind), squandered (winning→equal), and reduced (still slightly ahead) based on post-move `meEvalAfter`.
- **"Clear advantage" language gated on `nowLosing`** — softer phrasing used when position only swings to ±2.0 rather than a decisive ±2.5+ cp.
- "Random" button no longer hangs off the right side of the color picker — modal widened.
- Phantom board-image drag squashed via the anti-drag hardening above.
- Premove system: castling now offered, premoves now ignore blockers (empty-board pattern), each queued premove has its own color, dragging across the turn flip cancels cleanly, illegal premoves cancel the rest of the queue.
- Drag-across-turn-flip now plays the move if legal (instead of always cancelling).
- History navigation during CPU think-time fixed — the engine snapshots live state at the moment it starts thinking, so navigating to an old position while the CPU is "thinking" no longer causes it to play moves in the wrong position.
- Critical quiescence bug fixed in original engine: was returning input `alpha` on fail-low instead of `standPat`, causing all non-capture moves to appear equally scored (random-looking play).
- Computer delay is **3 seconds** by design — preserved through the worker port via `Promise.all(searchPromise, setTimeout(3000))`. Don't shorten without rethinking the premove UX.

'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const GRACE_MS = 30000;
const ROOM_GC_MS = 5 * 60 * 1000;
// Grace period before deleting a FINISHED room (resignation / checkmate / etc.)
// once both players are gone. Keeps the room alive long enough that a refresh
// by either player reconnects into the same room — so the gameover dialog,
// analysis state, and rematch flow all survive a refresh even after the other
// player has already left.
const FINISHED_ROOM_GRACE_MS = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();
const sockets = new WeakMap();

function generateCode() {
  for (let attempts = 0; attempts < 50; attempts++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function opposite(color) { return color === 'w' ? 'b' : 'w'; }

function resolveColor(choice) {
  if (choice === 'w' || choice === 'b') return choice;
  return Math.random() < 0.5 ? 'w' : 'b';
}

function send(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
}

function sendError(ws, code, message) {
  send(ws, { type: 'error', code, msg: message });
}

function broadcastRoom(room, msg, exceptColor) {
  for (const c of ['w', 'b']) {
    if (c === exceptColor) continue;
    const p = room.players[c];
    if (p && p.socket) send(p.socket, msg);
  }
}

function freshGameState(timeSec) {
  return {
    clockWhiteMs: timeSec ? timeSec * 1000 : 0,
    clockBlackMs: timeSec ? timeSec * 1000 : 0,
    activeColor: 'w',
    activeStartedAt: 0,
    timeoutHandle: null,
    history: [],
    status: 'playing',
    drawBy: null,
    winner: null,
    drawOfferFromColor: null,
    rematchOffer: null,
    capturedByWhite: [],
    capturedByBlack: [],
  };
}

function clearTimeoutHandle(room) {
  if (room.timeoutHandle) {
    clearTimeout(room.timeoutHandle);
    room.timeoutHandle = null;
  }
}

function scheduleTimeoutFire(room) {
  clearTimeoutHandle(room);
  if (!room.settings.timeSec) return;
  if (room.status !== 'playing') return;
  const remaining = room.activeColor === 'w' ? room.clockWhiteMs : room.clockBlackMs;
  if (remaining <= 0) {
    setImmediate(() => fireTimeout(room));
    return;
  }
  room.timeoutHandle = setTimeout(() => fireTimeout(room), remaining);
}

function fireTimeout(room) {
  if (room.status !== 'playing') return;
  if (!room.settings.timeSec) return;
  const elapsed = Date.now() - room.activeStartedAt;
  if (room.activeColor === 'w') room.clockWhiteMs = Math.max(0, room.clockWhiteMs - elapsed);
  else                          room.clockBlackMs = Math.max(0, room.clockBlackMs - elapsed);
  const loser = room.activeColor;
  room.status = 'timeout';
  room.winner = opposite(loser);
  room.timeoutColor = loser;
  room.activeColor = null;
  clearTimeoutHandle(room);
  recordGameResult(room);
  broadcastRoom(room, {
    type: 'gameOver',
    status: 'timeout',
    winner: room.winner,
    timeoutColor: loser,
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    score: scorePayload(room),
  });
}

function startActiveColor(room, color) {
  clearTimeoutHandle(room);
  room.activeColor = color;
  room.activeStartedAt = Date.now();
  scheduleTimeoutFire(room);
}

function stopActiveDeduct(room) {
  if (!room.settings.timeSec) return 0;
  if (!room.activeColor) return 0;
  const now = Date.now();
  const elapsed = now - room.activeStartedAt;
  if (room.activeColor === 'w') room.clockWhiteMs = Math.max(0, room.clockWhiteMs - elapsed);
  else                          room.clockBlackMs = Math.max(0, room.clockBlackMs - elapsed);
  clearTimeoutHandle(room);
  return elapsed;
}

function snapshotFor(room, color) {
  // Compute accurate remaining clocks by accounting for time already elapsed
  // in the current active turn (the stored values are frozen at turn-start).
  let cwMs = room.clockWhiteMs;
  let cbMs = room.clockBlackMs;
  if (room.status === 'playing' && room.activeColor && room.settings.timeSec && room.activeStartedAt) {
    const elapsed = Math.max(0, Date.now() - room.activeStartedAt);
    if (room.activeColor === 'w') cwMs = Math.max(0, cwMs - elapsed);
    else                          cbMs = Math.max(0, cbMs - elapsed);
  }
  return {
    type: 'stateSnapshot',
    color,
    token: room.players[color] ? room.players[color].token : null,  // needed for future reconnects
    settings: room.settings,
    code: room.code,
    history: room.history,
    capturedByWhite: room.capturedByWhite,
    capturedByBlack: room.capturedByBlack,
    clockWhiteMs: cwMs,
    clockBlackMs: cbMs,
    activeColor: room.activeColor,
    status: room.status,
    drawBy: room.drawBy,
    winner: room.winner,
    drawOfferFromColor: room.drawOfferFromColor,
    rematchOffer: room.rematchOffer,
    timeoutColor: room.timeoutColor || null,
    forfeitColor: room.forfeitColor || null,
    resignedColor: room.resignedColor || null,
    opponentConnected: !!(room.players[opposite(color)] && room.players[opposite(color)].socket),
    gameCount: room.gameCount,
    score: scorePayload(room),
  };
}

function clearDisconnectTimer(room, color) {
  if (room.disconnectTimers && room.disconnectTimers[color]) {
    clearTimeout(room.disconnectTimers[color]);
    room.disconnectTimers[color] = null;
  }
}

function armDisconnectTimer(room, color) {
  clearDisconnectTimer(room, color);
  room.disconnectTimers[color] = setTimeout(() => {
    forfeit(room, color);
  }, GRACE_MS);
}

function forfeit(room, color) {
  if (room.status !== 'playing') {
    cleanupRoomIfBothGone(room);
    return;
  }
  if (room.settings.timeSec && room.activeColor) {
    stopActiveDeduct(room);
  }
  room.status = 'forfeit';
  room.winner = opposite(color);
  room.forfeitColor = color;
  room.activeColor = null;
  clearTimeoutHandle(room);
  recordGameResult(room);
  broadcastRoom(room, {
    type: 'gameOver',
    status: 'forfeit',
    winner: room.winner,
    forfeitColor: color,
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    score: scorePayload(room),
  });
}

function cleanupRoomIfBothGone(room) {
  const wOff = !room.players.w || !room.players.w.socket;
  const bOff = !room.players.b || !room.players.b.socket;
  if (!wOff || !bOff) return;

  clearTimeoutHandle(room);
  if (room.disconnectTimers) {
    clearDisconnectTimer(room, 'w');
    clearDisconnectTimer(room, 'b');
  }

  // For finished games, defer deletion so a refresh by either player can
  // reconnect into the same room. handleReconnect cancels this timer.
  if (isFinishedStatus(room.status)) {
    if (room.finishedExpiryHandle) clearTimeout(room.finishedExpiryHandle);
    room.finishedExpiryHandle = setTimeout(() => {
      const wStill = !room.players.w || !room.players.w.socket;
      const bStill = !room.players.b || !room.players.b.socket;
      if (wStill && bStill) rooms.delete(room.code);
    }, FINISHED_ROOM_GRACE_MS);
    return;
  }

  rooms.delete(room.code);
}

function colorsCompatible(aOff, bOff) {
  if (aOff === bOff) return false;
  if (aOff === 'r' || bOff === 'r') return true;
  return aOff === opposite(bOff);
}

function resolveRematchColors(aOff, bOff) {
  if (aOff === 'r' && bOff === 'r') {
    const aColor = Math.random() < 0.5 ? 'w' : 'b';
    return { a: aColor, b: opposite(aColor) };
  }
  if (aOff === 'r') return { a: opposite(bOff), b: bOff };
  if (bOff === 'r') return { a: aOff, b: opposite(aOff) };
  return { a: aOff, b: bOff };
}

function startGameInRoom(room, sendStartTo) {
  const fresh = freshGameState(room.settings.timeSec);
  Object.assign(room, fresh);
  room.gameCount = (room.gameCount || 0) + 1;
  room.timeoutColor = null;
  room.forfeitColor = null;
  room.resignedColor = null;
  if (room.settings.timeSec) startActiveColor(room, 'w');
  else                       room.activeColor = 'w';

  for (const c of ['w', 'b']) {
    const p = room.players[c];
    if (!p || !p.socket) continue;
    if (sendStartTo && !sendStartTo.includes(c)) continue;
    send(p.socket, {
      type: 'start',
      color: c,
      settings: room.settings,
      code: room.code,
      token: p.token,
      gameCount: room.gameCount,
      score: scorePayload(room),
    });
  }
}

function handleCreate(ws, msg) {
  const timeSec = (typeof msg.timeSec === 'number' && msg.timeSec > 0) ? Math.floor(msg.timeSec) : null;
  const incSec = (typeof msg.incSec === 'number' && msg.incSec >= 0) ? Math.floor(msg.incSec) : 0;
  const colorChoice = (msg.colorChoice === 'w' || msg.colorChoice === 'b' || msg.colorChoice === 'r')
    ? msg.colorChoice : 'r';

  const code = generateCode();
  const token = generateToken();
  const creatorColor = resolveColor(colorChoice);

  const room = {
    code,
    settings: { timeSec, incSec, creatorColorChoice: colorChoice },
    originalSettings: { timeSec, incSec },
    players: {
      w: creatorColor === 'w' ? { socket: ws, token } : { socket: null, token: null },
      b: creatorColor === 'b' ? { socket: ws, token } : { socket: null, token: null },
    },
    disconnectTimers: { w: null, b: null },
    finishedExpiryHandle: null,
    createdAt: Date.now(),
    status: 'waiting',
    gameCount: 0,
    seriesScore: {},     // { [token]: wins } — keyed by player token, persists across color swaps
    seriesDraws: 0,      // draw / stalemate count across all games in this room
    rematchOffer: null,
    drawOfferFromColor: null,
    history: [],
    capturedByWhite: [],
    capturedByBlack: [],
    clockWhiteMs: timeSec ? timeSec * 1000 : 0,
    clockBlackMs: timeSec ? timeSec * 1000 : 0,
    activeColor: null,
    activeStartedAt: 0,
    timeoutHandle: null,
    timeoutColor: null,
    forfeitColor: null,
    resignedColor: null,
    winner: null,
    drawBy: null,
  };
  rooms.set(code, room);
  sockets.set(ws, { code, color: creatorColor, token });

  send(ws, {
    type: 'created',
    code,
    token,
    color: creatorColor,
    colorChoice,
    settings: room.settings,
  });
}

function handleJoin(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
  const room = rooms.get(code);
  if (!room) { sendError(ws, 'NOT_FOUND', 'Game code not found.'); return; }
  if (room.status !== 'waiting') {
    sendError(ws, 'NOT_JOINABLE', 'That game is no longer accepting joins.');
    return;
  }
  const openColor = !room.players.w.socket ? 'w' : (!room.players.b.socket ? 'b' : null);
  if (!openColor) { sendError(ws, 'FULL', 'Game already has two players.'); return; }
  const token = generateToken();
  room.players[openColor] = { socket: ws, token };
  sockets.set(ws, { code, color: openColor, token });

  startGameInRoom(room, ['w', 'b']);
}

function handleReconnect(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
  const token = typeof msg.token === 'string' ? msg.token : '';
  const room = rooms.get(code);
  if (!room) { sendError(ws, 'NOT_FOUND', 'Game no longer exists on server.'); return; }
  let color = null;
  for (const c of ['w', 'b']) {
    if (room.players[c] && room.players[c].token === token) { color = c; break; }
  }
  if (!color) { sendError(ws, 'BAD_TOKEN', 'Invalid reconnect token.'); return; }

  if (room.players[color].socket && room.players[color].socket !== ws) {
    try { room.players[color].socket.close(4001, 'replaced'); } catch (_) {}
  }
  room.players[color].socket = ws;
  sockets.set(ws, { code, color, token });
  clearDisconnectTimer(room, color);
  // Cancel any pending finished-room expiry — this reconnect saves the room.
  if (room.finishedExpiryHandle) {
    clearTimeout(room.finishedExpiryHandle);
    room.finishedExpiryHandle = null;
  }

  send(ws, snapshotFor(room, color));
  broadcastRoom(room, { type: 'opponentReconnected' }, color);
}

function handleCancelCreate(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (room.status !== 'waiting') return;
  rooms.delete(room.code);
  clearTimeoutHandle(room);
}

function handleMove(ws, msg) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (room.status !== 'playing') {
    sendError(ws, 'NOT_PLAYING', 'Game is not in playing state.');
    return;
  }
  if (room.activeColor !== meta.color) {
    sendError(ws, 'NOT_YOUR_TURN', 'Not your turn.');
    return;
  }
  if (typeof msg.from !== 'number' || typeof msg.to !== 'number') {
    sendError(ws, 'BAD_MOVE', 'Invalid move payload.');
    return;
  }

  if (room.drawOfferFromColor) {
    room.drawOfferFromColor = null;
  }
  if (room.rematchOffer) room.rematchOffer = null;

  let moveTimeMs = 0;
  if (room.settings.timeSec) {
    moveTimeMs = stopActiveDeduct(room);
    if (room.settings.incSec > 0) {
      const incMs = room.settings.incSec * 1000;
      if (meta.color === 'w') room.clockWhiteMs += incMs;
      else                    room.clockBlackMs += incMs;
    }
  }

  const entry = {
    from: msg.from,
    to: msg.to,
    promo: msg.promo || null,
    notation: msg.notation || '',
    sound: msg.sound || 'move',
    movingColor: meta.color,
    moveTimeMs,
    clockWhite: room.clockWhiteMs,
    clockBlack: room.clockBlackMs,
    capturedPiece: msg.capturedPiece || null,
    capturedSquare: typeof msg.capturedSquare === 'number' ? msg.capturedSquare : null,
    fullMove: msg.fullMove || null,
    terminalStatus: msg.terminalStatus || null,
    drawBy: msg.drawBy || null,
    // Board state for reconnect snapshots — trusted from client (client runs the
    // authoritative engine; server only mirrors for snapshot/reconnect purposes).
    boardAfter:           Array.isArray(msg.boardAfter) && msg.boardAfter.length === 64 ? msg.boardAfter : null,
    enPassantAfter:       typeof msg.enPassantAfter === 'number' ? msg.enPassantAfter : null,
    castlingAfter:        typeof msg.castlingAfter === 'string'  ? msg.castlingAfter  : null,
    halfMoveAfter:        typeof msg.halfMoveAfter  === 'number' ? msg.halfMoveAfter  : null,
    turnAfter:            (msg.turnAfter === 'w' || msg.turnAfter === 'b') ? msg.turnAfter : null,
    fullMoveAfter:        typeof msg.fullMoveAfter  === 'number' ? msg.fullMoveAfter  : null,
    capturedByWhiteAfter: Array.isArray(msg.capturedByWhiteAfter) ? msg.capturedByWhiteAfter : [],
    capturedByBlackAfter: Array.isArray(msg.capturedByBlackAfter) ? msg.capturedByBlackAfter : [],
    moveTime: moveTimeMs,
  };
  room.history.push(entry);

  if (msg.capturedPiece) {
    if (meta.color === 'w') room.capturedByWhite.push(msg.capturedPiece);
    else                    room.capturedByBlack.push(msg.capturedPiece);
  }

  const nextColor = opposite(meta.color);
  if (msg.terminalStatus && msg.terminalStatus !== 'playing') {
    room.status = msg.terminalStatus;
    room.drawBy = msg.drawBy || null;
    if (msg.terminalStatus === 'checkmate') room.winner = meta.color;
    else if (msg.terminalStatus === 'draw' || msg.terminalStatus === 'stalemate') room.winner = null;
    room.activeColor = null;
    clearTimeoutHandle(room);
  } else {
    if (room.settings.timeSec) startActiveColor(room, nextColor);
    else                       room.activeColor = nextColor;
  }

  const opponentSocket = room.players[nextColor] && room.players[nextColor].socket;
  send(opponentSocket, {
    type: 'move',
    from: msg.from,
    to: msg.to,
    promo: msg.promo || null,
    notation: msg.notation || '',
    sound: msg.sound || 'move',
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    activeColor: room.activeColor,
    moveTimeMs,
    terminalStatus: msg.terminalStatus || null,
    drawBy: msg.drawBy || null,
  });
  send(ws, {
    type: 'moveAck',
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    activeColor: room.activeColor,
    moveTimeMs,
  });

  if (msg.terminalStatus && msg.terminalStatus !== 'playing') {
    recordGameResult(room);
    broadcastRoom(room, {
      type: 'gameOver',
      status: msg.terminalStatus,
      drawBy: msg.drawBy || null,
      winner: room.winner,
      clockWhiteMs: room.clockWhiteMs,
      clockBlackMs: room.clockBlackMs,
      score: scorePayload(room),
    });
  }
}

function handleResign(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || room.status !== 'playing') return;
  if (room.settings.timeSec) stopActiveDeduct(room);
  room.status = 'resignation';
  room.winner = opposite(meta.color);
  room.resignedColor = meta.color;
  room.activeColor = null;
  clearTimeoutHandle(room);
  recordGameResult(room);
  broadcastRoom(room, {
    type: 'gameOver',
    status: 'resignation',
    winner: room.winner,
    resignedColor: meta.color,
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    score: scorePayload(room),
  });
}

function handleOfferDraw(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || room.status !== 'playing') return;
  if (room.drawOfferFromColor) return;
  room.drawOfferFromColor = meta.color;
  broadcastRoom(room, { type: 'drawOffered', fromColor: meta.color });
}

function handleAcceptDraw(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || room.status !== 'playing') return;
  if (!room.drawOfferFromColor || room.drawOfferFromColor === meta.color) return;
  if (room.settings.timeSec) stopActiveDeduct(room);
  room.status = 'draw';
  room.drawBy = 'agreement';
  room.winner = null;
  room.drawOfferFromColor = null;
  room.activeColor = null;
  clearTimeoutHandle(room);
  recordGameResult(room);
  broadcastRoom(room, {
    type: 'gameOver',
    status: 'draw',
    drawBy: 'agreement',
    winner: null,
    clockWhiteMs: room.clockWhiteMs,
    clockBlackMs: room.clockBlackMs,
    score: scorePayload(room),
  });
}

function handleDeclineDraw(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || room.status !== 'playing') return;
  if (!room.drawOfferFromColor || room.drawOfferFromColor === meta.color) return;
  room.drawOfferFromColor = null;
  broadcastRoom(room, { type: 'drawDeclined' });
}

function isFinishedStatus(s) {
  return s === 'checkmate' || s === 'stalemate' || s === 'draw' ||
         s === 'resignation' || s === 'timeout' || s === 'forfeit';
}

// Tally the result of the just-finished game into room.seriesScore / seriesDraws.
// Must be called AFTER room.winner is set and BEFORE the gameOver broadcast so
// scorePayload() below returns the updated totals.
function recordGameResult(room) {
  if (room.winner) {
    const p = room.players[room.winner];
    if (p && p.token) {
      room.seriesScore[p.token] = (room.seriesScore[p.token] || 0) + 1;
    }
  } else {
    room.seriesDraws = (room.seriesDraws || 0) + 1;
  }
}

// Build a color-keyed score object for sending to clients.
// Always returns the current win / draw counts so the client can decide
// when to display them (the UI hides the score box while the tally is 0-0-0).
function scorePayload(room) {
  if (!room.seriesScore) return null;
  const wP = room.players.w;
  const bP = room.players.b;
  return {
    w:      wP ? (room.seriesScore[wP.token] || 0) : 0,
    b:      bP ? (room.seriesScore[bP.token] || 0) : 0,
    draws:  room.seriesDraws || 0,
    gameCount: room.gameCount,
  };
}

function handleRematchOffer(ws, msg) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (!isFinishedStatus(room.status)) {
    sendError(ws, 'NOT_FINISHED', 'Game has not finished.');
    return;
  }
  const settings = msg.settings || {};
  const timeSec = (typeof settings.timeSec === 'number' && settings.timeSec > 0) ? Math.floor(settings.timeSec) : null;
  const incSec = (typeof settings.incSec === 'number' && settings.incSec >= 0) ? Math.floor(settings.incSec) : 0;
  const offererColor = (settings.offererColor === 'w' || settings.offererColor === 'b' || settings.offererColor === 'r')
    ? settings.offererColor : 'r';
  const newSettings = { timeSec, incSec, offererColor };

  if (room.rematchOffer && room.rematchOffer.fromColor !== meta.color) {
    const other = room.rematchOffer.settings;
    const sameTime = (other.timeSec || null) === (newSettings.timeSec || null);
    const sameInc = (other.incSec || 0) === (newSettings.incSec || 0);
    const colorsOk = colorsCompatible(other.offererColor, newSettings.offererColor);
    if (sameTime && sameInc && colorsOk) {
      const resolved = resolveRematchColors(other.offererColor, newSettings.offererColor);
      const aColor = resolved.a;
      const bColor = resolved.b;
      const offererPlayer = room.players[room.rematchOffer.fromColor];
      const accepterPlayer = room.players[meta.color];
      room.players = {
        [aColor]: offererPlayer,
        [bColor]: accepterPlayer,
      };
      const newMeta1 = sockets.get(offererPlayer.socket);
      if (newMeta1) newMeta1.color = aColor;
      const newMeta2 = sockets.get(accepterPlayer.socket);
      if (newMeta2) newMeta2.color = bColor;
      room.settings = { timeSec: newSettings.timeSec, incSec: newSettings.incSec, creatorColorChoice: room.settings.creatorColorChoice };
      room.rematchOffer = null;
      broadcastRoom(room, { type: 'rematchAccepted' });
      startGameInRoom(room, ['w', 'b']);
      return;
    } else {
      sendError(ws, 'OFFER_EXISTS', 'Opponent already proposed different settings.');
      return;
    }
  }

  if (room.rematchOffer && room.rematchOffer.fromColor === meta.color) {
    room.rematchOffer = { fromColor: meta.color, settings: newSettings };
    broadcastRoom(room, { type: 'rematchOffered', fromColor: meta.color, settings: newSettings }, meta.color);
    return;
  }

  room.rematchOffer = { fromColor: meta.color, settings: newSettings };
  broadcastRoom(room, { type: 'rematchOffered', fromColor: meta.color, settings: newSettings }, meta.color);
}

function handleRematchAccept(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;
  if (!room.rematchOffer || room.rematchOffer.fromColor === meta.color) {
    sendError(ws, 'NO_OFFER', 'No rematch offer to accept.');
    return;
  }
  const offer = room.rematchOffer;
  let offererColor = offer.settings.offererColor;
  let accepterColor = 'r';
  const resolved = resolveRematchColors(offererColor, accepterColor);
  const offererNew = resolved.a;
  const accepterNew = resolved.b;
  const offererPlayer = room.players[offer.fromColor];
  const accepterPlayer = room.players[meta.color];
  room.players = {
    [offererNew]: offererPlayer,
    [accepterNew]: accepterPlayer,
  };
  const m1 = sockets.get(offererPlayer.socket); if (m1) m1.color = offererNew;
  const m2 = sockets.get(accepterPlayer.socket); if (m2) m2.color = accepterNew;
  room.settings = {
    timeSec: offer.settings.timeSec,
    incSec: offer.settings.incSec,
    creatorColorChoice: room.settings.creatorColorChoice,
  };
  room.rematchOffer = null;
  broadcastRoom(room, { type: 'rematchAccepted' });
  startGameInRoom(room, ['w', 'b']);
}

function handleRematchDecline(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || !room.rematchOffer) return;
  if (room.rematchOffer.fromColor === meta.color) return;
  room.rematchOffer = null;
  broadcastRoom(room, { type: 'rematchDeclined' });
}

function handleRematchCancel(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room || !room.rematchOffer) return;
  if (room.rematchOffer.fromColor !== meta.color) return;
  room.rematchOffer = null;
  broadcastRoom(room, { type: 'rematchCancelled' });
}

function handleConnectionClose(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const room = rooms.get(meta.code);
  if (!room) return;

  // Was this socket still the current one for this player?
  // If not, it was replaced by a reconnect (handleReconnect force-closed it).
  // Just clean up the WeakMap entry — don't treat a stale close as a real
  // disconnect (which would spuriously broadcast opponentDisconnected and arm
  // a new forfeit timer even though the player just successfully reconnected).
  const isCurrentSocket = !!(room.players[meta.color] && room.players[meta.color].socket === ws);
  if (isCurrentSocket) {
    room.players[meta.color].socket = null;
  }
  sockets.delete(ws);

  if (!isCurrentSocket) return;   // replaced by reconnect — nothing more to do

  if (room.status === 'waiting') {
    rooms.delete(room.code);
    return;
  }
  if (isFinishedStatus(room.status)) {
    // Clear any outstanding rematch offer and always notify the remaining player.
    // This covers: A had a pending offer (cancel it), B had a pending offer to A
    // (cancel it), or no offer (B's UI resets cleanly either way).
    room.rematchOffer = null;
    broadcastRoom(room, { type: 'rematchCancelled' }, meta.color);
    cleanupRoomIfBothGone(room);
    return;
  }
  broadcastRoom(room, { type: 'opponentDisconnected', graceMs: GRACE_MS }, meta.color);
  armDisconnectTimer(room, meta.color);
}

function gcSweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === 'waiting' && (now - room.createdAt) > ROOM_GC_MS) {
      const p = room.players.w.socket || room.players.b.socket;
      if (!p) rooms.delete(code);
    }
  }
}
setInterval(gcSweep, 60 * 1000);

const HANDLERS = {
  create: handleCreate,
  join: handleJoin,
  reconnect: handleReconnect,
  cancelCreate: handleCancelCreate,
  move: handleMove,
  resign: handleResign,
  offerDraw: handleOfferDraw,
  acceptDraw: handleAcceptDraw,
  declineDraw: handleDeclineDraw,
  rematchOffer: handleRematchOffer,
  rematchAccept: handleRematchAccept,
  rematchDecline: handleRematchDecline,
  rematchCancel: handleRematchCancel,
};

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Chess multiplayer server. Open chess.html and connect via ws://localhost:' + PORT);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) {
      sendError(ws, 'BAD_JSON', 'Malformed message.');
      return;
    }
    const cmd = msg && msg.cmd;
    const handler = HANDLERS[cmd];
    if (!handler) {
      sendError(ws, 'BAD_CMD', 'Unknown command: ' + cmd);
      return;
    }
    try { handler(ws, msg); }
    catch (e) {
      console.error('handler error', cmd, e);
      sendError(ws, 'INTERNAL', 'Server error processing ' + cmd);
    }
  });
  ws.on('close', () => { handleConnectionClose(ws); });
  ws.on('error', () => { /* ignore; close will follow */ });
});

httpServer.listen(PORT, () => {
  console.log('Chess multiplayer server listening on :' + PORT);
});

/* Shove & Survive — Phase 4 authoritative multiplayer game server */
"use strict";

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const config = require("./config");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  cors: { origin: process.env.CORS_ORIGIN || true, methods: ["GET", "POST"] },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5
});

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

const rooms = new Map();
app.get("/health", (_req, res) => res.json({
  ok: true, service: "shove-and-survive", rooms: rooms.size,
  uptime: Math.round(process.uptime())
}));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#c8f36a", "#ff668e", "#69d5ff", "#ffb84d", "#b69aff", "#58dfb2", "#ff8b5c", "#f47bd2"];
const HATS = ["⭐", "🌵", "🦄", "👑", "🍒", "🧢"];
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hypot = (x, y) => Math.hypot(x, y);

function cleanName(value) {
  const name = String(value || "").replace(/[<>\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
  if (!name || /\b(fuck|shit|bitch|cunt|nigger|nigga|fag|retard)\b/i.test(name)) return null;
  return name;
}
function makeCode() {
  let code;
  do {
    code = Array.from({ length: config.ROOM_CODE_LENGTH }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function sendAck(ack, payload) { if (typeof ack === "function") ack(payload); }

function makePlayer(name, socket, reconnectKey, index) {
  const angle = Math.random() * Math.PI * 2;
  const spawnR = 70 + Math.random() * 95;
  return {
    id: crypto.randomUUID(), name, color: COLORS[index % COLORS.length],
    hat: HATS[crypto.randomInt(HATS.length)],
    x: Math.cos(angle) * spawnR, y: Math.sin(angle) * spawnR,
    vx: 0, vy: 0, inputX: 0, inputY: 0,
    lastDirX: Math.cos(angle), lastDirY: Math.sin(angle),
    alive: true, socketId: socket.id, reconnectKey,
    disconnectedUntil: 0, dashCooldownUntil: 0, invulnerableUntil: 0,
    pendingShove: false, lastShoveAt: 0, shoves: 0, falls: 0,
    fallsCaused: 0, pebbleHits: 0, nextPebbleAt: 0,
    lastPebbleBy: null, lastPebbleAt: 0,
    score: 0, roundPoints: 0, eliminatedAt: 0, placement: null,
    power: null, powerUntil: 0, shieldCharges: 0, megaShove: false
  };
}
function leaderboard(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score || b.shoves - a.shoves || a.name.localeCompare(b.name))
    .map(p => ({ id: p.id, name: p.name, color: p.color, score: p.score }));
}
function roomSummary(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase,
    targetRounds: room.targetRounds, matchFinished: room.matchFinished,
    endAfterRound: Boolean(room.endAfterRound), matchWinner: room.matchWinner,
    arenaRadius: room.arenaRadius, roundNumber: room.roundNumber,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, hat: p.hat,
      connected: Boolean(p.socketId), alive: p.alive, score: p.score
    })),
    leaderboard: leaderboard(room).slice(0, 8),
    lastResult: room.lastResult
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", roomSummary(room)); }

function attachPlayer(socket, room, player, ack) {
  player.socketId = socket.id;
  player.disconnectedUntil = 0;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  room.lastActivity = now();
  sendAck(ack, {
    ok: true, room: roomSummary(room), playerId: player.id,
    reconnectKey: player.reconnectKey, isHost: room.hostId === player.id
  });
  emitRoom(room);
}

function createRoom(socket, name, ack) {
  if (rooms.size >= config.MAX_ROOMS) return sendAck(ack, { ok: false, error: "Rooms are full right now. Try again shortly." });
  const code = makeCode();
  const room = {
    code, hostId: null, players: new Map(), phase: "lobby",
    createdAt: now(), lastActivity: now(), autoStartAt: 0,
    arenaRadius: config.ARENA_RADIUS, roundNumber: 0,
    countdownEndsAt: 0, roundStartedAt: 0, roundEndsAt: 0,
    nextShrinkAt: 0, shrinkWarning: false, shrinkCount: 0,
    scoreboardEndsAt: 0, tick: 0, lastSnapshotAt: 0,
    targetRounds: 3, matchFinished: false, matchWinner: null, endAfterRound: false,
    pickups: [], nextPickupAt: 0, hazard: "tilt", hazardUntil: 0, nextHazardAt: 0,
    lastActivityAt: now(), lastResult: null
  };
  const player = makePlayer(name, socket, crypto.randomBytes(18).toString("hex"), 0);
  room.hostId = player.id;
  room.players.set(player.id, player);
  rooms.set(code, room);
  attachPlayer(socket, room, player, ack);
  console.log(`[rooms] ${rooms.size} active — created ${code}`);
}

function joinRoom(socket, payload, ack) {
  const code = String(payload?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const name = cleanName(payload?.name);
  if (!name) return sendAck(ack, { ok: false, error: "Choose a name (1–12 characters, keep it friendly)." });
  const room = rooms.get(code);
  if (!room) return sendAck(ack, { ok: false, error: "Room not found. Check the 6-character code." });

  const reconnectKey = String(payload?.reconnectKey || "");
  if (reconnectKey && ["lobby", "scoreboard"].includes(room.phase)) {
    const returning = [...room.players.values()].find(p => p.reconnectKey === reconnectKey && !p.socketId);
    if (returning) {
      returning.name = name;
      attachPlayer(socket, room, returning, ack);
      return;
    }
  }
  if (!["lobby", "scoreboard"].includes(room.phase)) {
    return sendAck(ack, { ok: false, error: "This round is underway. Join when the scoreboard appears." });
  }
  if (room.players.size >= config.MAX_PLAYERS) return sendAck(ack, { ok: false, error: "This room is full (8 players max)." });

  const player = makePlayer(name, socket, crypto.randomBytes(18).toString("hex"), room.players.size);
  if (room.phase === "scoreboard") player.alive = false; // They join the next round.
  room.players.set(player.id, player);
  attachPlayer(socket, room, player, ack);
  if (room.phase === "lobby" && room.players.size >= config.MAX_PLAYERS) startGame(room);
  else if (room.phase === "lobby" && room.players.size >= 2 && !room.autoStartAt) {
    room.autoStartAt = now() + config.LOBBY_AUTO_START_MS;
  }
}

function resetPlayerForRound(p, index, count) {
  const angle = (Math.PI * 2 * index / count) + (Math.random() - .5) * .22;
  const radius = 65 + Math.random() * 70;
  p.x = Math.cos(angle) * radius; p.y = Math.sin(angle) * radius;
  p.vx = p.vy = p.inputX = p.inputY = 0;
  p.lastDirX = Math.cos(angle); p.lastDirY = Math.sin(angle);
  p.alive = true; p.dashCooldownUntil = 0; p.invulnerableUntil = 0;
  p.pendingShove = false; p.shoves = 0; p.falls = 0; p.fallsCaused = 0;
  p.pebbleHits = 0; p.nextPebbleAt = 0; p.lastPebbleBy = null;
  p.lastPebbleAt = 0; p.lastHitBy = null; p.roundPoints = 0;
  p.power = null; p.powerUntil = 0; p.shieldCharges = 0; p.megaShove = false; p.eliminatedAt = 0; p.placement = null;
}

function startGame(room) {
  if (!room || room.matchFinished || !["lobby", "scoreboard"].includes(room.phase) || room.players.size < 2) return false;
  const active = [...room.players.values()].filter(p => p.socketId);
  if (active.length < 2) return false;
  room.phase = "countdown";
  room.autoStartAt = 0;
  room.roundNumber++;
  room.tick = 0;
  room.arenaRadius = config.ARENA_RADIUS;
  room.countdownEndsAt = now() + config.COUNTDOWN_MS;
  room.roundStartedAt = 0;
  room.roundEndsAt = 0;
  room.nextShrinkAt = 0;
  room.shrinkWarning = false;
  room.shrinkCount = 0;
  room.scoreboardEndsAt = 0;
  room.lastResult = null;
  const players = [...room.players.values()].filter(p => p.socketId);
  players.forEach((p, i) => resetPlayerForRound(p, i, players.length));
  for (const p of room.players.values()) {
    if (!p.socketId) p.alive = false;
  }
  emitRoom(room);
  io.to(room.code).emit("game:countdown", { seconds: 3, round: room.roundNumber });
  console.log(`[rooms] ${rooms.size} active — ${room.code} countdown for round ${room.roundNumber}`);
  return true;
}

function eliminatePlayer(room, player, time, reason = "fall") {
  if (!player.alive) return;
  player.alive = false;
  player.eliminatedAt = time;
  player.falls++;
  player.vx = player.vy = player.inputX = player.inputY = 0;
  const attacker = player.lastPebbleBy
    ? room.players.get(player.lastPebbleBy)
    : null;
  if (attacker && time - player.lastPebbleAt <= config.PEBBLE_TAG_BONUS_MS) {
    attacker.score += config.PEBBLE_FALL_BONUS;
    attacker.roundPoints += config.PEBBLE_FALL_BONUS;
    attacker.fallsCaused++;
    io.to(attacker.socketId || "").emit("game:bonus", { points: config.PEBBLE_FALL_BONUS, reason: "PEBBLE FALL BONUS" });
  } else {
    const shover = player.lastHitBy ? room.players.get(player.lastHitBy) : null;
    if (shover) shover.fallsCaused++;
  }
  io.to(room.code).emit("effect:fall", { x: player.x, y: player.y, playerId: player.id, reason });
  emitRoom(room);
}

function resolveShoves(room, time) {
  const players = [...room.players.values()].filter(p => p.alive && p.socketId).sort((a, b) => a.id.localeCompare(b.id));
  for (const shover of players) {
    if (!shover.pendingShove) continue;
    shover.pendingShove = false;
    if (time < shover.dashCooldownUntil) continue;
    const len = hypot(shover.lastDirX, shover.lastDirY) || 1;
    const dx = shover.lastDirX / len, dy = shover.lastDirY / len;
    shover.vx += dx * config.DASH_FORCE;
    shover.vy += dy * config.DASH_FORCE;
    shover.dashCooldownUntil = time + config.DASH_COOLDOWN_MS;
    shover.invulnerableUntil = time + config.DASH_INVULNERABILITY_MS;
    for (const target of players) {
      if (target.id === shover.id || !target.alive || time < target.invulnerableUntil) continue;
      const tx = target.x - shover.x, ty = target.y - shover.y;
      const distance = hypot(tx, ty);
      if (distance > config.DASH_RANGE || distance < .001) continue;
      const nx = tx / distance, ny = ty / distance;
      if (nx * dx + ny * dy < .05) continue;
      if (target.shieldCharges > 0) {
        target.shieldCharges = 0; target.power = null; target.powerUntil = 0;
        io.to(room.code).emit("powerup:shield-break", { playerId: target.id });
        continue;
      }
      target.vx += nx * config.DASH_PUSH_FORCE * shoveMultiplier;
      target.vy += ny * config.DASH_PUSH_FORCE * shoveMultiplier;
      target.lastHitBy = shover.id;
      shover.vx -= nx * config.DASH_PUSH_FORCE * config.DASH_RECOIL;
      shover.vy -= ny * config.DASH_PUSH_FORCE * config.DASH_RECOIL;
      shover.shoves++;
      io.to(room.code).emit("effect:shove", { x: target.x, y: target.y, by: shover.id });
    }
    io.to(shover.socketId).emit("game:dash", { cooldownMs: config.DASH_COOLDOWN_MS });
  }
}

function resolveCollisions(players) {
  for (let i = 0; i < players.length; i++) {
    const a = players[i];
    for (let j = i + 1; j < players.length; j++) {
      const b = players[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      let distance = hypot(dx, dy);
      const minDistance = config.PLAYER_RADIUS * 2;
      if (distance >= minDistance) continue;
      if (distance < .001) { dx = .01; dy = 0; distance = .01; }
      const nx = dx / distance, ny = dy / distance;
      const separation = (minDistance - distance) * .5;
      a.x -= nx * separation; a.y -= ny * separation;
      b.x += nx * separation; b.y += ny * separation;
      const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeVelocity < 0) {
        const impulse = -(1 + config.COLLISION_RESTITUTION) * relativeVelocity * .5;
        a.vx -= impulse * nx; a.vy -= impulse * ny;
        b.vx += impulse * nx; b.vy += impulse * ny;
      }
    }
  }
}

function finishRound(room, time) {
  if (room.phase !== "playing") return;
  const all = [...room.players.values()];
  const ranked = all.slice().sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.alive && b.alive) return hypot(a.x, a.y) - hypot(b.x, b.y);
    return b.eliminatedAt - a.eliminatedAt;
  });
  const standings = ranked.map((p, index) => {
    const place = index + 1;
    const base = place === 1 ? 100 : place === 2 ? 60 : place === 3 ? 40 : 10;
    p.placement = place;
    p.roundPoints += base;
    p.score += base;
    return {
      id: p.id, name: p.name, color: p.color, hat: p.hat,
      place, alive: p.alive, shoves: p.shoves,
      roundPoints: p.roundPoints, totalScore: p.score
    };
  });
  const stats = [
    { key: "shoves", label: "MOST SHOVES", emoji: "💥" },
    { key: "fallsCaused", label: "MOST FALLS CAUSED", emoji: "🌀" },
    { key: "pebbleHits", label: "BEST PEBBLE", emoji: "🪨" }
  ];
  let mvp = null;
  for (const stat of stats) {
    const winner = all.slice().sort((a, b) => b[stat.key] - a[stat.key])[0];
    if (winner && winner[stat.key] > 0 && (!mvp || winner[stat.key] > mvp.value)) {
      mvp = { id: winner.id, name: winner.name, label: stat.label, emoji: stat.emoji, value: winner[stat.key] };
    }
  }
  const matchComplete = room.roundNumber >= room.targetRounds || room.endAfterRound;
  room.endAfterRound = false;
  room.matchFinished = matchComplete;
  if (matchComplete) {
    const champion = [...room.players.values()].sort((a,b) => b.score-a.score || b.roundPoints-a.roundPoints)[0];
    room.matchWinner = champion ? { id: champion.id, name: champion.name, score: champion.score } : null;
  }
  room.phase = "scoreboard";
  room.scoreboardEndsAt = time + config.SCOREBOARD_MS;
  room.lastResult = {
    round: room.roundNumber, standings,
    leaderboard: leaderboard(room).slice(0, 8), mvp,
    matchComplete, matchWinner: room.matchWinner, targetRounds: room.targetRounds,
    nextRoundIn: config.SCOREBOARD_MS
  };
  room.lastActivity = time;
  emitRoom(room);
  io.to(room.code).emit("game:round-end", room.lastResult);
  console.log(`[rooms] ${rooms.size} active — ${room.code} round ${room.roundNumber} scored`);
}

function endMatch(room, reason = "host") {
  if (!room || room.phase === "finished") return;
  room.matchFinished = true;
  room.phase = "finished";
  const champion = [...room.players.values()].sort((a,b) => b.score-a.score || b.roundPoints-a.roundPoints)[0];
  room.matchWinner = champion ? { id: champion.id, name: champion.name, score: champion.score } : null;
  room.lastActivity = now();
  const result = { reason, winner: room.matchWinner, leaderboard: leaderboard(room), roundsPlayed: room.roundNumber };
  emitRoom(room);
  io.to(room.code).emit("game:match-end", result);
}

function removePlayerFromRoom(socket, room, player) {
  if (!room || !player) return;
  room.players.delete(player.id);
  socket.leave(room.code);
  socket.data.roomCode = null; socket.data.playerId = null;
  if (room.hostId === player.id) room.hostId = [...room.players.values()].find(p => p.socketId)?.id || null;
  room.lastActivity = now();
  emitRoom(room);
  const active = [...room.players.values()].filter(p => p.alive && p.socketId).length;
  if (room.phase === "playing" && active <= 1) finishRound(room, now());
  if (room.phase === "countdown" && [...room.players.values()].filter(p => p.socketId).length < 2) {
    room.phase = "lobby"; room.countdownEndsAt = 0; emitRoom(room);
  }
  if (room.phase === "lobby" && [...room.players.values()].filter(p => p.socketId).length < 2) room.autoStartAt = 0;
  if (room.players.size === 0) rooms.delete(room.code);
}

function throwPebble(room, player, ack, time) {
  if (room.phase !== "playing" || player.alive || !player.socketId) {
    return sendAck(ack, { ok: false, error: "Pebbles are for eliminated spectators." });
  }
  if (time < player.nextPebbleAt) {
    return sendAck(ack, { ok: false, error: "Pebble recharging." });
  }
  const survivors = [...room.players.values()].filter(p => p.alive && p.socketId);
  if (!survivors.length) return sendAck(ack, { ok: false, error: "No survivors to nudge." });
  const target = survivors[crypto.randomInt(survivors.length)];
  const angle = Math.random() * Math.PI * 2;
  target.vx += Math.cos(angle) * config.PEBBLE_FORCE;
  target.vy += Math.sin(angle) * config.PEBBLE_FORCE;
  target.lastPebbleBy = player.id;
  target.lastPebbleAt = time;
  player.pebbleHits++;
  player.nextPebbleAt = time + config.PEBBLE_COOLDOWN_MS;
  io.to(room.code).emit("effect:pebble", {
    x: target.x, y: target.y, targetId: target.id, thrower: player.name
  });
  sendAck(ack, { ok: true, cooldownMs: config.PEBBLE_COOLDOWN_MS });
}

io.on("connection", socket => {
  socket.on("room:create", (payload, ack) => {
    const name = cleanName(payload?.name);
    if (!name) return sendAck(ack, { ok: false, error: "Choose a name (1–12 characters, keep it friendly)." });
    createRoom(socket, name, ack);
  });

  socket.on("room:qr", async (payload, ack) => {
    const room = rooms.get(String(payload?.code || "").toUpperCase());
    if (!room || !room.players.has(socket.data.playerId)) return sendAck(ack, { ok: false, error: "Room not found." });
    const host = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
    const origin = host || `${socket.request.headers["x-forwarded-proto"] || "http"}://${socket.request.headers.host}`;
    const invite = `${origin}/?room=${encodeURIComponent(room.code)}`;
    try {
      const dataUrl = await QRCode.toDataURL(invite, {
        width: 260, margin: 1, errorCorrectionLevel: "M",
        color: { dark: "#111629", light: "#ffffff" }
      });
      sendAck(ack, { ok: true, dataUrl, invite });
    } catch {
      sendAck(ack, { ok: false, error: "QR generation failed." });
    }
  });

  socket.on("room:join", (payload, ack) => joinRoom(socket, payload || {}, ack));

  socket.on("game:input", payload => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || room.phase !== "playing" || !player?.alive || !player.socketId) return;
    let x = Number(payload?.x), y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const magnitude = hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    player.inputX = clamp(x, -1, 1);
    player.inputY = clamp(y, -1, 1);
    player.mobileControlled = payload?.mobile === true;
    if (magnitude > .08) {
      const len = hypot(player.inputX, player.inputY) || 1;
      player.lastDirX = player.inputX / len;
      player.lastDirY = player.inputY / len;
    }
  });

  socket.on("game:shove", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || room.phase !== "playing" || !player?.alive || !player.socketId) return;
    player.pendingShove = true;
  });

  socket.on("spectator:pebble", (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player) return sendAck(ack, { ok: false, error: "Room not found." });
    throwPebble(room, player, ack, now());
  });

  socket.on("game:start", ack => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.hostId !== player.id) return sendAck(ack, { ok: false, error: "Only the host can start." });
    if (!startGame(room)) return sendAck(ack, { ok: false, error: "At least 2 connected players are needed." });
    sendAck(ack, { ok: true });
  });

  socket.on("room:leave", ack => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player) return sendAck(ack, { ok: false, error: "You are not in a room." });
    removePlayerFromRoom(socket, room, player);
    sendAck(ack, { ok: true });
  });

  socket.on("game:set-round-limit", (payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    const rounds = clamp(Math.round(Number(payload?.rounds) || 3), 1, 20);
    if (!room || !player || room.hostId !== player.id) return sendAck(ack, { ok: false, error: "Only the host can change match length." });
    if (!["lobby", "scoreboard"].includes(room.phase) || room.matchFinished) return sendAck(ack, { ok: false, error: "Set the match length between rounds." });
    room.targetRounds = rounds; emitRoom(room); sendAck(ack, { ok: true, rounds });
  });

  socket.on("game:end", ack => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.hostId !== player.id) return sendAck(ack, { ok: false, error: "Only the host can end the match." });
    if (room.phase === "playing") { room.endAfterRound = true; emitRoom(room); }
    else endMatch(room, "host");
    sendAck(ack, { ok: true });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.data.playerId);
    if (!room || !player || player.socketId !== socket.id) return;
    player.socketId = null;
    player.disconnectedUntil = now() + config.DISCONNECT_GRACE_MS;
    player.inputX = player.inputY = 0;
    room.lastActivity = now();
    if (room.hostId === player.id) {
      const nextHost = [...room.players.values()].find(p => p.socketId && p.id !== player.id);
      if (nextHost) room.hostId = nextHost.id;
    }
    emitRoom(room);
  });
});

function tickRoom(room, dt, time) {
  if (room.phase === "countdown") {
    if (time >= room.countdownEndsAt) {
      room.phase = "playing";
      room.roundStartedAt = time;
      room.roundEndsAt = time + config.ROUND_DURATION_MS;
      room.nextShrinkAt = time + config.ARENA_SHRINK_INTERVAL_MS;
      room.shrinkWarning = false;
      emitRoom(room);
      io.to(room.code).emit("game:started", {
        round: room.roundNumber, durationMs: config.ROUND_DURATION_MS
      });
    }
    return;
  }
  if (room.phase !== "playing") return;

  room.tick++;
  if (room.nextShrinkAt && !room.shrinkWarning &&
      time >= room.nextShrinkAt - config.ARENA_SHRINK_WARNING_MS) {
    room.shrinkWarning = true;
    io.to(room.code).emit("arena:warning", { shrinkInMs: Math.max(0, room.nextShrinkAt - time) });
  }
  if (room.nextShrinkAt && time >= room.nextShrinkAt) {
    room.arenaRadius *= config.ARENA_SHRINK_FACTOR;
    room.shrinkCount++;
    room.nextShrinkAt += config.ARENA_SHRINK_INTERVAL_MS;
    room.shrinkWarning = false;
    io.to(room.code).emit("arena:shrink", { radius: room.arenaRadius, shrinkCount: room.shrinkCount });
  }

  // Rotating, non-lethal arena hazards.
  if (time >= room.nextHazardAt) {
    const hazards = ["tilt", "slick", "gust"];
    const current = hazards.indexOf(room.hazard);
    room.hazard = hazards[(current + 1) % hazards.length];
    room.hazardUntil = time + config.HAZARD_DURATION_MS;
    room.nextHazardAt = time + config.HAZARD_INTERVAL_MS;
    io.to(room.code).emit("arena:hazard", { type: room.hazard, durationMs: config.HAZARD_DURATION_MS });
  }
  if (time >= room.nextPickupAt && room.pickups.length < 3) {
    const types = ["speed", "shield", "magnet", "mega"];
    const type = types[crypto.randomInt(types.length)];
    const angle = Math.random() * Math.PI * 2, r = Math.random() * room.arenaRadius * .58;
    const pickup = { id: crypto.randomUUID(), type, x: Math.cos(angle)*r, y: Math.sin(angle)*r, expiresAt: time + config.POWERUP_LIFETIME_MS };
    room.pickups.push(pickup);
    io.to(room.code).emit("powerup:spawn", pickup);
    room.nextPickupAt = time + config.POWERUP_SPAWN_MIN_MS + crypto.randomInt(config.POWERUP_SPAWN_JITTER_MS);
  }
  room.pickups = room.pickups.filter(p => p.expiresAt > time);
  const playersForPickups = [...room.players.values()].filter(p => p.alive && p.socketId);
  for (const p of playersForPickups) {
    if (p.power && time >= p.powerUntil) { p.power = null; p.shieldCharges = 0; p.megaShove = false; }
    for (let i = room.pickups.length - 1; i >= 0; i--) {
      const item = room.pickups[i];
      if (hypot(p.x-item.x,p.y-item.y) < config.PLAYER_RADIUS + 14) {
        room.pickups.splice(i,1);
        p.power = item.type; p.powerUntil = time + (item.type === "shield" ? 8000 : item.type === "mega" ? 12000 : item.type === "magnet" ? 4000 : 5000);
        if (item.type === "shield") p.shieldCharges = 1;
        if (item.type === "mega") p.megaShove = true;
        io.to(room.code).emit("powerup:collect", { playerId:p.id, type:item.type, name:p.name });
        break;
      }
    }
  }

  resolveShoves(room, time);
  const players = [...room.players.values()].filter(p => p.alive && p.socketId).sort((a, b) => a.id.localeCompare(b.id));
  for (const p of players) {
    const speedBoost = p.power === "speed" && time < p.powerUntil ? 1.5 : 1;
    const magnet = p.power === "magnet" && time < p.powerUntil;
    p.vx += p.inputX * config.PLAYER_ACCELERATION * speedBoost * dt;
    p.vy += p.inputY * config.PLAYER_ACCELERATION * speedBoost * dt;
    if (magnet) {
      for (const other of players) if (other.id !== p.id && other.alive) {
        const dx = p.x-other.x, dy = p.y-other.y, d = hypot(dx,dy);
        if (d > 1 && d < 145) { other.vx += dx/d*75*dt; other.vy += dy/d*75*dt; }
      }
    }
    if (room.hazard === "tilt" && time < room.hazardUntil) { p.vx += 28*dt; p.vy -= 18*dt; }
    if (room.hazard === "gust" && time < room.hazardUntil) { p.vx += 90*dt; p.vy += 28*dt; }
    const speed = hypot(p.vx, p.vy);
    const maxSpeed = config.PLAYER_MAX_SPEED * (p.mobileControlled ? 0.72 : 1) * speedBoost;
    if (speed > maxSpeed) {
      const factor = maxSpeed / speed;
      p.vx *= factor; p.vy *= factor;
    }
    const drag = room.hazard === "slick" && time < room.hazardUntil && p.x > 0 ? .996 : config.PLAYER_DRAG;
    const damping = Math.pow(drag, dt * 60);
    p.vx *= damping; p.vy *= damping;
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  resolveCollisions(players);
  for (const p of players) {
    if (p.alive && hypot(p.x, p.y) > room.arenaRadius + config.PLAYER_RADIUS * .15) {
      eliminatePlayer(room, p, time);
    }
  }

  const alive = [...room.players.values()].filter(p => p.alive && p.socketId).length;
  if (alive <= 1 || time >= room.roundEndsAt) finishRound(room, time);
}

function snapshotRoom(room, time) {
  io.to(room.code).emit("game:snapshot", {
    serverTime: time, phase: room.phase,
    arenaRadius: room.arenaRadius, roundNumber: room.roundNumber,
    countdownRemaining: Math.max(0, room.countdownEndsAt - time),
    roundRemaining: Math.max(0, room.roundEndsAt - time),
    scoreboardRemaining: Math.max(0, room.scoreboardEndsAt - time),
    shrinkInMs: room.nextShrinkAt ? Math.max(0, room.nextShrinkAt - time) : 0,
    shrinkWarning: room.shrinkWarning,
    targetRounds: room.targetRounds, matchFinished: room.matchFinished,
    hazard: room.hazardUntil > time ? room.hazard : null,
    hazardRemaining: Math.max(0, room.hazardUntil-time),
    pickups: room.pickups.map(p => ({ id:p.id, type:p.type, x:p.x, y:p.y })),
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, hat: p.hat,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy, alive: p.alive,
      score: p.score, roundPoints: p.roundPoints,
      dashReadyIn: Math.max(0, p.dashCooldownUntil - time),
      pebbleReadyIn: Math.max(0, p.nextPebbleAt - time),
      invulnerable: p.invulnerableUntil > time,
      power: p.power && p.powerUntil > time ? p.power : null,
      powerRemaining: Math.max(0, p.powerUntil-time),
      shield: p.shieldCharges > 0
    }))
  });
}

const tickMs = 1000 / config.TICK_RATE;
setInterval(() => {
  const time = now();
  const dt = 1 / config.TICK_RATE;
  for (const [code, room] of rooms) {
    for (const [id, player] of room.players) {
      if (!player.socketId && player.disconnectedUntil && time >= player.disconnectedUntil) {
        room.players.delete(id);
        if (room.hostId === id) room.hostId = [...room.players.values()].find(p => p.socketId)?.id || null;
        emitRoom(room);
      }
    }
    if (room.phase === "lobby" && room.autoStartAt && time >= room.autoStartAt) {
      if (!startGame(room)) room.autoStartAt = 0;
    }
    tickRoom(room, dt, time);
    if (room.phase === "scoreboard" && time >= room.scoreboardEndsAt) {
      if (room.matchFinished) endMatch(room, "round-limit");
      else if ([...room.players.values()].filter(p => p.socketId).length >= 2) startGame(room);
      else {
        room.phase = "lobby";
        room.lastActivity = time;
        emitRoom(room);
      }
    }
    if (room.players.size === 0 && time - room.lastActivity > config.ROOM_IDLE_TTL_MS) {
      rooms.delete(code);
      console.log(`[rooms] ${rooms.size} active — expired ${code}`);
    }
  }
  for (const room of rooms.values()) {
    if (time - room.lastSnapshotAt >= 1000 / config.SNAPSHOT_RATE) {
      room.lastSnapshotAt = time;
      if (["countdown", "playing", "scoreboard"].includes(room.phase)) snapshotRoom(room, time);
    }
  }
  if (Math.floor(time / 60000) !== Math.floor((time - tickMs) / 60000)) {
    console.log(`[rooms] ${rooms.size} active`);
  }
}, tickMs);

const port = config.PORT;
server.listen(port, "0.0.0.0", () => console.log(`Shove & Survive listening on :${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

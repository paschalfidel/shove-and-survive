(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const socket = io({ transports: ["websocket", "polling"] });
  const canvas = $("game");
  const ctx = canvas.getContext("2d", { alpha: false });
  const entryScreen = $("entry-screen");
  const roomScreen = $("room-screen");
  const nameInput = $("player-name");
  const codeInput = $("room-code");
  const entryError = $("entry-error");
  const playerList = $("player-list");
  const message = $("game-message");
  const joystick = $("joystick");
  const stick = $("stick");
  const dashButton = $("dash-button");
  const pebbleButton = $("pebble-button");
  const keys = new Set();
  const input = { x: 0, y: 0 };
  const joystickState = { active: false, pointerId: null, x: 0, y: 0 };
  const arenaTouch = { active: false, pointerId: null, startX: 0, startY: 0, x: 0, y: 0 };
  const touchDevice = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const TOUCH_MOVE_SCALE = 1.0;
  let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let audioContext = null;

  let room = null, playerId = null, reconnectKey = null, isHost = false;
  let width = 0, height = 0, dpr = 1, scale = 1;
  let snapshots = [], renderPlayers = [];
  let localDashReadyAt = 0, localPebbleReadyAt = 0, lastInputSentAt = 0;
  let shake = 0, effects = [], lastFrame = performance.now();
  let currentSnapshot = null, roundEndData = null;

  function storageKey(code) { return `sas-reconnect-${code}`; }
  function getName() { return nameInput.value.trim().slice(0, 12); }
  function showError(text) { entryError.textContent = text || ""; }
  function setMessage(title, subtitle) {
    message.querySelector("strong").textContent = title;
    message.querySelector("span").textContent = subtitle || "";
    message.classList.remove("hidden");
  }
  function formatTime(ms) {
    const sec = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  function renderLeaderboard(items) {
    const list = $("session-leaderboard");
    list.replaceChildren();
    (items || []).slice(0, 8).forEach((p, i) => {
      const li = document.createElement("li");
      const rank = document.createElement("b");
      rank.textContent = `${i + 1}.`;
      const dot = document.createElement("i");
      dot.className = "leader-dot";
      dot.style.background = p.color;
      const name = document.createElement("span");
      name.textContent = p.name;
      const score = document.createElement("strong");
      score.textContent = `${p.score} PTS`;
      li.append(rank, dot, name, score);
      list.append(li);
    });
  }

  function setRoomUI(summary) {
    room = summary;
    $("room-code-display").textContent = summary.code;
    $("player-count").textContent = `${summary.players.length} / 8`;
    $("alive-count").textContent = summary.players.filter(p => p.alive).length;
    $("status").textContent = summary.phase.toUpperCase();
    if (summary.endAfterRound) $("lobby-status").textContent = "MATCH WILL END AFTER THIS ROUND";
    const canStart = isHost && summary.players.filter(p => p.connected).length >= 2 &&
      ["lobby", "scoreboard"].includes(summary.phase);
    $("start-button").disabled = !canStart;
    $("round-limit").value = String(summary.targetRounds || 3);
    $("round-limit").disabled = !isHost || !["lobby", "scoreboard"].includes(summary.phase) || summary.matchFinished;
    $("end-match-button").disabled = !isHost || summary.phase === "finished" || summary.matchFinished;
    $("end-match-button").classList.toggle("hidden", !isHost || summary.phase === "finished" || summary.matchFinished);
    $("start-button").classList.toggle("hidden", summary.phase === "finished" || summary.matchFinished);
    $("leave-button").textContent = "LEAVE GAME";
    $("start-button").textContent = summary.phase === "scoreboard" ? "START NEXT ROUND" :
      summary.players.length < 2 ? "START GAME · NEED 2" : summary.phase === "lobby" ? "START GAME" : "ROUND IN PROGRESS";
    const matchChoice = summary.matchFinished && summary.phase === "scoreboard";
    $("match-choice").classList.toggle("hidden", !matchChoice);
    $("restart-match-button").classList.toggle("hidden", !isHost);
    $("finish-game-button").classList.toggle("hidden", !isHost);
    if (matchChoice && !isHost) $("next-round-note").textContent = "WAITING FOR THE HOST TO RESTART OR END THE GAME";

    playerList.replaceChildren();
    for (const p of summary.players) {
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = "player-swatch";
      swatch.style.background = p.color;
      const name = document.createElement("span");
      name.textContent = `${p.hat} ${p.name}`;
      const meta = document.createElement("span");
      meta.className = "player-meta";
      meta.textContent = p.id === summary.hostId ? "HOST" : p.connected ? "READY" : "RECONNECTING";
      li.append(swatch, name, meta);
      playerList.append(li);
    }
    renderLeaderboard(summary.leaderboard);

    const me = summary.players.find(p => p.id === playerId);
    const spectator = summary.phase === "playing" && me && !me.alive;
    pebbleButton.classList.toggle("hidden", !spectator);
    dashButton.classList.toggle("hidden", Boolean(spectator));
    dashButton.disabled = summary.phase !== "playing" || Boolean(spectator);

    if (summary.phase === "lobby") {
      $("lobby-status").textContent = summary.players.length < 2 ? "Waiting for at least 2 players…" : "Host can start · auto-start in 20s";
      setMessage("READY?", "Share your code and bring the chaos.");
      $("scoreboard").classList.add("hidden");
    } else if (summary.phase === "countdown") {
      setMessage("GET READY!", `ROUND ${summary.roundNumber}`);
      $("scoreboard").classList.add("hidden");
    } else if (summary.phase === "playing") {
      message.classList.add("hidden");
      $("scoreboard").classList.add("hidden");
    } else if (summary.phase === "scoreboard") {
      message.classList.add("hidden");
      if (roundEndData) showScoreboard(roundEndData);
    } else if (summary.phase === "finished") {
      message.classList.add("hidden");
      $("scoreboard").classList.remove("hidden");
      $("scoreboard-title").textContent = "MATCH COMPLETE";
      $("match-winner").textContent = summary.matchWinner ? `🏆 OVERALL WINNER: ${summary.matchWinner.name} · ${summary.matchWinner.score} PTS` : "MATCH ENDED";
      $("match-winner").classList.remove("hidden");
      $("next-round-note").textContent = "THE HOST CAN START A NEW MATCH BY CREATING A NEW ROOM";
      $("match-choice").classList.add("hidden");
    }
  }

  function enterRoom(result, host) {
    if (!result?.ok) { showError(result?.error || "Couldn't join that room."); return; }
    playerId = result.playerId;
    reconnectKey = result.reconnectKey;
    isHost = Boolean(host || result.isHost);
    room = result.room;
    if (room.lastResult) roundEndData = room.lastResult;
    localStorage.setItem(storageKey(room.code), reconnectKey);
    entryScreen.classList.add("hidden");
    roomScreen.classList.remove("hidden");
    showError("");
    const inviteUrl = `${location.origin}/?room=${encodeURIComponent(room.code)}`;
    $("copy-link").onclick = async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        $("copy-link").textContent = "LINK COPIED!";
      } catch { window.prompt("Copy this invite link:", inviteUrl); }
      setTimeout(() => $("copy-link").textContent = "COPY INVITE LINK", 1500);
    };
    socket.emit("room:qr", { code: room.code }, response => {
      if (response?.ok) $("room-qr").src = response.dataUrl;
    });
    setRoomUI(room);
    if (room.lastResult && room.phase === "scoreboard") showScoreboard(room.lastResult);
    resize();
  }

  $("create-button").addEventListener("click", () => {
    const name = getName();
    if (!name) return showError("Enter a display name first.");
    socket.emit("room:create", { name }, result => enterRoom(result, true));
  });
  $("join-button").addEventListener("click", () => {
    const name = getName();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) return showError("Enter a display name first.");
    if (code.length !== 6) return showError("Enter the 6-character room code.");
    socket.emit("room:join", { name, code, reconnectKey: localStorage.getItem(storageKey(code)) }, result => enterRoom(result, false));
  });
  $("start-button").addEventListener("click", () => {
    socket.emit("game:start", result => {
      if (!result?.ok) $("lobby-status").textContent = result?.error || "Unable to start.";
    });
  });
  $("leave-button").addEventListener("click", () => {
    if (!room) return location.href = "/";
    const code = room.code;
    socket.emit("room:leave", () => {
      localStorage.removeItem(storageKey(code));
      location.href = "/";
    });
  });
  $("round-limit").addEventListener("change", () => {
    socket.emit("game:set-round-limit", { rounds: Number($("round-limit").value) }, result => {
      if (!result?.ok) $("lobby-status").textContent = result?.error || "Unable to update match length.";
    });
  });
  $("end-match-button").addEventListener("click", () => {
    if (!window.confirm("End the match? If a round is active, it will finish before the overall winner is declared.")) return;
    socket.emit("game:end", result => {
      if (!result?.ok) $("lobby-status").textContent = result?.error || "Unable to end match.";
    });
  });
  $("restart-match-button").addEventListener("click", () => {
    socket.emit("game:restart", result => {
      if (!result?.ok) showError(result?.error || "Unable to restart the match.");
      else showError("");
    });
  });
  $("finish-game-button").addEventListener("click", () => {
    if (!window.confirm("End the game and keep the final results on screen?")) return;
    socket.emit("game:end", result => {
      if (!result?.ok) showError(result?.error || "Unable to end the game.");
      else showError("");
    });
  });
  $("reduced-motion-toggle").checked = reducedMotion;
  $("reduced-motion-toggle").addEventListener("change", e => { reducedMotion = e.target.checked; });

  function beep(freq = 440, duration = .07, type = "sine") {
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") audioContext.resume();
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
      oscillator.type = type; oscillator.frequency.value = freq;
      gain.gain.setValueAtTime(.045, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(); oscillator.stop(audioContext.currentTime + duration);
    } catch {}
  }

  socket.on("connect", () => {
    if (room && playerId && reconnectKey) {
      socket.emit("room:join", {
        name: getName() || room.players?.find(p => p.id === playerId)?.name || "Player",
        code: room.code,
        reconnectKey
      }, result => {
        if (result?.ok) enterRoom(result, result.isHost);
        else showError(result?.error || "Reconnection failed. Rejoin the room.");
      });
      return;
    }
    const queryCode = new URLSearchParams(location.search).get("room");
    if (queryCode && !room) {
      codeInput.value = queryCode.toUpperCase().slice(0, 6);
      nameInput.focus();
    }
  });
  socket.on("connect_error", () => showError("Can't reach the game server. Refresh to retry."));
  socket.on("room:update", summary => {
    if (!room || summary.code !== room.code) return;
    isHost = summary.hostId === playerId;
    setRoomUI(summary);
    if (!summary.players.some(p => p.id === playerId)) $("lobby-status").textContent = "You left this room.";
  });
  socket.on("game:countdown", data => {
    roundEndData = null;
    setMessage("3", `ROUND ${data.round}`);
    $("scoreboard").classList.add("hidden");
  });
  socket.on("game:started", data => {
    currentSnapshot = null;
    snapshots = [];
    setMessage("GO!", `ROUND ${data.round}`);
    setTimeout(() => message.classList.add("hidden"), 450);
  });
  socket.on("game:snapshot", snapshot => {
    if (!room) return;
    snapshots.push({ receivedAt: performance.now(), data: snapshot });
    // Keep a short history so the renderer can interpolate smoothly between
    // authoritative server snapshots instead of stepping at the network rate.
    if (snapshots.length > 6) snapshots.shift();
    currentSnapshot = snapshot;
    room.phase = snapshot.phase;
    room.arenaRadius = snapshot.arenaRadius;
    const me = snapshot.players.find(p => p.id === playerId);
    if (me) {
      localDashReadyAt = performance.now() + me.dashReadyIn;
      localPebbleReadyAt = performance.now() + me.pebbleReadyIn;
      pebbleButton.classList.toggle("hidden", snapshot.phase !== "playing" || me.alive);
      dashButton.classList.toggle("hidden", snapshot.phase === "playing" && !me.alive);
    }
    $("alive-count").textContent = snapshot.players.filter(p => p.alive).length;
    $("status").textContent = snapshot.phase.toUpperCase();
    if (snapshot.phase === "countdown") {
      const count = String(Math.max(1, Math.ceil(snapshot.countdownRemaining / 1000)));
      $("round-timer").textContent = count;
      setMessage(count, "GET READY!");
    } else if (snapshot.phase === "playing") {
      $("round-timer").textContent = formatTime(snapshot.roundRemaining);
    } else if (snapshot.phase === "scoreboard") {
      $("round-timer").textContent = snapshot.matchFinished
        ? "FINAL"
        : `NEXT ${Math.ceil(snapshot.scoreboardRemaining / 1000)}s`;
    }
  });
  socket.on("arena:warning", () => {
    if (!reducedMotion) shake = Math.max(shake, 2);
    $("arena-warning").classList.remove("hidden");
  });
  socket.on("arena:shrink", () => {
    $("arena-warning").classList.add("hidden");
    addBurst(width / 2, height / 2, "#ffb84d", 18);
  });
  socket.on("arena:hazard", data => {
    setMessage(data.type === "tilt" ? "TILT!" : data.type === "slick" ? "SLIPPERY!" : "GUST!");
    beep(data.type === "gust" ? 260 : 360, .13, "triangle");
    setTimeout(() => { if (room?.phase === "playing") message.classList.add("hidden"); }, 900);
  });
  socket.on("powerup:spawn", () => beep(720, .06));
  socket.on("powerup:collect", data => {
    setMessage(({speed:"SPEED BOOST!",shield:"SHIELD UP!",magnet:"MAGNET!",mega:"MEGA SHOVE!"})[data.type], data.name);
    beep(880, .12, "triangle");
    if (!reducedMotion) shake = Math.max(shake, 2);
    setTimeout(() => { if (room?.phase === "playing") message.classList.add("hidden"); }, 850);
  });
  socket.on("powerup:shield-break", data => {
    if (data.playerId === playerId) setMessage("SHIELD BLOCKED!", "One shove absorbed");
    beep(180, .1, "square");
  });
  socket.on("game:match-end", result => {
    $("scoreboard-title").textContent = "MATCH COMPLETE";
    $("match-winner").textContent = result.winner ? `🏆 OVERALL WINNER: ${result.winner.name} · ${result.winner.score} PTS` : "MATCH ENDED";
    $("match-winner").classList.remove("hidden");
    $("next-round-note").textContent = `${result.roundsPlayed} ROUNDS PLAYED`;
    $("scoreboard").classList.remove("hidden");
    if (room) { room.phase = "finished"; room.matchWinner = result.winner; }
    setMessage("MATCH OVER", result.winner ? `${result.winner.name} wins!` : "No winner");
    beep(660,.16); setTimeout(()=>beep(880,.22),180);
  });
  socket.on("game:round-end", result => {
    roundEndData = result;
    showScoreboard(result);
    setRoomUI({ ...room, phase: "scoreboard", leaderboard: result.leaderboard });
  });
  socket.on("game:bonus", bonus => {
    setMessage(`+${bonus.points} PTS`, bonus.reason);
    setTimeout(() => message.classList.add("hidden"), 1100);
  });
  socket.on("effect:shove", effect => {
    const p = worldToScreen(effect.x, effect.y);
    addBurst(p.x, p.y, "#ff668e", 12);
    if (!reducedMotion) shake = Math.max(shake, 4);
  });
  socket.on("effect:fall", effect => {
    const p = worldToScreen(effect.x, effect.y);
    addBurst(p.x, p.y, "#ffb84d", 20);
    if (effect.playerId === playerId) {
      setMessage("OOF!", "Spectator mode · toss a pebble!");
      pebbleButton.classList.remove("hidden");
      dashButton.classList.add("hidden");
    }
  });
  socket.on("effect:pebble", effect => {
    const p = worldToScreen(effect.x, effect.y);
    addBurst(p.x, p.y, "#b9a7ff", 10);
    setMessage("PLOP!", `${effect.thrower} tossed a pebble`);
    setTimeout(() => { if (room?.phase === "playing") message.classList.add("hidden"); }, 650);
  });
  socket.on("game:dash", () => {
    const me = renderPlayers.find(p => p.id === playerId);
    if (me) {
      const p = worldToScreen(me.x, me.y);
      addBurst(p.x, p.y, "#eaffae", 8);
    }
  });

  function showScoreboard(result) {
    if (!result) return;
    const panel = $("scoreboard");
    const standings = $("round-standings");
    standings.replaceChildren();
    (result.standings || []).forEach(row => {
      const li = document.createElement("li");
      const place = document.createElement("b");
      place.textContent = `#${row.place}`;
      const icon = document.createElement("span");
      icon.textContent = row.hat || "●";
      const name = document.createElement("span");
      name.textContent = row.name;
      const pts = document.createElement("strong");
      pts.textContent = `+${row.roundPoints}`;
      li.append(place, icon, name, pts);
      standings.append(li);
    });
    const mvp = result.mvp;
    $("mvp-callout").textContent = mvp ? `${mvp.emoji} ${mvp.name} · ${mvp.label}` : "NO MVP THIS ROUND";
    $("scoreboard-title").textContent = result.matchComplete ? "FINAL MATCH RESULTS" : `ROUND ${result.round} RESULTS`;
    const winner = $("match-winner");
    if (result.matchComplete && result.matchWinner) {
      winner.textContent = `🏆 OVERALL WINNER: ${result.matchWinner.name} · ${result.matchWinner.score} PTS`;
      winner.classList.remove("hidden");
      $("next-round-note").textContent = "MATCH COMPLETE";
    } else {
      winner.classList.add("hidden");
      $("next-round-note").textContent = `ROUND ${result.round} OF ${result.targetRounds || 3} · NEXT ROUND STARTS AUTOMATICALLY`;
    }
    $("scoreboard").classList.remove("hidden");
    renderLeaderboard(result.leaderboard);
  }

  function worldToScreen(x, y) { return { x: width / 2 + x * scale, y: height / 2 + y * scale }; }

  function interpolatePlayers(nowTime) {
    if (!snapshots.length) return renderPlayers;
    if (snapshots.length === 1) return snapshots[0].data.players;

    // Render slightly behind the newest server state. This gives us two real
    // snapshots to blend between and removes the visible 30 Hz position steps.
    const renderTime = nowTime - 50;
    let a = snapshots[0], b = snapshots[1];
    for (let i = 0; i < snapshots.length - 1; i++) {
      if (renderTime >= snapshots[i].receivedAt && renderTime <= snapshots[i + 1].receivedAt) {
        a = snapshots[i];
        b = snapshots[i + 1];
        break;
      }
      if (renderTime > snapshots[snapshots.length - 1].receivedAt) {
        a = snapshots[snapshots.length - 2];
        b = snapshots[snapshots.length - 1];
      }
    }
    const span = Math.max(1, b.receivedAt - a.receivedAt);
    const alpha = Math.max(0, Math.min(1, (renderTime - a.receivedAt) / span));
    const mapA = new Map(a.data.players.map(p => [p.id, p]));
    return b.data.players.map(p => {
      const old = mapA.get(p.id);
      if (!old) return p;
      return {
        ...p,
        x: old.x + (p.x - old.x) * alpha,
        y: old.y + (p.y - old.y) * alpha,
        vx: old.vx + (p.vx - old.vx) * alpha,
        vy: old.vy + (p.vy - old.vy) * alpha
      };
    });
  }

  function drawArena() {
    const c = { x: width / 2, y: height / 2 };
    const radius = (currentSnapshot?.arenaRadius || room?.arenaRadius || 260) * scale;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.fillStyle = "#11182b";
    ctx.beginPath(); ctx.arc(0, 0, radius + 14 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#394667";
    ctx.beginPath(); ctx.arc(0, 0, radius + 6 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f5f7fc";
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = "#dce2ee"; ctx.lineWidth = 1;
    const grid = Math.max(12, 28 * scale);
    for (let x = -radius; x <= radius; x += grid) { ctx.beginPath(); ctx.moveTo(x, -radius); ctx.lineTo(x, radius); ctx.stroke(); }
    for (let y = -radius; y <= radius; y += grid) { ctx.beginPath(); ctx.moveTo(-radius, y); ctx.lineTo(radius, y); ctx.stroke(); }
    ctx.restore();
    if (currentSnapshot?.hazard === "slick") {
      ctx.save(); ctx.beginPath(); ctx.arc(0,0,radius,0,Math.PI*2); ctx.clip();
      ctx.fillStyle = "#8be7ff"; ctx.globalAlpha = .18;
      ctx.fillRect(0,-radius,radius,radius*2);
      ctx.globalAlpha = .7; ctx.strokeStyle = "#7bdcf3"; ctx.lineWidth = 2;
      for (let x=18; x<radius; x+=24) {
        ctx.beginPath(); ctx.moveTo(x,-radius); ctx.lineTo(x,radius); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.strokeStyle = "#aeb9d0"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    if (currentSnapshot?.shrinkWarning) {
      ctx.save();
      ctx.strokeStyle = "#ff9c56"; ctx.lineWidth = 5;
      ctx.setLineDash([9, 7]);
      ctx.beginPath(); ctx.arc(c.x, c.y, radius * .85, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      $("arena-warning").classList.remove("hidden");
    } else {
      $("arena-warning").classList.add("hidden");
    }
  }

  function drawPickups() {
    const items = currentSnapshot?.pickups || [];
    for (const item of items) {
      const p = worldToScreen(item.x, item.y);
      const icon = ({speed:"⚡",shield:"🛡️",magnet:"🧲",mega:"💥"})[item.type] || "✦";
      ctx.save(); ctx.shadowColor = "#fff"; ctx.shadowBlur = 12;
      ctx.fillStyle = "#293653"; ctx.beginPath(); ctx.arc(p.x,p.y,13*scale,0,Math.PI*2); ctx.fill();
      ctx.font = `${Math.max(14,22*scale)}px system-ui`; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(icon,p.x,p.y); ctx.restore();
    }
  }

  function drawBlob(player) {
    const p = worldToScreen(player.x, player.y);
    const radius = 21 * scale;
    const speed = Math.hypot(player.vx || 0, player.vy || 0);
    const stretch = Math.min(speed / 500, .13);
    const angle = Math.atan2(player.vy || 0, player.vx || 0);
    ctx.save();
    ctx.translate(p.x, p.y);
    if (speed > 75) {
      ctx.save(); ctx.rotate(angle);
      ctx.globalAlpha = .22; ctx.fillStyle = player.color;
      ctx.beginPath(); ctx.ellipse(-radius*.95,0,radius*1.2,radius*.55,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    if (speed > 5) ctx.rotate(angle);
    ctx.scale(1 + stretch, 1 - stretch * .6);
    ctx.shadowColor = "#27314d55"; ctx.shadowBlur = 11; ctx.shadowOffsetY = 5;
    ctx.fillStyle = player.color;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#24314b";
    ctx.beginPath(); ctx.arc(-radius * .3, -radius * .08, radius * .11, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(radius * .3, -radius * .08, radius * .11, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#24314b"; ctx.lineWidth = Math.max(1.5, radius * .09); ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(0, radius * .05, radius * .28, .15, Math.PI - .15); ctx.stroke();
    if (player.invulnerable) {
      ctx.strokeStyle = "#69d5ff"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, radius + 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
    ctx.font = `${Math.max(13, radius * .8)}px system-ui`; ctx.textAlign = "center";
    ctx.fillText(player.hat || "⭐", p.x, p.y - radius * 1.05);
    if (player.power) {
      ctx.font = "bold 12px system-ui";
      ctx.fillText(({speed:"⚡",shield:"🛡️",magnet:"🧲",mega:"💥"})[player.power], p.x + radius, p.y - radius);
    }
    ctx.font = "800 10px system-ui"; ctx.fillStyle = "#1c2743";
    ctx.fillText(player.name, p.x, p.y + radius + 14);
  }

  function addBurst(x, y, color, count) {
    if (reducedMotion) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, speed = 30 + Math.random() * 140;
      effects.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life: .4 + Math.random() * .25, max: .65, color, size: 2 + Math.random() * 4 });
    }
  }
  function drawEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const p = effects[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= .97; p.vy *= .97; p.life -= dt;
      if (p.life <= 0) { effects.splice(i, 1); continue; }
      ctx.globalAlpha = p.life / p.max; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame(nowTime) {
    const dt = Math.min((nowTime - lastFrame) / 1000, .04);
    lastFrame = nowTime;
    renderPlayers = interpolatePlayers(nowTime) || [];
    ctx.save();
    if (!reducedMotion && shake > .1) { ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake); shake *= .82; }
    ctx.fillStyle = "#1b2340"; ctx.fillRect(0, 0, width, height);
    drawArena();
    drawPickups();
    drawEffects(dt);
    if (currentSnapshot?.hazard) {
      ctx.save(); ctx.fillStyle = "#1c2743"; ctx.globalAlpha = .75;
      ctx.font = "900 12px system-ui"; ctx.textAlign = "center";
      ctx.fillText(({tilt:"↗ TILT DRIFT",slick:"〰 SLICK FLOOR",gust:"➤ GUST"})[currentSnapshot.hazard], width/2, 82);
      ctx.restore();
    }
    for (const p of renderPlayers) if (p.alive) drawBlob(p);
    ctx.restore();
    const me = renderPlayers.find(p => p.id === playerId);
    const spectator = room?.phase === "playing" && me && !me.alive;
    const dashReady = performance.now() >= localDashReadyAt;
    dashButton.disabled = !dashReady || room?.phase !== "playing" || Boolean(spectator);
    $("cooldown-caption").textContent = dashReady ? "READY" : `${Math.max(0, (localDashReadyAt - performance.now()) / 1000).toFixed(1)} SEC`;
    pebbleButton.disabled = performance.now() < localPebbleReadyAt;
    $("pebble-caption").textContent = pebbleButton.disabled ? `${Math.max(0, (localPebbleReadyAt - performance.now()) / 1000).toFixed(1)}s` : "TOSS";
    requestAnimationFrame(frame);
  }

  function readKeys() {
    let x = 0, y = 0;
    if (keys.has("a") || keys.has("arrowleft")) x--;
    if (keys.has("d") || keys.has("arrowright")) x++;
    if (keys.has("w") || keys.has("arrowup")) y--;
    if (keys.has("s") || keys.has("arrowdown")) y++;
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }
  function updateInput() {
    const k = readKeys();
    if (arenaTouch.active) {
      input.x = arenaTouch.x * TOUCH_MOVE_SCALE;
      input.y = arenaTouch.y * TOUCH_MOVE_SCALE;
    } else if (joystickState.active) {
      input.x = joystickState.x * (touchDevice ? TOUCH_MOVE_SCALE : 1);
      input.y = joystickState.y * (touchDevice ? TOUCH_MOVE_SCALE : 1);
    } else {
      input.x = k.x;
      input.y = k.y;
    }
    const t = performance.now();
    if (t - lastInputSentAt >= 16 && socket.connected && room?.phase === "playing") {
      socket.emit("game:input", input);
      lastInputSentAt = t;
    }
  }
  function shove() {
    if (!socket.connected || room?.phase !== "playing" || dashButton.disabled) return;
    socket.emit("game:shove");
    localDashReadyAt = performance.now() + 2500;
    dashButton.disabled = true;
  }
  function pebble() {
    if (!socket.connected || room?.phase !== "playing" || pebbleButton.disabled) return;
    socket.emit("spectator:pebble", {}, result => {
      if (!result?.ok) {
        $("lobby-status").textContent = result?.error || "Pebble unavailable.";
        return;
      }
      localPebbleReadyAt = performance.now() + (result.cooldownMs || 3000);
    });
  }

  // On touch devices, drag directly on the arena to steer.
  // The drag is relative to the initial touch point, so players can hold
  // anywhere on the playfield without needing to reach a fixed control.
  if (touchDevice) {
    canvas.addEventListener("pointerdown", e => {
      if (e.pointerType !== "touch" || room?.phase !== "playing" || arenaTouch.active) return;
      e.preventDefault();
      arenaTouch.active = true;
      arenaTouch.pointerId = e.pointerId;
      arenaTouch.startX = e.clientX;
      arenaTouch.startY = e.clientY;
      arenaTouch.x = arenaTouch.y = 0;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });
    canvas.addEventListener("pointermove", e => {
      if (!arenaTouch.active || e.pointerId !== arenaTouch.pointerId) return;
      e.preventDefault();
      const dx = e.clientX - arenaTouch.startX;
      const dy = e.clientY - arenaTouch.startY;
      const maxDrag = 52;
      const distance = Math.hypot(dx, dy);
      const strength = Math.min(distance / maxDrag, 1);
      if (distance < 4) {
        arenaTouch.x = arenaTouch.y = 0;
      } else {
        arenaTouch.x = (dx / distance) * strength;
        arenaTouch.y = (dy / distance) * strength;
      }
    });
    function releaseArenaTouch(e) {
      if (e && e.pointerId !== arenaTouch.pointerId) return;
      arenaTouch.active = false;
      arenaTouch.pointerId = null;
      arenaTouch.x = arenaTouch.y = 0;
    }
    canvas.addEventListener("pointerup", releaseArenaTouch);
    canvas.addEventListener("pointercancel", releaseArenaTouch);
    canvas.addEventListener("lostpointercapture", releaseArenaTouch);
    canvas.addEventListener("contextmenu", e => e.preventDefault());
  }

  joystick.addEventListener("pointerdown", e => {
    e.preventDefault();
    if (joystickState.active) return;
    joystickState.active = true; joystickState.pointerId = e.pointerId;
    try { joystick.setPointerCapture(e.pointerId); } catch (_) {}
    setStick(e);
  });
  function setStick(e) {
    const rect = joystick.getBoundingClientRect(), max = rect.width * .32;
    let dx = e.clientX - rect.left - rect.width / 2, dy = e.clientY - rect.top - rect.height / 2;
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    joystickState.x = dx / max; joystickState.y = dy / max;
    stick.style.transform = `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;
  }
  joystick.addEventListener("pointermove", e => { if (joystickState.active && e.pointerId === joystickState.pointerId) setStick(e); });
  function releaseStick(e) {
    if (e && e.pointerId !== joystickState.pointerId) return;
    joystickState.active = false; joystickState.pointerId = null; joystickState.x = joystickState.y = 0;
    stick.style.transform = "translate(-50%,-50%)";
  }
  joystick.addEventListener("pointerup", releaseStick);
  joystick.addEventListener("pointercancel", releaseStick);
  joystick.addEventListener("lostpointercapture", releaseStick);
  dashButton.addEventListener("pointerdown", e => { e.preventDefault(); shove(); });
  pebbleButton.addEventListener("pointerdown", e => { e.preventDefault(); pebble(); });
  window.addEventListener("keydown", e => {
    const key = e.key.toLowerCase();
    if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(key)) e.preventDefault();
    keys.add(key); if (key === " " && !e.repeat) shove();
  });
  window.addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => {
    keys.clear(); releaseStick();
    arenaTouch.active = false; arenaTouch.pointerId = null; arenaTouch.x = arenaTouch.y = 0;
  });
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => requestAnimationFrame(resize));
  window.addEventListener("pagehide", () => socket.disconnect());
  window.addEventListener("pageshow", () => { if (!socket.connected) socket.connect(); });

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scale = Math.min((width * .43) / 260, (height * .43) / 260, 1.2);
  }

  resize();
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
  requestAnimationFrame(frame);
  setInterval(updateInput, 16);
  const queryCode = new URLSearchParams(location.search).get("room");
  if (queryCode) codeInput.value = queryCode.toUpperCase().slice(0, 6);
  if (queryCode) $("join-button").textContent = "JOIN THIS ROOM";
})();

let lastFakeOnline21 = -1;
let lastUpdateFakeTime21 = 0;


function readFakeOnline21Config() {
  try {
    const configPath = path.join(__dirname, "fake_online_21.json");
    if (!fs.existsSync(configPath)) return null;
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!data || typeof data !== "object") return null;
    return {
      enabled: Boolean(data.enabled),
      min: parseInt(data.min, 10),
      max: parseInt(data.max, 10)
    };
  } catch (e) {
    console.log("[FAKE-ONLINE-21] Error reading config:", e.message);
    return null;
  }
}

function broadcastLobbyStats() {
  const realCount = (typeof activeSocket21 !== 'undefined') ? activeSocket21.size : (io.engine.clientsCount || 0);

  let count = realCount;
  const fakeCfg = readFakeOnline21Config();
  // اصلاحِ لحظه‌ایِ عددِ فیک اگر از محدوده خارج شده باشد
  if (fakeCfg && lastFakeOnline21 !== -1) {
  if (lastFakeOnline21 > fakeCfg.max) lastFakeOnline21 = fakeCfg.max;
  if (lastFakeOnline21 < fakeCfg.min) lastFakeOnline21 = fakeCfg.min;
  }

  if (fakeCfg && fakeCfg.enabled && Number.isFinite(fakeCfg.min) && Number.isFinite(fakeCfg.max) && fakeCfg.max >= fakeCfg.min && fakeCfg.max > 0) {
    const now = Date.now();
    if (lastFakeOnline21 === -1 || (now - lastUpdateFakeTime21) >= 300000) {
      if (lastFakeOnline21 === -1) {
        lastFakeOnline21 = fakeCfg.min + Math.floor(Math.random() * (fakeCfg.max - fakeCfg.min + 1));
      } else {
        let change = Math.floor(Math.random() * 4) + 1;
        change *= (Math.random() > 0.5) ? 1 : -1;
        lastFakeOnline21 = Math.min(Math.max(lastFakeOnline21 + change, fakeCfg.min), fakeCfg.max);
      }
      lastUpdateFakeTime21 = now;
    }
    count = lastFakeOnline21;
  }

  io.emit("lobby:stats", { online: count, onlineCount: count, realOnline: realCount });
}

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");

dotenv.config();

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  path: "/21/socket.io",
  pingInterval: 2000,
  pingTimeout: 4000,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const JWT_SECRET = process.env.JWT_SECRET;
const SEAT_KEYS = ["seat_1", "seat_2", "seat_3", "seat_4", "seat_5"];
const MAX_SEATS = 5;
const WAITING_COUNTDOWN_SEC = 30;
const TURN_TIME_SEC = 35;
const TREASURY_FEE_PERCENT = 0.10;

const matches = new Map();
const userMatchMap = new Map();
const activeSocket21 = new Map();
const disconnectTimers = new Map();

function createDeck() {
  const suits = ["hearts", "diamonds", "clubs", "spades"];
  const values = [
    { rank: "6", val: 6 }, { rank: "7", val: 7 },
    { rank: "8", val: 8 }, { rank: "9", val: 9 }, { rank: "10", val: 10 },
    { rank: "J", val: 2 }, { rank: "Q", val: 3 }, { rank: "K", val: 4 },
    { rank: "A", val: 11 }
  ];
  const deck = [];
  for (const suit of suits) {
    for (const v of values) {
      deck.push({ suit, rank: v.rank, value: v.val });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateHand(cards) {
  let total = 0;
  for (const c of cards) {
    total += c.value;
  }
  const isBlackjack = (cards.length === 2 && total === 21);
  const isBusted = total > 21;
  return { score: total, isBlackjack, isBusted };
}

function createNewMatch(tier) {
  return {
    id: "m21_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    tier: Number(tier),
    status: "WAITING",
    countdownSeconds: WAITING_COUNTDOWN_SEC,
    countdownTimer: null,
    currentTurnSeat: null,
    turnTimeLeft: TURN_TIME_SEC,
    turnTimer: null,
    totalPot: 0,
    deck: [],
    players: {},
    results: null,
    settled: false,
    createdAt: Date.now()
  };
}

function getMatchState(match) {
  const playersState = {};
  for (const seat of SEAT_KEYS) {
    const p = match.players[seat];
    if (p) {
      playersState[seat] = {
        userId: p.userId,
        username: p.username,
        cards: p.cards,
        score: p.score,
        isBlackjack: p.isBlackjack,
        isBusted: p.isBusted,
        isStand: p.isStand
      };
    } else {
      playersState[seat] = null;
    }
  }
  return {
    matchId: match.id,
    tier: match.tier,
    status: match.status,
    totalPot: match.totalPot,
    countdownSeconds: match.countdownSeconds,
    currentTurnSeat: match.currentTurnSeat,
    turnTimeLeft: match.turnTimeLeft,
    players: playersState,
    results: match.results
  };
}

function broadcastMatchState(match) {
  const state = getMatchState(match);
  io.to("match21:" + match.id).emit("match21:state", state);
  io.to("match21:" + match.id).emit("game:state", state);

  if (match.status === "WAITING" || match.status === "COUNTDOWN") {
    const pCount = Object.keys(match.players).length;
    io.to("match21:" + match.id).emit("lobby:status", {
      matchId: match.id,
      tier: match.tier,
      playersCount: pCount,
      countdown: match.countdownSeconds,
      phase: pCount === MAX_SEATS ? 5 : (match.status === "COUNTDOWN" ? pCount : 1),
      message: match.status === "COUNTDOWN"
        ? `شروع تا ${match.countdownSeconds} ثانیه... (ورود نفر ${pCount + 1})`
        : "در انتظار ورود بازیکنان..."
    });
  }
}

function stopCountdown(match) {
  if (match.countdownTimer) {
    clearInterval(match.countdownTimer);
    match.countdownTimer = null;
  }
}

function startCountdown(match) {
  stopCountdown(match);
  match.countdownSeconds = WAITING_COUNTDOWN_SEC;
  match.countdownTimer = setInterval(() => {
    match.countdownSeconds--;
    if (match.countdownSeconds <= 0) {
      stopCountdown(match);
      startMatch(match);
    } else {
      broadcastMatchState(match);
    }
  }, 1000);
}

function onPlayerJoinedMatch(match) {
  const count = Object.keys(match.players).length;
  if (count === 1) {
    console.log("[DEBUG-STATUS] Setting WAITING for match", match.id); console.log("[DEBUG-STATUS] Setting WAITING for match:", match.id, "Player count after leave:", Object.keys(match.players).length); match.status = "WAITING";
    stopCountdown(match);
  } else if (count >= 2 && count < MAX_SEATS) {
    // با ورود نفر ۲، ۳ یا ۴ تایمر مجدداً ۳۰ ثانیه برای نفر بعدی تمدید می‌شود
    match.status = "COUNTDOWN";
    startCountdown(match);
  } else if (count === MAX_SEATS) {
    // با تکمیل ظرفیت ۵ نفره بلافاصله شروع می‌شود
    stopCountdown(match);
    startMatch(match);
  }
  broadcastMatchState(match);
}

async function refundPlayer(userId, matchId, tier) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { coins: { increment: tier } }
      });
      await tx.transaction.create({
        data: {
          userId,
          matchId,
          amount: tier,
          type: "REFUND_TIER_21",
          note: `21 refund match:${matchId} tier=${tier}`
        }
      });
    });
  } catch (err) {
    console.error("[REFUND_ERROR_21]", err);
  }
}

async function startMatch(match) {
  if (match.status === "PLAYING" || match.status === "FINISHED") return;
  stopCountdown(match);

  const seatKeys = Object.keys(match.players);
  if (seatKeys.length < 2) {
    console.log("[DEBUG-STATUS] Setting WAITING for match", match.id); console.log("[DEBUG-STATUS] Setting WAITING for match:", match.id, "Player count after leave:", Object.keys(match.players).length); match.status = "WAITING";
    broadcastMatchState(match);
    return;
  }

  match.status = "PLAYING";
  match.deck = createDeck();
  match.totalPot = seatKeys.length * match.tier;

  for (const seat of seatKeys) {
    const p = match.players[seat];
    p.cards = [match.deck.pop(), match.deck.pop()];
    const { score, isBlackjack, isBusted } = calculateHand(p.cards);
    p.score = score;
    p.isBlackjack = isBlackjack;
    p.isBusted = isBusted;
    p.isStand = isBlackjack;
  }

  io.to("match21:" + match.id).emit("game:started", { matchId: match.id, success: true });

  const nextSeat = findNextActiveSeat(match, null);
  if (!nextSeat) {
    finishMatch(match);
  } else {
    setPlayerTurn(match, nextSeat);
  }
  broadcastMatchState(match);
}

function setPlayerTurn(match, seatKey) {
  if (match.turnTimer) clearInterval(match.turnTimer);
  match.currentTurnSeat = seatKey;
  match.turnTimeLeft = TURN_TIME_SEC;

  match.turnTimer = setInterval(() => {
    match.turnTimeLeft--;
    if (match.turnTimeLeft <= 0) {
      clearInterval(match.turnTimer);
      match.turnTimer = null;
      const player = match.players[match.currentTurnSeat];
      if (player) player.isStand = true;
      advanceTurn(match);
    } else {
      broadcastMatchState(match);
    }
  }, 1000);
}

function advanceTurn(match) {
  if (match.turnTimer) {
    clearInterval(match.turnTimer);
    match.turnTimer = null;
  }
  const nextSeat = findNextActiveSeat(match, match.currentTurnSeat);
  if (!nextSeat) {
    finishMatch(match);
  } else {
    setPlayerTurn(match, nextSeat);
    broadcastMatchState(match);
  }
}

function findNextActiveSeat(match, currentSeat) {
  const seats = SEAT_KEYS.filter(s => match.players[s]);
  if (seats.length === 0) return null;
  const startIndex = currentSeat ? (seats.indexOf(currentSeat) + 1) : 0;
  for (let i = 0; i < seats.length; i++) {
    const seat = seats[(startIndex + i) % seats.length];
    const p = match.players[seat];
    if (p && !p.isStand && !p.isBusted) return seat;
  }
  return null;
}



async function ensureTreasuryUser() {
  const username = "treasury";
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return existing;

  const randomPass = crypto.randomBytes(32).toString("hex");
  return prisma.user.create({
    data: { username, password: randomPass, coins: 0, role: "TREASURY" },
  });
}

async function finishMatch(match) {

  if (match.status === "FINISHED") return;
  if (match.turnTimer) clearInterval(match.turnTimer);
  
  match.status = "FINISHED";
  match.currentTurnSeat = null;

  for (const p of Object.values(match.players)) {
    if (p.userId) userMatchMap.delete(p.userId);
  }

  const activePlayers = Object.values(match.players);
  const eligible = activePlayers.filter(p => !p.isBusted);
  if (eligible.length === 0) {
    const treasury = await ensureTreasuryUser();
    if (treasury) {
      await prisma.transaction.create({ data: { userId: treasury.id, matchId: match.id, amount: match.totalPot, type: "TREASURY_CUT", note: `21 ALL_BUSTED_FULL_POT match:${match.id}` } });
      await prisma.user.update({ where: { id: treasury.id }, data: { coins: { increment: match.totalPot } } });
    }
    match.results = { isAllBusted: true, winners: [], totalPot: match.totalPot };
    broadcastMatchState(match);
    setTimeout(() => { matches.delete(match.id); }, 10000);
    return;
  }

  const maxScore = Math.max(...eligible.map(p => p.score));
  let winners = eligible.filter(p => p.score === maxScore);
  const bjWinners = winners.filter(p => p.isBlackjack);
  if (bjWinners.length > 0) winners = bjWinners;

  const numWinners = winners.length;
  const rawShare = Math.floor(match.totalPot / numWinners);

  const payouts = [];
  for (const w of winners) {
    const commission = Math.floor(rawShare * TREASURY_FEE_PERCENT);
    const netPayout = rawShare - commission;
    payouts.push({ userId: w.userId, username: w.username, score: w.score, payout: netPayout, commission });
  }

  try {
    const treasury = await ensureTreasuryUser();
    const totalCommission = payouts.reduce((sum, p) => sum + (p.commission || 0), 0);

    await prisma.$transaction(async (tx) => {
      for (const p of payouts) {
        await tx.user.update({
          where: { id: p.userId },
          data: { coins: { increment: p.payout } }
        });
        await tx.transaction.create({
          data: {
            userId: p.userId,
            matchId: match.id,
            amount: p.payout,
            type: "WIN_POT_21",
            note: `21 win match:${match.id} payout=${p.payout} fee=${p.commission}`
          }
        });
      }

      if (totalCommission > 0 && treasury) {
        await tx.user.update({
          where: { id: treasury.id },
          data: { coins: { increment: totalCommission } }
        });
        await tx.transaction.create({
          data: {
            userId: treasury.id,
            matchId: match.id,
            amount: totalCommission,
            type: "TREASURY_CUT",
            note: `21 treasury cut match:${match.id} tier=${match.tier} fee=${totalCommission}`
          }
        });
      }
    });
    match.settled = true;
  } catch (err) {
    console.error("[SETTLE_ERROR_21]", err);
  }

  match.results = {
    isAllBusted: false,
    winners: winners.map(w => ({ username: w.username, score: w.score })),
    allPlayers: Object.values(match.players).map(p => ({ username: p.username, score: p.score, isBusted: p.isBusted })),
    totalPot: match.totalPot
  };

  broadcastMatchState(match);

  setTimeout(() => {
    matches.delete(match.id);
  }, 10000);
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error("Authentication token missing"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId || decoded.id;
    next();
  } catch (err) {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", async (socket) => {
  const activeUserKey = String(socket.userId);
    if (disconnectTimers.has(activeUserKey)) {
    clearTimeout(disconnectTimers.get(activeUserKey));
    disconnectTimers.delete(activeUserKey);
    console.log(`[GRACE-CANCELLED] Reconnect for user ${activeUserKey}`);
  }
  activeSocket21.set(activeUserKey, socket.id);
  socket.join("lobby");
  broadcastLobbyStats();
  console.log(">>> [21-SOCKET] Connected:", socket.id, "User:", socket.userId);
  const userId = socket.userId;

  socket.on("game:restoreSession", (data, callback) => {
    console.log("درخواست restoreSession توسط سرور دریافت شد");
    const matchId = userMatchMap.get(userId);
    const match = matchId ? matches.get(matchId) : null;

    if (!match || match.status === "FINISHED") {
      if (typeof callback === "function") callback({ success: false });
      return;
    }

    const seatKey = Object.keys(match.players).find(
      seat => match.players[seat]?.userId === userId
    );

    if (!seatKey) {
      if (typeof callback === "function") callback({ success: false });
      return;
    }

    match.players[seatKey].socketId = socket.id;
    socket.join("match21:" + match.id);
    socket.emit("match21:joined", { seatKey, tier: match.tier });
    socket.emit("match21:state", getMatchState(match));

    if (typeof callback === "function") {
      callback({
        success: true,
        restored: true,
        matchId: match.id,
        tier: match.tier,
        status: match.status
      });
    }
  });

  const handleJoin = async (tierVal, callback) => {
    console.log(">>> [21-JOIN] requested:", { userId, tierVal, socketId: socket.id });
    const validTier = parseInt(tierVal, 10) || 20;

    let existingMatchId = userMatchMap.get(userId);
    let existingMatch = existingMatchId ? matches.get(existingMatchId) : null;
    if (existingMatch && existingMatch.status !== "FINISHED") {
      socket.join("match21:" + existingMatch.id);
      const mySeat = Object.keys(existingMatch.players).find(s => existingMatch.players[s]?.userId === userId);
      if (mySeat) existingMatch.players[mySeat].socketId = socket.id;
      if (typeof callback === "function") callback({ success: true, matchId: existingMatch.id, seatKey: mySeat });
      socket.emit("match21:joined", { seatKey: mySeat, tier: existingMatch.tier });
      socket.emit("match21:state", getMatchState(existingMatch));
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, coins: true, username: true }
    });

    if (!user || user.coins < validTier) {
      console.log(">>> [21-JOIN] insufficient balance:", { userId, validTier, coins: user?.coins });
      const msg = "موجودی شما کافی نیست.";
      socket.emit("match21:error", { message: msg });
      if (typeof callback === "function") callback({ success: false, message: msg });
      return;
    }

    let match = null;
    for (const m of matches.values()) {
      if (m.tier === validTier && (m.status === "WAITING" || m.status === "COUNTDOWN")) {
        if (Object.keys(m.players).length < MAX_SEATS) {
          match = m;
          break;
        }
      }
    }

    if (!match) {
      match = createNewMatch(validTier);
      matches.set(match.id, match);
    }

    const emptySeat = SEAT_KEYS.find(s => !match.players[s]);
    if (!emptySeat) {
      if (typeof callback === "function") callback({ success: false, message: "میز پر است." });
      return;
    }

    // کسر ورودی در لحظه پیوستن به میز
    try {
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { coins: { decrement: validTier } }
        });
        await tx.transaction.create({
          data: {
            userId: user.id,
            matchId: match.id,
            amount: -validTier,
            type: "ENTRY_TIER_21",
            note: `21 match:${match.id} tier=${validTier}`
          }
        });
      });
    } catch (e) {
      console.error("[JOIN_CHARGE_ERR]", "Transaction failed:", e.message || e);
      const msg = "خطا در پردازش تراکنش: " + (e.message || "خطای ناشناخته");
      socket.emit("match21:error", { message: msg });
      if (typeof callback === "function") callback({ success: false, message: msg });
      return;
    }

          console.log(">>> [21-JOIN] Transaction success, adding player to match:", user.id);
match.players[emptySeat] = {
      userId: user.id,
      username: user.username,
      cards: [],
      score: 0,
      isBlackjack: false,
      isBusted: false,
      isStand: false,
      socketId: socket.id
    };
    userMatchMap.set(user.id, match.id);

    socket.join("match21:" + match.id);
    if (typeof callback === "function") callback({ success: true, matchId: match.id, seatKey: emptySeat });
    socket.emit("match21:joined", { seatKey: emptySeat, tier: match.tier });

    onPlayerJoinedMatch(match);
  };

  socket.on("room:join", ({ tier }, callback) => handleJoin(tier, callback));
  socket.on("match21:join", ({ tier }, callback) => handleJoin(tier, callback));
  socket.on("join", ({ tier }, callback) => handleJoin(tier, callback));

  socket.on("game:hit", () => {
    const matchId = userMatchMap.get(userId);
    if (!matchId) return;
    const match = matches.get(matchId);
    if (!match || match.status !== "PLAYING") return;
    const currentSeat = match.currentTurnSeat;
    const player = match.players[currentSeat];
    if (!player || player.userId !== userId) return;

    if (match.deck.length === 0) match.deck = createDeck();
    player.cards.push(match.deck.pop());

    const { score, isBlackjack, isBusted } = calculateHand(player.cards);
    player.score = score;
    player.isBlackjack = isBlackjack;
    player.isBusted = isBusted;

    if (isBusted || score === 21) {
      player.isStand = true;
      advanceTurn(match);
    } else {
      setPlayerTurn(match, currentSeat);
      broadcastMatchState(match);
    }
  });

  socket.on("game:stand", () => {
    const matchId = userMatchMap.get(userId);
    if (!matchId) return;
    const match = matches.get(matchId);
    if (!match || match.status !== "PLAYING") return;
    const currentSeat = match.currentTurnSeat;
    const player = match.players[currentSeat];
    if (!player || player.userId !== userId) return;

    player.isStand = true;
    advanceTurn(match);
  });

  const handleLeave = async (mId) => {
    const matchId = mId || userMatchMap.get(userId);
    if (!matchId) return;
    const match = matches.get(matchId);
    if (!match) {
      console.log("[DEBUG-MAP] Deleted userId:", userId, "from userMatchMap"); userMatchMap.delete(userId);
      return;
    }

    const seat = Object.keys(match.players).find(s => match.players[s]?.userId === userId);
    if (seat) {
      const isPreGame = (match.status === "WAITING" || match.status === "COUNTDOWN");
      delete match.players[seat];
      console.log("[DEBUG-MAP] Deleted userId:", userId, "from userMatchMap"); userMatchMap.delete(userId);
      console.log("[DEBUG-LEAVE] Player removed from match:", userId, "from match:", match.id, "Player count before:", Object.keys(match.players).length); socket.leave("match21:" + match.id);

      if (isPreGame) {
        await refundPlayer(userId, match.id, match.tier);
      }

      const remaining = Object.keys(match.players).length;
      if (remaining === 0) {
        stopCountdown(match);
        matches.delete(match.id);
      } else if (remaining === 1 && isPreGame) {
        console.log("[DEBUG-STATUS] Setting WAITING for match", match.id); console.log("[DEBUG-STATUS] Setting WAITING for match:", match.id, "Player count after leave:", Object.keys(match.players).length); match.status = "WAITING";
        stopCountdown(match);
        broadcastMatchState(match);
      } else {
        broadcastMatchState(match);
      }
    }
  };

  socket.on("game:leave", async ({ matchId }, callback) => {
    console.log("[DEBUG-CALL] handleLeave called via game:leave with matchId:", matchId); await handleLeave(matchId);
    if (typeof callback === "function") callback({ success: true });
  });

  socket.on("disconnect", async () => {
    const activeSocketId = activeSocket21.get(String(userId));
    console.log(`[DEBUG-DISCONNECT] User ${userId} disconnected with socket: ${socket.id}; active: ${activeSocketId || "none"}`);

    // قطع اتصال سوکت قدیمی نباید بازیکن را از میز خارج کند.
    if (activeSocketId !== socket.id) {
      console.log("[STALE_SOCKET_DISCONNECT_IGNORED]", {
        userId,
        staleSocketId: socket.id,
        activeSocketId: activeSocketId || null
      });
      return;
    }

    activeSocket21.delete(String(userId));

    const mId = userMatchMap.get(userId);
    if (mId) {
      const match = matches.get(mId);
      console.log("[DEBUG-DISCONNECT-STATE]", {
        userId,
        mId,
        matchFound: !!match,
        status: match?.status || null
      });
      if (match) {
        if (match.status === "WAITING" || match.status === "COUNTDOWN") {
          console.log(`[LOBBY-LEAVE] User ${userId} disconnected in queue/lobby (${match.status}). Instant leaving match ${mId}`);
          await handleLeave(mId);
        } else {
          console.log(`[GAME-GRACE] User ${userId} disconnected inside active game (${match.status}). Scheduling grace period 15s`);
          const timer = setTimeout(async () => {
            console.log(`[DEBUG-TIMEOUT] Grace period expired for user ${userId} in game, leaving match ${mId}`);
            await handleLeave(mId);
            disconnectTimers.delete(String(userId));
          }, 15000);
          disconnectTimers.set(String(userId), timer);
        }
      }
    }
  });
});

const PORT = process.env.PORT_21 || 3002;
server.listen(PORT, () => {
  console.log(`21 Game Server running successfully on port ${PORT}`);
});

setInterval(broadcastLobbyStats, 10000);

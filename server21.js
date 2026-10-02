
// --- BOT 21 CONFIGURATION ---
const BOT_21_ENABLED = true;
const BOT_INJECT_TIME = 3000;

async function injectBotIntoMatch(match) {
  try {
    if (!BOT_21_ENABLED || match.status !== "WAITING") return;
    const BOT_ALLOWED_TIERS = [20, 50];
    if (!BOT_ALLOWED_TIERS.includes(Number(match.tier))) return;
    const currentCount = Object.keys(match.players || {}).length;
    if (currentCount !== 1) return;

    
    let botSeat = SEAT_KEYS.find(s => match.players[s] && match.players[s].isBot);
    let targetSeat;
    if (botSeat) {
        delete match.players[botSeat];
        targetSeat = botSeat;
    } else {
        targetSeat = SEAT_KEYS.find(s => !match.players[s]);
    }
    const emptySeat = targetSeat;

    if (!emptySeat) return;

    const botUser = typeof ensureBot21User === "function" ? await ensureBot21User() : { id: 999999, username: "Bot_21" };
    const randomBotName = typeof getRandomBotDisplayName === "function" ? getRandomBotDisplayName() : (BOT_RANDOM_NAMES[Math.floor(Math.random() * BOT_RANDOM_NAMES.length)] || "Bot_21");
    console.log(`>>> [BOT-21] Injecting bot "${randomBotName}" into match ${match.id} on seat ${emptySeat}`);

    // کسر ورودی شرط برای ربات
    const botTier = Number(match.tier);
    try {
      const freshBot = await prisma.user.findUnique({ where: { id: botUser.id } });
      if (!freshBot || freshBot.coins < botTier) {
        console.log("[BOT-21] Bot lacks coins for tier:", botTier);
        return;
      }
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: botUser.id },
          data: { coins: { decrement: botTier } }
        });
        await tx.transaction.create({
          data: {
            userId: botUser.id,
            matchId: match.id,
            amount: -botTier,
            type: "MATCH_JOIN",
            note: `21 BOT ENTRY FEE ${botTier} match:${match.id}`
          }
        });
      });
      console.log(`>>> [BOT-21] Deducted ${botTier} coins from bot ${botUser.id}`);
    } catch (e) {
      console.error("[BOT-21-ERR] Failed to deduct entry fee from bot:", e);
      return;
    }

    match.players[emptySeat] = {
      userId: botUser.id,
      username: randomBotName,
      isBot: true,
      cards: [],
      score: 0,
      isStand: false,
      isBusted: false,
      socketId: null
    };

    match.status = "COUNTDOWN";
    if (typeof broadcastMatchState === "function") broadcastMatchState(match);
    if (typeof startCountdown === "function") startCountdown(match);
  } catch (err) {
    console.error("[BOT-21-ERR] injectBotIntoMatch failed:", err);
  }
}

// ==================== تنظیمات و ۳۰ اسم رندوم ربات ۲۱ ====================
const BOT_21_USERNAME = 'tajdas21_bot';

const BOT_RANDOM_NAMES = [
  'AliReza', 'Soroush', 'Mahdi', 'Arman', 'Pouya',
  'AmirHossein', 'Farhad', 'Kamyar', 'Sina', 'Navid',
  'Mohammad', 'Hamed', 'Danial', 'Shayan', 'Behzad',
  'Milad', 'Ashkan', 'Hossein', 'Ehsan', 'Nima',
  'Saeed', 'Babak', 'Pejman', 'Kian', 'Shahab',
  'Masoud', 'Morteza', 'Salar', 'Parham', 'Arash'
];

function getRandomBotDisplayName() {
  const randomIndex = Math.floor(Math.random() * BOT_RANDOM_NAMES.length);
  return BOT_RANDOM_NAMES[randomIndex];
}
// =======================================================================

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
  const fakeCfg2 = readFakeOnline21Config();
  // اصلاحِ لحظه‌ایِ عددِ فیک اگر از محدوده خارج شده باشد
  if (fakeCfg2 && lastFakeOnline21 !== -1) {
  if (lastFakeOnline21 > fakeCfg2.max) lastFakeOnline21 = fakeCfg2.max;
  if (lastFakeOnline21 < fakeCfg2.min) lastFakeOnline21 = fakeCfg2.min;
  }

  if (fakeCfg2 && fakeCfg2.enabled && Number.isFinite(fakeCfg2.min) && Number.isFinite(fakeCfg2.max) && fakeCfg2.max >= fakeCfg2.min && fakeCfg2.max > 0) {
    const now = Date.now();
    if (lastFakeOnline21 === -1 || (now - lastUpdateFakeTime21) >= 300000) {
      if (lastFakeOnline21 === -1) {
        lastFakeOnline21 = fakeCfg2.min + Math.floor(Math.random() * (fakeCfg2.max - fakeCfg2.min + 1));
      } else {
        let change = Math.floor(Math.random() * 4) + 1;
        change *= (Math.random() > 0.5) ? 1 : -1;
        lastFakeOnline21 = Math.min(Math.max(lastFakeOnline21 + change, fakeCfg2.min), fakeCfg2.max);
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

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: true
});

const prisma = new PrismaClient({ adapter });

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
  if (match.countdownTimer) return;

  match.countdownSeconds = typeof WAITING_COUNTDOWN_SEC !== "undefined" ? WAITING_COUNTDOWN_SEC : 30;
  match.countdownTimer = setInterval(() => {
    match.countdownSeconds--;
    if (match.countdownSeconds <= 0) {
      if (typeof stopCountdown === "function") stopCountdown(match);
      if (typeof startMatch === "function") startMatch(match);
    } else {
      if (typeof broadcastMatchState === "function") broadcastMatchState(match);
    }
  }, 1000);
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
          type: "REFUND_TIER_21"
        }
      });
    });
    console.log(`[REFUND] Success: User ${userId} refunded ${tier}`);
  } catch (err) {
    console.error(`[REFUND] Error: User ${userId} - ${err.message}`);
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
  if (match.turnTimeLeft === undefined || match.turnTimeLeft === null || match.turnTimeLeft <= 0) match.turnTimeLeft = TURN_TIME_SEC;

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
  // BOT: auto-play when turn reaches a bot seat
  triggerBotTurnIfNeeded(match);

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
  // BOT: auto-play when turn reaches a bot seat
  triggerBotTurnIfNeeded(match);

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



let bot21CachedUser = null;
async function ensureBot21User() {
  if (bot21CachedUser) return bot21CachedUser;
  try {
    const username = BOT_21_USERNAME;
    let botUser = await prisma.user.findUnique({ where: { username } });

    if (!botUser) {
      const tempBotPassword = crypto.randomBytes(32).toString('hex');
      botUser = await prisma.user.create({
        data: {
          username,
          password: tempBotPassword,
          coins: 50000000,
          role: 'BOT'
        }
      });
      console.log('>>> [BOT-21] Created bot account with 50M coins:', botUser.id);
    }

    bot21CachedUser = botUser;
    return botUser;
  } catch (err) {
    console.error('[BOT-21] Error ensuring bot user:', err.message);
    return null;
  }
}

// --- BOT 21 DECISION ENGINE (SMART PvP STRATEGY) ---
function getBotAction(match, currentSeat, botScore) {
  // 1. اگر ربات به 21 رسیده یا سوخته باشد
  if (botScore >= 21) return 'STAND';

  // 2. یافتن بالاترین امتیاز معتبر میان سایر بازیکنان نسوخته
  let bestOpponentScore = 0;
  if (match && match.players) {
    for (let s in match.players) {
      if (Number(s) === Number(currentSeat)) continue;
      const op = match.players[s];
      
      // محاسبه یا خواندن امتیاز حریف
      let opScore = op.score;
      if (op.cards && op.cards.length > 0) {
        const opCalc = calculateHand(op.cards);
        opScore = opCalc.score;
        if (opCalc.isBusted) continue; // حریف سوخته است، نادیده بگیر
      }
      if (op.isBusted) continue;

      if (opScore > bestOpponentScore && opScore <= 21) {
        bestOpponentScore = opScore;
      }
    }
  }

  // 3. وضعیت الف: همه رقبای دیگر سوخته‌اند -> ربات بدون ریسک ایست می‌دهد و برنده می‌شود
  if (bestOpponentScore === 0) {
    return 'STAND';
  }

  // 4. وضعیت ب: امتیاز ربات بالاتر از بهترین حریف است -> ایست
  if (botScore > bestOpponentScore) {
    return 'STAND';
  }

  // 5. وضعیت پ: ربات با بهترین حریف مساوی است -> ایست و تقسیم پات بدون ریسک سوختن
  if (botScore === bestOpponentScore) {
    return 'STAND';
  }

  // 6. وضعیت ت: امتیاز ربات کمتر از حریف است (مثلاً حریف 19 و ربات 17 یا 18)
  // ایست دادن یعنی باخت قطعی؛ بنابراین ربات حتماً کارت می‌کشد تا جلو بیفتد یا مساوی کند
  return 'HIT';
}

async function triggerBotTurnIfNeeded(match) {
  if (!match || match.status !== 'PLAYING') return;
  const currentSeat = match.currentTurnSeat;
  if (currentSeat === null || currentSeat === undefined) return;

  const player = match.players[currentSeat];
  if (!player || !player.isBot || player.isStand || player.isBusted) return;

  // تاخیر طبیعی 1.5 تا 3 ثانیه برای رفتار مشابه انسان
  const thinkingDelay = Math.floor(Math.random() * 1500) + 1500;

  setTimeout(async () => {
    try {
      // بازبینی وضعیت میز پس از سپری شدن تاخیر
      if (match.status !== 'PLAYING' || match.currentTurnSeat !== currentSeat) return;
      const p = match.players[currentSeat];
      if (!p || p.isStand || p.isBusted) return;

      const res = calculateHand(p.cards);
      const action = getBotAction(match, currentSeat, res.score);

      console.log(`>>> [BOT-21] Seat ${currentSeat} (${p.username || p.name}) Hand: ${res.score} -> Decision: ${action}`);

      if (action === 'HIT') {
        applyHit(match, currentSeat);
      } else {
        applyStand(match, currentSeat);
      }
    } catch (err) {
      console.error('[BOT-21] Error during bot turn action:', err);
    }
    }, 2000);
  }
// --------------------------------

  // --- BOT 21 INTERNAL ACTIONS (extracted from socket handlers) ---
  function applyHit(match, seat) {
    if (!match || match.status !== "PLAYING") return false;
    if (seat === null || seat === undefined) return false;
    let player = match.players?.[seat];

    player = match.players?.[seat];
    if (!player || player.isStand || player.isBusted) return false;

    if (!match.deck || match.deck.length === 0) match.deck = createDeck();
    player.cards.push(match.deck.pop());

    const { score, isBlackjack, isBusted } = calculateHand(player.cards);
    player.score = score;
    player.isBlackjack = isBlackjack;
    player.isBusted = isBusted;

    if (isBusted || score === 21) {
      player.isStand = true;
      advanceTurn(match);
    } else {
      setPlayerTurn(match, seat);
      broadcastMatchState(match);
      // اینجا هم ممکن است دوباره نوبت همین ربات باشد (اگر seat ربات باشد)
      triggerBotTurnIfNeeded(match);
    }
    return true;
  }

  function applyStand(match, seat) {
    if (!match || match.status !== "PLAYING") return false;
    if (seat === null || seat === undefined) return false;

    const player = match.players?.[seat];
    if (!player || player.isStand || player.isBusted) return false;

    player.isStand = true;
    advanceTurn(match);
    return true;
  }
  // ---------------------------------------------------------------

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
    const commission = Math.floor(rawShare * 0.10);
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
      console.log(">>> [DEBUG-MATCH-CHECK]", { mId: m.id, mTier: m.tier, validTier, status: m.status });
          match = m;
          break;
        }
      }
    }

    if (!match) {
      match = createNewMatch(validTier);
      matches.set(match.id, match);
    }

    
    let botSeat = SEAT_KEYS.find(s => match.players[s] && match.players[s].isBot);
    let targetSeat;
    if (botSeat) {
        delete match.players[botSeat];
        targetSeat = botSeat;
    } else {
        targetSeat = SEAT_KEYS.find(s => !match.players[s]);
    }
    const emptySeat = targetSeat;

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
      
      // ۱. اگر قبل از شروع بازی است، حتماً ابتدا موجودی بازیکن ریفاند شود
      if (isPreGame) {
        await refundPlayer(userId, match.id, match.tier);
        console.log("[REFUND-LEAVE] Refunded user", userId, "amount:", match.tier);
      }

      delete match.players[seat];
      console.log("[DEBUG-MAP] Deleted userId:", userId, "from userMatchMap"); userMatchMap.delete(userId);
      console.log("[DEBUG-LEAVE] Player removed from match:", userId, "from match:", match.id); socket.leave("match21:" + match.id);

      // بررسی وجود بازیکن واقعی
      const remainingHumans = Object.values(match.players).filter(p => !p.isBot);
      
      if (remainingHumans.length === 0) {
        // اگر هیچ انسانی باقی نمانده، ربات‌ها را ریفاند و میز را حذف کن
        for (const [sKey, p] of Object.entries(match.players)) {
          if (p && p.isBot) {
            await refundPlayer(p.userId, match.id, match.tier);
            console.log("[DEBUG-REFUND-BOT] Auto-refunded remaining bot on seat:", sKey);
          }
        }
        stopCountdown(match);
        matches.delete(match.id);
        console.log("[DEBUG-LEAVE] No humans left. Match deleted:", match.id);
      } else {
        // اگر انسان باقی مانده، وضعیت را بازبینی کن (اگر در لابی بود، ممکن است به WAITING برگردد)
        const isPreGame = (match.status === "WAITING" || match.status === "COUNTDOWN");
        if (isPreGame && Object.keys(match.players).length === 1) {
            match.status = "WAITING";
            stopCountdown(match);
        }
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
async function onPlayerJoinedMatch(match) {
  const count = Object.keys(match.players).length;
  console.log(`[DEBUG-JOIN] Match ${match.id} player count: ${count}`);

  if (count === 1) {
    if (typeof stopCountdown === "function") stopCountdown(match);
    match.status = "WAITING";
    
    if (BOT_21_ENABLED) {
      if (match.botInjectTimer) clearTimeout(match.botInjectTimer);
      match.botInjectTimer = setTimeout(() => injectBotIntoMatch(match), BOT_INJECT_TIME);
    }
    if (typeof broadcastMatchState === "function") broadcastMatchState(match);

  } else if (count >= 2 && count < 5) {
    if (match.botInjectTimer) {
      clearTimeout(match.botInjectTimer);
      match.botInjectTimer = null;
    }
    
    if (match.status === "WAITING") {
      match.status = "COUNTDOWN";
      if (typeof startCountdown === "function") startCountdown(match);
    }
    if (typeof broadcastMatchState === "function") broadcastMatchState(match);
    
  } else if (count === 5) {
    if (match.botInjectTimer) {
      clearTimeout(match.botInjectTimer);
      match.botInjectTimer = null;
    }
    if (typeof stopCountdown === "function") stopCountdown(match);
    match.status = "PLAYING";
    if (typeof broadcastMatchState === "function") broadcastMatchState(match);
    if (typeof startMatch === "function") await startMatch(match);
  }
}

const PORT = process.env.PORT_21 || 3002;
server.listen(PORT, () => {
  console.log(`21 Game Server running successfully on port ${PORT}`);
});

setInterval(broadcastLobbyStats, 10000);

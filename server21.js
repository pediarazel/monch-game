/**
 * ============================================================================
 * TAJ TAS - 21 GAME SERVER (server21.js)
 * Architecture: Competitive PvP 5-Player Blackjack Engine
 * DB & Auth: Shared PostgreSQL via Prisma & Unified JWT
 * ============================================================================
 */

require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

// ----------------------------------------------------------------------------
// 1. CONFIGURATION & CONSTANTS
// ----------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "tajtas_jwt_secret_key_2026";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "tajtas_admin_secret_2026";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not defined in environment variables.");
  process.exit(1);
}

const SEATS = ["seat_1", "seat_2", "seat_3", "seat_4", "seat_5"];
const COUNTDOWN_SECONDS = 30; // زمان انتظار برای ورود نفر بعدی
const TURN_TIMEOUT_SECONDS = 15; // زمان نوبت هر بازیکن برای Hit/Stand
const ALLOWED_TIERS = [20, 50, 100, 200]; // مبالغ مجاز میز (به هزار تومان / سکه)

// ----------------------------------------------------------------------------
// 2. DATABASE INITIALIZATION (PRISMA)
// ----------------------------------------------------------------------------
const prismaPg = new PrismaPg({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
const prisma = new PrismaClient({ adapter: prismaPg });

// اطمینان از وجود کاربر خزانه
async function ensureTreasuryUser() {
  try {
    const treasury = await prisma.user.findUnique({ where: { username: "treasury" } });
    if (!treasury) {
      const hashedPassword = await bcrypt.hash("treasury_secure_pass_" + Date.now(), 10);
      await prisma.user.create({
        data: {
          username: "treasury",
          password: hashedPassword,
          coins: 0,
          role: "TREASURY"
        }
      });
      console.log("✅ Treasury account initialized successfully.");
    }
  } catch (err) {
    console.error("❌ Error ensuring treasury user:", err.message);
  }
}
ensureTreasuryUser();

// ----------------------------------------------------------------------------
// 3. EXPRESS & HTTP SERVER SETUP
// ----------------------------------------------------------------------------
const app = express();
const httpServer = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

// سرو فایل‌های استاتیک پوشه anna و روت اصلی
app.use(express.static(path.join(__dirname, "anna")));
app.use("/static", express.static(path.join(__dirname, "anna")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "anna", "game21.html"));
});

app.get("/lobby21", (req, res) => {
  res.sendFile(path.join(__dirname, "anna", "lobby21.html"));
});

// ----------------------------------------------------------------------------
// 4. AUTH HELPERS & MIDDLEWARES
// ----------------------------------------------------------------------------
function getBearerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

function verifyJwtToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

async function authenticateHttp(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ error: "TOKEN_MISSING" });
  const decoded = verifyJwtToken(token);
  if (!decoded || !decoded.userId) return res.status(401).json({ error: "TOKEN_INVALID" });

  try {
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(401).json({ error: "USER_NOT_FOUND" });
    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: "DB_AUTH_ERROR" });
  }
}

function authenticateAdminSecret(req, res, next) {
  const secret = req.headers["x-admin-secret"] || req.query.adminSecret;
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(401).json({ error: "ADMIN_UNAUTHORIZED" });
  }
  next();
}

// ----------------------------------------------------------------------------
// 5. HTTP API ROUTES
// ----------------------------------------------------------------------------
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "MISSING_CREDENTIALS" });

  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: "INVALID_CREDENTIALS" });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: { id: user.id, username: user.username, coins: user.coins, role: user.role } });
  } catch (err) {
    return res.status(500).json({ error: "LOGIN_FAILED" });
  }
});

app.get("/api/me/balance", authenticateHttp, async (req, res) => {
  return res.json({ coins: req.user.coins, username: req.user.username, userId: req.user.id });
});

// پنل ادمین - گزارش خزانه
app.get("/admin/treasury-report", authenticateAdminSecret, async (req, res) => {
  try {
    const treasuryUser = await prisma.user.findUnique({ where: { username: "treasury" } });
    const treasuryBalance = treasuryUser ? treasuryUser.coins : 0;

    const cuts = await prisma.transaction.aggregate({
      _sum: { amount: true },
      _count: { id: true },
      where: { type: "TREASURY_CUT" }
    });

    return res.json({
      treasuryCoins: treasuryBalance,
      treasuryTomans: treasuryBalance * 1000,
      totalCutsCollected: cuts._sum.amount || 0,
      totalMatchesCut: cuts._count.id || 0
    });
  } catch (err) {
    return res.status(500).json({ error: "TREASURY_REPORT_ERROR" });
  }
});

// پنل ادمین - برداشت از خزانه
app.post("/admin/treasury-deduct", authenticateAdminSecret, async (req, res) => {
  const { amount, note } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ error: "INVALID_AMOUNT" });

  try {
    const result = await prisma.$transaction(async (tx) => {
      const treasury = await tx.user.findUnique({ where: { username: "treasury" } });
      if (!treasury || treasury.coins < numAmount) {
        throw new Error("INSUFFICIENT_TREASURY_BALANCE");
      }

      const updated = await tx.user.update({
        where: { id: treasury.id },
        data: { coins: { decrement: numAmount } }
      });

      const txRecord = await tx.transaction.create({
        data: {
          userId: treasury.id,
          amount: -numAmount,
          type: "WITHDRAW",
          note: note || "Admin treasury withdrawal"
        }
      });

      return { remainingCoins: updated.coins, transactionId: txRecord.id };
    });

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// آمار سرور
app.get("/admin/server-stats", authenticateAdminSecret, (req, res) => {
  const activeMatchesCount = Object.keys(matches).length;
  let totalPlayers = 0;
  Object.values(matches).forEach(m => {
    totalPlayers += Object.keys(m.players).length;
  });
  return res.json({
    activeMatches: activeMatchesCount,
    totalPlayersInMatches: totalPlayers,
    connectedSockets: io.engine.clientsCount
  });
});

// ----------------------------------------------------------------------------
// 6. CARD DECK & BLACKJACK SCORING ENGINE
// ----------------------------------------------------------------------------
const SUITS = ["♠", "♥", "♦", "♣"];
const VALUES = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];

function createFreshDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const val of VALUES) {
      deck.push({ suit, value: val });
    }
  }
  // بُر زدن شافل فیشر-یتس
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateHandScore(cards) {
  if (!cards || cards.length === 0) return 0;
  let score = 0;
  let aces = 0;

  for (const card of cards) {
    if (["J", "Q", "K"].includes(card.value)) {
      score += 10;
    } else if (card.value === "A") {
      aces += 1;
      score += 11;
    } else {
      score += parseInt(card.value, 10);
    }
  }

  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }
  return score;
}

// ----------------------------------------------------------------------------
// 7. MATCH & GAME STATE MANAGEMENT
// ----------------------------------------------------------------------------
const matches = {}; // matchId -> Match Object

function getOrCreateMatch(tier) {
  const tierNum = Number(tier);
  // جستجوی میزی که ظرفیت خالی دارد و هنوز بازی شروع نشده
  for (const matchId in matches) {
    const m = matches[matchId];
    if (m.tier === tierNum && (m.status === "WAITING" || m.status === "COUNTDOWN")) {
      const seatedCount = Object.keys(m.players).length;
      if (seatedCount < 5) return m;
    }
  }

  // ایجاد میز جدید
  const newMatchId = "match21_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  const newMatch = {
    id: newMatchId,
    tier: tierNum,
    status: "WAITING", // WAITING, COUNTDOWN, PLAYING, FINISHED
    deck: [],
    players: {}, // seatKey -> { userId, username, socketId, cards, score, isStand, isBusted, isBlackjack }
    currentTurnIndex: 0,
    activeSeatsOrder: [],
    countdownSeconds: COUNTDOWN_SECONDS,
    countdownTimer: null,
    turnTimer: null,
    turnTimeLeft: TURN_TIMEOUT_SECONDS,
    totalPot: 0,
    results: null
  };
  matches[newMatchId] = newMatch;
  return newMatch;
}

function getNextAvailableSeat(match) {
  for (const seatKey of SEATS) {
    if (!match.players[seatKey]) return seatKey;
  }
  return null;
}

function broadcastMatchState(match) {
  const payload = {
    matchId: match.id,
    tier: match.tier,
    status: match.status,
    countdownSeconds: match.countdownSeconds,
    totalPot: match.totalPot,
    currentTurnSeat: match.activeSeatsOrder[match.currentTurnIndex] || null,
    turnTimeLeft: match.turnTimeLeft,
    players: {},
    results: match.results
  };

  for (const [seatKey, p] of Object.entries(match.players)) {
    payload.players[seatKey] = {
      userId: p.userId,
      username: p.username,
      cards: p.cards,
      score: p.score,
      isStand: p.isStand,
      isBusted: p.isBusted,
      isBlackjack: p.isBlackjack
    };
  }

  io.to(match.id).emit("match:state", payload);
}

// ----------------------------------------------------------------------------
// 8. MATCHMAKING & TIMER LOGIC (چرخه ۳۰ ثانیه‌ای دقیق منچ)
// ----------------------------------------------------------------------------
function handlePlayerJoined(match, seatKey) {
  const playerCount = Object.keys(match.players).length;
  match.totalPot = playerCount * match.tier;

  if (playerCount === 1) {
    // نفر اول وارد شد: منتظر می‌ماند
    match.status = "WAITING";
    if (match.countdownTimer) clearInterval(match.countdownTimer);
    match.countdownSeconds = COUNTDOWN_SECONDS;
    broadcastMatchState(match);
  } else if (playerCount >= 2 && playerCount < 5) {
    // ورود نفر دوم، سوم یا چهارم: ریست تایمر ۳۰ ثانیه برای نفر بعدی
    match.status = "COUNTDOWN";
    match.countdownSeconds = COUNTDOWN_SECONDS;

    if (match.countdownTimer) clearInterval(match.countdownTimer);

    match.countdownTimer = setInterval(() => {
      match.countdownSeconds -= 1;
      broadcastMatchState(match);

      if (match.countdownSeconds <= 0) {
        clearInterval(match.countdownTimer);
        match.countdownTimer = null;
        startPvPGame(match);
      }
    }, 1000);

    broadcastMatchState(match);
  } else if (playerCount === 5) {
    // نفر پنجم وارد شد: لغو تایمر و شروع درجا و آنی بازی
    if (match.countdownTimer) {
      clearInterval(match.countdownTimer);
      match.countdownTimer = null;
    }
    match.countdownSeconds = 0;
    startPvPGame(match);
  }
}

function handlePlayerLeft(match, seatKey, user) {
  if (match.players[seatKey]) {
    delete match.players[seatKey];
  }

  const remainingCount = Object.keys(match.players).length;
  match.totalPot = remainingCount * match.tier;

  if (match.status === "WAITING" || match.status === "COUNTDOWN") {
    // عودت وجه ورودی در صورت خروج در مرحله لابی
    refundPlayerEntry(user.id, match.tier, match.id);

    if (remainingCount < 2) {
      if (match.countdownTimer) clearInterval(match.countdownTimer);
      match.countdownTimer = null;
      match.status = "WAITING";
      match.countdownSeconds = COUNTDOWN_SECONDS;
    } else {
      // اگر هنوز ۲ یا بیشتر موندن، تایمر ریست میشه
      match.countdownSeconds = COUNTDOWN_SECONDS;
    }
    broadcastMatchState(match);
  } else if (match.status === "PLAYING") {
    // اگر حین بازی خارج شد، دستش Stand/Bust می‌خورد
    if (match.activeSeatsOrder[match.currentTurnIndex] === seatKey) {
      advanceTurn(match);
    }
  }

  if (remainingCount === 0) {
    if (match.countdownTimer) clearInterval(match.countdownTimer);
    if (match.turnTimer) clearInterval(match.turnTimer);
    delete matches[match.id];
  }
}

// ----------------------------------------------------------------------------
// 9. FINANCIAL TRANSACTIONS (کسر ورودی، تسویه ۱۰٪ خزانه)
// ----------------------------------------------------------------------------
async function deductPlayerEntry(userId, tier, matchId) {
  return await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.coins < tier) {
      throw new Error("INSUFFICIENT_COINS");
    }

    await tx.user.update({
      where: { id: userId },
      data: { coins: { decrement: tier } }
    });

    await tx.transaction.create({
      data: {
        userId,
        amount: -tier,
        type: "ENTRY_TIER",
        note: `21 Match Entry - Match: ${matchId}`
      }
    });

    return true;
  });
}

async function refundPlayerEntry(userId, tier, matchId) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { coins: { increment: tier } }
      });

      await tx.transaction.create({
        data: {
          userId,
          amount: tier,
          type: "REFUND",
          note: `21 Match Refund - Left Match: ${matchId}`
        }
      });
    });
  } catch (err) {
    console.error("Refund error:", err.message);
  }
}

async function settlePvPMatchResults(match, winners) {
  const totalPot = match.totalPot;
  const tier = match.tier;
  const winnerCount = winners.length;

  try {
    const treasuryUser = await prisma.user.findUnique({ where: { username: "treasury" } });
    if (!treasuryUser) {
      console.error("Treasury user not found for settlement!");
      return;
    }

    if (winnerCount === 0) {
      // اگر همه سوخته باشند: کل پات به خزانه می‌رسد
      await prisma.$transaction([
        prisma.user.update({
          where: { id: treasuryUser.id },
          data: { coins: { increment: totalPot } }
        }),
        prisma.transaction.create({
          data: {
            userId: treasuryUser.id,
            amount: totalPot,
            type: "TREASURY_CUT",
            note: `21 Match ${match.id} - All players busted (Pot to Treasury)`
          }
        })
      ]);
      return;
    }

    const sharePerWinner = Math.floor(totalPot / winnerCount);

    await prisma.$transaction(async (tx) => {
      let totalTreasuryCuts = 0;

      for (const winner of winners) {
        const netProfit = Math.max(0, sharePerWinner - tier);
        const treasuryCut = Math.floor(netProfit * 0.10); // ۱۰٪ سهم خزانه از سود خالص
        const winnerPayout = sharePerWinner - treasuryCut;

        totalTreasuryCuts += treasuryCut;

        // پرداخت به برنده
        await tx.user.update({
          where: { id: winner.userId },
          data: { coins: { increment: winnerPayout } }
        });

        await tx.transaction.create({
          data: {
            userId: winner.userId,
            amount: winnerPayout,
            type: "WIN_MATCH",
            note: `21 Match Win - Match: ${match.id}`
          }
        });
      }

      // واریز مجموع کارمزدهای ۱۰٪ به خزانه
      if (totalTreasuryCuts > 0) {
        await tx.user.update({
          where: { id: treasuryUser.id },
          data: { coins: { increment: totalTreasuryCuts } }
        });

        await tx.transaction.create({
          data: {
            userId: treasuryUser.id,
            amount: totalTreasuryCuts,
            type: "TREASURY_CUT",
            note: `10% Treasury Cut from Match ${match.id}`
          }
        });
      }
    });

    console.log(`✅ Match ${match.id} settled successfully. Pot: ${totalPot}, Winners: ${winnerCount}`);
  } catch (err) {
    console.error("Settlement error:", err.message);
  }
}

// ----------------------------------------------------------------------------
// 10. PVP GAMEPLAY LOOP (بدون دیلر - لیدر فقط کارت‌پخش‌کن)
// ----------------------------------------------------------------------------
function startPvPGame(match) {
  match.status = "PLAYING";
  match.deck = createFreshDeck();
  match.activeSeatsOrder = Object.keys(match.players);
  match.currentTurnIndex = 0;

  // لیدر به هر بازیکن ۲ کارت رو می‌دهد
  for (const seatKey of match.activeSeatsOrder) {
    const p = match.players[seatKey];
    p.cards = [match.deck.pop(), match.deck.pop()];
    p.score = calculateHandScore(p.cards);
    p.isBusted = false;
    p.isStand = false;
    p.isBlackjack = p.cards.length === 2 && p.score === 21;
    if (p.isBlackjack) {
      p.isStand = true; // با داشتن بلک‌جک نیازی به بازی نیست
    }
  }

  // پیدا کردن اولین بازیکنی که بلک‌جک ندارد برای شروع نوبت
  findNextActiveTurn(match);
  broadcastMatchState(match);
}

function startTurnTimer(match) {
  if (match.turnTimer) clearInterval(match.turnTimer);
  match.turnTimeLeft = TURN_TIMEOUT_SECONDS;

  match.turnTimer = setInterval(() => {
    match.turnTimeLeft -= 1;
    broadcastMatchState(match);

    if (match.turnTimeLeft <= 0) {
      clearInterval(match.turnTimer);
      match.turnTimer = null;
      // تایم‌اوت نوبت -> خودکار Stand می‌شود
      const currentSeat = match.activeSeatsOrder[match.currentTurnIndex];
      if (currentSeat && match.players[currentSeat]) {
        match.players[currentSeat].isStand = true;
      }
      advanceTurn(match);
    }
  }, 1000);
}

function advanceTurn(match) {
  if (match.turnTimer) {
    clearInterval(match.turnTimer);
    match.turnTimer = null;
  }
  match.currentTurnIndex += 1;
  findNextActiveTurn(match);
}

function findNextActiveTurn(match) {
  while (match.currentTurnIndex < match.activeSeatsOrder.length) {
    const seatKey = match.activeSeatsOrder[match.currentTurnIndex];
    const player = match.players[seatKey];

    if (player && !player.isStand && !player.isBusted && !player.isBlackjack) {
      startTurnTimer(match);
      broadcastMatchState(match);
      return;
    }
    match.currentTurnIndex++;
  }

  // نوبت همه تمام شد -> پایان دست و تعیین برنده
  finishPvPRound(match);
}

function finishPvPRound(match) {
  if (match.turnTimer) clearInterval(match.turnTimer);
  match.status = "FINISHED";

  const allPlayers = Object.entries(match.players).map(([seatKey, p]) => ({
    seatKey,
    userId: p.userId,
    username: p.username,
    score: p.score,
    isBusted: p.isBusted,
    isBlackjack: p.isBlackjack
  }));

  const eligiblePlayers = allPlayers.filter(p => !p.isBusted && p.score <= 21);

  let winners = [];
  if (eligiblePlayers.length > 0) {
    // اولویت ۱: بازیکنانی که بلک‌جک طبیعی (۲۱ با ۲ کارت) دارند
    const blackjackWinners = eligiblePlayers.filter(p => p.isBlackjack);
    if (blackjackWinners.length > 0) {
      winners = blackjackWinners;
    } else {
      // اولویت ۲: بالاترین امتیاز زیر یا مساوی ۲۱
      const maxScore = Math.max(...eligiblePlayers.map(p => p.score));
      winners = eligiblePlayers.filter(p => p.score === maxScore);
    }
  }

  match.results = {
    winners: winners.map(w => ({ seatKey: w.seatKey, username: w.username, score: w.score })),
    isAllBusted: winners.length === 0,
    totalPot: match.totalPot
  };

  broadcastMatchState(match);

  // تسویه مالی در دیتابیس
  settlePvPMatchResults(match, winners);

  // ریست خودکار میز بعد از ۱۲ ثانیه
  setTimeout(() => {
    delete matches[match.id];
    io.to(match.id).emit("match:disbanded");
  }, 12000);
}

// ----------------------------------------------------------------------------
// 11. SOCKET.IO INTEGRATION & HANDLERS
// ----------------------------------------------------------------------------
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error("SOCKET_AUTH_TOKEN_MISSING"));

  const decoded = verifyJwtToken(token);
  if (!decoded || !decoded.userId) return next(new Error("SOCKET_AUTH_TOKEN_INVALID"));

  try {
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return next(new Error("SOCKET_USER_NOT_FOUND"));
    socket.user = user;
    next();
  } catch (err) {
    return next(new Error("SOCKET_DB_ERROR"));
  }
});

io.on("connection", (socket) => {
  const user = socket.user;

  // ۱. درخواست پیوستن به میز
  socket.on("match:join", async (data) => {
    const { tier } = data;
    const tierNum = Number(tier);

    if (!ALLOWED_TIERS.includes(tierNum)) {
      return socket.emit("match:error", { message: "میزان شرط میز نامعتبر است." });
    }

    try {
      // کسر مبلغ ورودی به محض نشستن روی صندلی
      await deductPlayerEntry(user.id, tierNum, "PENDING");
    } catch (err) {
      return socket.emit("match:error", { message: "موجودی حساب شما برای ورود به این میز کافی نیست." });
    }

    const match = getOrCreateMatch(tierNum);
    const seatKey = getNextAvailableSeat(match);

    if (!seatKey) {
      // اگر در همین لحظه پر شد، پول پس داده می‌شود
      await refundPlayerEntry(user.id, tierNum, match.id);
      return socket.emit("match:error", { message: "ظرفیت میز پر شده است." });
    }

    match.players[seatKey] = {
      userId: user.id,
      username: user.username,
      socketId: socket.id,
      cards: [],
      score: 0,
      isStand: false,
      isBusted: false,
      isBlackjack: false
    };

    socket.join(match.id);
    socket.matchId = match.id;
    socket.seatKey = seatKey;

    socket.emit("match:joined", { matchId: match.id, seatKey });
    handlePlayerJoined(match, seatKey);
  });

  // ۲. دریافت کارت اضافه (Hit)
  socket.on("game:hit", () => {
    const match = matches[socket.matchId];
    if (!match || match.status !== "PLAYING") return;

    const currentSeat = match.activeSeatsOrder[match.currentTurnIndex];
    if (currentSeat !== socket.seatKey) {
      return socket.emit("game:error", { message: "نوبت شما نیست." });
    }

    const player = match.players[socket.seatKey];
    if (player.isStand || player.isBusted) return;

    // لیدر یک کارت به بازیکن می‌دهد
    const card = match.deck.pop();
    player.cards.push(card);
    player.score = calculateHandScore(player.cards);

    if (player.score > 21) {
      player.isBusted = true;
      advanceTurn(match);
    } else if (player.score === 21) {
      player.isStand = true;
      advanceTurn(match);
    } else {
      // تمدید زمان نوبت بعد از دریافت کارت
      startTurnTimer(match);
      broadcastMatchState(match);
    }
  });

  // ۳. توقف و پایان نوبت (Stand)
  socket.on("game:stand", () => {
    const match = matches[socket.matchId];
    if (!match || match.status !== "PLAYING") return;

    const currentSeat = match.activeSeatsOrder[match.currentTurnIndex];
    if (currentSeat !== socket.seatKey) {
      return socket.emit("game:error", { message: "نوبت شما نیست." });
    }

    const player = match.players[socket.seatKey];
    player.isStand = true;
    advanceTurn(match);
  });

  // ۴. خروج بازیکن از میز یا قطع اتصال
  function onLeave() {
    if (socket.matchId && matches[socket.matchId]) {
      const match = matches[socket.matchId];
      handlePlayerLeft(match, socket.seatKey, user);
    }
  }

  socket.on("match:leave", onLeave);
  socket.on("disconnect", onLeave);
});

// ----------------------------------------------------------------------------
// 12. START SERVER
// ----------------------------------------------------------------------------
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`===================================================`);
  console.log(`🚀 TAJ TAS 21 (PvP) Server is running on port ${PORT}`);
  console.log(`📡 WebSocket and Express APIs are active`);
  console.log(`===================================================`);
});

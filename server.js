"use strict";

require("dotenv").config();

const http = require("http");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

/*
|--------------------------------------------------------------------------
| Env validation
|--------------------------------------------------------------------------
*/
const requiredEnvironmentVariables = ["DATABASE_URL", "JWT_SECRET", "ADMIN_SECRET"];
for (const variableName of requiredEnvironmentVariables) {
  if (!process.env[variableName]) {
    console.error(`❌ متغیر ${variableName} در فایل .env تعریف نشده است.`);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

const START_COINS = Number(process.env.START_COINS) || 1000;
const TURN_MS = 30000;

const connectedUsers = new Map(); // userId -> socketId

/*
|--------------------------------------------------------------------------
| Express + HTTP
|--------------------------------------------------------------------------
*/
const app = express();
const httpServer = http.createServer(app);
app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - startedAt;
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

/*
|--------------------------------------------------------------------------
| CORS
|--------------------------------------------------------------------------
*/
const allowedOrigins =
  CLIENT_ORIGIN === "*"
    ? "*"
    : CLIENT_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins === "*") return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("این Origin اجازه دسترسی به سرور را ندارد."));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: allowedOrigins !== "*",
  })
);

/*
|--------------------------------------------------------------------------
| Static
|--------------------------------------------------------------------------
*/
const publicDirectory = path.join(__dirname, "public");
app.use(express.static(publicDirectory));

/*
|--------------------------------------------------------------------------
| Prisma
|--------------------------------------------------------------------------
*/
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/
function getBearerToken(req) {
  const authorization = req.headers.authorization;
  if (!authorization) return null;
  const [type, token] = authorization.split(" ");
  if (type !== "Bearer" || !token) return null;
  return token;
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function safeJsonError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

function assertValidTier(tier) {
  if (!Number.isFinite(tier)) throw new Error("tier نامعتبر است.");
  if (![20, 50, 100].includes(tier)) throw new Error("tier باید یکی از 20/50/100 باشد.");
}

/*
|--------------------------------------------------------------------------
| Auth HTTP middleware
|--------------------------------------------------------------------------
*/
function authenticateHttp(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return safeJsonError(res, 401, "توکن احراز هویت ارسال نشده است.");
    const decoded = verifyToken(token);
    req.user = decoded;
    return next();
  } catch (error) {
    return safeJsonError(
      res,
      401,
      error.name === "TokenExpiredError" ? "توکن منقضی شده است." : "توکن نامعتبر است."
    );
  }
}

/*
|--------------------------------------------------------------------------
| Admin secret middleware
|--------------------------------------------------------------------------
*/
function authenticateAdminSecret(req, res, next) {
  const secret = req.query?.adminSecret ?? req.body?.adminSecret ?? "";
  if (String(secret) !== String(ADMIN_SECRET)) {
    return safeJsonError(res, 403, "رمز ادمین اشتباه است.");
  }
  return next();
}

/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
*/
app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "سرور بازی منچ با موفقیت در حال اجرا است.",
    server: "online",
    name: "Iran Ludo Server",
    version: "4.2.0",
    endpoints: {
      health: "/health",
      authCheck: "/api/auth/check",
      treasuryReport: "/admin/treasury-report?range=day|week|month",
      adminCharge: "/admin/charge-coins",
      userBalance: "/api/me/balance",
    },
  });
});

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      success: true,
      server: "online",
      database: "connected",
      time: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      server: "online",
      database: "disconnected",
      message: "اتصال به دیتابیس برقرار نشد.",
      error: error.message,
    });
  }
});

/*
|--------------------------------------------------------------------------
| Auth routes
|--------------------------------------------------------------------------
*/
app.post("/api/auth/register", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (username.length < 3) return safeJsonError(res, 400, "نام کاربری حداقل 3 کاراکتر باشد.");
    if (password.length < 4) return safeJsonError(res, 400, "رمز عبور حداقل 4 کاراکتر باشد.");

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return safeJsonError(res, 409, "این نام کاربری قبلاً استفاده شده است.");

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.user.create({
      data: { username, password: passwordHash, coins: START_COINS, role: "USER" },
    });

    return res.status(201).json({ success: true, message: "ثبت‌نام با موفقیت انجام شد." });
  } catch (e) {
    return safeJsonError(res, 500, e.message || "خطای داخلی");
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!username || !password) return safeJsonError(res, 400, "نام کاربری و رمز عبور را وارد کنید.");

    const user = await prisma.user.findUnique({ where: { username: username.trim() } });
    if (!user) return safeJsonError(res, 401, "نام کاربری یا رمز عبور اشتباه است.");

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return safeJsonError(res, 401, "نام کاربری یا رمز عبور اشتباه است.");

    const token = createToken({ userId: user.id, username: user.username });
    return res.status(200).json({ success: true, token });
  } catch (e) {
    return safeJsonError(res, 500, e.message || "خطای داخلی");
  }
});

app.get("/api/auth/check", authenticateHttp, (req, res) => {
  return res.status(200).json({ success: true, user: req.user });
});

app.get("/api/me/balance", authenticateHttp, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("ETag", "");

    const userId = Number(req.user.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true, username: true },
    });
    if (!user) return safeJsonError(res, 404, "کاربر پیدا نشد.");
    return res.status(200).json({ success: true, username: user.username, coins: user.coins });
  } catch (e) {
    return safeJsonError(res, 500, e.message || "خطای داخلی");
  }
});

/*
|--------------------------------------------------------------------------
| Game engine data (منچ ساده روی برد ثابت)
|--------------------------------------------------------------------------
*/
const SIZE = 600;
const GRID_COUNT = 13;
const CELL = SIZE / GRID_COUNT;

const layout = {
  cells: {
    P1: { c: 7, r: 2 }, P2: { c: 7, r: 3 }, P3: { c: 7, r: 4 }, P4: { c: 7, r: 5 },
    P5: { c: 8, r: 5 }, P6: { c: 9, r: 5 }, P7: { c: 10, r: 5 }, P8: { c: 11, r: 5 },
    P9: { c: 11, r: 6 }, P10: { c: 10, r: 7 }, P11: { c: 9, r: 7 }, P12: { c: 8, r: 7 },
    P13: { c: 7, r: 7 }, P14: { c: 7, r: 8 }, P15: { c: 7, r: 9 }, P16: { c: 7, r: 10 },
    P17: { c: 7, r: 11 }, P18: { c: 6, r: 11 }, P19: { c: 5, r: 10 }, P20: { c: 5, r: 9 },
    P21: { c: 5, r: 8 }, P22: { c: 5, r: 7 }, P23: { c: 4, r: 7 }, P24: { c: 3, r: 7 },
    P25: { c: 2, r: 7 }, P26: { c: 1, r: 7 }, P27: { c: 1, r: 6 }, P28: { c: 2, r: 5 },
    P29: { c: 3, r: 5 }, P30: { c: 4, r: 5 }, P31: { c: 5, r: 5 }, P32: { c: 5, r: 4 },
    P33: { c: 5, r: 3 }, P34: { c: 5, r: 2 }, P35: { c: 5, r: 1 }, P36: { c: 6, r: 1 },
    S_R: { c: 1, r: 5 }, S_B: { c: 7, r: 1 }, S_G: { c: 11, r: 7 }, S_Y: { c: 5, r: 11 },
    F_R1: { c: 2, r: 6 }, F_R2: { c: 3, r: 6 }, F_R3: { c: 4, r: 6 }, F_R4: { c: 5, r: 6 },
    F_B1: { c: 6, r: 2 }, F_B2: { c: 6, r: 3 }, F_B3: { c: 6, r: 4 }, F_B4: { c: 6, r: 5 },
    F_G1: { c: 10, r: 6 }, F_G2: { c: 9, r: 6 }, F_G3: { c: 8, r: 6 }, F_G4: { c: 7, r: 6 },
    F_Y1: { c: 6, r: 10 }, F_Y2: { c: 6, r: 9 }, F_Y3: { c: 6, r: 8 }, F_Y4: { c: 6, r: 7 },
  },
  mainPath: [
    "P1","P2","P3","P4","P5","P6","P7","P8","P9","P10","P11","P12","P13","P14",
    "P15","P16","P17","P18","P19","P20","P21","P22","P23","P24","P25","P26",
    "P27","P28","P29","P30","P31","P32","P33","P34","P35","P36",
  ],
  startCells: { red: "S_R", blue: "S_B", green: "S_G", yellow: "S_Y" },
  entryPathIndexes: { red: 27, blue: 0, green: 9, yellow: 18 },
  finishCells: {
    red: ["F_R1","F_R2","F_R3","F_R4"],
    blue: ["F_B1","F_B2","F_B3","F_B4"],
    green: ["F_G1","F_G2","F_G3","F_G4"],
    yellow: ["F_Y1","F_Y2","F_Y3","F_Y4"],
  },
};

const colorOrder = ["red", "green", "yellow", "blue"];

function buildPieces() {
  const arr = [];
  for (const c of colorOrder) {
    for (let i = 0; i < 4; i++) {
      arr.push({ id: `${c}_${i}`, color: c, index: i, state: "yard", pathIndex: -1, homeIndex: -1 });
    }
  }
  return arr;
}

function cloneGameForClient(game) {
  return {
    currentTurn: game.currentTurn,
    currentTurnColor: colorOrder[game.currentTurn],
    currentTurnPlayerId: game.playerColors[colorOrder[game.currentTurn]],
    dice: game.dice,
    rolled: game.rolled,
    rolling: false,
    winner: game.winner,
    turnDeadlineAt: game.turnDeadlineAt,
    turnMoved: game.turnMoved,
    pieces: game.pieces.map((p) => ({ ...p })),
    playerColors: game.playerColors,
  };
}

function isOccupiedBySameColorAtPathIndex(game, myColor, pieceId, destPathIndex) {
  const destCell = layout.mainPath[destPathIndex];
  return game.pieces.some(
    (p) =>
      p.color === myColor &&
      p.id !== pieceId &&
      p.state === "path" &&
      layout.mainPath[p.pathIndex] === destCell
  );
}

function canPieceMove(game, piece) {
  if (!game.rolled) return false;
  if (piece.color !== colorOrder[game.currentTurn]) return false;
  if (game.winner) return false;
  if (Date.now() > game.turnDeadlineAt) return false;

  const dice = game.dice;

  if (piece.state === "yard") return dice === 6;

  if (piece.state === "start") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const destPathIndex = (entryIndex + dice - 1) % 36;
    return !isOccupiedBySameColorAtPathIndex(game, piece.color, piece.id, destPathIndex);
  }

  if (piece.state === "path") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const currentPathIndex = piece.pathIndex;
    const walkedSteps = (currentPathIndex - entryIndex + 36) % 36;
    const remainingStepsToHomeEntry = 35 - walkedSteps;

    if (dice <= remainingStepsToHomeEntry) {
      const destPathIndex = (currentPathIndex + dice) % 36;
      return !isOccupiedBySameColorAtPathIndex(game, piece.color, piece.id, destPathIndex);
    } else {
      const stepsIntoHome = dice - remainingStepsToHomeEntry - 1;
      return (
        stepsIntoHome < 4 &&
        !game.pieces.some(
          (p) =>
            p.color === piece.color &&
            p.id !== piece.id &&
            p.state === "home" &&
            p.homeIndex === stepsIntoHome
        )
      );
    }
  }

  if (piece.state === "home") {
    const destHomeIndex = piece.homeIndex + dice;
    return (
      destHomeIndex < 4 &&
      !game.pieces.some(
        (p) =>
          p.color === piece.color &&
          p.id !== piece.id &&
          p.state === "home" &&
          p.homeIndex === destHomeIndex
      )
    );
  }

  return false;
}

function capture(game, cellName, myColor) {
  for (const p of game.pieces) {
    if (p.color === myColor) continue;

    if (p.state === "path" && layout.mainPath[p.pathIndex] === cellName) {
      p.state = "yard";
      p.pathIndex = -1;
      p.homeIndex = -1;
    }
    if (p.state === "start" && layout.startCells[p.color] === cellName) {
      p.state = "yard";
      p.pathIndex = -1;
      p.homeIndex = -1;
    }
  }
}

function movePiece(game, piece) {
  const dice = game.dice;

  if (piece.state === "yard") {
    if (dice !== 6) return false;
    piece.state = "start";
    piece.pathIndex = -1;
    piece.homeIndex = -1;
    return true;
  }

  if (piece.state === "start") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const destPathIndex = (entryIndex + dice - 1) % 36;
    piece.state = "path";
    piece.pathIndex = destPathIndex;
    piece.homeIndex = -1;
    capture(game, layout.mainPath[piece.pathIndex], piece.color);
    return true;
  }

  if (piece.state === "path") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const walkedSteps = (piece.pathIndex - entryIndex + 36) % 36;
    const remainingStepsToHomeEntry = 35 - walkedSteps;

    if (dice <= remainingStepsToHomeEntry) {
      piece.pathIndex = (piece.pathIndex + dice) % 36;
      capture(game, layout.mainPath[piece.pathIndex], piece.color);
    } else {
      piece.state = "home";
      piece.homeIndex = dice - remainingStepsToHomeEntry - 1;
      piece.pathIndex = -1;
    }
    return true;
  }

  if (piece.state === "home") {
    piece.homeIndex += dice;
    return true;
  }

  return false;
}

function checkWinner(game) {
  const byColor = {};
  for (const p of game.pieces) {
    byColor[p.color] ??= 0;
    if (p.state === "home" && p.homeIndex === 3) byColor[p.color]++;
  }
  for (const color of colorOrder) {
    if ((byColor[color] || 0) === 4) return color;
  }
  return null;
}

/*
|--------------------------------------------------------------------------
| Rooms & match
|--------------------------------------------------------------------------
*/
const matches = new Map(); // matchId -> match

function createMatch(matchId) {
  return {
    matchId,
    status: "waiting",
    players: new Map(), // userId -> socketId
    playerColors: { red: null, green: null, yellow: null, blue: null },
    game: null,
    turnDeadlineAt: 0,
    turnId: 0,
    pendingTurnTimer: null,
    createdAt: Date.now(),
    tier: null,

    financialSettled: false,
    chargedEntry: false,
  };
}

function resetMatchGame(match) {
  match.game = {
    currentTurn: 0,
    dice: 0,
    rolled: false,
    winner: null,
    pieces: buildPieces(),
    turnMoved: false,
    turnDeadlineAt: Date.now() + TURN_MS,
    playerColors: {
      red: match.playerColors.red,
      green: match.playerColors.green,
      yellow: match.playerColors.yellow,
      blue: match.playerColors.blue,
    },
  };
  match.turnDeadlineAt = match.game.turnDeadlineAt;
  match.turnId++;
}

function getCurrentColor(match) {
  return colorOrder[match.game.currentTurn];
}

let io; // assigned after Server creation

function broadcastState(match) {
  const snapshot = cloneGameForClient(match.game);
  snapshot.matchId = match.matchId;

  console.log("[BROADCAST STATE]", {
    matchId: match.matchId,
    snapshotKeys: Object.keys(snapshot),
    status: snapshot.status ?? match.status,
    currentTurnColor: snapshot.currentTurnColor ?? snapshot.currentTurn,
    currentTurnPlayerId: snapshot.currentTurnPlayerId ?? snapshot.currentTurnPlayerId,
  });

  io.to(`match:${match.matchId}`).emit("game:state", snapshot);
}

function nextTurn(match) {
  if (!match.game) return;
  if (match.game.dice !== 6) match.game.currentTurn = (match.game.currentTurn + 1) % 4;

  match.game.dice = 0;
  match.game.rolled = false;
  match.game.turnMoved = false;
  match.game.turnDeadlineAt = Date.now() + TURN_MS;

  match.turnDeadlineAt = match.game.turnDeadlineAt;
  match.turnId++;
  broadcastState(match);
}

function startTurnTimeout(match) {
  if (match.pendingTurnTimer) clearTimeout(match.pendingTurnTimer);

  const myTurnId = match.turnId;
  const deadlineAt = match.game.turnDeadlineAt;

  match.pendingTurnTimer = setTimeout(() => {
    if (!matches.has(match.matchId)) return;
    const m = matches.get(match.matchId);
    if (m.turnId !== myTurnId) return;
    if (!m.game || m.game.winner) return;

    if (!m.game.rolled) {
      nextTurn(m);
      return;
    }
    if (!m.game.turnMoved) {
      nextTurn(m);
    }
  }, Math.max(1, deadlineAt - Date.now() + 5));
}

function getNextDiceValueFromMatch() {
  return Math.floor(Math.random() * 6) + 1;
}

/*
|--------------------------------------------------------------------------
| Admin: update by username
|--------------------------------------------------------------------------
*/
app.post("/admin/update-balance-by-username", authenticateAdminSecret, async (req, res) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const amount = Number(req.body?.amount);

    if (!username) return safeJsonError(res, 400, "username لازم است.");
    if (!Number.isFinite(amount)) return safeJsonError(res, 400, "amount باید عدد باشد.");

    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, coins: true },
    });
    if (!user) return res.json({ success: false, message: "کاربر با این نام کاربری یافت نشد!" });

    const updatedUser = await prisma.user.update({
      where: { username },
      data: { coins: { increment: amount } },
      select: { id: true, username: true, coins: true },
    });

    const targetSocketId = connectedUsers.get(String(updatedUser.id));
    if (targetSocketId && io) {
      io.to(targetSocketId).emit("balanceChanged", {
        newCoins: updatedUser.coins,
        message: "موجودی شما توسط ادمین به روزرسانی شد.",
      });
    }

    return res.json({ success: true, newCoins: updatedUser.coins });
  } catch (error) {
    console.error("❌ خطا در آپدیت سکه:", error);
    return res.status(500).json({ success: false, message: "خطای سرور: " + error.message });
  }
});

app.get("/admin/user-balance/:username", async (req, res) => {
  try {
    // 🔒 جلوگیری از 304 و کش
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    // اگر ETag تولید می‌کنی، اینجا بهتره خاموش کنی
    // (اگر express compression/etag پیش‌فرض داره، این کمک می‌کنه)
    res.setHeader("ETag", "");

    const { username } = req.params;
    const adminSecret = req.query.adminSecret;

    // ... بقیه منطق احراز/دریافت موجودی خودت ...

    // مثال:
    // const user = await db.findUserByUsername(username)
    // res.json({ success:true, username, userId:user.id, coins:user.coins });

    // نتیجه واقعی پروژه‌ات را مثل قبل برگردان
    // res.json(...);

  } catch (err) {
    res.status(500).json({ success: false, message: "server error" });
  }
});

/*
|--------------------------------------------------------------------------
| Treasury / financial functions + realtime balance
|--------------------------------------------------------------------------
*/
function emitBalanceChanged(userId, newCoins, message) {
  const socketId = connectedUsers.get(String(userId));
  console.log("[emitBalanceChanged]", { userId, socketId, newCoins });
  if (!socketId || !io) return;
  io.to(socketId).emit("balanceChanged", { newCoins, message });
}

async function getUsersCoins(userIds) {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, coins: true },
  });
  return new Map(users.map((u) => [u.id, u.coins]));
}

async function ensureTreasuryUser() {
  const username = "treasury";
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

  return prisma.user.create({
    data: { username, password: passwordHash, coins: 0, role: "TREASURY" },
  });
}

async function chargeTierFromPlayers(match) {
  if (match.chargedEntry) return;
  if (!match.tier) throw new Error("tier نامعتبر است یا ست نشده است.");
  assertValidTier(match.tier);

  const userIds = colorOrder.map((c) => match.playerColors[c]).filter(Boolean);
  if (userIds.length !== 4) throw new Error("برای شروع باید دقیقاً ۴ نفر باشند.");

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, coins: true },
  });

  const mapCoins = new Map(users.map((u) => [u.id, u.coins]));
  for (const uid of userIds) {
    const coins = mapCoins.get(uid);
    if (typeof coins !== "number" || coins < match.tier) {
      throw new Error("موجودی یکی از کاربران برای tier کافی نیست.");
    }
  }

  const amount = match.tier;

  // ✅ فقط ۲ کوئری داخل ترنزکشن: آپدیت کاربران + ثبت رکوردهای مالی
  await prisma.$transaction(async (tx) => {
    await tx.user.updateMany({
      where: { id: { in: userIds } },
      data: { coins: { decrement: amount } },
    });

    await tx.transaction.createMany({
      data: userIds.map((uid) => ({
        userId: uid,
        amount: -amount,
        type: "ENTRY_TIER",
        note: `match:${match.matchId} tier=${amount} entry`,
      })),
    });
  });

  const mapAfter = await getUsersCoins(userIds);
  for (const uid of userIds) {
    emitBalanceChanged(uid, mapAfter.get(uid), "موجودی شما بابت ورود به بازی کم شد.");
  }

  match.chargedEntry = true;
}


async function settleCoinsForMatch(match) {
  if (match.financialSettled) return;
  if (!match.game?.winner) return;
  if (!match.tier) throw new Error("tier نامعتبر است یا ست نشده است.");
  assertValidTier(match.tier);

  const winnerColor = match.game.winner;
  const winnerUserId = match.playerColors[winnerColor];
  if (!winnerUserId) throw new Error("winnerUserId پیدا نشد.");

  const totalPot = 4 * match.tier;
  const winnerAmount = Math.floor(0.9 * totalPot);
  const treasuryAmount = totalPot - winnerAmount;

  const treasury = await ensureTreasuryUser();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: winnerUserId }, data: { coins: { increment: winnerAmount } } });
    await tx.transaction.create({
      data: {
        userId: winnerUserId,
        amount: winnerAmount,
        type: "WIN",
        note: `match:${match.matchId} tier=${match.tier} winnerColor=${winnerColor}`,
      },
    });

    await tx.user.update({ where: { id: treasury.id }, data: { coins: { increment: treasuryAmount } } });
    await tx.transaction.create({
      data: {
        userId: treasury.id,
        amount: treasuryAmount,
        type: "TREASURY_CUT",
        note: `match:${match.matchId} tier=${match.tier} treasuryCut`,
      },
    });
  });

  match.financialSettled = true;

  const targets = Array.from(new Set([winnerUserId, treasury.id]));
  const mapAfter = await getUsersCoins(targets);

  emitBalanceChanged(winnerUserId, mapAfter.get(winnerUserId), "شما برنده بازی شدید. موجودی افزایش یافت.");
  emitBalanceChanged(treasury.id, mapAfter.get(treasury.id), "سهم سرور/ترژری ثبت شد.");

  io.to(`match:${match.matchId}`).emit("game:settled", {
    success: true,
    winnerColor,
    winnerAmount,
    treasuryAmount,
    tier: match.tier,
  });
}

/*
|--------------------------------------------------------------------------
| Admin: treasury report
|--------------------------------------------------------------------------
*/
function getRangeBounds(range) {
  const now = new Date();

  if (range === "day") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { from, to };
  }

  if (range === "week") {
    const day = (now.getDay() + 6) % 7; // Monday-based
    const from = new Date(now);
    from.setDate(now.getDate() - day);
    from.setHours(0, 0, 0, 0);

    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    to.setHours(23, 59, 59, 999);

    return { from, to };
  }

  if (range === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
  }

  return null;
}

app.get("/admin/treasury-report", authenticateAdminSecret, async (req, res) => {
  try {
    const range = String(req.query?.range || "day");
    const bounds = getRangeBounds(range);
    if (!bounds) return safeJsonError(res, 400, "range فقط day/week/month باشد.");

    const treasuryUser = await prisma.user.findUnique({ where: { username: "treasury" } });
    if (!treasuryUser) return safeJsonError(res, 404, "treasury پیدا نشد.");

    const items = await prisma.transaction.findMany({
      where: {
        userId: treasuryUser.id,
        type: "TREASURY_CUT",
        createdAt: { gte: bounds.from, lte: bounds.to },
      },
      select: { amount: true, createdAt: true, type: true, note: true },
      orderBy: { createdAt: "desc" },
    });

    const total = items.reduce((acc, x) => acc + Number(x.amount), 0);

    return res.status(200).json({
      success: true,
      range,
      from: bounds.from,
      to: bounds.to,
      total,
      count: items.length,
      items: items.slice(0, 200),
    });
  } catch (e) {
    return safeJsonError(res, 500, e.message || "خطای داخلی");
  }
});

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/
io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins === "*" ? "*" : allowedOrigins,
    methods: ["GET", "POST"],
    credentials: allowedOrigins !== "*",
  },
  transports: ["websocket", "polling"],
});

io.use((socket, next) => {
  try {
    let token = socket.handshake.auth?.token;

    if (!token) {
      const authorization = socket.handshake.headers?.authorization;
      if (authorization?.startsWith("Bearer ")) token = authorization.slice(7);
    }

    if (!token) return next(new Error("توکن Socket.io ارسال نشده است."));

    const decoded = verifyToken(token);
    socket.user = decoded;
    return next();
  } catch (error) {
    return next(
      new Error(
        error.name === "TokenExpiredError"
          ? "توکن Socket.io منقضی شده است."
          : "توکن Socket.io نامعتبر است."
      )
    );
  }
});

io.on("connection", (socket) => {
socket.on("room:join", async (payload, callback) => {
  try {
    const matchId =
      typeof payload?.roomId === "string" && payload.roomId.trim()
        ? payload.roomId.trim()
        : null;

    if (!matchId) return callback?.({ success: false, message: "شناسه اتاق معتبر نیست." });

    const tier = Number(payload?.tier);
    if (!Number.isFinite(tier)) return callback?.({ success: false, message: "tier لازم است." });
    assertValidTier(tier);

    const userId = Number(socket.user.userId);
    if (!Number.isFinite(userId)) return callback?.({ success: false, message: "userId نامعتبر است." });

    connectedUsers.set(String(userId), socket.id);

    if (!matches.has(matchId)) matches.set(matchId, createMatch(matchId));
    const match = matches.get(matchId);

    socket.join(`match:${matchId}`);

    // assign color if not assigned yet
    const alreadyAssigned = Object.values(match.playerColors).includes(userId);
    if (!alreadyAssigned) {
      for (const c of colorOrder) {
        if (!match.playerColors[c]) {
          match.playerColors[c] = userId;
          break;
        }
      }
    }

    match.players.set(userId, socket.id);

    // set tier once
    if (match.tier === null) {
      match.tier = tier;
    } else if (match.tier !== tier) {
      return callback?.({ success: false, message: `این match با tier=${match.tier} ست شده است.` });
    }

    const filledColors = colorOrder.filter((c) => match.playerColors[c] !== null).length;

    console.log("[JOIN]", {
      matchId,
      userId,
      tier,
      filledColors,
      status: match.status,
      playerColors: match.playerColors,
      matchTier: match.tier,
    });

if (filledColors === 4 && match.status !== "playing") {
      try {
        match.status = "playing";

        console.log("[START CHECK]", {
          matchId,
          filledColors,
          status: match.status,
          tier: match.tier,
          playerColors: match.playerColors,
        });

        await chargeTierFromPlayers(match);

        console.log("[CHARGED OK]", {
          matchId,
          tier: match.tier,
          playerColors: match.playerColors,
        });

        resetMatchGame(match);
        broadcastState(match);
        startTurnTimeout(match);

        return callback?.({
          success: true,
          message: "بازی شروع شد.",
          matchId,
          tier: match.tier,
        });
      } catch (e) {
        console.error("[CHARGE FAILED]", {
          matchId,
          tier: match.tier,
          playerColors: match.playerColors,
          error: e?.message || String(e),
        });

        // ✅ مهم: برگرداندن وضعیت تا نیمه‌کاره نماند
        match.status = "waiting";
        match.chargedEntry = false;

        return callback?.({
          success: false,
          message: "شروع بازی ممکن نشد (خطای تسویه). دوباره تلاش کنید.",
          matchId,
        });
      }
    }

    return callback?.({
      success: true,
      message: filledColors === 0 ? "منتظر بازیکنان" : "به صف اضافه شد.",
      matchId,
      tier: match.tier,
      filledColors,
    });
  } catch (e) {
    console.error("JOIN ERROR:", e);
    return callback?.({ success: false, message: e.message || "خطای join" });
  }
});

socket.on("game:roll", async (payload, callback) => {
    try {
      const matchId = payload?.matchId ?? payload?.roomId;
      if (!matchId || !matches.has(String(matchId))) {
        return callback?.({ success: false, message: "match پیدا نشد." });
      }

      const match = matches.get(String(matchId));

      if (!match.game || match.status !== "playing") {
        return callback?.({ success: false, message: "بازی هنوز شروع نشده است." });
      }

      if (match.game.winner) return callback?.({ success: false, message: "بازی تمام شده است." });

      const userId = Number(socket.user.userId);
      const turnColor = getCurrentColor(match);

      if (match.playerColors[turnColor] !== userId) {
        return callback?.({ success: false, message: "نوبت شما نیست." });
      }

      if (match.game.rolled) return callback?.({ success: false, message: "قبلاً رول شده است." });
      if (Date.now() > match.game.turnDeadlineAt) {
        return callback?.({ success: false, message: "زمان نوبت گذشته." });
      }

      const dice = getNextDiceValueFromMatch();
      match.game.dice = dice;
      match.game.rolled = true;
      match.game.turnMoved = false;

      broadcastState(match);
      startTurnTimeout(match);

      return callback?.({ success: true, dice });
    } catch (e) {
      return callback?.({ success: false, message: e.message || "خطای roll" });
    }
  });

  socket.on("game:move", async (payload, callback) => {
    try {
      const matchId = payload?.matchId ?? payload?.roomId;
      const pieceId = payload?.pieceId;

      if (!matchId || !matches.has(String(matchId))) {
        return callback?.({ success: false, message: "match پیدا نشد." });
      }
      if (pieceId === undefined || pieceId === null) {
        return callback?.({ success: false, message: "pieceId لازم است." });
      }

      const match = matches.get(String(matchId));

      if (!match.game || match.status !== "playing") {
        return callback?.({ success: false, message: "بازی هنوز شروع نشده است." });
      }

      if (match.game.winner) {
        return callback?.({ success: false, message: "بازی تمام شده است." });
      }

      if (!match.game.rolled) {
        return callback?.({ success: false, message: "اول رول کنید." });
      }

      if (Date.now() > match.game.turnDeadlineAt) {
        return callback?.({ success: false, message: "زمان نوبت گذشته." });
      }

      const userId = Number(socket.user.userId);
      const turnColor = getCurrentColor(match);

      if (match.playerColors[turnColor] !== userId) {
        return callback?.({ success: false, message: "نوبت شما نیست." });
      }

      if (match.game.turnMoved) {
        return callback?.({ success: false, message: "در این نوبت فقط یک حرکت مجاز است." });
      }

      const piece = match.game.pieces.find((p) => p.id === pieceId);
      if (!piece) return callback?.({ success: false, message: "مهره پیدا نشد." });

      const movable = canPieceMove(match.game, piece);
      if (!movable) return callback?.({ success: false, message: "حرکت مجاز نیست." });

      const ok = movePiece(match.game, piece);
      if (!ok) return callback?.({ success: false, message: "حرکت انجام نشد." });

      match.game.turnMoved = true;

      const winnerColor = checkWinner(match.game);
      if (winnerColor) {
        match.game.winner = winnerColor;
        match.status = "finished";
        match.turnDeadlineAt = Date.now();

        broadcastState(match);

        try {
          await settleCoinsForMatch(match);
        } catch (e) {
          console.error("settleCoinsForMatch failed:", e);
        }

        return callback?.({ success: true, winnerColor });
      }

      broadcastState(match);
      startTurnTimeout(match);

      return callback?.({ success: true, moved: true });
    } catch (e) {
      return callback?.({ success: false, message: e.message || "خطای move" });
    }
  });

  socket.on("disconnect", () => {
    try {
      const userId = Number(socket.user?.userId);
      if (!Number.isFinite(userId)) return;
      const key = String(userId);
      if (connectedUsers.get(key) === socket.id) connectedUsers.delete(key);
    } catch {}
  });
}); // end io.on("connection")

// Start server
httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
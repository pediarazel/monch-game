"use strict";

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

console.log("JWT_SECRET len:", (process.env.JWT_SECRET || "").length);
console.log("ADMIN_SECRET present:", !!process.env.ADMIN_SECRET);

const http = require("http");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
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

const TURN_MS = 30000;

// --------- تایمرهای match
const matchTimers = new Map(); // matchId -> { timeout }
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
const allowedOriginsForSocket =
  allowedOrigins === "*" ? "*" : allowedOrigins;
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
| Static Files
|--------------------------------------------------------------------------
*/
const staticFilesDirectory = path.join(__dirname, "anna");
app.use(express.static(staticFilesDirectory));

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

function assertValidTier(tier) {
  if (!Number.isFinite(tier)) throw new Error("tier نامعتبر است.");
  if (![20, 50, 100].includes(tier)) throw new Error("tier باید یکی از 20/50/100 باشد.");
}

function safeJsonError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

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

function normalizeEnvSecret(s) {
  return s == null ? "" : String(s);
}

function authenticateAdminSecret(req, res, next) {
  const secret = req.query?.adminSecret ?? req.body?.adminSecret ?? "";
  if (normalizeEnvSecret(secret) !== normalizeEnvSecret(ADMIN_SECRET)) {
    return safeJsonError(res, 403, "رمز ادمین اشتباه است.");
  }
  return next();
}

/*
|--------------------------------------------------------------------------
| Auth routes
|--------------------------------------------------------------------------
*/
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1h" });
    return res.json({ token });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
});

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
      data: { username, password: passwordHash, coins: 0, role: "USER" },
    });

    return res.status(201).json({ success: true, message: "ثبت‌نام با موفقیت انجام شد." });
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
| Admin HTTP routes (برای admin.html)
|--------------------------------------------------------------------------
*/
function getRangeBounds(range) {
  const r = String(range || "day");
  const now = new Date();

  if (r === "day") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { from, to };
  }

  if (r === "week") {
    const day = (now.getDay() + 6) % 7; // Monday=0
    const from = new Date(now);
    from.setDate(now.getDate() - day);
    from.setHours(0, 0, 0, 0);

    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    to.setHours(23, 59, 59, 999);
    return { from, to };
  }

  if (r === "month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from, to };
  }

  return null;
}
// آپدیت موجودی
app.post("/admin/update-balance-by-username", authenticateAdminSecret, async (req, res) => {
  const maxAttempts = 3;

  async function attemptOnce() {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const amount = Number(req.body?.amount);

    if (!username) return safeJsonError(res, 400, "username لازم است.");
    if (!Number.isFinite(amount)) return safeJsonError(res, 400, "amount باید عدد باشد.");

    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, coins: true },
    });
    if (!user) return res.json({ success: false, message: "کاربر با این نام کاربری یافت نشد!" });

    // اگر می‌خوای موجودی منفی نشه
    if (user.coins + amount < 0) {
      return res.json({ success: false, message: "موجودی کافی نیست." });
    }

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
  }

  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await attemptOnce();
    } catch (e) {
      const msg = String(e?.message || "");
      const code = String(e?.code || "");

      const transient =
        msg.includes("EAI_AGAIN") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        code === "P1001";

      if (!transient || i === maxAttempts) {
        console.error("❌ خطا در آپدیت موجودی ادمین:", e);
        return res.status(500).json({ success: false, message: "خطای سرور: " + (e?.message || String(e)) });
      }

      // backoff ساده
      await new Promise((r) => setTimeout(r, i * 300));
    }
  }
});

// دریافت موجودی با username
app.get("/admin/user-balance/:username", authenticateAdminSecret, async (req, res) => {
  try {
    const username = String(req.params?.username || "").trim();
    if (!username) return safeJsonError(res, 400, "نام کاربری وارد نشده است.");

    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true, username: true, coins: true, role: true },
    });

    if (!user) return safeJsonError(res, 404, "کاربر پیدا نشد.");

    return res.status(200).json({
      success: true,
      userId: user.id,
      username: user.username,
      coins: user.coins,
      role: user.role,
    });
  } catch (error) {
    console.error("[ADMIN BALANCE ERROR]", error);
    return safeJsonError(res, 500, error?.message || "خطای داخلی سرور");
  }
});

app.get("/admin/treasury-report", authenticateAdminSecret, async (req, res) => {
  try {
    const range = String(req.query?.range || "day");
    const bounds = getRangeBounds(range);
    if (!bounds) return safeJsonError(res, 400, "range فقط day/week/month باشد.");

    const treasuryUser = await ensureTreasuryUser();

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
| Game engine (منچ)
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
    dice1: game.dice1,
    dice2: game.dice2,
    pendingDice: Array.isArray(game.pendingDice) ? game.pendingDice.slice() : [],
    rolled: game.rolled,
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

function canPieceMove(game, piece, dieValue) {
  if (!game.rolled) return false;
  if (piece.color !== colorOrder[game.currentTurn]) return false;
  if (game.winner) return false;
  if (Date.now() > game.turnDeadlineAt) return false;

if (piece.state === "yard") {
  if (dieValue !== 6) return false;

  // خانه شروع مخصوص رنگ این مهره
  const sCell = layout.startCells[piece.color]; // S_R / S_B / S_G / S_Y

  // فقط یک مهره هم‌رنگ می‌تواند در همان S باشد
  const occupiedStart = game.pieces.some(
    (p) =>
      p.id !== piece.id &&
      p.color === piece.color &&
      p.state === "start" &&
      layout.startCells[p.color] === sCell
  );

  return !occupiedStart;
}

  if (piece.state === "start") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const destPathIndex = (entryIndex + dieValue - 1) % 36;
    return !isOccupiedBySameColorAtPathIndex(game, piece.color, piece.id, destPathIndex);
  }

  if (piece.state === "path") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const currentPathIndex = piece.pathIndex;
    const walkedSteps = (currentPathIndex - entryIndex + 36) % 36;
    const remainingStepsToHomeEntry = 35 - walkedSteps;

    if (dieValue <= remainingStepsToHomeEntry) {
      const destPathIndex = (currentPathIndex + dieValue) % 36;
      return !isOccupiedBySameColorAtPathIndex(game, piece.color, piece.id, destPathIndex);
    } else {
      const stepsIntoHome = dieValue - remainingStepsToHomeEntry - 1;
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
    const destHomeIndex = piece.homeIndex + dieValue;
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

function hasLegalMoveForDie(game, dieValue) {
  if (!game || !Array.isArray(game.pieces)) return false;
  const currentColor = colorOrder[game.currentTurn];
  return game.pieces.some((piece) => piece.color === currentColor && canPieceMove(game, piece, dieValue));
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

function movePiece(game, piece, dieValue) {
  if (piece.state === "yard") {
    if (dieValue !== 6) return false;
    piece.state = "start";
    piece.pathIndex = -1;
    piece.homeIndex = -1;
    return true;
  }
  if (piece.state === "start") {
    const entryIndex = layout.entryPathIndexes[piece.color];
    const destPathIndex = (entryIndex + dieValue - 1) % 36;
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

    if (dieValue <= remainingStepsToHomeEntry) {
      piece.pathIndex = (piece.pathIndex + dieValue) % 36;
      capture(game, layout.mainPath[piece.pathIndex], piece.color);
    } else {
      piece.state = "home";
      piece.homeIndex = dieValue - remainingStepsToHomeEntry - 1;
      piece.pathIndex = -1;
    }
    return true;
  }
  if (piece.state === "home") {
    piece.homeIndex += dieValue;
    return true;
  }
  return false;
}

function checkWinner(game) {
  for (const color of colorOrder) {
    const homePieces = game.pieces.filter(
      (piece) => piece.color === color && piece.state === "home" && piece.homeIndex >= 0 && piece.homeIndex < 4
    );
    const occupiedHomeIndexes = new Set(homePieces.map((piece) => piece.homeIndex));
    if (homePieces.length === 4 && occupiedHomeIndexes.size === 4) return color;
  }
  return null;
}

/*
|--------------------------------------------------------------------------
| Rooms & match
|--------------------------------------------------------------------------
*/
const matches = new Map(); // matchId -> match
let io;

const tierLobbies = new Map(); // tier -> lobby

function makeMatchId(tier) {
  return `m:${tier}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
}

function createLobby(tier) {
  return {
    matchId: makeMatchId(tier),
    tier,
    status: "lobby",
    createdAt: Date.now(),
    playerUidsInOrder: [],
    playerColors: { red: null, green: null, yellow: null, blue: null },
    lobbyPhase: 1,
    lobbyDeadlineAt: null,
    lobbyTimer: null,
    timerToken: 0,
    ready: false,
  };
}

function getTierLobby(tier) {
  if (!tierLobbies.has(tier)) tierLobbies.set(tier, createLobby(tier));
  return tierLobbies.get(tier);
}

function activePlayersCountFromPlayerColors(playerColors) {
  return colorOrder.filter((c) => playerColors[c] != null).length;
}

function assignColorsToLobbyPlayers(lobby) {
  const colors = ["red", "green", "yellow", "blue"];
  for (let i = 0; i < lobby.playerUidsInOrder.length; i++) {
    lobby.playerColors[colors[i]] = lobby.playerUidsInOrder[i];
  }
  for (let i = lobby.playerUidsInOrder.length; i < 4; i++) {
    lobby.playerColors[colors[i]] = null;
  }
}

function emitLobbyStatus(lobby, data) {
  const payload = {
    success: true,
    matchId: lobby.matchId,
    tier: lobby.tier,
    phase: data?.phase ?? lobby.lobbyPhase,
    filledColors: activePlayersCountFromPlayerColors(lobby.playerColors),
    deadlineAt: data?.deadlineAt ?? lobby.lobbyDeadlineAt ?? null,
    deadlineMs: data?.deadlineMs ?? null,
    message: data?.message ?? null,
    searchingFor: data?.searchingFor ?? null,
    status: data?.status ?? "lobby",
  };
  io.to(`match:${lobby.matchId}`).emit("lobby:status", payload);
}

function stopLobbyTimer(lobby) {
  lobby.timerToken++;
  if (lobby.lobbyTimer) clearTimeout(lobby.lobbyTimer);
  lobby.lobbyTimer = null;
  lobby.lobbyDeadlineAt = null;
}

async function getUsersCoins(userIds) {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, coins: true },
  });
  return new Map(users.map((u) => [u.id, u.coins]));
}

function emitBalanceChanged(userId, newCoins, message) {
  const socketId = connectedUsers.get(String(userId));
  if (!socketId || !io) return;
  io.to(socketId).emit("balanceChanged", { newCoins, message });
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

  const userIds = colorOrder.map((color) => match.playerColors[color]).filter((userId) => userId != null);

  if (userIds.length < 2 || userIds.length > 4) {
    throw new Error("برای شروع بازی باید بین ۲ تا ۴ بازیکن حضور داشته باشند.");
  }

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
  if (!match.tier) throw new Error("tier نامعتبر است.");
  assertValidTier(match.tier);

  const winnerColor = match.game.winner;
  const winnerUserId = match.playerColors[winnerColor];
  if (!winnerUserId) throw new Error("winnerUserId پیدا نشد.");

  const activePlayersCount = activePlayersCountFromPlayerColors(match.playerColors);
  if (activePlayersCount < 2 || activePlayersCount > 4) {
    throw new Error("تعداد بازیکنان برای تسویه مالی باید بین ۲ تا ۴ باشد.");
  }

  const totalPot = activePlayersCount * match.tier;
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

// ---------- match game ----------
function createMatchFromLobby(lobby) {
  return {
    matchId: lobby.matchId,
    status: "waiting",
    players: new Map(),
    playerColors: { ...lobby.playerColors },
    game: null,
    turnDeadlineAt: 0,
    turnId: 0,
    pendingTurnTimer: null,
    createdAt: Date.now(),
    tier: lobby.tier,
    financialSettled: false,
    chargedEntry: false,
  };
}

function getActivePlayersCount(match) {
  return activePlayersCountFromPlayerColors(match.playerColors);
}

function resetMatchGame(match) {
  const initialTurn = colorOrder.findIndex((color) => match.playerColors[color] != null);
  const turn = initialTurn !== -1 ? initialTurn : 0;

  match.game = {
    currentTurn: turn,
    dice: 0,
    dice1: 0,
    dice2: 0,
    pendingDice: [],
    rolled: false,
    winner: null,
    pieces: buildPieces(),
    turnMoved: false,
    turnDeadlineAt: null,
    playerColors: { ...match.playerColors },
    transitioning: false,
  };

  match.turnDeadlineAt = null;
  match.turnId = (match.turnId || 0) + 1;
}

function broadcastState(match) {
  console.log("[BROADCAST_STATE]", {
  matchId: match.matchId,
  currentTurn: match.game.currentTurn,
  activeColor: colorOrder[match.game.currentTurn],
  dice1: match.game.dice1,
  dice2: match.game.dice2,
  dice: match.game.dice,
  pendingDice: match.game.pendingDice,
  rolled: match.game.rolled,
});
  console.log("[BROADCAST_STATE]", {
  matchId: match.matchId,
  currentTurn: match.game.currentTurn,
  dice: match.game.dice,
});
  if (!match.game) return;

  const activeColor = colorOrder[match.game.currentTurn];

  io.to(`match:${match.matchId}`).emit("game:state", {
    ...cloneGameForClient(match.game),
    matchId: match.matchId,
    status: match.status,
    tier: match.tier,
    turnId: match.turnId,
    turnDeadlineAt: match.turnDeadlineAt || match.game.turnDeadlineAt || null,
    playerColors: match.playerColors,
    activeColor,
  });
}

function startTurnTimeout(match) {
  if (!match.game || match.game.winner) return;

  if (match.pendingTurnTimer) {
    clearTimeout(match.pendingTurnTimer);
    match.pendingTurnTimer = null;
  }

  const myTurnId = match.turnId;

  match.game.turnDeadlineAt = Date.now() + TURN_MS;
  match.turnDeadlineAt = match.game.turnDeadlineAt;

  broadcastState(match);

  match.pendingTurnTimer = setTimeout(() => {
    const m = matches.get(match.matchId);
    if (!m) return;
    if (m.turnId !== myTurnId) return;
    if (!m.game || m.game.winner) return;
    if (m.game?.transitioning) return;
    nextTurn(m);
  }, TURN_MS);
}

function nextTurn(match) {
  console.log("[NEXT_TURN] start", {
  matchId: match?.matchId,
  turnId: match?.turnId,
  currentTurnBefore: match?.game?.currentTurn,
  currentTurnColorBefore: match?.game ? colorOrder[match.game.currentTurn] : null,
});
  if (!match.game || match.game.winner) return;

  let attempts = 0;
  do {
    match.game.currentTurn = (match.game.currentTurn + 1) % colorOrder.length;
    attempts++;
  } while (attempts < colorOrder.length && match.playerColors[colorOrder[match.game.currentTurn]] == null);

  match.game.dice = 0;
  match.game.dice1 = 0;
  match.game.dice2 = 0;
  match.game.pendingDice = [];
  match.game.rolled = false;
  match.game.turnMoved = false;

  match.turnId = (match.turnId || 0) + 1;
console.log("[NEXT_TURN] after change", {
  matchId: match?.matchId,
  turnId: match?.turnId,
  currentTurnAfter: match?.game?.currentTurn,
  currentTurnColorAfter: match?.game ? colorOrder[match.game.currentTurn] : null,
});
  startTurnTimeout(match);
}

function getNextDiceValueFromMatch() {
  return Math.floor(Math.random() * 6) + 1;
}

async function startMatch(match) {
  if (!match) throw new Error("مسابقه پیدا نشد.");
  if (match.status !== "waiting") return false;

  const activePlayersCount = getActivePlayersCount(match);
  if (activePlayersCount < 2 || activePlayersCount > 4) {
    throw new Error("برای شروع بازی باید بین ۲ تا ۴ بازیکن حضور داشته باشند.");
  }

  match.status = "starting";

  try {
    await chargeTierFromPlayers(match);
    resetMatchGame(match);
    match.status = "playing";

    broadcastState(match);
    startTurnTimeout(match);

    io.to(`match:${match.matchId}`).emit("game:started", {
      success: true,
      message:
        activePlayersCount === 4
          ? "بازی با ۴ بازیکن شروع شد."
          : activePlayersCount === 3
            ? "بازی با ۳ بازیکن شروع شد."
            : "بازی با ۲ بازیکن شروع شد.",
      matchId: match.matchId,
      tier: match.tier,
      filledColors: activePlayersCount,
      status: match.status,
      playerColors: match.playerColors,
    });

    return true;
  } catch (error) {
    match.status = "waiting";
    throw error;
  }
}

// ---------- lobby phase logic ----------
function setLobbyDeadline(lobby, seconds) {
  lobby.timerToken++;
  lobby.lobbyDeadlineAt = Date.now() + seconds * 1000;

  const token = lobby.timerToken;
  if (lobby.lobbyTimer) clearTimeout(lobby.lobbyTimer);

  lobby.lobbyTimer = setTimeout(() => {
    const current = tierLobbies.get(lobby.tier);
    if (!current) return;
    if (current.timerToken !== token) return;
    handleLobbyTimeout(current).catch((e) => console.error("handleLobbyTimeout error:", e));
  }, seconds * 1000);
}

async function handleLobbyTimeout(lobby) {
  const count = lobby.playerUidsInOrder.length;
  if (count === 2) return startMatchFromLobby(lobby, 2);
  if (count === 3) return startMatchFromLobby(lobby, 3);
  if (count >= 4) return startMatchFromLobby(lobby, 4);
}

function getLobbyPhaseFromCount(count) {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return 3;
  return 4;
}

async function onLobbyPlayerJoined(tier) {
  const lobby = tierLobbies.get(tier);
  if (!lobby) return;

  const count = lobby.playerUidsInOrder.length;
  lobby.lobbyPhase = getLobbyPhaseFromCount(count);

  if (count === 2) {
    lobby.status = "lobby";
    lobby.lobbyDeadlineAt = null;
    lobby.lobbyPhase = 2;

    emitLobbyStatus(lobby, {
      phase: 2,
      searchingFor: 3,
      deadlineAt: null,
      message: "در حال جستجوی نفر سوم...",
      status: "SEARCHING_3",
    });

    setLobbyDeadline(lobby, 60);

    emitLobbyStatus(lobby, {
      phase: 2,
      searchingFor: 3,
      deadlineAt: lobby.lobbyDeadlineAt,
      deadlineMs: 60000,
      message: "در حال جستجوی نفر سوم... (۶۰ ثانیه)",
      status: "SEARCHING_3",
    });
    return;
  }

  if (count === 3) {
    lobby.lobbyPhase = 3;
    setLobbyDeadline(lobby, 60);

    emitLobbyStatus(lobby, {
      phase: 3,
      searchingFor: 4,
      deadlineAt: lobby.lobbyDeadlineAt,
      deadlineMs: 60000,
      message: "در حال جستجوی نفر چهارم...",
      status: "SEARCHING_4",
    });
    return;
  }

  if (count >= 4) {
    lobby.lobbyPhase = 4;

    emitLobbyStatus(lobby, {
      phase: 4,
      searchingFor: null,
      deadlineAt: lobby.lobbyDeadlineAt,
      message: "نفر چهارم پیدا شد ✅",
      status: "FULL",
    });

    await startMatchFromLobby(lobby, 4);
  }
}

async function startMatchFromLobby(lobby, filledColors) {
  if (!lobby || lobby.status !== "lobby") return;
  if (![2, 3, 4].includes(filledColors)) return;

  assignColorsToLobbyPlayers(lobby);

  const match = createMatchFromLobby(lobby);
  matches.set(match.matchId, match);

  lobby.status = "matching";
  if (lobby.lobbyTimer) clearTimeout(lobby.lobbyTimer);
  lobby.lobbyTimer = null;

for (const uid of lobby.playerUidsInOrder) {
  const sid = connectedUsers.get(String(uid));
  if (sid) {
    const targetSocket = io.sockets.sockets.get(sid);
    if (targetSocket) await targetSocket.join(`match:${match.matchId}`);
    match.players.set(uid, sid);
  }
}
// بعد از join room ها
  const ok = await startMatch(match);
  if (!ok) {
    lobby.status = "lobby";
    lobby.playerUidsInOrder = [];
    lobby.playerColors = { red: null, green: null, yellow: null, blue: null };
    lobby.lobbyPhase = 1;
    lobby.lobbyDeadlineAt = null;
    stopLobbyTimer(lobby);
  }

  // خود startMatch می‌فرسته game:started و game:state
}

//
// ------------------------------------------------------------
// Socket.IO
// ------------------------------------------------------------
httpServer.on("request", (req) => {
  if (String(req.url || "").includes("/socket.io/")) {
    console.log("[HTTP SOCKET.IO REQUEST]", {
      method: req.method,
      url: req.url,
      origin: req.headers?.origin || null,
      hasAuthorizationHeader: Boolean(req.headers?.authorization),
    });
  }
});

function normalizeSocketToken(value) {
  if (value === undefined || value === null) return "";
  let token = String(value).trim();

  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    try {
      token = JSON.parse(token);
    } catch {
      token = token.slice(1, -1);
    }
  }

  token = String(token || "").trim();
  token = token.replace(/^Bearer\s+/i, "").trim();
  return token;
}

io = new Server(httpServer, {
  cors: {
    origin: allowedOriginsForSocket,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: allowedOriginsForSocket !== "*",
  },
  transports: ["polling", "websocket"],
  allowEIO3: false,
  pingTimeout: 20000,
  pingInterval: 25000,
});

io.use((socket, next) => {
  try {
    let token = normalizeSocketToken(socket.handshake?.auth?.token);
    if (!token) token = normalizeSocketToken(socket.handshake?.headers?.authorization);
    if (!token) token = normalizeSocketToken(socket.handshake?.query?.token);

    const tokenParts = token ? token.split(".") : [];
    if (!token) {
      const error = new Error("توکن Socket.io ارسال نشده است.");
      error.data = { code: "SOCKET_TOKEN_MISSING" };
      return next(error);
    }
    if (tokenParts.length !== 3) {
      const error = new Error("فرمت توکن Socket.io صحیح نیست.");
      error.data = { code: "SOCKET_TOKEN_FORMAT_INVALID" };
      return next(error);
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = Number(decoded?.userId ?? decoded?.id ?? decoded?.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      const error = new Error("شناسه کاربر داخل توکن معتبر نیست.");
      error.data = { code: "SOCKET_USER_ID_INVALID" };
      return next(error);
    }

    socket.user = { ...decoded, userId };
    return next();
  } catch (error) {
    let publicMessage = "توکن Socket.io نامعتبر است.";
    let code = "SOCKET_TOKEN_INVALID";

    if (error?.name === "TokenExpiredError") {
      publicMessage = "توکن Socket.io منقضی شده است.";
      code = "SOCKET_TOKEN_EXPIRED";
    } else if (error?.name === "NotBeforeError") {
      publicMessage = "توکن Socket.io هنوز فعال نشده است.";
      code = "SOCKET_TOKEN_NOT_ACTIVE";
    }

    const socketError = new Error(publicMessage);
    socketError.data = { code, jwtErrorName: error?.name || null };
    return next(socketError);
  }
});

/*
|--------------------------------------------------------------------------
| Lobby join + Game events
|--------------------------------------------------------------------------
*/
io.on("connection", (socket) => {
  const uid = Number(socket.user?.userId);
  if (!Number.isInteger(uid) || uid <= 0) return;

  connectedUsers.set(String(uid), socket.id);

  // Join lobby / match room
  socket.on("room:join", async (payload, callback) => {
    try {
      const tier = Number(payload?.tier);
      if (!Number.isFinite(tier)) {
        return callback?.({ success: false, message: "tier لازم است." });
      }
      assertValidTier(tier);

      const lobby = getTierLobby(tier);

      if (!lobby.playerUidsInOrder.includes(uid)) {
        if (lobby.status !== "lobby") {
          return callback?.({
            success: false,
            message: "این لابی در حال شروع است. لطفاً دوباره تلاش کنید.",
          });
        }
        lobby.playerUidsInOrder.push(uid);
      }

      await socket.join(`match:${lobby.matchId}`);

      const filled = lobby.playerUidsInOrder.length;
      lobby.lobbyPhase = getLobbyPhaseFromCount(filled);

      // آپدیت فاز و تایمر
      await onLobbyPlayerJoined(tier);

      if (filled < 2) {
        emitLobbyStatus(lobby, {
          phase: 1,
          searchingFor: 3,
          deadlineAt: null,
          message: "منتظر نفر دوم...",
          status: "WAIT_2",
        });
        return callback?.({
          success: true,
          waiting: true,
          matchId: lobby.matchId,
          tier,
          filledColors: filled,
          status: "waiting",
          startAfterMs: null,
        });
      }

      if (filled === 2) {
        return callback?.({
          success: true,
          waiting: true,
          matchId: lobby.matchId,
          tier,
          filledColors: 2,
          status: "SEARCHING_3",
          startAfterMs: 60000,
        });
      }

      if (filled === 3) {
        return callback?.({
          success: true,
          waiting: true,
          matchId: lobby.matchId,
          tier,
          filledColors: 3,
          status: "SEARCHING_4",
          startAfterMs: 60000,
        });
      }

      return callback?.({
        success: true,
        waiting: false,
        matchId: lobby.matchId,
        tier,
        filledColors: 4,
        status: "FULL",
      });
    } catch (e) {
      return callback?.({ success: false, message: e?.message || "خطای join" });
    }
  });

  socket.on("disconnect", () => {
    try {
      for (const [tier, lobby] of tierLobbies.entries()) {
        if (!lobby) continue;

        const idx = lobby.playerUidsInOrder.indexOf(uid);
        if (idx !== -1 && lobby.status === "lobby") {
          lobby.playerUidsInOrder.splice(idx, 1);

          stopLobbyTimer(lobby);

          if (lobby.playerUidsInOrder.length < 2) {
            lobby.lobbyPhase = 1;
            emitLobbyStatus(lobby, {
              phase: 1,
              searchingFor: 3,
              deadlineAt: null,
              deadlineMs: null,
              message: "منتظر نفر دوم...",
              status: "WAIT_2",
            });
          } else if (lobby.playerUidsInOrder.length === 2) {
            onLobbyPlayerJoined(tier).catch(() => {});
          } else if (lobby.playerUidsInOrder.length === 3) {
            onLobbyPlayerJoined(tier).catch(() => {});
          }
        }
      }

      if (connectedUsers.get(String(uid)) === socket.id) {
        connectedUsers.delete(String(uid));
      }
    } catch (error) {
      console.error("[DISCONNECT ERROR]", error);
    }
  });

  // ---------------- Game: roll ----------------
  socket.on("game:roll", (payload, callback) => {
    try {
      const matchId = String(payload?.matchId ?? "");
      const m = matches.get(matchId);
      if (!m || !m.game || !m.playerColors) {
        return callback?.({ success: false, message: "match پیدا نشد." });
      }
if (m.game.transitioning) {
  return callback?.({ success: false, message: "نوبت در حال پردازش است. لطفاً صبر کنید." });
}
m.game.transitioning = true;

      const userId = Number(socket.user?.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return callback?.({ success: false, message: "userId نامعتبر است." });
      }

      const currentColor = colorOrder[m.game.currentTurn];
      const expectedUserId = m.playerColors[currentColor];
      if (expectedUserId == null || expectedUserId !== userId) {
        m.game.transitioning = false;
        return callback?.({ success: false, message: "الان نوبت شما نیست." });
      }

if (m.game.winner) {
  m.game.transitioning = false;
  return callback?.({ success: false, message: "بازی تمام شده است." });
}

if (!m.game.turnDeadlineAt || Date.now() > m.game.turnDeadlineAt) {
  m.game.transitioning = false;
  return callback?.({ success: false, message: "نوبت منقضی شده یا هنوز شروع نشده است." });
}

if (m.game.rolled) {
  m.game.transitioning = false;
  return callback?.({ success: false, message: "قبلاً تاس ریختی." });
}

      const d1 = getNextDiceValueFromMatch();
      const d2 = getNextDiceValueFromMatch();

      m.game.dice1 = d1;
      m.game.dice2 = d2;
      m.game.dice = d1 + d2;
      console.log("[ROLL_RESULT]", {
  matchId: m.matchId,
  currentTurn: m.game.currentTurn,
  activeColor: colorOrder[m.game.currentTurn],
  dice1: d1,
  dice2: d2,
  diceSum: d1 + d2,
});

      const isBonusSix = d1 === 6 && d2 === 6;

      if (isBonusSix) {
        // ✅ bonus: نوبت عوض نشه، رول مجدد مجاز باشه
        m.game.dice1 = 6;
        m.game.dice2 = 6;
        m.game.dice = 12;

        m.game.pendingDice = []; // چون حرکت نمی‌خوایم اینجا انجام بدیم
        m.game.rolled = false;    // اجازه roll دوباره
        m.game.turnMoved = false;

        // deadline رو تمدید کن تا کاربر فرصت کلیک roll داشته باشه
        m.game.turnDeadlineAt = Date.now() + TURN_MS;
        m.turnDeadlineAt = m.game.turnDeadlineAt;
console.log("[BONUS_6]", {
  matchId: m.matchId,
  activeColor: colorOrder[m.game.currentTurn],
  dice1: m.game.dice1,
  dice2: m.game.dice2,
  diceSum: m.game.dice,
  pendingDice: m.game.pendingDice,
});
        broadcastState(m);
m.game.transitioning = false;
        return callback?.({
          success: true,
          dice1: 6,
          dice2: 6,
          bonusRoll: true,
          pendingDice: [],
          noLegalMoves: false,
          turnSkipped: false,
          winnerColor: null,
        });
      }

      // حالت عادی/اسکیپ:
      m.game.pendingDice = [d1, d2];
      m.game.rolled = true;
      m.game.turnMoved = false;

      const canMove1 = hasLegalMoveForDie(m.game, d1);
      const canMove2 = hasLegalMoveForDie(m.game, d2);
      const noLegalMoves = !canMove1 && !canMove2;

      if (noLegalMoves) {
        m.game.transitioning = false;
        // ✅ skip: نوبت عوض میشه
        const myTurnId = m.turnId;

        m.game.pendingDice = [];
        m.game.dice1 = 0;
        m.game.dice2 = 0;
        m.game.dice = 0;


        m.game.turnMoved = true;
console.log("[NO_MOVES] before broadcastState", {
  matchId,
  myTurnId,
  currentTurn: m.game.currentTurn,
  currentTurnColor: colorOrder[m.game.currentTurn],
  rolled: m.game.rolled,
  pendingDice: m.game.pendingDice
});
        broadcastState(m);

const mm = matches.get(matchId);
if (mm && mm.turnId === myTurnId) {
  nextTurn(mm);
}
console.log("[NO_MOVES] callback return", {
  matchId,
  turnSkipped: true,
  dice: { d1, d2 },
  time: Date.now(),
});
        return callback?.({
          success: true,
          dice1: d1,
          dice2: d2,
          noLegalMoves: true,
          turnSkipped: true,
          bonusRoll: false,
          pendingDice: [],
        });
      }

      broadcastState(m);

      return callback?.({
        success: true,
        dice1: d1,
        dice2: d2,
        bonusRoll: false,
        noLegalMoves: false,
        turnSkipped: false,
        pendingDice: m.game.pendingDice.slice(),
        winnerColor: null,
      });
} catch (e) {
  if (m?.game) m.game.transitioning = false;
  return callback?.({ success: false, message: e?.message || "roll error" });
}
  });

  // ---------------- Game: move ----------------
  socket.on("game:move", (payload, callback) => {
    let m;
    try {
      const matchId = String(payload?.matchId ?? "");
      const pieceId = String(payload?.pieceId ?? "");
      const dieValue = Number(payload?.dieValue);
const dieIndex = Number(payload?.dieIndex);
console.log("[MOVE_REQ]", {
  matchId,
  pieceId,
  dieValue,
  dieIndex,
  turnId: payload?.turnId,
  serverTurnId: matches.get(matchId)?.turnId,
  pendingDice: matches.get(matchId)?.game?.pendingDice
});

if (!Number.isInteger(dieIndex) || (dieIndex !== 0 && dieIndex !== 1)) {
  return callback?.({ success: false, message: "dieIndex نامعتبر است." });
}
      const m = matches.get(matchId);
      if (!m || !m.game) return callback?.({ success: false, message: "match پیدا نشد." });
      const moveTurnId = Number(payload?.turnId);
if (!Number.isInteger(moveTurnId) || moveTurnId !== m.turnId) {
  console.log("[MOVE_REJECT] turnId mismatch", { moveTurnId, serverTurnId: m.turnId });
  return callback?.({
    success: false,
    message: "این حرکت مربوط به نوبت قدیمی است. دوباره state را بگیر و حرکت کن.",
  });
}
if (m.game.transitioning) {
  console.log("[MOVE_REJECT] transitioning=true", { matchId });
  return callback?.({
    success: false,
    message: "نوبت در حال پردازش است. لطفاً صبر کنید."
  });
}

m.game.transitioning = true;
      const userId = Number(socket.user?.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return callback?.({ success: false, message: "userId نامعتبر است." });
      }

      const currentColor = colorOrder[m.game.currentTurn];
      const expectedUserId = m.playerColors[currentColor];
if (expectedUserId == null || expectedUserId !== userId) {
  console.log("[MOVE_REJECT] wrong turn user", {
    matchId,
    userId,
    expectedUserId,
    currentColor,
    currentTurn: m.game.currentTurn
  });

  return callback?.({
    success: false,
    message: "الان نوبت شما نیست."
  });
}


      if (m.game.winner) return callback?.({ success: false, message: "بازی تمام شده است." });

if (
  !m.game.rolled ||
  !Array.isArray(m.game.pendingDice) ||
  m.game.pendingDice.length === 0
) {
  console.log("[MOVE_REJECT] not rolled or empty pendingDice", {
    matchId,
    rolled: m.game.rolled,
    pendingDice: m.game.pendingDice
  });

  return callback?.({
    success: false,
    message: "اول باید تاس ریخته شود."
  });
}


      if (!Number.isFinite(dieValue) || dieValue < 1 || dieValue > 6) {
        return callback?.({ success: false, message: "dieValue نامعتبر است." });
      }

const pending = m.game.pendingDice;
if (!Array.isArray(pending) || pending.length <= dieIndex) {
  return callback?.({ success: false, message: "pendingDice نامعتبر است." });
}
const expectedDieValue = Number(pending[dieIndex]);
if (expectedDieValue !== dieValue) {
  console.log("[MOVE_REJECT] die mismatch", {
    matchId,
    dieValue,
    expectedDieValue,
    dieIndex,
    pendingDice: pending
  });

  return callback?.({
    success: false,
    message: "dieValue با dieIndex هم‌خوانی ندارد."
  });
}


      const piece = m.game.pieces.find((p) => p.id === pieceId);
if (!piece) {
  console.log("[MOVE_REJECT] piece not found", { matchId, pieceId });
  return callback?.({ success: false, message: "piece پیدا نشد." });
}

if (!canPieceMove(m.game, piece, dieValue)) {
  console.log("[MOVE_REJECT] canPieceMove=false", {
    matchId,
    pieceId,
    dieValue,
    piece
  });

  return callback?.({ success: false, message: "حرکت مجاز نیست." });
}


      movePiece(m.game, piece, dieValue);

// ✅ کد اصلاح‌شده سرور: حذف تاس بازی شده و بازسازی متغیرهای کمکی بر اساس آرایه واقعی
if (Array.isArray(m.game.pendingDice)) {
  m.game.pendingDice.splice(dieIndex, 1);
} else {
  m.game.pendingDice = [];
}

// مقداردهی مجدد dice1 و dice2 بر اساس اعضای باقی‌مانده آرایه
m.game.dice1 = m.game.pendingDice[0] ? Number(m.game.pendingDice[0]) : 0;
m.game.dice2 = m.game.pendingDice[1] ? Number(m.game.pendingDice[1]) : 0;
m.game.dice = m.game.dice1 + m.game.dice2;

console.log("[MOVE_AFTER_CONSUME]", {
  matchId,
  pendingDice: m.game.pendingDice,
  dice1: m.game.dice1,
  dice2: m.game.dice2,
  diceSum: m.game.dice
});
      const winnerColor = checkWinner(m.game);
      m.game.winner = winnerColor || null;

      if (m.game.winner) {
        broadcastState(m);
        settleCoinsForMatch(m).catch((e) => console.error("settle error:", e));

        return callback?.({
          success: true,
          winnerColor: m.game.winner,
          bonusRoll: false,
          pendingDice: m.game.pendingDice,
        });
      }

      // اگر هنوز تاس باقیه => ادامه نوبت
if (m.game.pendingDice.length > 0) {
  m.game.turnMoved = true;
  broadcastState(m);

  m.game.transitioning = false; // ✅ این خط را قبل از return بذار

  return callback?.({
    success: true,
    bonusRoll: false,
    pendingDice: m.game.pendingDice.slice(),
    turnSkipped: false,
    winnerColor: null,
  });
}

// اگر تاس تموم شد => نوبت بعد
m.game.turnMoved = true;
m.game.rolled = false;
m.game.pendingDice = [];

broadcastState(m);
nextTurn(m);

// مهم: transitioning را بعد از تغییر نوبت و قبل از برگشت به کلاینت آزاد کن
m.game.transitioning = false;

return callback?.({
  success: true,
  bonusRoll: false,
  pendingDice: [],
  turnSkipped: false,
  winnerColor: null,
});
} catch (e) {
    return callback?.({ success: false, message: e?.message || "move error" });
  } finally {
    if (m?.game) m.game.transitioning = false;
  }
});
});

// Start
httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
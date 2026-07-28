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

const START_COINS = Number(process.env.START_COINS) || 1000;
const TURN_MS = 30000;

// --------- تایمرهای match (برای cancel/race-proof)
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
| Login route
|--------------------------------------------------------------------------
*/
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  console.log(`Attempting login for username: ${username}`);
  try {
    const user = await prisma.user.findUnique({
      where: { username: username },
    });

    if (user) {
      console.log(`User found: ${user.username}`);
      const isMatch = await bcrypt.compare(password, user.password);
      console.log(`Password comparison result: ${isMatch}`);

      if (isMatch) {
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
        console.log("Login successful, token generated.");
        return res.json({ token });
      } else {
        console.log("Login failed: Invalid password");
        return res.status(401).json({ message: "Invalid credentials" });
      }
    } else {
      console.log("Login failed: User not found");
      return res.status(401).json({ message: "Invalid credentials" });
    }
  } catch (error) {
    console.error("Error during login:", error);
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
| Game engine (همان کد خودت)
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

  if (piece.state === "yard") return dieValue === 6;

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

function hasAnyLegalPendingMove(game) {
  const pendingDice = Array.isArray(game?.pendingDice) ? game.pendingDice : [];
  return pendingDice.some((dieValue) => hasLegalMoveForDie(game, dieValue));
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
| Rooms & match (tier-separated, queue-of-4)
|--------------------------------------------------------------------------
*/

const matches = new Map(); // matchId -> match

function makeMatchId(tier) {
  return `m:${tier}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
}

// صف واقعی: هر tier یک آرایه از userIdها
const tierQueues = new Map(); // tier -> Array<uid>
const userTierQueue = new Map(); // uid -> tier (برای اینکه دوباره داخل صف نرود)

function getTierQueue(tier) {
  if (!tierQueues.has(tier)) tierQueues.set(tier, []);
  return tierQueues.get(tier);
}

function createMatch(matchId, tier) {
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
    tier: tier ?? null,
    financialSettled: false,
    chargedEntry: false,
  };
}

function getActivePlayersCount(match) {
  return colorOrder.filter((c) => match.playerColors[c] != null).length;
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
    playerColors: {
      red: match.playerColors.red,
      green: match.playerColors.green,
      yellow: match.playerColors.yellow,
      blue: match.playerColors.blue,
    },
  };

  match.turnDeadlineAt = null;
  match.turnId = (match.turnId || 0) + 1;
}

let io; // set later

function broadcastState(match) {
  if (!match.game) return;

  const activeColor = colorOrder[match.game.currentTurn];

  const snapshot = {
    ...cloneGameForClient(match.game),
    matchId: match.matchId,
    status: match.status,
    tier: match.tier,
    turnDeadlineAt: match.turnDeadlineAt || match.game.turnDeadlineAt || null,
    playerColors: match.playerColors,
    activeColor,
  };

  io.to(`match:${match.matchId}`).emit("game:state", snapshot);
}

function nextTurn(match) {
  if (!match.game || match.game.winner) return;

  let attempts = 0;
  do {
    match.game.currentTurn = (match.game.currentTurn + 1) % colorOrder.length;
    attempts++;
  } while (
    attempts < colorOrder.length &&
    match.playerColors[colorOrder[match.game.currentTurn]] == null
  );

  const nextColor = colorOrder[match.game.currentTurn];
  const nextPlayerId = match.playerColors[nextColor];
  if (nextPlayerId == null) return;

  match.game.dice = 0;
  match.game.dice1 = 0;
  match.game.dice2 = 0;
  match.game.pendingDice = [];
  match.game.rolled = false;
  match.game.turnMoved = false;

  match.turnId = (match.turnId || 0) + 1;

  startTurnTimeout(match);
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

    nextTurn(m);
  }, TURN_MS);
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

    if (matchTimers.has(match.matchId)) {
      clearTimeout(matchTimers.get(match.matchId).timeout);
      matchTimers.delete(match.matchId);
    }

    broadcastState(match);
    startTurnTimeout(match);

    io.to(`match:${match.matchId}`).emit("game:started", {
      success: true,
      message: activePlayersCount === 4
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

/*
|--------------------------------------------------------------------------
| Admin updates & treasury (همان منطق خودت)
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
    return res.status(500).json({ success: false, message: "خطای سرور: " + error.message });
  }
});

app.get("/admin/user-balance/:username", authenticateAdminSecret, async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

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
    return safeJsonError(res, 500, error?.message || "خطای داخلی سرور");
  }
});

function emitBalanceChanged(userId, newCoins, message) {
  const socketId = connectedUsers.get(String(userId));
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

  const userIds = colorOrder
    .map((color) => match.playerColors[color])
    .filter((userId) => userId != null);

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

  const activePlayersCount = getActivePlayersCount(match);
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

/*
|--------------------------------------------------------------------------
| Socket.IO
|--------------------------------------------------------------------------
*/
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

const allowedOriginsForSocket =
  allowedOrigins === "*" ? "*" : allowedOrigins;

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

io.on("connection", (socket) => {
  const uid = Number(socket.user?.userId);
  if (!Number.isInteger(uid)) return;

  connectedUsers.set(String(uid), socket.id);

  // ---------------------------
  // room:join (فقط tier می‌خواهیم)
  // ---------------------------
  socket.on("room:join", async (payload, callback) => {
    try {
      const tier = Number(payload?.tier);
      if (!Number.isFinite(tier)) {
        return callback?.({ success: false, message: "tier لازم است." });
      }
      assertValidTier(tier);

      // جلوگیری از ورود دوباره به صف
      if (userTierQueue.has(uid)) {
        const existingTier = userTierQueue.get(uid);
        if (existingTier === tier) {
          return callback?.({
            success: true,
            waiting: true,
            matchId: null,
            tier,
            message: "شما قبلاً در صف همین tier هستید.",
          });
        }
        return callback?.({
          success: false,
          message: `شما الان داخل صف tier=${existingTier} هستید.`,
        });
      }

      // وارد صف شو
      userTierQueue.set(uid, tier);
      const q = getTierQueue(tier);

      // جلوگیری از تکرار uid داخل queue
      if (!q.includes(uid)) q.push(uid);

      const filled = q.length;

      // به همه نفرات حاضر در همان صف (اختیاری: برای خبر دادن تعداد)
      // چون هنوز match ساخته نشده، فقط به همان socketها خبر می‌دهیم.
      if (filled >= 2 && filled <= 4) {
        // ساده: فقط تعداد را به همین socket خود کاربر می‌فرستیم
        // (برای اینکه همه socketها رو ذخیره نکردیم)
      }

      // اگر 4 نفر شد => یک match بساز
      if (q.length >= 4) {
        // dequeue دقیقاً 4 نفر
        const players = q.splice(0, 4);

        // مطمئن شو این 4 نفر هنوز در صف هستند
        for (const pUid of players) userTierQueue.delete(pUid);

        const matchId = makeMatchId(tier);
        const match = createMatch(matchId, tier);
        matches.set(matchId, match);

        // رنگ‌دهی طبق ترتیب ثابت
        // players: [uid0, uid1, uid2, uid3] => red, green, yellow, blue
        const colors = ["red", "green", "yellow", "blue"];
        for (let i = 0; i < players.length; i++) {
          match.playerColors[colors[i]] = players[i];
          // join هر 4 نفر به room match
          const sid = connectedUsers.get(String(players[i]));
          if (sid) {
            // join socket room باید توسط همان socket انجام شود، اما
            // چون اینجا در handler یک socket هستیم، نمی‌تونیم مستقیم join کنیم مگر io.sockets.sockets را داشته باشیم.
            // پس بهتر: از socket موجود برای خود uid join می‌کنیم،
            // و برای بقیه: هنگام دریافت callback همون لحظه join می‌شوند؟ نه.
          }
        }

        // برای اینکه room match درست جا بیفتد:
        // از طریق io.sockets.sockets به socketهای همان uidها دسترسی می‌گیریم.
        for (const pUid of players) {
          const sid = connectedUsers.get(String(pUid));
          const targetSocket = sid ? io.sockets.sockets.get(sid) : null;
          if (targetSocket) {
            await targetSocket.join(`match:${matchId}`);
            match.players.set(pUid, sid);
          }
        }

        // شروع بازی
        const startedOk = await startMatch(match);

        if (!startedOk) {
          // اگر شروع ناموفق شد، دوباره 4 نفر را به صف برمی‌گردانیم
          for (const pUid of players) {
            if (!userTierQueue.has(pUid)) {
              userTierQueue.set(pUid, tier);
              q.push(pUid);
            }
          }
          return callback?.({ success: false, message: "شروع بازی ناموفق بود." });
        }

        // به هر 4 نفر callback بده:
        // چون callback فقط برای همین socket است، برای سایرین باید emit کنیم.
        io.to(`match:${matchId}`).emit("match:playerCountUpdated", {
          success: true,
          matchId,
          tier,
          filledColors: 4,
          event: "FOURTH_JOINED",
          playerColors: match.playerColors,
        });

        // این socket هم پاسخ خودشو بگیره:
        return callback?.({
          success: true,
          message: "بازی با ۴ بازیکن شروع شد.",
          matchId,
          tier,
          filledColors: 4,
          status: "playing",
          playerColors: match.playerColors,
        });
      }

      // اگر کمتر از 4 نفر است
      return callback?.({
        success: true,
        waiting: true,
        matchId: null,
        tier,
        filledColors: filled,
        status: "waiting",
        message: "در صف منتظر نفرات بیشتر هستید.",
        startAfterMs: 60000, // همون مقدار UI می‌تونه استفاده کنه
      });
    } catch (e) {
      return callback?.({ success: false, message: e?.message || "خطای join" });
    }
  });

  // ---------------------------
  // game:roll
  // ---------------------------
  socket.on("game:roll", async (payload, callback) => {
    try {
      const matchId = payload?.matchId;
      if (!matchId || !matches.has(String(matchId))) {
        return callback?.({ success: false, message: "match پیدا نشد." });
      }

      const match = matches.get(String(matchId));
      if (!match.game || match.status !== "playing") {
        return callback?.({ success: false, message: "بازی هنوز شروع نشده است." });
      }
      if (match.game.winner) return callback?.({ success: false, message: "بازی تمام شده است." });

      const uid2 = Number(socket.user.userId);
      const turnColor = colorOrder[match.game.currentTurn];

      if (match.playerColors[turnColor] !== uid2) {
        return callback?.({ success: false, message: "نوبت شما نیست." });
      }

      if (match.game.rolled) return callback?.({ success: false, message: "قبلاً رول شده است." });
      if (Date.now() > match.game.turnDeadlineAt) return callback?.({ success: false, message: "زمان نوبت گذشته." });

      const dice1 = getNextDiceValueFromMatch();
      const dice2 = getNextDiceValueFromMatch();

      match.game.dice = 0;
      match.game.dice1 = dice1;
      match.game.dice2 = dice2;
      match.game.pendingDice = [dice1, dice2];
      match.game.rolled = true;
      match.game.turnMoved = false;

      if (!hasAnyLegalPendingMove(match.game)) {
        nextTurn(match);
        return callback?.({ success: true, dice1, dice2, pendingDice: [], noLegalMoves: true, turnSkipped: true });
      }

      broadcastState(match);
      startTurnTimeout(match);

      return callback?.({
        success: true,
        dice1,
        dice2,
        pendingDice: match.game.pendingDice,
        noLegalMoves: false,
        turnSkipped: false,
      });
    } catch (e) {
      return callback?.({ success: false, message: e?.message || "خطای roll" });
    }
  });

  // ---------------------------
  // game:move
  // ---------------------------
  socket.on("game:move", async (payload, callback) => {
    try {
      const matchId = payload?.matchId;
      const pieceId = payload?.pieceId;
      const dieValue = Number(payload?.dieValue);

      if (!matchId || !matches.has(String(matchId))) {
        return callback?.({ success: false, message: "match پیدا نشد." });
      }
      if (pieceId === undefined || pieceId === null) {
        return callback?.({ success: false, message: "pieceId لازم است." });
      }
      if (!Number.isFinite(dieValue) || dieValue < 1 || dieValue > 6) {
        return callback?.({ success: false, message: "dieValue باید 1 تا 6 باشد." });
      }

      const match = matches.get(String(matchId));

      if (!match.game || match.status !== "playing") {
        return callback?.({ success: false, message: "بازی هنوز شروع نشده است." });
      }
      if (match.game.winner) return callback?.({ success: false, message: "بازی تمام شده است." });

      if (!match.game.rolled) return callback?.({ success: false, message: "اول رول کنید." });
      if (Date.now() > match.game.turnDeadlineAt) return callback?.({ success: false, message: "زمان نوبت گذشته." });

      const uid2 = Number(socket.user.userId);
      const turnColor = colorOrder[match.game.currentTurn];

      if (match.playerColors[turnColor] !== uid2) {
        return callback?.({ success: false, message: "نوبت شما نیست." });
      }

      const pending = Array.isArray(match.game.pendingDice) ? match.game.pendingDice : [];
      const idx = pending.findIndex((d) => d === dieValue);
      if (idx === -1) {
        return callback?.({ success: false, message: "این تاس برای این نوبت شما باقی نمانده است." });
      }

      const piece = match.game.pieces.find((p) => p.id === pieceId);
      if (!piece) return callback?.({ success: false, message: "مهره پیدا نشد." });

      const movable = canPieceMove(match.game, piece, dieValue);
      if (!movable) return callback?.({ success: false, message: "حرکت مجاز نیست." });

      const moved = movePiece(match.game, piece, dieValue);
      if (!moved) return callback?.({ success: false, message: "حرکت انجام نشد." });

      match.game.pendingDice.splice(idx, 1);

      const winnerColor = checkWinner(match.game);
      if (winnerColor) {
        match.game.winner = winnerColor;
        match.status = "finished";
        match.turnDeadlineAt = Date.now();
        match.game.turnDeadlineAt = Date.now();

        if (match.pendingTurnTimer) {
          clearTimeout(match.pendingTurnTimer);
          match.pendingTurnTimer = null;
        }

        broadcastState(match);

        try {
          await settleCoinsForMatch(match);
        } catch (error) {
          console.error("settleCoinsForMatch failed:", error);
        }

        return callback?.({ success: true, moved: true, winnerColor });
      }

      if (match.game.pendingDice.length > 0) {
        match.game.turnMoved = true;

        if (!hasAnyLegalPendingMove(match.game)) {
          nextTurn(match);
          return callback?.({
            success: true,
            moved: true,
            consumedDie: dieValue,
            pendingDice: [],
            noLegalMoves: true,
            turnSkipped: true,
            moreMovesAllowed: false,
          });
        }

        broadcastState(match);

        return callback?.({
          success: true,
          moved: true,
          consumedDie: dieValue,
          pendingDice: match.game.pendingDice,
          moreMovesAllowed: true,
        });
      }

      const isDoubleSix = match.game.dice1 === 6 && match.game.dice2 === 6;
      if (isDoubleSix) {
        match.game.dice = 0;
        match.game.dice1 = 0;
        match.game.dice2 = 0;
        match.game.pendingDice = [];
        match.game.rolled = false;
        match.game.turnMoved = false;

        match.game.turnDeadlineAt = Date.now() + TURN_MS;
        match.turnDeadlineAt = match.game.turnDeadlineAt;
        match.turnId = (match.turnId || 0) + 1;

        broadcastState(match);
        startTurnTimeout(match);

        return callback?.({ success: true, moved: true, consumedDie: dieValue, bonusRoll: true });
      }

      nextTurn(match);
      return callback?.({ success: true, moved: true, consumedDie: dieValue, bonusRoll: false });
    } catch (error) {
      console.error("[GAME MOVE ERROR]", error);
      return callback?.({ success: false, message: error?.message || "خطای move" });
    }
  });

  // ---------------------------
  // disconnect
  // ---------------------------
  socket.on("disconnect", (reason) => {
    try {
      const uid2 = Number(socket.user?.userId);
      if (!Number.isInteger(uid2) || uid2 <= 0) return;

      const key = String(uid2);
      if (connectedUsers.get(key) === socket.id) connectedUsers.delete(key);

      // اگر در صف بود، از صف حذفش کن
      if (userTierQueue.has(uid2)) {
        const tier = userTierQueue.get(uid2);
        userTierQueue.delete(uid2);
        const q = getTierQueue(tier);
        const idx = q.indexOf(uid2);
        if (idx !== -1) q.splice(idx, 1);
      }

      // حذف از matchهای waiting (اگر هنوز بازی شروع نشده)
      for (const [matchId, match] of matches.entries()) {
        if (match.status !== "waiting") continue;

        const disconnectedColor = colorOrder.find((c) => match.playerColors[c] === uid2);
        if (!disconnectedColor) continue;

        match.playerColors[disconnectedColor] = null;
        match.players.delete(uid2);

        // اگر 0 بازیکن شد، match را پاک کن
        const filledColors = colorOrder.filter((c) => match.playerColors[c] != null).length;
        if (filledColors === 0) {
          matches.delete(matchId);
        }
      }
    } catch (error) {
      console.error("[DISCONNECT ERROR]", { socketId: socket.id, error: error?.message || String(error) });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});
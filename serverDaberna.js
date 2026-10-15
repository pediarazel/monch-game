/**
 * Daberna (Bingo) Game Server - Port 3003
 * Strictly atomic Prisma wallet integration (Shared with Ludo & 21)
 * No plain text credentials, numeric JWT authentication
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const path = require('path');

dotenv.config();

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: true
});

const prisma = new PrismaClient({ adapter });

const app = express();
const server = http.createServer(app);

const PORT = process.env.DABERNA_PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'your-fallback-jwt-secret';

// Schema auto-adaptation settings
const USER_MODEL = process.env.DABERNA_USER_MODEL || 'user';
const USER_ID_FIELD = process.env.DABERNA_USER_ID_FIELD || 'id';
const BALANCE_FIELD = "coins";
const io = new Server(server, {
  path: '/daberna/socket.io',
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use('/anna', express.static(path.join(__dirname, 'anna')));
app.use(express.static(path.join(__dirname, 'anna')));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));

// دریافت تاریخچه برد و باخت دبرنا
app.get('/daberna/history', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'توکن نامعتبر است' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = Number(decoded.userId || decoded.id || decoded.sub);

    if (!Number.isFinite(userId)) return res.status(400).json({ error: 'کاربر نامعتبر' });

    const history = await prisma.transaction.findMany({
      where: {
        userId,
        type: { in: ['DABERNA_WIN', 'DABERNA_LOSS'] }
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ error: 'خطا در دریافت تاریخچه' });
  }
});

async function createTx({ userId, matchId, amount, type, note }) {
  const numericId = Number(userId);
  if (!Number.isFinite(numericId)) return null;
  try {
    return await prisma.transaction.create({
      data: {
        userId: numericId,
        matchId: matchId ? String(matchId) : null,
        amount: Number(amount) || 0,
        type: String(type),
        note: note ? String(note) : null
      }
    });
  } catch (e) {
    console.error('[Daberna TX Error]', e);
    return null;
  }
}

// ----------------------------------------------------
// ATOMIC WALLET ADAPTER (Shared with 21 & Ludo)
// ----------------------------------------------------
async function getUserRecord(userId) {
  const model = prisma[USER_MODEL] || prisma[USER_MODEL.charAt(0).toUpperCase() + USER_MODEL.slice(1)];
  if (!model) throw new Error(`Prisma model '${USER_MODEL}' not found`);

  return await model.findUnique({
    where: { [USER_ID_FIELD]: Number(userId) }
  });
}

async function atomicDeductBalance(userId, amount) {
  const model = prisma[USER_MODEL] || prisma[USER_MODEL.charAt(0).toUpperCase() + USER_MODEL.slice(1)];
  const numericId = Number(userId);
  const cost = Number(amount);

  return await prisma.$transaction(async (tx) => {
    const user = await tx[model.name].findUnique({
      where: { [USER_ID_FIELD]: numericId }
    });

    if (!user) throw new Error('User not found');
    const currentBalance = Number(user[BALANCE_FIELD]);
    if (currentBalance < cost) throw new Error('موجودی حساب کافی نیست');

    const updated = await tx[model.name].update({
      where: { [USER_ID_FIELD]: numericId },
      data: {
        [BALANCE_FIELD]: { decrement: cost }
      }
    });

    return Number(updated[BALANCE_FIELD]);
  });
}

async function atomicAddBalance(userId, amount) {
  const model = prisma[USER_MODEL] || prisma[USER_MODEL.charAt(0).toUpperCase() + USER_MODEL.slice(1)];
  const numericId = Number(userId);
  const reward = Number(amount);

  const updated = await model.update({
    where: { [USER_ID_FIELD]: numericId },
    data: {
      [BALANCE_FIELD]: { increment: reward }
    }
  });

  return Number(updated[BALANCE_FIELD]);
}

// ----------------------------------------------------
// BINGO CARD GENERATION (Official 3x9 Matrix)
// ----------------------------------------------------
function generateDabernaCard(cardId) {
  const grid = Array.from({ length: 3 }, () => Array(9).fill(null));
  const colRanges = [
    [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
    [50, 59], [60, 69], [70, 79], [80, 90]
  ];

  // انتخاب ۳ سطر با ۵ عدد در هر سطر
  for (let r = 0; r < 3; r++) {
    const chosenCols = [];
    while (chosenCols.length < 5) {
      const c = Math.floor(Math.random() * 9);
      if (!chosenCols.includes(c) && grid[r][c] === null) {
        chosenCols.push(c);
      }
    }

    chosenCols.forEach(col => {
      const [min, max] = colRanges[col];
      let num;
      let existingInCol = [grid[0][col], grid[1][col], grid[2][col]].filter(x => x !== null);
      do {
        num = Math.floor(Math.random() * (max - min + 1)) + min;
      } while (existingInCol.includes(num));
      grid[r][col] = num;
    });
  }

  // مرتب‌سازی عمودی هر ستون
  for (let c = 0; c < 9; c++) {
    const colNums = [grid[0][c], grid[1][c], grid[2][c]].filter(x => x !== null).sort((a, b) => a - b);
    let idx = 0;
    for (let r = 0; r < 3; r++) {
      if (grid[r][c] !== null) {
        grid[r][c] = colNums[idx++];
      }
    }
  }

  return { id: cardId, grid };
}

// ----------------------------------------------------
// ROOM ENGINE
// ----------------------------------------------------
const ROOM_TIERS = {
  '5': { price: 5000, name: '۵ هزار تومانی' },
  '10': { price: 10000, name: '۱۰ هزار تومانی' },
  '20': { price: 20000, name: '۲۰ هزار تومانی' },
  '50': { price: 50000, name: '۵۰ هزار تومانی' },
  '100': { price: 100000, name: '۱۰۰ هزار تومانی' }
};

async function ensureTreasuryUser() {
  const model = prisma[USER_MODEL] || prisma[USER_MODEL.charAt(0).toUpperCase() + USER_MODEL.slice(1)];
  return model.upsert({
    where: { username: "treasury" },
    update: {},
    create: { username: "treasury", password: "passwordHash", coins: 0, role: "TREASURY" }
  });
}


class DabernaRoom {
  constructor(roomId, tierConfig) {
    this.id = roomId;
    this.pricePerCard = tierConfig.price;
    this.name = tierConfig.name;
    this.code = 'BG-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    this.status = 'WAITING'; // WAITING, COUNTDOWN, PLAYING, ENDED
    this.players = new Map(); // userId -> { socketId, username, cards: [], cardCount: 0 }
    this.timer = 150;
    this.countdown = 10;
    this.drawnNumbers = [];
    this.drawPool = Array.from({ length: 90 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    this.loopInterval = null;
    this.drawInterval = null;
    this.loopInterval = null;
    this.drawInterval = null;
    this.retryCount = 1;

  }

  getTotalActiveCards() {
    let total = 0;
    for (const p of this.players.values()) total += p.cards.length;
    return total;
  }

  broadcastState() {
    const totalPrizePool = this.getTotalActiveCards() * this.pricePerCard;
    const houseFee = Math.floor(totalPrizePool * 0.10);
    const winAmount = totalPrizePool - houseFee;

    for (const [uid, player] of this.players.entries()) {
      if (!player.socketId) continue;

      const opponentCards = [];
      for (const [otherUid, otherPlayer] of this.players.entries()) {
        if (Number(otherUid) !== Number(uid) && otherPlayer.cards) {
          otherPlayer.cards.forEach((card, idx) => {
            opponentCards.push({
              username: otherPlayer.username,
              cardIndex: idx + 1,
              grid: card.grid
            });
          });
        }
      }

      io.to(player.socketId).emit('roomState', {
      roomId: String(this.id),
      code: this.code,
        status: this.status,
        timer: this.timer,
        onlineCount: this.players.size,
        totalActiveCards: this.getTotalActiveCards(),
        prizePool: winAmount,
        myCards: player.cards.length,
        myCardsData: player.cards,
        opponentCards: opponentCards,
        drawnNumbers: this.drawnNumbers,
        players: Array.from(this.players.values()).map(p => ({
          userId: p.userId,
          username: p.username,
          cardCount: p.cards.length
        }))
      });
    }
  }

  startWaitingLoop() {
    if (this.loopInterval) return;
    this.loopInterval = setInterval(async () => {
      if (this.status === 'WAITING') {
        if (this.timer > 0) {
          this.timer--;
          this.broadcastState(); // این خط باید دقیقاً اینجا باشد
        } else {
          // اگر تایمر صفر شد، حتماً یک بار برادکست کن تا کلاینت صفر را ببیند
            this.broadcastState();
            const cardedPlayers = [...this.players.values()].filter(p => p && p.cards && p.cards.length > 0).length;
            if (cardedPlayers >= 2 && this.getTotalActiveCards() >= 2) {

              clearInterval(this.loopInterval);
              this.loopInterval = null;
              this.startCountdown();
            } else if (cardedPlayers >= 2 && this.retryCount > 0) {


            this.retryCount--;
            this.timer = 150;
          } else {
            clearInterval(this.loopInterval);
            this.loopInterval = null;
            await this.refundAndResetRoom();
          }

        }
      }
    }, 1000);
  }

  async refundAndResetRoom() {
    // ۱. واریز مبالغ
    for (const [userId, player] of this.players) {
      if (player && player.cards && player.cards.length > 0) {
        const refundAmountToman = (player.cards.length * this.pricePerCard);
        const refundCoins = Math.ceil(refundAmountToman / 1000);
        try {
          const newBalance = await atomicAddBalance(userId, refundCoins);
          if (player.socketId) {
            io.to(player.socketId).emit('balanceUpdated', { balance: newBalance });
          }
        } catch (e) {
          console.error(`[Daberna Refund Error] User: ${userId}`, e);
        }
      }
    }

    // ۲. ریست کردن دقیق
    this.players.clear();
    this.timer = 150;
    this.retryCount = 1; // اصلاح به ۱ (فقط یک بار تمدید)
    this.status = 'WAITING';

    io.to(this.id).emit('roomReset');
    // ۳. مهم: استارت مجدد حلقه انتظار
    this.startWaitingLoop();
  }

  startCountdown() {
    this.status = 'COUNTDOWN';
    let count = 5;
    const cd = setInterval(() => {
      this.timer = count;
      this.broadcastState();
      count--;
      if (count < 0) {
        clearInterval(cd);
        this.startGameplay();
      }
    }, 1000);
  }

  startGameplay() {
    this.status = 'PLAYING';
    this.timer = 0;
    this.broadcastState();

    this.drawInterval = setInterval(async () => {
      if (this.drawPool.length === 0 || this.status !== 'PLAYING') {
        this.endGame();
        return;
      }

      const drawn = this.drawPool.pop();
      this.drawnNumbers.push(drawn);

io.to(this.id).emit('numberDrawn', {
  roomId: String(this.id),
  number: drawn,
  history: this.drawnNumbers
});

      // بررسی خودکار برنده فول‌کارت
      const winner = this.checkForWinner();
      if (winner) {
        clearInterval(this.drawInterval);
        await this.handleWin(winner);
      }
    }, 2000);
  }

  checkForWinner() {
    const drawnSet = new Set(this.drawnNumbers);
    for (const player of this.players.values()) {
      for (const card of player.cards) {
        let isFullBingo = true;
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 9; c++) {
            const num = card.grid[r][c];
            if (num !== null && !drawnSet.has(num)) {
              isFullBingo = false;
              break;
            }
          }
          if (!isFullBingo) break;
        }
        if (isFullBingo) {
          return { player, cardId: card.id };
        }
      }
    }
    return null;
  }

  async handleWin(winnerData) {
    this.status = 'ENDED';

    const totalPrizePool = this.getTotalActiveCards() * this.pricePerCard;
    const houseFee = Math.floor(totalPrizePool * 0.10);
    const winAmount = totalPrizePool - houseFee;
    const winCoins = Math.floor(winAmount / 1000);
    const feeCoins = Math.floor(houseFee / 1000);

    // واریز اتمیک به برنده به صورت کوین
    await atomicAddBalance(winnerData.player.userId, winCoins);

    // واریز ۱۰٪ کارمزد به خزانه سایت
    try {
      if (feeCoins > 0) {
        const treasury = await ensureTreasuryUser();
        await atomicAddBalance(treasury.id, feeCoins);
        await prisma.transaction.create({
          data: {
            userId: treasury.id,
            matchId: String(this.id),
            amount: feeCoins,
            type: "TREASURY_CUT",
            note: `Daberna 10% fee room:${this.id}`
          }
        });
      }
    } catch (tErr) {
      console.error(`[Daberna Treasury Error] Room: ${this.id}`, tErr);
    }

    // ثبت برد برنده
    await createTx({
      userId: winnerData.player.userId,
      matchId: String(this.id),
      amount: winCoins,
      type: "DABERNA_WIN",
      note: `برد دبرنا - اتاق ${this.id}`
    });

    // ثبت باخت سایر بازیکنان فعال
    for (const [uid, p] of this.players.entries()) {
      if (Number(uid) !== Number(winnerData.player.userId) && p.cards && p.cards.length > 0) {
        const lossToman = (p.cards.length || 0) * this.pricePerCard;
        const lossCoins = Math.ceil(lossToman / 1000);
        await createTx({
          userId: uid,
          matchId: String(this.id),
          amount: lossCoins,
          type: "DABERNA_LOSS",
          note: `باخت دبرنا - اتاق ${this.id} (${p.cards.length} کارت)`
        });
      }
    }


    io.to(this.id).emit('gameEnded', {
      roomId: String(this.id),
      winnerUsername: winnerData.player.username,
      winnerId: winnerData.player.userId,
      prize: winAmount,
      winningCardId: winnerData.cardId
    });

    setTimeout(() => this.resetRoom(), 10000);
  }

  resetRoom() {
    if (this.drawInterval) clearInterval(this.drawInterval);
    this.drawInterval = null;
    this.status = 'WAITING';
    this.timer = 150;
    this.retryCount = 1;
    this.code = 'BG-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    this.drawnNumbers = [];
    this.drawPool = Array.from({ length: 90 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    for (const p of this.players.values()) {
      p.cards = [];
    }
    io.to(this.id).emit('roomReset');
    this.startWaitingLoop();
    this.broadcastState();
  }

  endGame() {
    if (this.drawInterval) clearInterval(this.drawInterval);
    this.status = 'ENDED';
    io.to(this.id).emit('gameEnded', {
      roomId: String(this.id),
      winnerUsername: null
    });

    setTimeout(() => this.resetRoom(), 8000);
  }

}

// مدیریت چندنمونه‌ای اتاق‌های دبرنا
const rooms = new Map();
let roomCounter = 1;

function getBaseTierKey(idStr) {
  return String(idStr).split('#')[0];
}

function createRoomInstance(tierKey) {
  const tierConfig = ROOM_TIERS[tierKey];
  if (!tierConfig) return null;
  const uniqueRoomId = `${tierKey}#${roomCounter++}`;
  const room = new DabernaRoom(uniqueRoomId, tierConfig);
  rooms.set(uniqueRoomId, room);
  room.startWaitingLoop();
  return room;
}

// ساخت اتاق‌های پایه اولیه برای هر سطح
Object.keys(ROOM_TIERS).forEach(tierKey => {
  createRoomInstance(tierKey);
});

function resolveTargetRoom(requestedTierOrId, userId) {
  const reqStr = String(requestedTierOrId);
  const baseTier = getBaseTierKey(reqStr);
  if (!ROOM_TIERS[baseTier]) return null;

  // ۱. بررسی اتصال مجدد (اگر بازیکن در اتاقی از این سطح کارتی در بازی دارد)
  for (const [rId, r] of rooms.entries()) {
    if (getBaseTierKey(rId) === baseTier) {
      const p = r.players.get(userId);
      if (p && p.cards && p.cards.length > 0) {
        return r;
      }
    }
  }

  // ۲. پیدا کردن اتاقی در این سطح که در انتظار بازیکن باشد و سقف ۳۰ کارت پر نشده باشد
  for (const [rId, r] of rooms.entries()) {
    if (getBaseTierKey(rId) === baseTier && r.status === 'WAITING' && r.getTotalActiveCards() < 30) {
      return r;
    }
  }

  // ۳. اگر همه اتاق‌ها در حال بازی یا پر بودند، یک اتاق نو برای این سطح بساز
  return createRoomInstance(baseTier);
}

// ----------------------------------------------------
// SOCKET.IO AUTH & EVENTS
// ----------------------------------------------------
io.use(async (socket, next) => {
  try {
    const headerToken = socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      headerToken;

    if (!token) return next(new Error('توکن احراز هویت الزامی است'));

    const decoded = jwt.verify(token, JWT_SECRET);

    const userId = Number(decoded.userId || decoded.id || decoded.sub);
    if (!userId) return next(new Error('شناسه کاربری عددی نامعتبر است'));

    const user = await getUserRecord(userId);
    if (!user) return next(new Error('کاربر در دیتابیس یافت نشد'));

    socket.user = {
      id: userId,
      username: user.username || user.name || `کاربر ${userId}`,
      balance: Number(user[BALANCE_FIELD])
    };
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  let currentRoomId = null;
  // ارسال اطلاعات زنده لابی دبرنا (تعداد نفرات تجمیعی هر سطح)
  socket.on('getLobbyState', async () => {
    try {
      const refreshedUser = await getUserRecord(socket.user.id);
      const balance = Number(refreshedUser[BALANCE_FIELD]);
      socket.emit('initSync', { balance, userId: socket.user.id });

      const stats = {};
      Object.keys(ROOM_TIERS).forEach(tierKey => {
        stats[tierKey] = 0;
      });

      rooms.forEach((r, rId) => {
        const baseKey = getBaseTierKey(rId);
        if (stats[baseKey] !== undefined) {
          stats[baseKey] += r.players.size;
        }
      });
      socket.emit('lobbyRoomsState', stats);
    } catch (err) {
      console.error('getLobbyState error:', err.message);
    }
  });

  socket.on('joinDabernaRoom', async ({ roomId }) => {
    const room = resolveTargetRoom(roomId, socket.user.id);
    if (!room) return socket.emit('errorMsg', 'سطح اتاق یافت نشد');

    const targetRoomId = String(room.id);

    if (currentRoomId && currentRoomId !== targetRoomId) {
      const previousRoom = rooms.get(currentRoomId);
      const previousPlayer = previousRoom?.players.get(socket.user.id);

      if (previousPlayer?.socketId === socket.id) {
        previousPlayer.socketId = null;
      }

      socket.leave(currentRoomId);

      if (previousRoom) {
        previousRoom.broadcastState();
      }
    }

    currentRoomId = targetRoomId;
    socket.join(currentRoomId);

    if (!room.players.has(socket.user.id)) {
      room.players.set(socket.user.id, {
        userId: socket.user.id,
        socketId: socket.id,
        username: socket.user.username,
        cards: []
      });
    } else {
      const p = room.players.get(socket.user.id);
      p.socketId = socket.id;
    }

    // استعلام مانده جدید حساب
    const refreshedUser = await getUserRecord(socket.user.id);
    const balance = Number(refreshedUser[BALANCE_FIELD]);

    socket.emit('initSync', { balance });
    room.broadcastState();
  });

socket.on('buyCards', async ({ count }) => {

    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.status !== 'WAITING') {
      return socket.emit('errorMsg', 'امکان خرید کارت در این وضعیت اتاق وجود ندارد');
    }

    const cardCount = parseInt(count, 10);
    if (isNaN(cardCount) || cardCount < 1 || cardCount > 6) {
      return socket.emit('errorMsg', 'تعداد کارت نامعتبر است');
    }

    const player = room.players.get(socket.user.id);
    if (!player) return;

    if (player.cards.length + cardCount > 6) {
      return socket.emit('errorMsg', 'حداکثر سقف مجاز کارت در هر بازی ۶ عدد است');
    }

    if (room.getTotalActiveCards() + cardCount > 30) {
      return socket.emit('errorMsg', 'سقف کارت این اتاق پر است (۳۰ کارت)');
    }

    const totalCost = room.pricePerCard * cardCount;

    try {
      // کسر اتمیک وجه از دیتابیس
      const updatedBalance = await atomicDeductBalance(socket.user.id, Math.ceil(totalCost / 1000));

      // بررسی مجدد بعد از کسر پول برای جلوگیری از دور زدن هم‌زمان سقف ۳۰
      if (room.getTotalActiveCards() + cardCount > 30) {
        const refundedBalance = await atomicAddBalance(socket.user.id, Math.ceil(totalCost / 1000));
        socket.emit('balanceUpdated', { balance: refundedBalance });

        return socket.emit('errorMsg', 'سقف کارت این اتاق پر شد (۳۰ کارت)');
      }

      for (let i = 0; i < cardCount; i++) {
        const card = generateDabernaCard(`${socket.user.id}-${Date.now()}-${i}`);
        player.cards.push(card);
      }

      socket.emit('purchaseSuccess', { balance: updatedBalance, newCardsCount: player.cards.length });
      room.broadcastState();

      // استارت آنی در صورت تکمیل سقف ۳۰ کارت
      if (room.status === 'WAITING' && room.getTotalActiveCards() >= 30) {
        if (room.loopInterval) {
          clearInterval(room.loopInterval);
          room.loopInterval = null;
        }
        room.startCountdown();
      }
    } catch (err) {
      socket.emit('errorMsg', err.message || 'خطا در کسر موجودی');
    }
  });

    socket.on('disconnect', async () => {
      if (!currentRoomId) return;
      const room = rooms.get(currentRoomId);
      if (!room) return;

      const player = room.players.get(socket.user.id);
      // جلوگیری از اثرگذاری سوکت قدیمی قطع‌شده روی اتصال جدید کاربر
      if (!player || player.socketId !== socket.id) return;

      player.socketId = null;

      // اگر کاربر هیچ کارتی نخریده بود، از لیست بازیکنان لابی خارج شود
      if (room.status === 'WAITING' && (!player.cards || player.cards.length === 0)) {
        room.players.delete(socket.user.id);
      }

      room.broadcastState();
    });

});

server.listen(PORT, () => {
  console.log(`[Daberna Server] Listening strictly on port ${PORT}`);
});

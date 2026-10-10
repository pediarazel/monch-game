/**
 * Daberna (Bingo) Game Server - Port 3003
 * Strictly atomic Prisma wallet integration (Shared with Ludo & 21)
 * No plain text credentials, numeric JWT authentication
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const PORT = process.env.DABERNA_PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'your-fallback-jwt-secret';

// Schema auto-adaptation settings
const USER_MODEL = process.env.DABERNA_USER_MODEL || 'user';
const USER_ID_FIELD = process.env.DABERNA_USER_ID_FIELD || 'id';
const BALANCE_FIELD = process.env.DABERNA_BALANCE_FIELD || 'balance';

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health Check
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));

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
  }

  getTotalActiveCards() {
    let total = 0;
    for (const p of this.players.values()) total += p.cards.length;
    return total;
  }

  broadcastState() {
    for (const [uid, player] of this.players.entries()) {
      io.to(player.socketId).emit('roomState', {
        code: this.code,
        status: this.status,
        timer: this.timer,
        onlineCount: this.players.size,
        totalActiveCards: this.getTotalActiveCards(),
        myCards: player.cards.length,
        myCardsData: player.cards,
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
    this.loopInterval = setInterval(() => {
      if (this.status === 'WAITING') {
        if (this.timer > 0) {
          this.timer--;
        } else {
          // در صورت داشتن کارت و حداقل ۲ بازیکن بازی آغاز می‌شود
          if (this.getTotalActiveCards() >= 2 && this.players.size >= 2) {
            this.startCountdown();
          } else {
            this.timer = 60; // تمدید تایمر
          }
        }
        this.broadcastState();
      }
    }, 1000);
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

      io.to(this.id).emit('numberDrawn', { number: drawn, history: this.drawnNumbers });

      // بررسی خودکار برنده فول‌کارت
      const winner = this.checkForWinner();
      if (winner) {
        clearInterval(this.drawInterval);
        await this.handleWin(winner);
      }
    }, 4000);
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

    // واریز اتمیک به برنده
    await atomicAddBalance(winnerData.player.userId, winAmount);

    io.to(this.id).emit('gameEnded', {
      winnerUsername: winnerData.player.username,
      winnerId: winnerData.player.userId,
      prize: winAmount,
      winningCardId: winnerData.cardId
    });

    setTimeout(() => this.resetRoom(), 10000);
  }

  resetRoom() {
    if (this.drawInterval) clearInterval(this.drawInterval);
    this.status = 'WAITING';
    this.timer = 150;
    this.drawnNumbers = [];
    this.drawPool = Array.from({ length: 90 }, (_, i) => i + 1).sort(() => Math.random() - 0.5);
    for (const p of this.players.values()) {
      p.cards = [];
    }
    this.broadcastState();
  }

  endGame() {
    if (this.drawInterval) clearInterval(this.drawInterval);
    this.status = 'ENDED';
    io.to(this.id).emit('gameEnded', { winnerUsername: null, message: 'گردونه به پایان رسید بدون برنده' });
    setTimeout(() => this.resetRoom(), 8000);
  }
}

// ایجاد نمونه‌های اتاق‌ها
const rooms = new Map();
Object.keys(ROOM_TIERS).forEach(roomId => {
  const room = new DabernaRoom(roomId, ROOM_TIERS[roomId]);
  rooms.set(roomId, room);
  room.startWaitingLoop();
});

// ----------------------------------------------------
// SOCKET.IO AUTH & EVENTS
// ----------------------------------------------------
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
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
    next(new Error('احراز هویت ناموفق: ' + err.message));
  }
});

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('joinDabernaRoom', async ({ roomId }) => {
    const room = rooms.get(String(roomId));
    if (!room) return socket.emit('errorMsg', 'اتاق یافت نشد');

    currentRoomId = String(roomId);
    socket.join(currentRoomId);

    if (!room.players.has(socket.user.id)) {
      room.players.set(socket.user.id, {
        userId: socket.user.id,
        socketId: socket.id,
        username: socket.user.username,
        cards: []
      });
    } else {
      // به‌روزرسانی socketId در صورت اتصال مجدد
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

    const totalCost = room.pricePerCard * cardCount;

    try {
      // کسر اتمیک وجه از دیتابیس
      const updatedBalance = await atomicDeductBalance(socket.user.id, totalCost);

      for (let i = 0; i < cardCount; i++) {
        const card = generateDabernaCard(`${socket.user.id}-${Date.now()}-${i}`);
        player.cards.push(card);
      }

      socket.emit('purchaseSuccess', { balance: updatedBalance, newCardsCount: player.cards.length });
      room.broadcastState();
    } catch (err) {
      socket.emit('errorMsg', err.message || 'خطا در کسر موجودی');
    }
  });

  socket.on('disconnect', async () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const player = room.players.get(socket.user.id);
    if (player && room.status === 'WAITING' && player.cards.length > 0) {
      // بازگرداندن اتمیک وجه کارت‌های خریداری‌شده در صورت خروج قبل از شروع مسابقه
      const refundAmount = player.cards.length * room.pricePerCard;
      try {
        await atomicAddBalance(socket.user.id, refundAmount);
      } catch (e) {
        console.error('Refund failed:', e);
      }
    }

    if (room.status === 'WAITING') {
      room.players.delete(socket.user.id);
    }
    room.broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`[Daberna Server] Listening strictly on port ${PORT}`);
});

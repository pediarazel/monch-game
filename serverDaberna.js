const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 300000,
  pingInterval: 30000,
  transports: ['websocket', 'polling']
});
const PORT = 3001;

app.use(express.static(__dirname));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio_files', express.static(path.join(__dirname, 'public', 'audio_files')));
// ==================== دیتابیس ====================
function readDB() {
    try {
        if (fs.existsSync('database.json')) {
            return JSON.parse(fs.readFileSync('database.json', 'utf8'));
        }
    } catch (e) { }
    return { users: {}, transactions: [], withdrawalRequests: [], diceRolls: [], adminLogs: [], settings: {} };
}

function writeDB(data) {
    try {
        fs.writeFileSync('database.json', JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        return false;
    }
}

// ==================== هش رمز عبور ====================
async function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

async function verifyPassword(password, hash) {
    const hashed = await hashPassword(password);
    return hashed === hash;
}

// ==================== تولید کارت‌های غیرتکراری ====================
class CardGenerator {
    constructor() {
        this.usedCards = new Set();
    }

    generateUniqueCard() {
        let card;
        let attempts = 0;
        let isValid = false;

        do {
            card = this.generateCard();
            attempts++;
            isValid = this.validateCard(card);
            if (attempts > 100) break;
        } while (!isValid || this.usedCards.has(this.cardToKey(card)));

        if (isValid) {
            this.usedCards.add(this.cardToKey(card));
        }
        return card;
    }

    generateCard() {
        const card = Array(3).fill().map(() => Array(9).fill(''));
        const columnRanges = [
            [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
            [50, 59], [60, 69], [70, 79], [80, 90]
        ];

        const numbersPerColumn = Array(9).fill(1);
        let remainingNumbers = 6;
        while (remainingNumbers > 0) {
            const randomCol = Math.floor(Math.random() * 9);
            if (numbersPerColumn[randomCol] < 3) {
                numbersPerColumn[randomCol]++;
                remainingNumbers--;
            }
        }

        for (let col = 8; col >= 0; col--) {
            const [min, max] = columnRanges[col];
            const numbers = this.getRandomNumbers(min, max, numbersPerColumn[col]);
            const positions = this.getRandomPositions(numbersPerColumn[col]);
            for (let i = 0; i < numbersPerColumn[col]; i++) {
                card[positions[i]][col] = numbers[i];
            }
        }

        this.balanceRows(card);
        return card;
    }

    balanceRows(card) {
        const numbersPerRow = [0, 0, 0];
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 9; col++) {
                if (card[row][col] !== '') numbersPerRow[row]++;
            }
        }

        for (let i = 0; i < 10; i++) {
            const maxRow = numbersPerRow.indexOf(Math.max(...numbersPerRow));
            const minRow = numbersPerRow.indexOf(Math.min(...numbersPerRow));
            if (numbersPerRow[maxRow] <= 5 && numbersPerRow[minRow] >= 5) break;
            if (numbersPerRow[maxRow] > 5 && numbersPerRow[minRow] < 5) {
                for (let col = 0; col < 9; col++) {
                    if (card[maxRow][col] !== '' && card[minRow][col] === '') {
                        card[minRow][col] = card[maxRow][col];
                        card[maxRow][col] = '';
                        numbersPerRow[maxRow]--;
                        numbersPerRow[minRow]++;
                        break;
                    }
                }
            }
        }
    }

    getRandomNumbers(min, max, count) {
        const numbers = [];
        const available = Array.from({ length: max - min + 1 }, (_, i) => min + i);
        for (let i = 0; i < count; i++) {
            const randomIndex = Math.floor(Math.random() * available.length);
            numbers.push(available[randomIndex]);
            available.splice(randomIndex, 1);
        }
        return numbers.sort((a, b) => a - b);
    }

    getRandomPositions(count) {
        const positions = [0, 1, 2];
        const result = [];
        for (let i = 0; i < count; i++) {
            const randomIndex = Math.floor(Math.random() * positions.length);
            result.push(positions[randomIndex]);
            positions.splice(randomIndex, 1);
        }
        return result.sort((a, b) => a - b);
    }

    validateCard(card) {
        let totalNumbers = 0;
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 9; col++) {
                if (card[row][col] !== '') totalNumbers++;
            }
        }
        if (totalNumbers !== 15) return false;

        for (let row = 0; row < 3; row++) {
            let numbersInRow = 0;
            for (let col = 0; col < 9; col++) {
                if (card[row][col] !== '') numbersInRow++;
            }
            if (numbersInRow !== 5) return false;
        }
        return true;
    }

    cardToKey(card) {
        const numbers = [];
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 9; col++) {
                if (card[row][col] !== '') numbers.push(card[row][col]);
            }
        }
        return numbers.sort((a, b) => a - b).join(',');
    }

    resetUsedCards() {
        this.usedCards.clear();
    }
}

// ==================== ربات‌ها ====================
const botNamesByRoom = {
    5000: [
        "سیمین کوچولو", "امیر1125", "Reza ramzani", "parmis", "Reza27",
        "آقا صابر", "سعید رشتی", "رگنار", "mona khanom", "Maryam76",
        "56ج", "سهراب جوادی", "مارشال", "روزبه رئیسی", "مازیار۱۹",
        "vahid M", "Arman AR", "tataloo7", "Rezvane tattoo", "لاهیجان سیتی",
        "یا ابول قاسم", "مهدی لنگرود", "yashar", "raha91", "💙قلب یخی💙",
        "nahid", "456", "bahram66", "Arya Mz", "Rayan", "ایران", "Boy turk", "beni",
        "mahan nas", "mostafa", "عمو اسی", "آرام1374", "ارشیا", "bad boys", "نامبروان",
        "pooopak", "رستم", "شیطان", "شهره 6970", "Ayhan",
        "رضا۰۵۱۷", "Meysam90", "weed", "برگ برنده", "میزبان", "ارصلانم"
    ],
    10000: [
        "Rezvane tattoo", "بدشانس", "مریم گلی", "فروهر", "عشق 206",
        "hamed", "سلطان شهر", "تکی بخون", "هادی کمیل", "استقلال",
        "Messi", "Aida Jojo", "tataloo7", "لاهیجان سیتی", "حاج احمد",
        "khanomi", "hamed123", "❤️عشقم فقط تویی M❤️", "عروس خانوم",
        "نوید و امین", "@jamshidraj1171", "بازنده", "Waking dead",
        "آقای نوروزی", "امین صافکار", "rastin31", "👑King👑",
        "bad boys", "farahnak", "فارس", "weed", "Meysam90", "عمو اسی",
        "ارصلانم", "رضا۰۵۱۷", "تک بخون", "Rozita", "دهن گشاد", "kami666",
        "میرکوهن", "tak par", "شادی", "شهید گمنام", "فرهاد دادرس", "fatiii"
    ],
    20000: [
        "👑king👑", "Eminem", "parsa", "tataloo7", "شوتی", "khanomi",
        "عروس خانوم", "Milad rastad", "دلشکسته 💔", "پت من", "نوید و امین",
        "پلنگ مازندران", "مانی پسر بابا", "عقاب", "Arad Max", "طلا خانوم",
        "ترانه", "dadash ali", "bad boys", "ramin pixel", "peyman lover",
        "پسر جهنمی", "پیروزی", "استقلال"
    ]
};

// ==================== مدیریت اتاق‌های بازی ====================
class GameRoomManager {
    constructor() {
        this.activeRooms = new Map();
        this.roomCounters = new Map();
        this.cardGenerator = new CardGenerator();
        this.usedBotNamesByRoom = {
            5000: new Set(),
            10000: new Set(),
            20000: new Set()
        };
    }

    getOrCreateRoom(roomPrice) {
        const available = this.findAvailableRoom(roomPrice);
        if (available) return available;

        const roomId = `room_${roomPrice}_${Date.now()}`;
        const session = new GameSession(roomPrice, roomId, this.cardGenerator, this);
        this.activeRooms.set(roomId, session);

        if (!this.roomCounters.has(roomPrice)) {
            this.roomCounters.set(roomPrice, 0);
        }
        const counter = this.roomCounters.get(roomPrice) + 1;
        this.roomCounters.set(roomPrice, counter);

        return session;
    }

    findAvailableRoom(roomPrice) {
        for (const [roomId, session] of this.activeRooms) {
            if (session.roomPrice === roomPrice &&
                session.soldCards < 30 &&
                session.status === 'waiting') {
                return session;
            }
        }
        return null;
    }

    getAvailableBotNames(roomPrice) {
        const allNames = botNamesByRoom[roomPrice] || [];
        const usedNames = this.usedBotNamesByRoom[roomPrice];
        return allNames.filter(name => !usedNames.has(name));
    }

    markBotNameAsUsed(roomPrice, name) {
        this.usedBotNamesByRoom[roomPrice].add(name);
    }

    resetUsedBotNames(roomPrice) {
        this.usedBotNamesByRoom[roomPrice].clear();
    }

    getSession(roomId) {
        return this.activeRooms.get(roomId);
    }
}

// ==================== جلسه بازی ====================
class GameSession {
    constructor(roomPrice, roomId, cardGenerator, roomManager) {
        this.roomPrice = roomPrice;
        this.roomId = roomId;
        this.cardGenerator = cardGenerator;
        this.roomManager = roomManager;
        this.players = [];
        this.soldCards = 0;
        this.timer = 120;
        this.timerInterval = null;
        this.gameInterval = null;
        this.calledNumbers = [];
        this.currentNumber = 0;
        this.lineWinner = null;
        this.fullHouseWinner = null;
        this.totalPrize = 0;
        this.linePrize = 0;
        this.fullHousePrize = 0;
        this.cardNumbers = [];
        this.usedBotNames = new Set();
        this.status = 'waiting';
        this.userCardsPurchased = new Map();
        this.usedCardIndices = new Set();
        this.allWinners = [];
        this.highlightedNumbers = new Set();
        this.shuffledCards = null;
        this.targetBotCardsTotal = undefined;
        this.lastBotAddTime = Date.now();
        this.connectedSockets = new Set();

        this.startPurchaseTimer();
    }

    startPurchaseTimer() {
        this.status = 'waiting';
        if (this.timerInterval) clearInterval(this.timerInterval);

        this.timerInterval = setInterval(() => {
            const timeSinceLastBot = (Date.now() - this.lastBotAddTime) / 1000;

            if (timeSinceLastBot >= 15 && this.soldCards < 30 && this.players.filter(p => p.isBot).length < 10) {
                this.addBotPlayer();
                this.lastBotAddTime = Date.now();
            }

            if (typeof this.timer !== 'number' || isNaN(this.timer)) this.timer = 120;
            if (this.timer <= 0) return;

            this.timer--;
            this.emitRoomUpdate();

            if (this.soldCards >= 30) {
                clearInterval(this.timerInterval);
                this.startGame();
                return;
            }

            if (this.timer <= 0) {
                clearInterval(this.timerInterval);
                if (this.players.length >= 2) {
                    this.startGame();
                } else {
                    this.timer = 120;
                    this.startPurchaseTimer();
                }
            }
        }, 1000);
    }

    addBotPlayer() {
        let targetMinTotal, targetMaxTotal;
        switch (this.roomPrice) {
            case 5000: targetMinTotal = 10; targetMaxTotal = 15; break;
            case 10000: targetMinTotal = 6; targetMaxTotal = 8; break;
            case 20000: targetMinTotal = 3; targetMaxTotal = 5; break;
            default: targetMinTotal = 3; targetMaxTotal = 5;
        }

        if (this.targetBotCardsTotal === undefined) {
            this.targetBotCardsTotal = Math.floor(Math.random() * (targetMaxTotal - targetMinTotal + 1)) + targetMinTotal;
        }

        const currentTotalBotCards = this.players
            .filter(p => p.isBot)
            .reduce((sum, p) => sum + p.cards.length, 0);

        if (currentTotalBotCards >= this.targetBotCardsTotal) return;

        const availableNames = this.roomManager.getAvailableBotNames(this.roomPrice);
        if (availableNames.length === 0) {
            this.roomManager.resetUsedBotNames(this.roomPrice);
            const newAvailable = this.roomManager.getAvailableBotNames(this.roomPrice);
            if (newAvailable.length === 0) return;
        }
        const allAvailable = availableNames.length > 0 ? availableNames : this.roomManager.getAvailableBotNames(this.roomPrice);
        const randomName = allAvailable[Math.floor(Math.random() * allAvailable.length)];
        this.roomManager.markBotNameAsUsed(this.roomPrice, randomName);

        const remainingToTarget = this.targetBotCardsTotal - currentTotalBotCards;
        let minCardPerBot, maxCardPerBot;
        switch (this.roomPrice) {
            case 5000: minCardPerBot = 2; maxCardPerBot = 4; break;
            case 10000: minCardPerBot = 2; maxCardPerBot = 3; break;
            case 20000: minCardPerBot = 1; maxCardPerBot = 2; break;
            default: minCardPerBot = 1; maxCardPerBot = 2;
        }

        let cardCount;
        if (remainingToTarget >= minCardPerBot) {
            const maxPossible = Math.min(maxCardPerBot, remainingToTarget);
            const minPossible = Math.min(minCardPerBot, maxPossible);
            cardCount = Math.floor(Math.random() * (maxPossible - minPossible + 1)) + minPossible;
        } else {
            cardCount = remainingToTarget;
        }
        if (cardCount <= 0) return;

        const player = {
            name: randomName,
            userId: `bot_${Date.now()}_${Math.random()}`,
            cards: [],
            isBot: true
        };

        for (let i = 0; i < cardCount; i++) {
            if (this.soldCards < 30) {
                let cardNumber;
                do {
cardNumber = Math.floor(Math.random() * (this.soldCards + 1)) + 1;
                } while (this.cardNumbers.includes(cardNumber));

                this.cardNumbers.push(cardNumber);
                const cardTemplate = this.cardGenerator.generateUniqueCard();

                player.cards.push({
                    template: JSON.parse(JSON.stringify(cardTemplate)),
                    removedNumbers: [],
                    number: cardNumber,
                    roomPrice: this.roomPrice
                });
                this.soldCards++;
            }
        }

        if (player.cards.length > 0) {
            this.players.push(player);
        }
    }

    addRealPlayer(userData, cardCount) {
        const existingPlayer = this.players.find(p => p.userId === userData.phone);

        if (existingPlayer) {
            for (let i = 0; i < cardCount; i++) {
                if (this.soldCards < 30) {
                    let cardNumber;
                    do {
cardNumber = Math.floor(Math.random() * (this.soldCards + 1)) + 1;
                    } while (this.cardNumbers.includes(cardNumber));
                    this.cardNumbers.push(cardNumber);
                    const cardTemplate = this.cardGenerator.generateUniqueCard();
                    existingPlayer.cards.push({
                        template: JSON.parse(JSON.stringify(cardTemplate)),
                        removedNumbers: [],
                        number: cardNumber,
                        roomPrice: this.roomPrice
                    });
                    this.soldCards++;
                }
            }
            const currentCount = this.userCardsPurchased.get(userData.phone) || 0;
            this.userCardsPurchased.set(userData.phone, currentCount + cardCount);
        } else {
            const player = {
                name: userData.username,
                userId: userData.phone,
                cards: [],
                isBot: false
            };

            for (let i = 0; i < cardCount; i++) {
                if (this.soldCards < 30) {
                    let cardNumber;
                    do {
cardNumber = Math.floor(Math.random() * (this.soldCards + 1)) + 1;
                    } while (this.cardNumbers.includes(cardNumber));
                    this.cardNumbers.push(cardNumber);
                    const cardTemplate = this.cardGenerator.generateUniqueCard();
                    player.cards.push({
                        template: JSON.parse(JSON.stringify(cardTemplate)),
                        removedNumbers: [],
                        number: cardNumber,
                        roomPrice: this.roomPrice
                    });
                    this.soldCards++;
                }
            }

            this.players.push(player);
            this.userCardsPurchased.set(userData.phone, cardCount);
        }

        return this.soldCards;
    }

    startGame() {
        this.status = 'playing';
        this.totalPrize = this.roomPrice * this.soldCards;
        this.linePrize = this.totalPrize * 0.1;
        this.fullHousePrize = this.totalPrize * 0.8;
        this.calledNumbers = [];
        this.currentNumber = 0;
        this.lineWinner = null;
        this.fullHouseWinner = null;
        this.allWinners = [];

        const numbers = Array.from({ length: 90 }, (_, i) => i + 1);
        this.shuffleArray(numbers);

        let numberIndex = 0;

        // ارسال اطلاعات شروع بازی
        io.to(this.roomId).emit('gameStarted', {
            roomId: this.roomId,
            roomPrice: this.roomPrice,
            totalPrize: this.totalPrize,
            linePrize: this.linePrize,
            fullHousePrize: this.fullHousePrize,
            players: this.getPlayerList(),
            soldCards: this.soldCards
        });

        if (this.gameInterval) clearInterval(this.gameInterval);

        this.gameInterval = setInterval(() => {
            if (numberIndex >= numbers.length || this.fullHouseWinner) {
                clearInterval(this.gameInterval);
                this.endGame();
                return;
            }

            this.currentNumber = numbers[numberIndex];
            this.calledNumbers.push(this.currentNumber);
            numberIndex++;
            this.highlightedNumbers.add(this.currentNumber);

            // ارسال عدد جدید به کلاینت‌ها
            io.to(this.roomId).emit('newNumber', {
                roomId: this.roomId,
                number: this.currentNumber,
                highlightedNumbers: Array.from(this.highlightedNumbers)
            });

            setTimeout(() => {
                this.removeNumberFromCards(this.currentNumber);
                this.highlightedNumbers.delete(this.currentNumber);
                this.checkWinners();
            }, 1500);

        }, 2000);
    }

    removeNumberFromCards(number) {
        this.players.forEach(player => {
            player.cards.forEach(card => {
                for (let row = 0; row < 3; row++) {
                    for (let col = 0; col < 9; col++) {
                        const cellValue = card.template[row][col];
                        if (cellValue !== '' && parseInt(cellValue) === number) {
                            if (!card.removedNumbers.includes(number)) {
                                card.removedNumbers.push(number);
                            }
                        }
                    }
                }
            });
        });
    }

    checkWinners() {
        // ========== برنده خط کامل ==========
        if (!this.lineWinner) {
            const lineWinners = [];
            for (const player of this.players) {
                for (const card of player.cards) {
                    let foundWinner = false;
                    for (let row = 0; row < 3; row++) {
                        let lineComplete = true;
                        let hasNumberInRow = false;
                        for (let col = 0; col < 9; col++) {
                            const cellValue = card.template[row][col];
                            if (cellValue !== '') {
                                hasNumberInRow = true;
                                if (!card.removedNumbers.includes(parseInt(cellValue))) {
                                    lineComplete = false;
                                    break;
                                }
                            }
                        }
                        if (lineComplete && hasNumberInRow) {
                            lineWinners.push({
                                player: player.name,
                                userId: player.userId,
                                cardNumber: card.number,
                                type: 'برنده خط کامل',
                                isBot: player.isBot
                            });
                            foundWinner = true;
                            break;
                        }
                    }
                    if (foundWinner) break;
                }
            }

            if (lineWinners.length > 0) {
                const realUsers = lineWinners.filter(w => !w.isBot);
                const bots = lineWinners.filter(w => w.isBot);
                let finalWinners = [];

                if (realUsers.length > 0) {
                    let totalUserCards = 0;
                    const userCardsMap = [];
                    for (const user of realUsers) {
                        const player = this.players.find(p => p.userId === user.userId);
                        const cardCount = player ? player.cards.length : 1;
                        userCardsMap.push({ user, cardCount });
                        totalUserCards += cardCount;
                    }
                    const randomNum = Math.random() * 100;
                    let cumulativeChance = 0;
                    let selectedWinner = null;
                    for (const { user, cardCount } of userCardsMap) {
                        const userChance = (6 * cardCount) / totalUserCards;
                        cumulativeChance += userChance;
                        if (randomNum < cumulativeChance && !selectedWinner) {
                            selectedWinner = user;
                        }
                    }
                    if (selectedWinner) {
                        finalWinners = [selectedWinner];
                    } else if (bots.length > 0) {
                        finalWinners = [bots[Math.floor(Math.random() * bots.length)]];
                    } else {
                        finalWinners = lineWinners.length > 0 ? [lineWinners[0]] : [];
                    }
                } else {
                    finalWinners = bots.length > 0 ? [bots[Math.floor(Math.random() * bots.length)]] : (lineWinners.length > 0 ? [lineWinners[0]] : []);
                }
                if (finalWinners.length === 0) finalWinners = lineWinners;

                this.lineWinner = finalWinners;
                const prizePerWinner = Math.floor(this.linePrize / finalWinners.length);

                finalWinners.forEach(winner => {
                    winner.amount = prizePerWinner;
                    this.allWinners.push(winner);
                    this.distributePrize(winner, 'برنده خط کامل', prizePerWinner);
                });

                io.to(this.roomId).emit('lineWinner', {
                    roomId: this.roomId,
                    winners: finalWinners,
                    prize: prizePerWinner
                });
            }
        }

        // ========== برنده کارت کامل ==========
        if (!this.fullHouseWinner) {
            const fullHouseWinners = [];
            for (const player of this.players) {
                for (const card of player.cards) {
                    let cardComplete = true;
                    for (let row = 0; row < 3; row++) {
                        for (let col = 0; col < 9; col++) {
                            const cellValue = card.template[row][col];
                            if (cellValue !== '' && !card.removedNumbers.includes(parseInt(cellValue))) {
                                cardComplete = false;
                                break;
                            }
                        }
                        if (!cardComplete) break;
                    }
                    if (cardComplete) {
                        fullHouseWinners.push({
                            player: player.name,
                            userId: player.userId,
                            cardNumber: card.number,
                            type: 'برنده کامل',
                            isBot: player.isBot
                        });
                    }
                }
            }

            if (fullHouseWinners.length > 0) {
                const realUsers = fullHouseWinners.filter(w => !w.isBot);
                const bots = fullHouseWinners.filter(w => w.isBot);
                let finalWinners = [];

                if (realUsers.length > 0) {
                    let totalUserCards = 0;
                    const userCardsMap = [];
                    for (const user of realUsers) {
                        const player = this.players.find(p => p.userId === user.userId);
                        const cardCount = player ? player.cards.length : 1;
                        userCardsMap.push({ user, cardCount });
                        totalUserCards += cardCount;
                    }
                    const randomNum = Math.random() * 100;
                    let cumulativeChance = 0;
                    let selectedWinner = null;
                    for (const { user, cardCount } of userCardsMap) {
                        const userChance = (2.8 * cardCount) / totalUserCards;
                        cumulativeChance += userChance;
                        if (randomNum < cumulativeChance && !selectedWinner) {
                            selectedWinner = user;
                        }
                    }
                    if (selectedWinner) {
                        finalWinners = [selectedWinner];
                    } else if (bots.length > 0) {
                        finalWinners = [bots[Math.floor(Math.random() * bots.length)]];
                    } else {
                        finalWinners = fullHouseWinners.length > 0 ? [fullHouseWinners[0]] : [];
                    }
                } else {
                    finalWinners = bots.length > 0 ? [bots[Math.floor(Math.random() * bots.length)]] : (fullHouseWinners.length > 0 ? [fullHouseWinners[0]] : []);
                }
                if (finalWinners.length === 0) finalWinners = fullHouseWinners;

                this.fullHouseWinner = finalWinners;
                const prizePerWinner = Math.floor(this.fullHousePrize / finalWinners.length);

                finalWinners.forEach(winner => {
                    winner.amount = prizePerWinner;
                    this.allWinners.push(winner);
                    this.distributePrize(winner, 'برنده کامل', prizePerWinner);
                });

                io.to(this.roomId).emit('fullHouseWinner', {
                    roomId: this.roomId,
                    winners: finalWinners,
                    prize: prizePerWinner
                });
            }
        }
    }

    distributePrize(winner, prizeType, amount) {
        if (!winner.isBot) {
            const db = readDB();
            if (db.users[winner.userId]) {
                db.users[winner.userId].balance = (db.users[winner.userId].balance || 0) + amount;

                if (!db.users[winner.userId].winners) db.users[winner.userId].winners = [];
                db.users[winner.userId].winners.push({
                    player: winner.player,
                    cardNumber: winner.cardNumber,
                    type: prizeType,
                    amount: amount,
                    date: new Date().toLocaleDateString('fa-IR'),
                    time: new Date().toLocaleTimeString('fa-IR')
                });

                if (!db.users[winner.userId].transactions) db.users[winner.userId].transactions = [];
                db.users[winner.userId].transactions.push({
                    type: 'جایزه',
                    description: prizeType,
                    amount: amount,
                    date: new Date().toLocaleDateString('fa-IR'),
                    time: new Date().toLocaleTimeString('fa-IR')
                });

                if (!db.users[winner.userId].transactionHistory) db.users[winner.userId].transactionHistory = [];
                db.users[winner.userId].transactionHistory.push({
                    type: 'dice-win',
                    amount: amount,
                    dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
                    timestamp: new Date().toISOString(),
                    description: prizeType
                });

            // ===== اضافه کردن جایزه به dailyGames =====
            const now = new Date();
            const today = now.toLocaleDateString('fa-IR');

            let todayGame = db.users[winner.userId].dailyGames?.find(g => 
                g.roomPrice === this.roomPrice && 
                g.date === today
            );

            if (todayGame) {
                todayGame.prizeWon = (todayGame.prizeWon || 0) + amount;
            } else {
                if (!db.users[winner.userId].dailyGames) db.users[winner.userId].dailyGames = [];
                db.users[winner.userId].dailyGames.push({
                    roomPrice: this.roomPrice,
                    cardCount: 0,
                    prizeWon: amount,
                    date: today,
                    time: now.toLocaleTimeString('fa-IR'),
                    timestamp: now.toISOString()
                });
            }
            // ===========================================
                writeDB(db);

                // ارسال به کاربر برنده
                const winnerSocket = this.getSocketByUserId(winner.userId);
                if (winnerSocket) {
                    winnerSocket.emit('prizeWon', {
                        prizeType: prizeType,
                        amount: amount,
                        winner: winner
                    });
                }
            }
        }
    }

    getSocketByUserId(userId) {
        for (const socketId of this.connectedSockets) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket && socket.userId === userId) {
                return socket;
            }
        }
        return null;
    }

    endGame() {
        this.status = 'finished';
        io.to(this.roomId).emit('gameEnded', {
            roomId: this.roomId,
            allWinners: this.allWinners
        });

        setTimeout(() => {
            this.resetForNewGame();
        }, 15000);
    }

    resetForNewGame() {
        this.lastBotAddTime = Date.now();
        this.players = [];
        this.soldCards = 0;
        this.timer = 120;
        this.cardNumbers = [];
        this.usedBotNames.clear();
        this.roomManager.resetUsedBotNames(this.roomPrice);
        this.userCardsPurchased.clear();
        this.usedCardIndices.clear();
        this.lineWinner = null;
        this.fullHouseWinner = null;
        this.allWinners = [];
        this.calledNumbers = [];
        this.currentNumber = 0;
        this.highlightedNumbers.clear();
        this.shuffledCards = null;
        this.targetBotCardsTotal = undefined;

        if (this.gameInterval) clearInterval(this.gameInterval);
        if (this.timerInterval) clearInterval(this.timerInterval);

        this.cardGenerator.resetUsedCards();
        this.startPurchaseTimer();
    }

    getPlayerList() {
        return this.players.map(p => ({
            name: p.name,
            cardCount: p.cards.length,
            isBot: p.isBot
        }));
    }

    getUserCards(userId) {
        const player = this.players.find(p => p.userId === userId);
        if (!player) return [];
        return player.cards.map(card => ({
            template: card.template,
            removedNumbers: card.removedNumbers,
            number: card.number,
            roomPrice: card.roomPrice
        }));
    }

    getAllCardsForDisplay(userId) {
        const userPlayer = this.players.find(p => p.userId === userId);
        const userCards = userPlayer ? userPlayer.cards.filter(c => parseInt(c.roomPrice) === parseInt(this.roomPrice)) : [];
        const otherCards = [];

        this.players.forEach(player => {
            if (player.userId !== userId) {
                const cardsInRoom = player.cards.filter(c => c.roomPrice === this.roomPrice);
                cardsInRoom.forEach(card => {
otherCards.push({ 
    player: { name: player.name },
    card: {
        template: card.template,
        removedNumbers: card.removedNumbers,
        number: card.number,
        roomPrice: card.roomPrice
    }
});
                });
            }
        });

        // Shuffle other cards once
        if (!this.shuffledCards) {
            this.shuffledCards = this.shuffleArray([...otherCards]);
        }

        return {
            userCards,
            otherCards: this.shuffledCards
        };
    }

    emitRoomUpdate() {
        io.to(this.roomId).emit('roomUpdate', {
            roomId: this.roomId,
            roomPrice: this.roomPrice,
            timer: this.timer,
            soldCards: this.soldCards,
            players: this.getPlayerList(),
            status: this.status,
            linePrize: this.linePrize,
            fullHousePrize: this.fullHousePrize,
            totalPrize: this.totalPrize
        });
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}

// ==================== سیستم تاس شانسی ====================
const dicePrizes = [
    { type: 'prize', value: '10,000 تومان', amount: 10000, face: 1 },
    { type: 'prize', value: '5,000 تومان', amount: 5000, face: 2 },
    { type: 'prize', value: '5,000 تومان', amount: 5000, face: 3 },
    { type: 'prize', value: '5,000 تومان', amount: 5000, face: 4 },
    { type: 'empty', value: 'پوچ', amount: 0, face: 5 },
    { type: 'empty', value: 'پوچ', amount: 0, face: 6 }
];

function rollDiceOnServer() {
    const randomPercent = Math.random() * 100;

if (randomPercent < 15) {
        return { type: 'prize', value: '10,000 تومان', amount: 10000, face: 1, sticker: '💰', message: 'تبریک! شما 10,000 تومان برنده شدید!', moneyRain: true };
    } else if (randomPercent < 70) {
        const randomFace = Math.floor(Math.random() * 3) + 2;
        return { type: 'prize', value: '5,000 تومان', amount: 5000, face: randomFace, sticker: '💵', message: 'تبریک! شما 5,000 تومان برنده شدید!', moneyRain: true };
    } else {
        const randomFace = Math.random() < 0.5 ? 5 : 6;
        const sticker = randomFace === 5 ? '😞' : '😢';
        return { type: 'empty', value: 'پوچ', amount: 0, face: randomFace, sticker: sticker, message: 'متأسفانه امروز جایزه‌ای برنده نشدید', moneyRain: false };
    }
}

// ==================== متغیرهای سراسری ====================
const gameRoomManager = new GameRoomManager();

// ==================== API اصلی ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==================== API ثبت نام ====================
app.post('/register', async (req, res) => {
    const { phone, username, password, fullname } = req.body;
    const db = readDB();

    if (db.users[phone]) {
        return res.status(400).json({ error: 'شماره تکراری است' });
    }

    const hashedPassword = await hashPassword(password);

    // تولید بخش شارژ تصادفی
    const chargeAmountsSections = [
        [95000, 145000, 170000, 215000, 305000, 535000, 855000, 1150000, 1400000],
        [97000, 137000, 172000, 217000, 307000, 537000, 857000, 1117000, 1500000],
        [98000, 125000, 185000, 230000, 320000, 555000, 755000, 1220000, 1550000],
        [99000, 140000, 195000, 245000, 355000, 545000, 795000, 1000000, 1455000],
        [96000, 144000, 189000, 255000, 345000, 580000, 775000, 998000, 1450000],
        [99000, 130000, 198000, 265000, 435000, 610000, 990000, 1255000],
        [94000, 155000, 210000, 305000, 495000, 610000, 825000, 1115000, 1540000],
        [95000, 139000, 222000, 311000, 500000, 698000, 811000, 1350000],
        [97000, 170000, 235000, 460000, 745000, 985000, 1255000],
        [98000, 145000, 210000, 340000, 525000, 800000, 915000, 1450000],
        [99000, 176000, 265000, 420000, 855000, 1050000, 1560000],
        [101000, 190000, 320000, 470000, 633000, 998000, 1500000],
        [100000, 145000, 188000, 252000, 490000, 760000, 930000, 1300000],
        [96000, 165000, 200000, 395000, 675000, 915000, 1080000, 1460000],
        [93000, 139000, 205000, 300000, 620000, 835000, 1300000],
        [93000, 119000, 185000, 345000, 650000, 865000, 1120000, 1500000],
        [105000, 155000, 220000, 375000, 660000, 965000, 1000000, 1340000],
        [106000, 127000, 185000, 245000, 500000, 850000, 1000000],
        [101000, 168000, 315000, 610000, 833000, 1050000, 1400000],
        [105000, 194000, 203000, 266000, 545000, 1155000, 1250000],
        [95000, 145000, 201000, 355000, 530000, 675000, 811000, 996000, 1500000],
        [96000, 125000, 203000, 407000, 633000, 855000, 1100000],
        [107000, 155000, 215000, 407000, 898000, 1235000, 1600000],
        [106000, 137000, 195000, 250000, 440000, 675000, 998000, 1200000],
        [99000, 149000, 199000, 289000, 395000, 520000, 833000, 1350000],
        [92000, 145000, 222000, 311000, 650000, 885000, 1100000],
        [99000, 165000, 202000, 307000, 501000, 705000, 905000, 1530000],
        [104000, 174000, 207000, 306000, 550000, 1098000, 1350000],
        [110000, 150000, 255000, 365000, 700000, 901000, 1400000],
        [107000, 137000, 206000, 296000, 460000, 823000, 945000, 1000000],
        [105000, 135000, 175000, 266000, 450000, 660000, 825000, 1400000],
        [103000, 130000, 185000, 225000, 400000, 705000, 978000, 1100000],
        [108000, 140000, 165000, 255000, 365000, 520000, 866000, 1355000],
        [101000, 165000, 233000, 408000, 655000, 845000, 1050000, 1300000],
        [103000, 125000, 206000, 410000, 715000, 920000, 1225000, 1500000]
    ];
    const randomChargeSection = chargeAmountsSections[Math.floor(Math.random() * chargeAmountsSections.length)];

    db.users[phone] = {
        phone,
        username,
        fullname: fullname || '',
        password: hashedPassword,
        balance: 0,
        registerDate: new Date().toLocaleDateString('fa-IR'),
        lastLogin: new Date().toLocaleDateString('fa-IR'),
        status: 'active',
        chargeSection: randomChargeSection,
        transactions: [],
        transactionHistory: [],
        winners: [],
        cardPurchases: [],
        withdrawalRequests: [],
        diceProgress: { gamesPlayed: 0, lastRollTime: 0, isActivated: false },
        diceHistory: [],
        cardNumber: '',
        sheba: ''
    };

    writeDB(db);

    const userResponse = { ...db.users[phone] };
    delete userResponse.password;

    res.json({ success: true, user: userResponse });
});

// ==================== API ورود ====================
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const db = readDB();

    let userFound = null;
    for (const phone in db.users) {
        if (db.users[phone].username === username) {
            const isPasswordValid = await verifyPassword(password, db.users[phone].password);
            if (isPasswordValid) {
                userFound = db.users[phone];
                break;
            }
        }
    }

    if (userFound) {
        if (userFound.status === 'banned') {
            return res.status(403).json({ error: 'حساب کاربری شما غیرفعال شده است!' });
        }

if (userFound.status === 'deleted') {
    return res.status(403).json({ error: '🚫 حساب کاربری شما از پنل مدیریت مسدود شده است!' });
}
        userFound.lastLogin = new Date().toLocaleDateString('fa-IR');
        writeDB(db);

        const userResponse = { ...userFound };
        delete userResponse.password;
        res.json({ success: true, user: userResponse });
    } else {
        res.status(401).json({ error: 'نام کاربری یا رمز عبور اشتباه است!' });
    }
});

// ==================== API اطلاعات کاربر ====================
app.get('/api/user/:phone', (req, res) => {
    const db = readDB();
    const user = db.users[req.params.phone];
    if (!user) return res.status(404).json({ error: 'کاربر یافت نشد' });

    const userResponse = { ...user };
    delete userResponse.password;
    res.json(userResponse);
});

app.post('/api/user/update', (req, res) => {
    const { phone, cardNumber, sheba } = req.body;
    const db = readDB();
    if (!db.users[phone]) return res.status(404).json({ error: 'کاربر یافت نشد' });

    if (cardNumber !== undefined) db.users[phone].cardNumber = cardNumber;
    if (sheba !== undefined) db.users[phone].sheba = sheba;

    writeDB(db);
    const userResponse = { ...db.users[phone] };
    delete userResponse.password;
    res.json({ success: true, user: userResponse });
});

// ==================== API برداشت ====================
app.post('/withdrawal', (req, res) => {
    const { phone, amount, cardNumber, fullName } = req.body;
    const db = readDB();

    if (!db.users[phone]) return res.status(404).json({ error: 'کاربر یافت نشد' });
    if ((db.users[phone].balance || 0) < parseInt(amount)) return res.status(400).json({ error: 'موجودی کافی نیست' });

    if (!db.withdrawalRequests) db.withdrawalRequests = [];
    db.withdrawalRequests.push({
        id: Date.now().toString(),
        userId: phone,
        username: db.users[phone].username || 'ناشناس',
        amount: parseInt(amount),
        cardNumber,
        fullName,
        status: 'pending',
        requestDate: new Date().toLocaleDateString('fa-IR'),
        requestTime: new Date().toLocaleTimeString('fa-IR')
    });

    db.users[phone].balance = (db.users[phone].balance || 0) - parseInt(amount);

    if (!db.users[phone].transactions) db.users[phone].transactions = [];
    db.users[phone].transactions.push({
        type: 'برداشت',
        description: 'درخواست برداشت وجه',
        amount: parseInt(amount),
        date: new Date().toLocaleDateString('fa-IR'),
        time: new Date().toLocaleTimeString('fa-IR')
    });

    if (!db.users[phone].transactionHistory) db.users[phone].transactionHistory = [];
    db.users[phone].transactionHistory.push({
        type: 'withdrawal',
        amount: parseInt(amount),
        dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
        timestamp: new Date().toISOString(),
        description: 'برداشت وجه',
        status: 'pending'
    });

    db.users[phone].lastWithdrawalRequest = Date.now();
    writeDB(db);
    res.json({ success: true });
});

// ==================== API شارژ (شبیه‌سازی) ====================
app.post('/api/charge', (req, res) => {
    const { phone, amount } = req.body;
    const db = readDB();

    if (!db.users[phone]) return res.status(404).json({ error: 'کاربر یافت نشد' });

    // بررسی اعتبار مبلغ
    const validAmounts = db.users[phone].chargeSection || [];
    if (!validAmounts.includes(parseInt(amount))) {
        return res.status(400).json({ error: 'مبلغ وارد شده معتبر نیست' });
    }

    db.users[phone].balance = (db.users[phone].balance || 0) + parseInt(amount);

    if (!db.users[phone].transactions) db.users[phone].transactions = [];
    db.users[phone].transactions.push({
        type: 'واریز',
        description: 'شارژ حساب',
        amount: parseInt(amount),
        date: new Date().toLocaleDateString('fa-IR'),
        time: new Date().toLocaleTimeString('fa-IR')
    });

    if (!db.users[phone].transactionHistory) db.users[phone].transactionHistory = [];
    db.users[phone].transactionHistory.push({
        type: 'charge',
        amount: parseInt(amount),
        dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
        timestamp: new Date().toISOString(),
        description: 'شارژ حساب'
    });

    writeDB(db);

    const userResponse = { ...db.users[phone] };
    delete userResponse.password;
    res.json({ success: true, user: userResponse });
});

// ==================== API تاس شانسی ====================
app.post('/api/dice-roll', (req, res) => {
    const { phone } = req.body;
    const db = readDB();
    if (!db.users[phone]) return res.status(404).json({ error: 'کاربر یافت نشد' });

    const user = db.users[phone];
    const now = Date.now();
    const cooldownTime = 24 * 60 * 60 * 1000;
    const requiredGames = 5;

    const hasCharged = user.balance > 0;
    const gamesPlayed = user.diceProgress?.gamesPlayed || 0;
    const lastRoll = user.diceProgress?.lastRollTime || 0;

    if (!hasCharged) {
        return res.status(400).json({ error: 'برای استفاده از تاس شانسی باید حساب خود را شارژ کنید!' });
    }
    if (gamesPlayed < requiredGames) {
        return res.status(400).json({ error: `برای فعال‌سازی تاس شانسی باید ${requiredGames} دست بازی کنید! (${gamesPlayed}/${requiredGames})` });
    }
    if (now - lastRoll < cooldownTime) {
        const remainingTime = cooldownTime - (now - lastRoll);
        const hours = Math.floor(remainingTime / (1000 * 60 * 60));
        const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
        return res.status(400).json({ error: `هر ۲۴ ساعت یکبار. ${hours} ساعت و ${minutes} دقیقه دیگر` });
    }

    // اجرای تاس روی سرور
    const result = rollDiceOnServer();

    if (result.amount > 0) {
        user.balance += result.amount;

        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'جایزه',
            description: 'برنده تاس شانسی',
            amount: result.amount,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });

        if (!user.transactionHistory) user.transactionHistory = [];
        user.transactionHistory.push({
            type: 'dice-win',
            amount: result.amount,
            dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
            timestamp: new Date().toISOString(),
            description: 'برنده تاس شانسی'
        });

        if (!user.diceHistory) user.diceHistory = [];
        user.diceHistory.push({
            type: 'جایزه تاس شانسی',
            amount: result.amount,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });
    } else {
        if (!user.transactions) user.transactions = [];
        user.transactions.push({
            type: 'تاس شانسی',
            description: 'متأسفانه برنده نشدید',
            amount: 0,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });

        if (!user.transactionHistory) user.transactionHistory = [];
        user.transactionHistory.push({
            type: 'dice-no-win',
            amount: 0,
            dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
            timestamp: new Date().toISOString(),
            description: 'باخت در تاس شانسی'
        });

        if (!user.diceHistory) user.diceHistory = [];
        user.diceHistory.push({
            type: 'باخت تاس شانسی',
            amount: 0,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });
    }

    if (!user.diceProgress) user.diceProgress = { gamesPlayed: 0, lastRollTime: 0 };
    user.diceProgress.lastRollTime = now;

    writeDB(db);

    const userResponse = { ...user };
    delete userResponse.password;

    res.json({ success: true, result: result, user: userResponse });
});

// ==================== API افزایش gamesPlayed ====================
app.post('/api/dice-game-played', (req, res) => {
    const { phone } = req.body;
    const db = readDB();
    if (!db.users[phone]) return res.status(404).json({ error: 'کاربر یافت نشد' });

    if (!db.users[phone].diceProgress) {
        db.users[phone].diceProgress = { gamesPlayed: 0, lastRollTime: 0, isActivated: false };
    }

    if (db.users[phone].balance > 0) {
        db.users[phone].diceProgress.gamesPlayed++;
        writeDB(db);
    }

    const userResponse = { ...db.users[phone] };
    delete userResponse.password;
    res.json({ success: true, gamesPlayed: db.users[phone].diceProgress.gamesPlayed, user: userResponse });
});

// ==================== API پنل مدیریت ====================
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'Rafael' && password === '11228') {
        res.json({ success: true, admin: { username } });
    } else {
        res.status(401).json({ error: 'نام کاربری یا رمز اشتباه' });
    }
});

app.get('/api/admin/dashboard', (req, res) => {
    const db = readDB();
    const users = Object.values(db.users);
    res.json({
        totalUsers: users.length,
        totalBalance: users.reduce((sum, u) => sum + (u.balance || 0), 0),
        activeUsers: users.filter(u => u.status === 'active').length,
        bannedUsers: users.filter(u => u.status === 'banned').length,
        pendingWithdrawals: db.withdrawalRequests?.filter(w => w.status === 'pending').length || 0,
        totalTransactions: db.transactions?.length || 0,
        totalDiceRolls: db.diceRolls?.length || 0
    });
});

app.get('/api/admin/users', (req, res) => {
    const db = readDB();
    const users = Object.values(db.users).map(user => ({
        id: user.phone,
        username: user.username,
        phone: user.phone,
        balance: user.balance || 0,
        registerDate: user.registerDate,
        lastLogin: user.lastLogin,
        status: user.status || 'active'
    }));
    res.json(users);
});

app.post('/api/admin/charge', (req, res) => {
    const { phone, amount, description } = req.body;
    const db = readDB();
    if (!db.users[phone]) return res.json({ success: false, error: 'کاربر یافت نشد' });

    db.users[phone].balance = (db.users[phone].balance || 0) + parseInt(amount);
    if (!db.transactions) db.transactions = [];
    db.transactions.push({
        id: Date.now().toString(),
        userId: phone,
        username: db.users[phone].username,
        type: 'واریز',
        description: description || 'شارژ توسط ادمین',
        amount: parseInt(amount),
        date: new Date().toLocaleDateString('fa-IR'),
        time: new Date().toLocaleTimeString('fa-IR')
    });

    if (!db.users[phone].transactions) db.users[phone].transactions = [];
    db.users[phone].transactions.push({
        type: 'واریز',
        description: description || 'شارژ توسط ادمین',
        amount: parseInt(amount),
        date: new Date().toLocaleDateString('fa-IR'),
        time: new Date().toLocaleTimeString('fa-IR')
    });

    if (!db.users[phone].transactionHistory) db.users[phone].transactionHistory = [];
    db.users[phone].transactionHistory.push({
        type: 'admin-bonus',
        amount: parseInt(amount),
        dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
        timestamp: new Date().toISOString(),
        description: description || 'شارژ توسط ادمین'
    });

    writeDB(db);
    res.json({ success: true, message: `حساب کاربر ${amount} تومان شارژ شد` });
});

app.get('/api/admin/withdrawals', (req, res) => {
    const db = readDB();
    res.json(db.withdrawalRequests || []);
});

app.post('/api/admin/withdrawals/approve', (req, res) => {
    const { id } = req.body;
    const db = readDB();
    const withdrawal = db.withdrawalRequests?.find(w => w.id === id);
    if (withdrawal) withdrawal.status = 'approved';
    writeDB(db);
    res.json({ success: true });
});

app.get('/api/admin/transactions', (req, res) => {
    const db = readDB();
    res.json(db.transactions || []);
});

app.get('/api/admin/dice', (req, res) => {
    const db = readDB();
    res.json(db.diceRolls || []);
});

app.get('/api/admin/settings', (req, res) => {
    const db = readDB();
    res.json(db.settings || { minWithdrawal: 10000, maxCards: 4, diceCooldown: 24 });
});

app.post('/api/admin/settings', (req, res) => {
    const { minWithdrawal, maxCards, diceCooldown } = req.body;
    const db = readDB();
    db.settings = { minWithdrawal, maxCards, diceCooldown };
    writeDB(db);
    res.json({ success: true });
});
// ==================== API حذف کاربر ====================
app.post('/api/admin/user/delete', (req, res) => {
    const { phone } = req.body;
    const db = readDB();

    if (!db.users[phone]) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
    }

db.users[phone].status = 'deleted';
    writeDB(db);
    res.json({ success: true, message: 'کاربر با موفقیت حذف شد' });
});
// ==================== API حذف درخواست برداشت ====================
app.post('/api/admin/withdrawals/delete', (req, res) => {
    const { id } = req.body;
    const db = readDB();

    if (!db.withdrawalRequests) {
        return res.status(404).json({ error: 'درخواستی یافت نشد' });
    }

    const initialLength = db.withdrawalRequests.length;
    db.withdrawalRequests = db.withdrawalRequests.filter(r => r.id !== id);

    if (db.withdrawalRequests.length === initialLength) {
        return res.status(404).json({ error: 'درخواست مورد نظر یافت نشد' });
    }

    writeDB(db);
    res.json({ success: true, message: 'درخواست با موفقیت حذف شد' });
});
// ==================== Socket.IO ====================
io.on('connection', (socket) => {
    console.log('🔌 کاربر متصل شد:', socket.id);

    socket.on('authenticate', (data) => {
        socket.userId = data.phone;
        socket.username = data.username;
        console.log(`👤 کاربر احراز هویت شد: ${data.username}`);
    });

    // وارد شدن به اتاق بازی
    socket.on('joinRoom', (data) => {
        const { roomPrice, phone } = data;

        // ترک اتاق قبلی
        if (socket.currentRoomId) {
            const oldSession = gameRoomManager.getSession(socket.currentRoomId);
            if (oldSession) {
                oldSession.connectedSockets.delete(socket.id);
            }
            socket.leave(socket.currentRoomId);
        }

        const session = gameRoomManager.getOrCreateRoom(parseInt(roomPrice));
        socket.join(session.roomId);
        socket.currentRoomId = session.roomId;
        session.connectedSockets.add(socket.id);

        // ارسال وضعیت فعلی اتاق
        socket.emit('roomJoined', {
            roomId: session.roomId,
            roomPrice: session.roomPrice,
            timer: session.timer,
            soldCards: session.soldCards,
            players: session.getPlayerList(),
            status: session.status,
            linePrize: session.linePrize,
            fullHousePrize: session.fullHousePrize
        });
    });

    // خرید کارت
    socket.on('purchaseCards', async (data) => {
        const { phone, cardCount } = data;
        const roomId = socket.currentRoomId;

        if (!roomId) {
            socket.emit('purchaseError', { error: 'اتاق بازی پیدا نشد!' });
            return;
        }

        const session = gameRoomManager.getSession(roomId);
        if (!session) {
            socket.emit('purchaseError', { error: 'اتاق بازی پیدا نشد!' });
            return;
        }

        if (session.timer <= 0) {
            socket.emit('purchaseError', { error: 'زمان خرید کارت به پایان رسیده است!' });
            return;
        }

        const db = readDB();
        const user = db.users[phone];
        if (!user) {
            socket.emit('purchaseError', { error: 'کاربر یافت نشد!' });
            return;
        }

        const totalPrice = session.roomPrice * cardCount;
        const userCardsInSession = session.userCardsPurchased.get(phone) || 0;

        if (userCardsInSession + cardCount > 4) {
            socket.emit('purchaseError', { error: 'شما نمی‌توانید بیشتر از ۴ کارت در هر دست خریداری کنید!' });
            return;
        }

        if (user.balance < totalPrice) {
            socket.emit('purchaseError', { error: 'موجودی کافی نیست! لطفا حساب خود را شارژ کنید.' });
            return;
        }

        // کسر از موجودی
        db.users[phone].balance -= totalPrice;

        if (!db.users[phone].transactions) db.users[phone].transactions = [];
        db.users[phone].transactions.push({
            type: 'برداشت',
            description: 'خرید کارت بازی',
            amount: totalPrice,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });

        if (!db.users[phone].transactionHistory) db.users[phone].transactionHistory = [];
        db.users[phone].transactionHistory.push({
            type: 'purchase',
            amount: totalPrice,
            dateTime: new Date().toLocaleDateString('fa-IR') + ' ' + new Date().toLocaleTimeString('fa-IR'),
            timestamp: new Date().toISOString(),
            description: `خرید ${cardCount} کارت اتاق ${session.roomPrice} تومانی`
        });

        if (!db.users[phone].dailyGames) db.users[phone].dailyGames = [];
        db.users[phone].dailyGames.push({
            roomPrice: session.roomPrice,
            cardCount: cardCount,
            prizeWon: 0,
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR'),
            timestamp: new Date().toISOString()
        });

        // افزایش gamesPlayed برای تاس شانسی
        if (db.users[phone].balance > 0 || true) {
            if (!db.users[phone].diceProgress) db.users[phone].diceProgress = { gamesPlayed: 0, lastRollTime: 0 };
            db.users[phone].diceProgress.gamesPlayed++;
        }

        if (!db.users[phone].cardPurchases) db.users[phone].cardPurchases = [];
        db.users[phone].cardPurchases.push({
            cardCount: cardCount,
            roomPrice: session.roomPrice,
            winAmount: 0,
            result: 'بدون برنده شدن',
            date: new Date().toLocaleDateString('fa-IR'),
            time: new Date().toLocaleTimeString('fa-IR')
        });

        writeDB(db);

        // اضافه کردن بازیکن واقعی به اتاق
        session.addRealPlayer({ phone, username: user.username }, cardCount);

        // ارسال کارت‌ها به کاربر
        const userCards = session.getUserCards(phone);

        socket.emit('purchaseSuccess', {
            cardCount: cardCount,
            totalPrice: totalPrice,
            cards: userCards,
            soldCards: session.soldCards,
            balance: db.users[phone].balance
        });

        // به‌روزرسانی اتاق
        session.emitRoomUpdate();
    });

    // درخواست کارت‌ها برای نمایش بازی
    socket.on('getGameCards', (data) => {
        const { phone } = data;
        const roomId = socket.currentRoomId;
        if (!roomId) return;

        const session = gameRoomManager.getSession(roomId);
        if (!session) return;

        const cardsData = session.getAllCardsForDisplay(phone);
        socket.emit('gameCards', {
            roomId: session.roomId,
            userCards: cardsData.userCards,
            otherCards: cardsData.otherCards,
            calledNumbers: session.calledNumbers,
            highlightedNumbers: Array.from(session.highlightedNumbers)
        });
    });

    // ترک اتاق
    socket.on('leaveRoom', () => {
        if (socket.currentRoomId) {
            const session = gameRoomManager.getSession(socket.currentRoomId);
            if (session) {
                session.connectedSockets.delete(socket.id);
            }
            socket.leave(socket.currentRoomId);
            socket.currentRoomId = null;
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 کاربر قطع شد:', socket.id);
        if (socket.currentRoomId) {
            const session = gameRoomManager.getSession(socket.currentRoomId);
            if (session) {
                session.connectedSockets.delete(socket.id);
            }
        }
    });
});
// ==================== ریست خودکار روزانه ====================
function resetDailyGames() {
    const db = readDB();
    const now = new Date();
    const tehranTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
    const year = tehranTime.getFullYear();
    const month = String(tehranTime.getMonth() + 1).padStart(2, '0');
    const day = String(tehranTime.getDate()).padStart(2, '0');
    const today = `${year}/${month}/${day}`;
    
    const lastResetDate = db.lastDailyReset || '';
    
    // اگر امروز ریست نشده و ساعت >= 9 هست
    if (lastResetDate !== today && tehranTime.getHours() >= 9) {
        console.log('🔄 ریست روزانه انجام میشود...');
        
        // پاک کردن dailyGames برای همه کاربران
        for (const phone in db.users) {
            if (db.users[phone]) {
                db.users[phone].dailyGames = [];
            }
        }
        
        db.lastDailyReset = today;
        writeDB(db);
        console.log('✅ ریست روزانه انجام شد برای تاریخ:', today);
    }
}

// اجرای ریست هر 60 ثانیه
setInterval(resetDailyGames, 60000);

// اجرای یکبار در شروع سرور
resetDailyGames();
// ==================== اجرای سرور ====================
server.listen(PORT, () => {
    console.log('🚀 سرور کامل فینگیلی اجرا شد: http://localhost:' + PORT);
    console.log('🎮 بازی: http://localhost:' + PORT);
    console.log('📊 پنل مدیریت: http://localhost:' + PORT + '/admin.html');
});

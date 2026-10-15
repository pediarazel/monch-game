// خواندن توکن JWT ذخیره‌شده از ورود
const token =
  localStorage.getItem('token') ||
  sessionStorage.getItem('token');

if (!token) {
  alert('لطفاً ابتدا وارد حساب کاربری شوید.');
  window.location.href = '/lobbyDaberna.html';
}

// دریافت شناسه اتاق از URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || '5';
function getBaseTierKey(idStr) {
  return String(idStr).split('#')[0];
}

// اتصال به سرور دبرنا از طریق Nginx
const socket = io({
  path: '/daberna/socket.io',
  auth: { token },
  transports: ['websocket', 'polling']
});
let myUserId = null;

// دریافت اطلاعات اولیه و ذخیره آیدی کاربر
socket.on('initSync', (data) => {
  if (data.userId) {
    myUserId = data.userId;
  }
  if (data.balance !== undefined) {
    const balanceElem = document.getElementById('userBalance');
    if (balanceElem) {
      balanceElem.textContent = Number(data.balance).toLocaleString('fa-IR');
    }
  }
});

let drawnNumbersSet = new Set();
let myCards = [];

// مدیریت صدای بازی
let isMuted = localStorage.getItem('daberna_muted') === 'true';

function updateMuteBtn() {
  const btn = document.getElementById('muteBtn');
  if (btn) btn.textContent = isMuted ? '🔇' : '🔊';
}

function toggleMute() {
  isMuted = !isMuted;
  localStorage.setItem('daberna_muted', isMuted);
  updateMuteBtn();
}

// مقداردهی اولیه آیکون پس از لود صفحه
document.addEventListener('DOMContentLoaded', updateMuteBtn);

// پخش صدای مهره
function playNumberAudio(num) {
  if (isMuted) return;
  try {
    const audio = new Audio(`/audio/audio.number_1,90/number_${num}.mp3`);
    audio.play().catch(e => console.log('Audio autoplay prevented:', e));
  } catch (err) {
    console.error('Audio error:', err);
  }
}

// اتصال موفق و ورود به اتاق
socket.on('connect', () => {
  socket.emit('joinDabernaRoom', { roomId });
});

socket.on('initSync', (data) => {
  document.getElementById('userBalance').textContent =  (Number(data.balance) * 1000) .toLocaleString('fa-IR');
});
// اضافه کردن این بخش برای ریست خودکار:
socket.on('roomReset', () => {
    console.log("Room reset received, reloading page...");
    window.location.reload();
});

let opponentCardsRendered = false;

// دریافت آخرین وضعیت اتاق
socket.on('roomState', (state) => {
  if (getBaseTierKey(state.roomId) !== getBaseTierKey(roomId)) return;

  if (state.status === 'WAITING') {

      drawnNumbersSet.clear();
      myCards = [];
      opponentCardsRendered = false;
      document.getElementById('currentBarrel').textContent = '—';
      document.getElementById('historyContainer').innerHTML = '';
      document.getElementById('myCards').innerHTML = '';
      document.getElementById('opponentCards').innerHTML = '';
  }


  // اضافه کردن این بخش برای آپدیت تایمر:
const timerEl = document.getElementById('timer');
if (timerEl) {
    timerEl.textContent = state.timer !== undefined ? state.timer : "۱۵۰";
}

  document.getElementById('roomCode').textContent = state.code;

  if (state.prizePool !== undefined) {
    const prizeEl = document.getElementById('prizePoolDisplay');
    if (prizeEl) prizeEl.textContent = Number(state.prizePool).toLocaleString('fa-IR');
  }

  if (state.drawnNumbers) {
    state.drawnNumbers.forEach(n => drawnNumbersSet.add(n));
    renderHistory(state.drawnNumbers);
  }

  if (state.myCardsData && myCards.length === 0) {
    myCards = state.myCardsData;
    renderCards(myCards);
  }

  if (state.opponentCards && !opponentCardsRendered && state.opponentCards.length > 0) {
    renderOpponentCards(state.opponentCards);
    opponentCardsRendered = true;
  }
});

// کشیده شدن شماره جدید توسط سرور
socket.on('numberDrawn', (data) => {
  if (getBaseTierKey(data.roomId) !== getBaseTierKey(roomId)) return;
  const { number, history } = data;

  drawnNumbersSet.add(number);

  // به‌روزرسانی نمایشگر مهره بزرگ
  const barrel = document.getElementById('currentBarrel');
  barrel.textContent = number;
  barrel.style.animation = 'none';
  void barrel.offsetWidth; // Trigger reflow
  barrel.style.animation = 'pop 0.4s ease-out';

  // پخش صدای فارسی شماره
  playNumberAudio(number);

  // به‌روزرسانی نوار سابقه
  renderHistory(history);

  // علامت‌گذاری خودکار عدد روی تمام کارت‌ها
  document.querySelectorAll(`.cell[data-val="${number}"]`).forEach(cell => {
    cell.classList.add('marked');
  });
});

// تابع پخش صدای پیروزی (فقط برای بازیکن برنده)
function playWinAudio() {
  if (isMuted) return;
  try {
    const audio = new Audio('/audio/win.mp3');
    audio.play().catch(e => console.log('Win audio autoplay prevented:', e));
  } catch (err) {
    console.error('Win audio error:', err);
  }
}

// پایان بازی
socket.on('gameEnded', (data) => {
    if (data.roomId && getBaseTierKey(data.roomId) !== getBaseTierKey(roomId)) return;

    console.log("Game Ended Received:", data);

    const winnerName = data.winnerUsername || 'ناشناس';
    const prize = data.prize || 0;

    // تشخیص برنده (مقایسه آیدی کاربر جاری با برنده)
    const isMyWin = myUserId && data.winnerId && Number(data.winnerId) === Number(myUserId);

    // پیدا کردن تمام گزینه‌های احتمالی مودال و متن در HTML
    const modal = document.getElementById('endModal') || document.getElementById('victoryModal') || document.getElementById('winnerModal');
    const titleEl = document.getElementById('modalTitle') || document.getElementById('title');
    const descEl = document.getElementById('modalDesc') || document.getElementById('winnerText');

    // تنظیم متن عنوان مودال
    if (titleEl) {
        titleEl.textContent = data.winnerUsername 
            ? (isMyWin ? '🏆 تبریک! شما برنده شدید!' : '🏆 بازی به پایان رسید')
            : 'پایان دور';
    }

    // تنظیم متن توضیحات مودال
    if (descEl) {
        if (data.winnerUsername) {
            descEl.innerHTML = isMyWin 
                ? `<b>شما برنده جایزه شدید!</b><br>مبلغ جایزه: <b>${Number(prize).toLocaleString('fa-IR')} تومان</b>`
                : `برنده دور: <b>${winnerName}</b><br>مبلغ جایزه: <b>${Number(prize).toLocaleString('fa-IR')} تومان</b>`;
        } else {
            descEl.textContent = data.message || 'بازی بدون برنده خاتمه یافت.';
        }
    }

    // نمایش دادن مودال وسط صفحه به صورت بزرگ، خوانا و تمام‌صفحه
    // نمایش دادن مودال وسط صفحه به صورت بزرگ، خوانا و تمام‌صفحه
    if (modal) {
        modal.style.display = 'flex';
        modal.style.flexDirection = 'column';
        modal.style.justifyContent = 'center'; // اصلاح شده با علامت مساوی
        modal.style.alignItems = 'center';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.zIndex = '99999';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.75)';
        modal.classList.add('show');
    }

    // 🎵 تولید و پخش صدای پیروزی (بدون نیاز به فایل MP3)
    if (isMyWin && !isMuted) {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            
            // تابع پخش یک نت صوتی با فرکانس مشخص
            const playTone = (frequency, startTime, duration) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'triangle'; // نوع موج دلنشین
                osc.frequency.value = frequency;
                
                gain.gain.setValueAtTime(0.3, audioCtx.currentTime + startTime);
                gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + startTime + duration);
                
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                
                osc.start(audioCtx.currentTime + startTime);
                osc.stop(audioCtx.currentTime + startTime + duration);
            };

            // ملودی کوتاه تبریک (سه نت پشت سر هم: دو، می، سل)
            playTone(523.25, 0, 0.15);     // نت C5
            playTone(659.25, 0.15, 0.15);  // نت E5
            playTone(783.99, 0.30, 0.35);  // نت G5 (کشیده تر)
        } catch (err) {
            console.log("Web Audio API not supported or blocked:", err);
        }
    }

    // هدایت خودکار به لابی پس از ۹ ثانیه
    setTimeout(() => {
        window.location.href = '/lobbyDaberna.html';
    }, 9000);
});

socket.on('roomReset', () => {
    window.location.reload(); // این دستور باعث می‌شود صفحه خودکار رفرش شود
});


socket.on('errorMsg', (msg) => {
  alert(msg);
});

// ترسیم نوار تاریخچه مهره‌ها
function renderHistory(history) {
  const strip = document.getElementById('historyStrip');
  strip.innerHTML = '';
  const rev = [...history].reverse();
  rev.forEach(num => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.textContent = num;
    strip.appendChild(el);
  });
}

// ترسیم کارت‌های ۳ در ۹ کاربر
function renderCards(cards) {
  const container = document.getElementById('cards-container');
  container.innerHTML = '';

  cards.forEach((card, cIdx) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'card-box';

    const header = document.createElement('div');
    header.className = 'card-header';
    header.textContent = `کارت #${cIdx + 1}`;
    cardEl.appendChild(header);

    const gridEl = document.createElement('div');
    gridEl.className = 'grid-3x9';

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) {
        const val = card.grid[r][c];
        const cell = document.createElement('div');
        cell.className = 'cell';

        if (val === null) {
          cell.classList.add('empty');
        } else {
          cell.textContent = val;
          cell.setAttribute('data-val', val);
          if (drawnNumbersSet.has(val)) {
            cell.classList.add('marked');
          }
          // قابلیت تغییر وضعیت دستی با کلیک
          cell.addEventListener('click', () => {
            if (drawnNumbersSet.has(val)) {
              cell.classList.toggle('marked');
            }
          });
        }

        gridEl.appendChild(cell);
      }
    }

    cardEl.appendChild(gridEl);
    container.appendChild(cardEl);
  });
}

function renderOpponentCards(cards) {
  const container = document.getElementById('opponents-container');
  if (!container) return;
  container.innerHTML = '';

  cards.forEach((card) => {
    const cardEl = document.createElement('div');
    cardEl.className = 'card-box';
    cardEl.style.borderColor = '#555';

    const header = document.createElement('div');
    header.className = 'card-header';
    header.style.background = '#2c3e50';
    header.style.color = '#fff';
    header.style.padding = '4px 8px';
    header.style.borderRadius = '4px';
    header.textContent = `بازیکن: ${card.username} (کارت #${card.cardIndex})`;
    cardEl.appendChild(header);

    const gridEl = document.createElement('div');
    gridEl.className = 'grid-3x9';

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) {
        const val = card.grid[r][c];
        const cell = document.createElement('div');
        cell.className = 'cell';

        if (val === null) {
          cell.classList.add('empty');
        } else {
          cell.textContent = val;
          cell.setAttribute('data-val', val);
          if (drawnNumbersSet.has(val)) {
            cell.classList.add('marked');
          }
        }
        gridEl.appendChild(cell);
      }
    }

    cardEl.appendChild(gridEl);
    container.appendChild(cardEl);
  });
}
// دریافت آپدیت موجودی از سرور
socket.on('balanceUpdated', (data) => {
    // اگر آیدی المنت موجودی در صفحه شما متفاوت است، همان را جایگزین 'balance' کن
    const balanceEl = document.getElementById('balance');
    if (balanceEl) {
        balanceEl.textContent = Number(data.balance).toLocaleString('fa-IR');
    }
});

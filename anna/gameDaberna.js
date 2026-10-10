// خواندن توکن JWT ذخیره‌شده از ورود
const token = localStorage.getItem('token') || sessionStorage.getItem('token');
if (!token) {
  alert('لطفاً ابتدا وارد حساب کاربری شوید.');
  window.location.href = '/lobbyDaberna.html';
}

// دریافت شناسه اتاق از URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('room') || '5';

// اتصال به سرور دبرنا (پورت ۳۰۰۳)
const socket = io({
  auth: { token: token },
  transports: ['websocket', 'polling']
});

let drawnNumbersSet = new Set();
let myCards = [];

// پخش صدای مهره
function playNumberAudio(num) {
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
  document.getElementById('userBalance').textContent = Number(data.balance).toLocaleString('fa-IR');
});

// دریافت آخرین وضعیت اتاق
socket.on('roomState', (state) => {
  document.getElementById('roomCode').textContent = state.code;
  
  if (state.drawnNumbers) {
    state.drawnNumbers.forEach(n => drawnNumbersSet.add(n));
    renderHistory(state.drawnNumbers);
  }

  if (state.myCardsData && myCards.length === 0) {
    myCards = state.myCardsData;
    renderCards(myCards);
  }
});

// کشیده شدن شماره جدید توسط سرور
socket.on('numberDrawn', ({ number, history }) => {
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
});

// پایان بازی
socket.on('gameEnded', (data) => {
  const modal = document.getElementById('endModal');
  const title = document.getElementById('modalTitle');
  const desc = document.getElementById('modalDesc');

  if (data.winnerUsername) {
    title.textContent = '🏆 بازی به پایان رسید!';
    desc.innerHTML = `برنده: <b>${data.winnerUsername}</b><br>مبلغ جایزه: <b>${Number(data.prize).toLocaleString('fa-IR')} تومان</b>`;
  } else {
    title.textContent = 'پایان دور';
    desc.textContent = data.message || 'بازی بدون برنده خاتمه یافت.';
  }

  modal.style.display = 'flex';
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
          // اگر شماره قبلاً خوانده شده باشد، با کلیک یا به صورت خودکار قابل علامت‌گذاری است
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

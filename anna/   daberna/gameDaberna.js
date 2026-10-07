class GameVoiceSystem {
    constructor() {
      this.isEnabled = true;
      this.audioInterval = null;
      this.isPlaying = false;
      this.usedNumbers = new Set();
      this.audioFilesPath = './audio_files/';
      this.isGameStarted = false;
      this.currentSessionId = null;
    }

    async init() {
      console.log('🔊 سیستم صوتی راه‌اندازی شد');
      this.loadSettings();
    }

    startGame(sessionId) {
      console.log('🎮 بازی شروع شد - Session:', sessionId);
      this.currentSessionId = sessionId;
      this.isGameStarted = true;
          // ✅ فعال کردن صدا برای شروع بازی
      this.isEnabled = true;
      localStorage.setItem('game_sound_enabled', true);  

      // اگر قبلاً در حال پخش است، متوقف کن
      this.stop();
      
      // ۳ ثانیه صبر کن سپس صدا شروع شود
      setTimeout(() => {
        this.startAutoPlay();
      }, 3000);
    }

    startAutoPlay() {
      console.log('🎬 شروع پخش خودکار صدا');
      
      if (this.isPlaying) {
        console.log('⏭️ صدا در حال پخش است');
        return;
      }
      
      // اگر تایمر قبلی وجود دارد، پاک کن
      if (this.audioInterval) {
        clearInterval(this.audioInterval);
        this.audioInterval = null;
      }
      
      this.isPlaying = true;
      console.log('✅ پخش صدا شروع شد');
      
      // اول یک عدد پخش کن
      this.playRandomNumber();
      
      // سپس تایمر را تنظیم کن
      this.audioInterval = setInterval(() => {
        this.playRandomNumber();
      }, 3000);
    }

    playRandomNumber() {
      // اگر صدا غیرفعال است یا بازی شروع نشده یا در حال پخش نیستیم
      if (!this.isEnabled || !this.isGameStarted || !this.isPlaying) {
        console.log('⏹️ صدا پخش نمی‌شود (شرایط برقرار نیست)');
        return;
      }

      // اگر کاربر در session دیگری است
      if (!currentGameSession || currentGameSession.roomId !== this.currentSessionId) {
        console.log('🚫 session مطابقت ندارد');
        return;
      }

      // اگر کاربر در صفحه بازی نیست
      const gamePage = document.getElementById('game');
      if (!gamePage || !gamePage.classList.contains('active')) {
        console.log('📱 صفحه بازی فعال نیست');
        this.stop();
        return;
      }

      const randomNum = Math.floor(Math.random() * 90) + 1;
      console.log(`🎲 پخش عدد ${randomNum}`);
      
      this.playNumber(randomNum);
    }

    playNumber(number) {
      if (!this.isEnabled || !this.isPlaying) return;

      // توقف همه صداهای قبلی
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        audio.pause();
        audio.currentTime = 0;
      });

      const audioPath = `${this.audioFilesPath}number_${number}.mp3`;
      console.log(`🔊 تلاش برای پخش: ${audioPath}`);

      const audio = new Audio(audioPath);

      audio.onplay = () => {
        console.log(`✅ پخش شد: number_${number}.mp3`);
      };

      audio.onerror = (error) => {
        console.log(`❌ خطا در پخش number_${number}.mp3:`, error);
      };

      audio.play().catch(error => {
        console.log('❌ خطای پخش:', error);
      });
    }

    stop() {
      console.log('🛑 تابع stop() فراخوانی شد');
      
      // توقف تایمر
      if (this.audioInterval) {
        clearInterval(this.audioInterval);
        this.audioInterval = null;
        console.log('✅ تایمر متوقف شد');
      }
      
      // توقف پخش
      this.isPlaying = false;
this.isEnabled = false;
      this.isGameStarted = false;
      
      // توقف همه صداها
      const audioElements = document.querySelectorAll('audio');
      audioElements.forEach(audio => {
        audio.pause();
        audio.currentTime = 0;
      });
      
 console.log('✅ سیستم صوتی ۱۰۰٪ متوقف شد - isPlaying:', this.isPlaying, 'isEnabled:', this.isEnabled);
    }

    toggle() {
      console.log('🔄 دکمه صدا کلیک شد');
      
      this.isEnabled = !this.isEnabled;
      console.log(this.isEnabled ? '🔊 صدا روشن' : '🔇 صدا خاموش');
      
      // اگر صدا خاموش شد، همه چیز را متوقف کن
      if (!this.isEnabled) {
        console.log('🛑 صدا خاموش شد - همه چیز متوقف می‌شود');
        this.stop();
      }
      
      localStorage.setItem('game_sound_enabled', this.isEnabled);
      return this.isEnabled;
    }

    loadSettings() {
      const savedSetting = localStorage.getItem('game_sound_enabled');
      if (savedSetting !== null) {
        this.isEnabled = JSON.parse(savedSetting);
      }
    }
  }

  // ایجاد سیستم صوتی
  const gameVoiceSystem = new GameVoiceSystem();

  document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 صفحه لود شد');
    gameVoiceSystem.init();
// ✅ راه‌اندازی سیستم گزارش مالی
reportSystem = new ReportSystem();
console.log('📊 سیستم گزارش مالی راه‌اندازی شد');
  });
// گوش دادن به تغییرات localStorage برای آپدیت خودکار وضعیت برداشت
window.addEventListener('storage', function(e) {
    if (e.key === 'fingili_withdrawal_requests' && currentUser) {
        const allRequests = JSON.parse(localStorage.getItem('fingili_withdrawal_requests')) || [];
        const userRequests = allRequests.filter(req => req.userId === currentUser.phone);
        const lastRequest = userRequests[userRequests.length - 1];
        
        if (lastRequest && lastRequest.status !== 'pending') {
            if (currentUser.transactions) {
                const withdrawalTransaction = currentUser.transactions.find(t => 
                    t.type === 'برداشت' && t.status === 'pending'
                );
                if (withdrawalTransaction) {
                    withdrawalTransaction.status = lastRequest.status;
                    if (lastRequest.status === 'completed') {
                        withdrawalTransaction.description = 'واریز شد';
                    } else if (lastRequest.status === 'rejected') {
                        withdrawalTransaction.description = 'رد شد - خطا در اتصال';
                    }
                    localStorage.setItem('fingili_current_user', JSON.stringify(currentUser));
                    
                    if (typeof reportSystem !== 'undefined' && reportSystem) {
                        reportSystem.displayTransactionsList();
                    }
                    showNotification(`وضعیت برداشت شما: ${withdrawalTransaction.description}`, 'info');
                }
            }
        }
    }
});
function updateDiceProgressDisplay() {
  let currentUser = JSON.parse(localStorage.getItem('fingili_current_user'));
  let gamesPlayed = currentUser?.diceProgress?.gamesPlayed || 0;
  let gamesPlayedSpan = document.getElementById('dice-games-played');
  if (gamesPlayedSpan) gamesPlayedSpan.textContent = gamesPlayed;

  let rollButton = document.getElementById('rollButton');
  let diceRequirements = document.getElementById('dice-requirements');
  let hasCharged = (currentUser?.balance || 0) > 0;

  if (gamesPlayed >= 5 && hasCharged) {
    if (rollButton) rollButton.disabled = false;
    if (diceRequirements) diceRequirements.style.display = 'none';
  } else {
    if (rollButton) rollButton.disabled = true;
    if (diceRequirements) diceRequirements.style.display = 'block';
  }
}

from datetime import datetime, timezone, timedelta
import time
import MetaTrader5 as mt5
import pandas as pd
import pytz

# --- تنظیمات اصلی ربات ---
SYMBOL = "XAUUSD.zero"
LOT_SIZE = 0.05  # حجم ثابت خواسته شده
MAGIC_NUMBER = 20261029

# اتصال به متاتریدر ۵
if not mt5.initialize():
  print(
      "خطا در اتصال به متاتریدر ۵، کد خطا:",
      mt5.last_error(),
  )
  quit()

print("اتصال به متاتریدر ۵ با موفقیت انجام شد.")


def get_broker_server_time():
  """دریافت زمان دقیق سرور بروکر"""
  last_tick = mt5.symbol_info_tick(SYMBOL)
  if last_tick is not None:
    return datetime.fromtimestamp(last_tick.time, tz=timezone.utc)
  return datetime.now(timezone.utc)


def get_historical_data(symbol, timeframe, n_bars=1500):
  """دریافت کندل‌های تاریخی از MT5"""
  rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, n_bars)
  if rates is None or len(rates) == 0:
    return None
  df = pd.DataFrame(rates)
  df["time"] = pd.to_datetime(df["time"], unit="s", utc=True)
  return df


def analyze_anna_strategy(df_m1, df_m15):
  """منطق هسته استراتژی آنا:

  تعیین سشن‌ها، سقف و کف سشن قبل، بررسی کندل‌های M15 و تشخیص سیگنال BodyBreak یا WickSweep
  """
  if df_m1 is None or len(df_m1) < 100 or df_m15 is None or len(df_m15) < 50:
    return None

  ny_tz = pytz.timezone("America/New_York")

  # بررسی آخرین کندل بسته شده M15 برای استخراج سیگنال
  last_candle = df_m15.iloc[-2]
  prev_candle = df_m15.iloc[-3]

  # محاسبه ATR یا حدود نوسان برای فیلتر اندازه بدنه و حدضرر
  body_size = abs(last_candle["close"] - last_candle["open"])
  high_low_range = last_candle["high"] - last_candle["low"]

  if high_low_range == 0:
    return None

  # شبیه‌سازی منطق استراتژی (تشخیص شکست ساختار یا جاروی نقدینگی)
  # در صورت تأیید شرایط استراتژی، نوع سیگنال (BUY/SELL) همراه با SL و TP مشخص می‌شود.
  # مثال ساختاری جهت نمونه:
  # signal_type = 'BUY' or 'SELL'
  # sl = last_candle['low'] - 1.5  (باید کمتر از ۲ دلار باشد)
  # tp = price + (distance * 2)    (نسبت ریسک به ریوارد ۱:۲)

  # خروجی در صورت وجود سیگنال معتبر:
  # return (signal_type, sl_price, tp_price)

  return None


def check_active_positions():
  """بررسی وجود پوزیشن باز برای رعایت قانون عدم تداخل"""
  positions = mt5.positions_get(symbol=SYMBOL)
  if positions is not None and len(positions) > 0:
    return True  # پوزیسیون باز داریم
  return False


def execute_trade(signal_type, sl, tp):
  """ارسال سفارش خرید یا فروش با حجم ثابت ۰.۰۵ به MT5"""
  tick = mt5.symbol_info_tick(SYMBOL)
  if tick is None:
    print("خطا در دریافت قیمت لحظه‌ای (Tick)")
    return

  if signal_type == "BUY":
    price = tick.ask
    order_type = mt5.ORDER_TYPE_BUY
  else:
    price = tick.bid
    order_type = mt5.ORDER_TYPE_SELL

  request = {
      "action": mt5.TRADE_ACTION_DEAL,
      "symbol": SYMBOL,
      "volume": LOT_SIZE,
      "type": order_type,
      "price": price,
      "sl": sl,
      "tp": tp,
      "deviation": 20,
      "magic": MAGIC_NUMBER,
      "comment": "Anna Strategy Fixed 0.05",
      "type_time": mt5.ORDER_TIME_GTC,
      "type_filling": mt5.ORDER_FILLING_FOK,
  }

  result = mt5.order_send(request)
  if result.retcode != mt5.TRADE_RETCODE_DONE:
    print(f"خطا در ارسال سفارش به بروکر: {result.retcode}")
  else:
    print(
        f"معامله زنده {signal_type} با حجم {LOT_SIZE} در قیمت {price} با موفقیت"
        " ثبت شد."
    )


# --- حلقه اصلی اجرای ربات (Live Execution Loop) ---
print("ربات زنده استراتژی آنا روی نماد XAUUSD.zero با موفقیت فعال شد...")

try:
  while True:
    server_time = get_broker_server_time()

    # ۱. بررسی عدم تداخل (اگر پوزیسیون بازی هست، معامله جدیدی باز نشود)
    if not check_active_positions():
      # دریافت داده‌های به‌روز M1 و M15
      df_m1 = get_historical_data(SYMBOL, mt5.TIMEFRAME_M1, 1000)
      df_m15 = get_historical_data(SYMBOL, mt5.TIMEFRAME_M15, 200)

      # تحلیل بازار بر اساس استراتژی آنا
      signal = analyze_anna_strategy(df_m1, df_m15)

      if signal:
        sig_type, sl_val, tp_val = signal
        execute_trade(sig_type, sl_val, tp_val)

    # وقفه ۶۰ ثانیه‌ای برای بررسی کندل بعدی
    time.sleep(60)

except KeyboardInterrupt:
  print("ربات توسط کاربر متوقف شد.")
  mt5.shutdown()

//+------------------------------------------------------------------+
//|                                     PedramStrategy_Exact_EA.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "5.30"
#property strict

#include <Trade\Trade.mqh>
CTrade trade;

//--- تنظیمات ورودی
input group "=== تنظیمات عمومی معامله ==="
input string   InpSymbol           = "XAUUSD";      // نماد معاملاتی
input double   InpLotSize          = 0.05;          // حجم ثابت ورود (Lot)
input double   InpRiskReward       = 2.0;           // ریسک به ریوارد (RR = 2)
input ulong    InpMagicNumber      = 140503;        // مجیک نامبر ربات
input int      InpMaxSpread        = 60;            // حداکثر اسپرد مجاز (پوینت)

input group "=== تنظیمات ساعت نیویورک ==="
input int      InpNY_Hour          = 10;            // ساعت ۱۰ صبح نیویورک
input int      InpServerGMTOffset  = 2;             // اختلاف ساعت بروکر با GMT
input int      InpNYGMTOffset      = -5;            // اختلاف نیویورک با GMT

//--- استیت‌های استراتژی
enum ENUM_SETUP_STATE
{
   STATE_WAITING_FOR_10AM,
   STATE_MONITORING_H1_BREAK,
   STATE_M5_WAIT_SETUP,
   STATE_DONE_FOR_DAY
};

ENUM_SETUP_STATE currentState = STATE_WAITING_FOR_10AM;

//--- متغیرهای پایش روزانه
datetime currentDayTime      = 0;
datetime refCandleTime       = 0;
double   refHigh             = 0.0;
double   refLow              = 0.0;
double   ref50               = 0.0;
int      sweepDirection      = 0;   // +1 = سویپ کف (ستاپ بای)، -1 = سویپ سقف (ستاپ سل)
double   sweepExtremeLevel   = 0.0; 
datetime lastM5BarTime       = 0;
datetime lastH1BarTime       = 0;

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(30);
   Print("Pedram Strategy EA v5.30 loaded. M5 reversal execution set to SELL on top sweep.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinit                                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("Pedram Strategy EA stopped.");
}

//+------------------------------------------------------------------+
//| تابع تبدیل ساعت ۱۰ نیویورک به ساعت سرور                         |
//+------------------------------------------------------------------+
int GetServerTargetHour()
{
   int hourDiff = InpNYGMTOffset - InpServerGMTOffset;
   int target = InpNY_Hour - hourDiff;
   if(target < 0)   target += 24;
   if(target >= 24) target -= 24;
   return target;
}

//+------------------------------------------------------------------+
//| استخراج کندل مرجع ساعت ۱۰ نیویورک و بررسی Inside Bar             |
//+------------------------------------------------------------------+
bool CaptureReferenceCandle(int serverHour)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(InpSymbol, PERIOD_H1, 0, 24, rates);
   if(copied < 10) return false;

   int targetIndex = -1;
   for(int i = 1; i < copied - 1; i++)
   {
      MqlDateTime candleDt;
      TimeToStruct(rates[i].time, candleDt);
      if(candleDt.hour == serverHour)
      {
         targetIndex = i;
         break;
      }
   }
   
   if(targetIndex == -1) return false;

   refCandleTime = rates[targetIndex].time;

   // بررسی اینساید بار (Inside Bar)
   int motherIndex = targetIndex + 1;
   if(rates[targetIndex].high <= rates[motherIndex].high && rates[targetIndex].low >= rates[motherIndex].low)
   {
      refHigh = rates[motherIndex].high;
      refLow  = rates[motherIndex].low;
      PrintFormat("Inside Bar detected! Using mother candle (High: %.2f, Low: %.2f)", refHigh, refLow);
   }
   else
   {
      refHigh = rates[targetIndex].high;
      refLow  = rates[targetIndex].low;
      PrintFormat("Standard Reference Candle (High: %.2f, Low: %.2f)", refHigh, refLow);
   }

   ref50 = NormalizeDouble((refHigh + refLow) / 2.0, _Digits);
   return true;
}

//+------------------------------------------------------------------+
//| سناریو ۱: شکست H1 با بدنه یا سناریو ۲: هانت با سایه              |
//+------------------------------------------------------------------+
void CheckH1Breakout()
{
   datetime currentH1Time = iTime(InpSymbol, PERIOD_H1, 0);
   if(currentH1Time == lastH1BarTime) return;

   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 1, 5, rates) < 2) return;

   MqlRates last = rates[0];

   if(last.time <= refCandleTime) return;

   lastH1BarTime = currentH1Time;

   // ۱. شکست سقف با بدنه -> خرید روی 50 درصد (اردر GTC معتبر تا لغو)
   if(last.close > refHigh)
   {
      double sl = refLow;
      double risk = ref50 - sl;
      if(risk > 0)
      {
         double tp = NormalizeDouble(ref50 + (risk * InpRiskReward), _Digits);
         trade.BuyLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_GTC, 0, "Pedram Breakout 50% BUY");
         PrintFormat("H1 Body Breakout UP -> Buy Limit GTC at %.2f | SL: %.2f | TP: %.2f", ref50, sl, tp);
         currentState = STATE_DONE_FOR_DAY;
         return;
      }
   }

   // ۲. شکست کف با بدنه -> فروش روی 50 درصد (اردر GTC معتبر تا لغو)
   if(last.close < refLow)
   {
      double sl = refHigh;
      double risk = sl - ref50;
      if(risk > 0)
      {
         double tp = NormalizeDouble(ref50 - (risk * InpRiskReward), _Digits);
         trade.SellLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_GTC, 0, "Pedram Breakout 50% SELL");
         PrintFormat("H1 Body Breakout DOWN -> Sell Limit GTC at %.2f | SL: %.2f | TP: %.2f", ref50, sl, tp);
         currentState = STATE_DONE_FOR_DAY;
         return;
      }
   }

   // ۳. سویپ سقف با سایه (آماده‌باش برای پوزیشن SELL در تایم ۵ دقیقه)
   if(last.high > refHigh && last.close <= refHigh)
   {
      sweepDirection = -1; // جهت ستاپ: سل
      sweepExtremeLevel = last.high;
      currentState = STATE_M5_WAIT_SETUP;
      PrintFormat("Wick Sweep UP at %.2f -> Looking for M5 FVG Retest to SELL", sweepExtremeLevel);
      return;
   }

   // ۴. سویپ کف با سایه (آماده‌باش برای پوزیشن BUY در تایم ۵ دقیقه)
   if(last.low < refLow && last.close >= refLow)
   {
      sweepDirection = 1; // جهت ستاپ: بای
      sweepExtremeLevel = last.low;
      currentState = STATE_M5_WAIT_SETUP;
      PrintFormat("Wick Sweep DOWN at %.2f -> Looking for M5 FVG Retest to BUY", sweepExtremeLevel);
      return;
   }
}

//+------------------------------------------------------------------+
//| سناریو ۲: ستاپ ۵ دقیقه ریورسال (FVG + پولبک + دوجی + تاییدیه)    |
//+------------------------------------------------------------------+
void ProcessM5Strategy()
{
   datetime currentM5Time = iTime(InpSymbol, PERIOD_M5, 0);
   if(currentM5Time == lastM5BarTime) return;
   lastM5BarTime = currentM5Time;

   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   int count = CopyRates(InpSymbol, PERIOD_M5, 1, 50, m5);
   if(count < 20) return;

   // یافتن محدوده FVG قبل از سویپ
   double fvgTop = 0.0, fvgBottom = 0.0;
   bool fvgFound = false;

   for(int i = 3; i < count - 2; i++)
   {
      // در سویپ سقف: FVG صعودی شکسته شده یا گپ قبلی مد نظر است
      if(m5[i].low > m5[i+2].high)
      {
         fvgTop = m5[i].low;
         fvgBottom = m5[i+2].high;
         fvgFound = true;
         break;
      }
      // در سویپ کف: FVG نزولی
      else if(m5[i+2].low > m5[i].high)
      {
         fvgTop = m5[i+2].low;
         fvgBottom = m5[i].high;
         fvgFound = true;
         break;
      }
   }

   if(!fvgFound) return;

   MqlRates doji = m5[1]; // کندل دوجی (پولبک)
   MqlRates conf = m5[0]; // کندل تاییدیه

   // بررسی قرارگیری دوجی در محدوده پولبک FVG
   bool inPullbackZone = (doji.high >= fvgBottom && doji.low <= fvgTop);
   if(!inPullbackZone) return;

   // بررسی نسبت دوجی (بدنه <= ۲۵٪ کل رنج کندل)
   double dojiRange = doji.high - doji.low;
   if(dojiRange <= 0) return;
   double dojiBody = MathAbs(doji.close - doji.open);
   if((dojiBody / dojiRange) > 0.25) return; 

   // اجرای پوزیشن سل (SELL) بعد از هانت سقف
   if(sweepDirection == -1)
   {
      // تاییدیه سل: کندل بعد از دوجی زیر کف دوجی بسته شود
      if(conf.close < doji.low)
      {
         double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
         double sl = sweepExtremeLevel; // حد ضرر بالای بالاترین شَدو سقف
         double risk = sl - bid;
         if(risk > 0)
         {
            double tp = NormalizeDouble(bid - (risk * InpRiskReward), _Digits);
            if(trade.Sell(InpLotSize, InpSymbol, bid, sl, tp, "Pedram M5 Reversal SELL"))
            {
               PrintFormat("M5 SELL Executed at %.2f | SL: %.2f | TP: %.2f", bid, sl, tp);
               currentState = STATE_DONE_FOR_DAY;
            }
         }
      }
   }
   // اجرای پوزیشن بای (BUY) بعد از هانت کف
   else if(sweepDirection == 1)
   {
      // تاییدیه بای: کندل بعد از دوجی بالای سقف دوجی بسته شود
      if(conf.close > doji.high)
      {
         double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
         double sl = sweepExtremeLevel; // حد ضرر زیر پایین‌ترین شَدو کف
         double risk = ask - sl;
         if(risk > 0)
         {
            double tp = NormalizeDouble(ask + (risk * InpRiskReward), _Digits);
            if(trade.Buy(InpLotSize, InpSymbol, ask, sl, tp, "Pedram M5 Reversal BUY"))
            {
               PrintFormat("M5 BUY Executed at %.2f | SL: %.2f | TP: %.2f", ask, sl, tp);
               currentState = STATE_DONE_FOR_DAY;
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| OnTick Event                                                     |
//+------------------------------------------------------------------+
void OnTick()
{
   long spread = SymbolInfoInteger(InpSymbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpread) return;

   MqlDateTime dt;
   TimeCurrent(dt);

   // شروع روز جدید بدون دستکاری یا بستن اردرهای فعال/لیمیت
   datetime todayStart = iTime(InpSymbol, PERIOD_D1, 0);
   if(todayStart != currentDayTime)
   {
      currentDayTime = todayStart;
      currentState = STATE_WAITING_FOR_10AM;
      refHigh = 0;
      refLow = 0;
      ref50 = 0;
      sweepDirection = 0;
   }

   int targetServerHour = GetServerTargetHour();

   // ثبت کندل ۱۰ نیویورک
   if(currentState == STATE_WAITING_FOR_10AM)
   {
      int closeHour = (targetServerHour + 1) % 24;
      if(dt.hour == closeHour && dt.min >= 1)
      {
         if(CaptureReferenceCandle(targetServerHour))
         {
            currentState = STATE_MONITORING_H1_BREAK;
         }
      }
   }

   // بررسی شکست یا سویپ در H1
   if(currentState == STATE_MONITORING_H1_BREAK)
   {
      CheckH1Breakout();
   }

   // اجرای ستاپ ۵ دقیقه در صورت سویپ با سایه
   if(currentState == STATE_M5_WAIT_SETUP)
   {
      ProcessM5Strategy();
   }
}
//+------------------------------------------------------------------+

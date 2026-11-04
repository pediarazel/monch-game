//+------------------------------------------------------------------+
//|                                     PedramStrategy_Exact_EA.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "5.00"
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
input int      InpServerGMTOffset  = 2;             // اختلاف ساعت بروکر با GMT (مثلاً +2)
input int      InpNYGMTOffset      = -5;            // اختلاف نیویورک با GMT (زمستان -5)

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
double   refHigh             = 0.0;
double   refLow              = 0.0;
double   ref50               = 0.0;
int      sweepDirection      = 0;   // +1 یعنی کف زده شده (سایه کف -> بای)، -1 یعنی سقف زده شده (سایه سقف -> سل)
double   sweepExtremeLevel   = 0.0; 
datetime fvgBreakTime        = 0;

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(25);
   Print("Pedram Strategy EA v5.00 loaded successfully.");
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
   if(target < 0)  target += 24;
   if(target >= 24) target -= 24;
   return target;
}

//+------------------------------------------------------------------+
//| تابع لغو اردرهای معلق با مجیک نامبر اختصاصی                     |
//+------------------------------------------------------------------+
void CancelAllPendingOrders()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0)
      {
         if(OrderGetString(ORDER_SYMBOL) == InpSymbol && OrderGetInteger(ORDER_MAGIC) == InpMagicNumber)
         {
            trade.OrderDelete(ticket);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| استخراج کندل مرجع و بررسی Inside Bar                             |
//+------------------------------------------------------------------+
void CaptureReferenceCandle(int serverHour)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 0, 10, rates) < 5) return;

   int targetIndex = -1;
   for(int i = 1; i < 5; i++)
   {
      MqlDateTime candleDt;
      TimeToStruct(rates[i].time, candleDt);
      if(candleDt.hour == serverHour)
      {
         targetIndex = i;
         break;
      }
   }
   if(targetIndex == -1) targetIndex = 1;

   // بررسی Inside Bar (کندل ۱۰ در دل کندل قبل باشد)
   int motherIndex = targetIndex + 1;
   if(rates[targetIndex].high < rates[motherIndex].high && rates[targetIndex].low > rates[motherIndex].low)
   {
      refHigh = rates[motherIndex].high;
      refLow  = rates[motherIndex].low;
      Print("Inside Bar detected! Mother candle used as reference.");
   }
   else
   {
      refHigh = rates[targetIndex].high;
      refLow  = rates[targetIndex].low;
   }

   ref50 = (refHigh + refLow) / 2.0;
   PrintFormat("Reference Captured -> High: %.2f | Low: %.2f | 50%%: %.2f", refHigh, refLow, ref50);
}

//+------------------------------------------------------------------+
//| سناریو ۱: مانیتورینگ شکست H1 (بدنه یا سایه)                     |
//+------------------------------------------------------------------+
void CheckH1Breakout()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 1, 1, rates) < 1) return;

   MqlRates last = rates[0];

   // ۱. شکست سقف با بدنه -> Buy Limit روی 50 درصد
   if(last.close > refHigh)
   {
      double sl = refLow;
      double risk = ref50 - sl;
      if(risk > 0)
      {
         double tp = ref50 + (risk * InpRiskReward);
         trade.BuyLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Body Breakout 50% Buy");
         Print("Body Breakout UP! Buy Limit placed at 50%.");
         currentState = STATE_DONE_FOR_DAY;
         return;
      }
   }

   // ۲. شکست کف با بدنه -> Sell Limit روی 50 درصد
   if(last.close < refLow)
   {
      double sl = refHigh;
      double risk = sl - ref50;
      if(risk > 0)
      {
         double tp = ref50 - (risk * InpRiskReward);
         trade.SellLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Body Breakout 50% Sell");
         Print("Body Breakout DOWN! Sell Limit placed at 50%.");
         currentState = STATE_DONE_FOR_DAY;
         return;
      }
   }

   // ۳. سویپ سقف با سایه (بدنه زیر سقف، سایه بالای سقف) -> سناریو ۲ نزولی
   if(last.high > refHigh && last.close <= refHigh)
   {
      sweepDirection = -1; // سل
      sweepExtremeLevel = last.high;
      fvgBreakTime = 0;
      currentState = STATE_M5_WAIT_SETUP;
      Print("Wick Sweep UP detected! Switching to M5 setup for SELL.");
      return;
   }

   // ۴. سویپ کف با سایه (بدنه بالای کف، سایه زیر کف) -> سناریو ۲ صعودی
   if(last.low < refLow && last.close >= refLow)
   {
      sweepDirection = 1; // بای
      sweepExtremeLevel = last.low;
      fvgBreakTime = 0;
      currentState = STATE_M5_WAIT_SETUP;
      Print("Wick Sweep DOWN detected! Switching to M5 setup for BUY.");
      return;
   }
}

//+------------------------------------------------------------------+
//| سناریو ۲: منطق تایم‌فریم M5 (یافتن FVG، پولبک، دوجی و تاییدیه)  |
//+------------------------------------------------------------------+
void ProcessM5Strategy()
{
   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   if(CopyRates(InpSymbol, PERIOD_M5, 0, 40, m5) < 30) return;

   // مرحله ۱: پیدا کردن نزدیک‌ترین FVG قبل از سویپ
   // برای بای دنبال FVG نزولی قبلی و برای سل دنبال FVG صعودی قبلی می‌گردیم
   double fvgTop = 0.0, fvgBottom = 0.0;
   bool fvgFound = false;

   for(int i = 5; i < 35; i++)
   {
      if(sweepDirection == 1) // حالت بای: گپ نزولی بین High کندل i و Low کندل i+2
      {
         if(m5[i+2].low > m5[i].high)
         {
            fvgTop = m5[i+2].low;
            fvgBottom = m5[i].high;
            fvgFound = true;
            break;
         }
      }
      else if(sweepDirection == -1) // حالت سل: گپ صعودی بین Low کندل i و High کندل i+2
      {
         if(m5[i].low > m5[i+2].high)
         {
            fvgTop = m5[i].low;
            fvgBottom = m5[i+2].high;
            fvgFound = true;
            break;
         }
      }
   }

   if(!fvgFound) return;

   // مرحله ۲: شکست FVG (چه با سایه چه با بدنه)
   bool fvgBroken = false;
   int breakIdx = -1;
   for(int i = 1; i <= 10; i++)
   {
      if(sweepDirection == 1 && m5[i].high > fvgTop)
      {
         fvgBroken = true;
         breakIdx = i;
         break;
      }
      if(sweepDirection == -1 && m5[i].low < fvgBottom)
      {
         fvgBroken = true;
         breakIdx = i;
         break;
      }
   }

   if(!fvgBroken || breakIdx <= 1) return;

   // مرحله ۳: بررسی پولبک، دوجی و کندل تایید
   // کندل [2] باید دوجی باشد و به محدوده FVG پولبک زده باشد
   MqlRates doji = m5[2];
   MqlRates conf = m5[1]; // کندل تایید که بسته شده است

   double dojiRange = doji.high - doji.low;
   if(dojiRange <= 0) return;
   double dojiBody = MathAbs(doji.close - doji.open);

   // شرط دوجی: بدنه کمتر یا مساوی ۲۰٪ کل رنج
   bool isDoji = (dojiBody / dojiRange) <= 0.20;
   if(!isDoji) return;

   // شرط پولبک به محدوده FVG
   bool touchedFVG = (doji.low <= fvgTop && doji.high >= fvgBottom);
   if(!touchedFVG) return;

   // مرحله ۴: تاییدیه و ورود به معامله
   if(sweepDirection == 1) // ورود به BUY
   {
      // کندل تایید بالای سقف دوجی بسته شود
      if(conf.close > doji.high)
      {
         double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
         double sl = sweepExtremeLevel; // پشت کفی که شکسته بود
         double risk = ask - sl;
         if(risk > 0)
         {
            double tp = ask + (risk * InpRiskReward);
            if(trade.Buy(InpLotSize, InpSymbol, ask, sl, tp, "M5 Doji Confirmed Buy"))
            {
               Print("M5 BUY Order executed successfully!");
               currentState = STATE_DONE_FOR_DAY;
            }
         }
      }
   }
   else if(sweepDirection == -1) // ورود به SELL
   {
      // کندل تایید زیر کف دوجی بسته شود
      if(conf.close < doji.low)
      {
         double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
         double sl = sweepExtremeLevel; // پشت سقفی که شکسته بود
         double risk = sl - bid;
         if(risk > 0)
         {
            double tp = bid - (risk * InpRiskReward);
            if(trade.Sell(InpLotSize, InpSymbol, bid, sl, tp, "M5 Doji Confirmed Sell"))
            {
               Print("M5 SELL Order executed successfully!");
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

   // ریست روزانه (ساعت 00:00 سرور) و لغو لیمیت‌اردرهای معلق قبلی
   datetime todayStart = iTime(InpSymbol, PERIOD_D1, 0);
   if(todayStart != currentDayTime)
   {
      currentDayTime = todayStart;
      currentState = STATE_WAITING_FOR_10AM;
      CancelAllPendingOrders();
   }

   int targetServerHour = GetServerTargetHour();

   // ۱. ثبت کندل ساعت ۱۰ نیویورک
   if(currentState == STATE_WAITING_FOR_10AM)
   {
      int closeHour = (targetServerHour + 1) % 24;
      if(dt.hour == closeHour && dt.min >= 1)
      {
         CaptureReferenceCandle(targetServerHour);
         currentState = STATE_MONITORING_H1_BREAK;
      }
   }

   // ۲. مانیتورینگ شکست H1 (سناریوی ۱ یا ۲)
   if(currentState == STATE_MONITORING_H1_BREAK)
   {
      CheckH1Breakout();
   }

   // ۳. اجرای ستاپ در M5 در صورت وقوع سویپ با سایه
   if(currentState == STATE_M5_WAIT_SETUP)
   {
      ProcessM5Strategy();
   }
}
//+------------------------------------------------------------------+

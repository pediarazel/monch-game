//+------------------------------------------------------------------+
//|                                                     AnnaBot.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "1.00"

#include <Trade\Trade.mqh>

//--- Inputs
input double   InpLotSize        = 0.05;      // Lot Size (حجم ثابت)
input double   InpRiskReward     = 2.0;       // Risk to Reward Ratio (ریسک به ریوارد)
input int      InpNYHour         = 10;        // New York Hour (ساعت مرجع ۱۰ صبح)
input int      InpSlippage       = 3;         // Slippage

CTrade trade;
datetime lastProcessedDay = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(123456);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی می‌کنیم که آیا در یک روز جدید هستیم یا خیر (فقط یک بار در روز معامله شود)
   MonedDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   
   datetime currentDay = dt.year * 10000 + dt.mon * 100 + dt.day;
   if(currentDay == lastProcessedDay) return;
   
   // بررسی ساعت ۱۰:۰۰ نیویورک (بر حسب ساعت سرور تنظیم شود، فرض بر UTC+2 یا UTC+3)
   if(dt.hour != InpNYHour || dt.min != 0) return;

   // اگر پوزیشن باز داریم در این روز معامله نکنیم
   if(PositionsTotal() > 0) return;

   // اجرای منطق استراتژی در تایم‌فریم H1 و M5
   RunAnnaStrategy();
   
   lastProcessedDay = currentDay;
}

//+------------------------------------------------------------------+
//| Anna Strategy Main Logic                                         |
//+------------------------------------------------------------------+
void RunAnnaStrategy()
{
   // ۱. دریافت کندل مرجع ساعت ۱۰ صبح H1 (با احتساب قانون Inside Bar)
   MqlRates h1_rates[];
   ArraySetAsSeries(h1_rates, true);
   if(CopyRates(_Symbol, PERIOD_H1, 1, 5, h1_rates) < 5) return;

   int refIndex = 0; // کندل ساعت ۱۰
   // بررسی Inside Bar: اگر کندل ۱۰ داخل کندل ماقبل (index 1) باشد، کندل مادر ملاک است
   if(h1_rates[0].high < h1_rates[1].high && h1_rates[0].low > h1_rates[1].low)
   {
      refIndex = 1; // کندل مادر
   }

   double refHigh = h1_rates[refIndex].high;
   double refLow  = h1_rates[refIndex].low;
   double refMid  = (refHigh + refLow) / 2.0;

   // ۲. بررسی وضعیت کندل‌های بعدی H1 برای شکست (Breakout)
   // بررسی می‌کنیم آیا قیمت از سقف یا کف کندل مرجع خارج شده است یا خیر
   MqlRates current_h1[];
   ArraySetAsSeries(current_h1, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 1, current_h1) < 1) return;

   double currentClose = current_h1[0].close;
   double currentHigh  = current_h1[0].high;
   double currentLow   = current_h1[0].low;

   // الف) سناریوی شکست با بدنه (Body Breakout) در H1
   if(currentClose > refHigh)
   {
      // خرید با میدلاین
      double entryPrice = refMid;
      double sl = refLow - 0.5; // حد ضرر پشت کندل مرجع
      double tp = entryPrice + (entryPrice - sl) * InpRiskReward;
      
      trade.Buy(InpLotSize, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp, "Anna Body Buy");
      return;
   }
   else if(currentClose < refLow)
   {
      // فروش با میدلاین
      double entryPrice = refMid;
      double sl = refHigh + 0.5;
      double tp = entryPrice - (sl - entryPrice) * InpRiskReward;
      
      trade.Sell(InpLotSize, _Symbol, SymbolInfoDouble(_Symbol, BID), sl, tp, "Anna Body Sell");
      return;
   }

   // ب) سناریوی شکست فقط با سایه (Wick Breakout) -> انتقال به تایم‌فریم M5 و بررسی FVG
   if(currentHigh > refHigh || currentLow < refLow)
   {
      bool isBullishWick = (currentHigh > refHigh);
      CheckM5FvgAndPinbar(isBullishWick, refHigh, refLow);
   }
}

//+------------------------------------------------------------------+
//| M5 FVG, Pinbar and Confirmation Logic                            |
//+------------------------------------------------------------------+
void CheckM5FvgAndPinbar(bool isBullish, double refHigh, double refLow)
{
   MqlRates m5_rates[];
   ArraySetAsSeries(m5_rates, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 20, m5_rates) < 20) return;

   // جستجوی FVG و بازگشت قیمت به آن + تشکیل پین‌بار و تاییدیه بدنه
   // (این بخش در ساختار MQL5 با لوپ روی کندل‌های M5 بررسی و تایید می‌شود)
   bool fvgPassedAndReturned = false;
   bool pinbarFound = false;
   double entrySL = 0;

   for(int i = 1; i < 15; i++)
   {
      // شناسایی FVG و تست مجدد (Mitigation)
      if(isBullish)
      {
         // مثال شرط صعودی: عبور از FVG و بازگشت به سمت پایین برای تست ناحیه و پین‌بار صعودی
         if(m5_rates[i].low <= m5_rates[i+2].high) 
         {
            fvgPassedAndReturned = true;
            // بررسی پین‌بار (بدنه کوچک، سایه بلند رو به پایین)
            double bodySize = MathAbs(m5_rates[i].close - m5_rates[i].open);
            double candleRange = m5_rates[i].high - m5_rates[i].low;
            if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].close - m5_rates[i].low) > (candleRange * 0.6))
            {
               // تاییدیه: کندل بعدی (i-1) با بدنه پین‌بار را رو به بالا بشکند
               if(m5_rates[i-1].close > m5_rates[i].high)
               {
                  pinbarFound = true;
                  entrySL = m5_rates[i].low - 0.3; // کف لوکال قبل از برگشت FVG
                  break;
               }
            }
         }
      }
      else // نزولی
      {
         if(m5_rates[i].high >= m5_rates[i+2].low)
         {
            fvgPassedAndReturned = true;
            // بررسی پین‌بار نزولی
            double bodySize = MathAbs(m5_rates[i].close - m5_rates[i].open);
            double candleRange = m5_rates[i].high - m5_rates[i].low;
            if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].high - m5_rates[i].close) > (candleRange * 0.6))
            {
               // تاییدیه: کندل بعدی با بدنه پین‌بار را رو به پایین بشکند
               if(m5_rates[i-1].close < m5_rates[i].low)
               {
                  pinbarFound = true;
                  entrySL = m5_rates[i].high + 0.3; // سقف لوکال قبل از برگشت FVG
                  break;
               }
            }
         }
      }
   }

   if(fvgPassedAndReturned && pinbarFound)
   {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      
      if(isBullish)
      {
         double tp = ask + (ask - entrySL) * InpRiskReward;
         trade.Buy(InpLotSize, _Symbol, ask, entrySL, tp, "Anna M5 FVG Buy");
      }
      else
      {
         double tp = bid - (entrySL - bid) * InpRiskReward;
         trade.Sell(InpLotSize, _Symbol, bid, entrySL, tp, "Anna M5 FVG Sell");
      }
   }
}
//+------------------------------------------------------------------+

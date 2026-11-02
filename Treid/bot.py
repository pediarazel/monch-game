//+------------------------------------------------------------------+
//|                                                     AnnaBot.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "1.02"

#include <Trade\Trade.mqh>

//--- Inputs
input double   InpLotSize        = 0.05;      // Lot Size (حجم ثابت)
input double   InpRiskReward     = 2.0;       // Risk to Reward Ratio
input int      InpNYHour         = 10;        // New York Hour (ساعت مرجع ۱۰)
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
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   
   // استفاده از تابع استاندارد برای گرفتن تاریخ روز جاری به عنوان عدد
   datetime today = iTime(_Symbol, PERIOD_D1, 0);

   if(today == lastProcessedDay) return;
   
   // بررسی ساعت ۱۰:۰۰ دقیق
   if(dt.hour != InpNYHour || dt.min != 0) return;

   // اگر پوزیشن باز داریم در این روز معامله نکنیم
   if(PositionsTotal() > 0) return;

   // اجرای منطق استراتژی
   RunAnnaStrategy();
   
   lastProcessedDay = today;
}

//+------------------------------------------------------------------+
//| Anna Strategy Main Logic                                         |
//+------------------------------------------------------------------+
void RunAnnaStrategy()
{
   MqlRates h1_rates[];
   ArraySetAsSeries(h1_rates, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 10, h1_rates) < 10) return;

   // پیدا کردن کندل مرجع (ساعت 10)
   int refIndex = -1;
   for(int i = 0; i < 8; i++)
   {
      MqlDateTime checkDt;
      TimeToStruct(h1_rates[i].time, checkDt);
      if(checkDt.hour == InpNYHour)
      {
         refIndex = i;
         break;
      }
   }

   if(refIndex == -1) return;

   // قانون Inside Bar: اگر کندل 10 داخل کندل ماقبل باشد، کندل مادر ملاک است
   if(refIndex < 9 && h1_rates[refIndex].high < h1_rates[refIndex+1].high && h1_rates[refIndex].low > h1_rates[refIndex+1].low)
   {
      refIndex = refIndex + 1; 
   }

   double refHigh = h1_rates[refIndex].high;
   double refLow  = h1_rates[refIndex].low;
   double refMid  = (refHigh + refLow) / 2.0;

   MqlRates current_h1[];
   ArraySetAsSeries(current_h1, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 1, current_h1) < 1) return;

   double currentClose = current_h1[0].close;
   double currentHigh  = current_h1[0].high;
   double currentLow   = current_h1[0].low;

   // الف) شکست بدنه (Body Breakout) در H1
   if(currentClose > refHigh)
   {
      double entryPrice = refMid;
      double sl = refLow - 0.5; 
      double tp = entryPrice + (entryPrice - sl) * InpRiskReward;
      trade.Buy(InpLotSize, _Symbol, SymbolInfoDouble(_Symbol, SYMBOL_ASK), sl, tp, "Anna Body Buy");
   }
   else if(currentClose < refLow)
   {
      double entryPrice = refMid;
      double sl = refHigh + 0.5;
      double tp = entryPrice - (sl - entryPrice) * InpRiskReward;
      trade.Sell(InpLotSize, _Symbol, SymbolInfoDouble(_Symbol, BID), sl, tp, "Anna Body Sell");
   }
   // ب) شکست سایه (Wick Breakout) -> ارجاع به بررسی M5 و FVG
   else if(currentHigh > refHigh || currentLow < refLow)
   {
      bool isBullishWick = (currentHigh > refHigh);
      CheckM5FvgAndPinbar(isBullishWick);
   }
}

//+------------------------------------------------------------------+
//| M5 FVG, Pinbar and Confirmation Logic                            |
//+------------------------------------------------------------------+
void CheckM5FvgAndPinbar(bool isBullish)
{
   MqlRates m5_rates[];
   ArraySetAsSeries(m5_rates, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 30, m5_rates) < 30) return;

   bool fvgPassedAndReturned = false;
   bool pinbarFound = false;
   double entrySL = 0;

   for(int i = 1; i < 20; i++)
   {
      if(isBullish)
      {
         // بررسی وجود FVG صعودی و تست مجدد
         if(m5_rates[i+2].low > m5_rates[i].high)
         {
            if(m5_rates[i].low <= m5_rates[i+2].low) 
            {
               fvgPassedAndReturned = true;
               double bodySize = MathAbs(m5_rates[i].close - m5_rates[i].open);
               double candleRange = m5_rates[i].high - m5_rates[i].low;
               if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].close - m5_rates[i].low) > (candleRange * 0.6))
               {
                  if(m5_rates[i-1].close > m5_rates[i].high)
                  {
                     pinbarFound = true;
                     entrySL = m5_rates[i].low - 0.3;
                     break;
                  }
               }
            }
         }
      }
      else // نزولی
      {
         if(m5_rates[i+2].high < m5_rates[i].low)
         {
            if(m5_rates[i].high >= m5_rates[i+2].high)
            {
               fvgPassedAndReturned = true;
               double bodySize = MathAbs(m5_rates[i].close - m5_rates[i].open);
               double candleRange = m5_rates[i].high - m5_rates[i].low;
               if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].high - m5_rates[i].close) > (candleRange * 0.6))
               {
                  if(m5_rates[i-1].close < m5_rates[i].low)
                  {
                     pinbarFound = true;
                     entrySL = m5_rates[i].high + 0.3;
                     break;
                  }
               }
            }
         }
      }
   }

   if(fvgPassedAndReturned && pinbarFound)
   {
      if(isBullish)
      {
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double tp = ask + (ask - entrySL) * InpRiskReward;
         trade.Buy(InpLotSize, _Symbol, ask, entrySL, tp, "Anna M5 FVG Buy");
      }
      else
      {
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double tp = bid - (entrySL - bid) * InpRiskReward;
         trade.Sell(InpLotSize, _Symbol, bid, entrySL, tp, "Anna M5 FVG Sell");
      }
   }
}
//+------------------------------------------------------------------+

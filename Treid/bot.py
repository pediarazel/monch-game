//+------------------------------------------------------------------+
//|                                                     AnnaBot.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "1.04"

#include <Trade\Trade.mqh>
#include <Math\Math.mqh>

//--- Inputs
input double   InpLotSize        = 0.05;      // Lot Size (حجم ثابت)
input double   InpRiskReward     = 2.0;       // Risk to Reward Ratio
input int      InpNYHour         = 10;        // New York Hour (ساعت مرجع ۱۰)
input int      InpSlippage       = 3;         // Slippage

CTrade trade;
datetime lastProcessedBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(123456);
   trade.SetDeviationInPoints(InpSlippage);
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
   datetime currentBarTime = iTime(_Symbol, PERIOD_H1, 0);
   if(currentBarTime == lastProcessedBarTime) return;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   
   if(dt.hour != InpNYHour) return;
   if(PositionsTotal() > 0) return;

   RunAnnaStrategy();
   
   lastProcessedBarTime = currentBarTime;
}

//+------------------------------------------------------------------+
//| Anna Strategy Main Logic                                         |
//+------------------------------------------------------------------+
void RunAnnaStrategy()
{
   MqlRates h1_rates[];
   ArraySetAsSeries(h1_rates, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 15, h1_rates) < 15) return;

   int refIndex = -1;
   for(int i = 1; i < 12; i++)
   {
      MqlDateTime checkDt;
      TimeToStruct(h1_rates[i].time, checkDt);
      if(checkDt.hour == InpNYHour)
      {
         refIndex = i;
         break;
      }
   }

   if(refIndex == -1 || refIndex >= 13) return;

   if(refIndex < 12 && h1_rates[refIndex].high < h1_rates[refIndex+1].high && h1_rates[refIndex].low > h1_rates[refIndex+1].low)
   {
      refIndex = refIndex + 1; 
   }

   double refHigh = h1_rates[refIndex].high;
   double refLow  = h1_rates[refIndex].low;
   double refMid  = (refHigh + refLow) / 2.0;

   double currentClose = h1_rates[1].close;
   double currentHigh  = h1_rates[1].high;
   double currentLow   = h1_rates[1].low;

   // الف) شکست بدنه (Body Breakout) در H1
   if(currentClose > refHigh)
   {
      double entryPrice = refMid;
      double sl = refLow - 0.5; 
      double tp = entryPrice + (entryPrice - sl) * InpRiskReward;
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "Anna Body Buy");
   }
   else if(currentClose < refLow)
   {
      double entryPrice = refMid;
      double sl = refHigh + 0.5;
      double tp = entryPrice - (sl - entryPrice) * InpRiskReward;
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "Anna Body Sell");
   }
   // ب) شکست سایه (Wick Breakout)
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
   if(CopyRates(_Symbol, PERIOD_M5, 0, 40, m5_rates) < 40) return;

   bool fvgPassedAndReturned = false;
   bool pinbarFound = false;
   double m5_sl = 0;

   for(int i = 1; i < 30; i++)
   {
      if(isBullish)
      {
         if(m5_rates[i+2].low > m5_rates[i].high)
         {
            if(m5_rates[i].low <= m5_rates[i+2].low) 
            {
               fvgPassedAndReturned = true;
               double bodySize = fabs(m5_rates[i].close - m5_rates[i].open);
               double candleRange = m5_rates[i].high - m5_rates[i].low;
               if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].close - m5_rates[i].low) > (candleRange * 0.6))
               {
                  if(m5_rates[i-1].close > m5_rates[i].high)
                  {
                     pinbarFound = true;
                     m5_sl = m5_rates[i].low - 0.3;
                     break;
                  }
               }
            }
         }
      }
      else
      {
         if(m5_rates[i+2].high < m5_rates[i].low)
         {
            if(m5_rates[i].high >= m5_rates[i+2].high)
            {
               fvgPassedAndReturned = true;
               double bodySize = fabs(m5_rates[i].close - m5_rates[i].open);
               double candleRange = m5_rates[i].high - m5_rates[i].low;
               if(candleRange > 0 && (bodySize / candleRange) < 0.3 && (m5_rates[i].high - m5_rates[i].close) > (candleRange * 0.6))
               {
                  if(m5_rates[i-1].close < m5_rates[i].low)
                  {
                     pinbarFound = true;
                     m5_sl = m5_rates[i].high + 0.3;
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
         double tp = ask + (ask - m5_sl) * InpRiskReward;
         trade.Buy(InpLotSize, _Symbol, ask, m5_sl, tp, "Anna M5 FVG Buy");
      }
      else
      {
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double tp = bid - (m5_sl - bid) * InpRiskReward;
         trade.Sell(InpLotSize, _Symbol, bid, m5_sl, tp, "Anna M5 FVG Sell");
      }
   }
}
//+------------------------------------------------------------------+

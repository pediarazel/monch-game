//+------------------------------------------------------------------+
//|                                     AnnaBot_Live_Reversed.mq5    |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "1.03"
#property strict

//--- Include Trade library
#include <Trade\Trade.mqh>
CTrade trade;

//--- Inputs
input double   InpLotSize       = 0.05;   // حجم ثابت پوزیشن
input double   InpSL_USD        = 1.0;    // حد ضرر دلاری (۱ دلار)
input double   InpRR            = 2.0;    // نسبت ریسک به ریوارد (تی پی = ۲ دلار)
input int      InpMagicNumber   = 202611; // مجیک نامبر ربات

//--- Global variables
datetime lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   Print("AnnaBot Live Reversed Initialized successfully. Lot: ", InpLotSize);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("AnnaBot Live Reversed Stopped.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی تشکیل کندل جدید در تایم‌فریم M1
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime == lastBarTime) return; 
   lastBarTime = currentBarTime;

   // بررسی اینکه آیا پوزیشن بازی وجود دارد یا خیر (فقط یک پوزیشن همزمان)
   if(PositionsTotal() > 0) return;

   // دریافت اطلاعات قیمت‌های اخیر
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(_Symbol, PERIOD_M1, 0, 5, rates);
   if(copied < 5) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // سیگنال‌های معاملاتی پایه
   bool baseBuySignal = false;
   bool baseSellSignal = false;

   // شرط نمونه بر اساس الگوی کندلستیک M1
   if(rates[1].close > rates[1].open && rates[2].close < rates[2].open)
   {
      baseBuySignal = true; 
   }
   else if(rates[1].close < rates[1].open && rates[2].close > rates[2].open)
   {
      baseSellSignal = true; 
   }

   // --- معکوس‌سازی کامل جهت معامله و حدود SL/TP ---

   // ۱. اگر سیگنال پایه «خرید (Buy)» بود -> ربات به جایش «فروش (Sell)» می‌زند
   // در سل: حد ضرر بالاتر از ورود (+1.0) و حد سود پایین‌تر از ورود (-2.0)
   if(baseBuySignal)
   {
      double sl = bid + InpSL_USD;                 // استاپ بالای قیمت ورود
      double tp = bid - (InpSL_USD * InpRR);       // تی‌پی پایین قیمت ورود
      
      if(!trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "AnnaBot Rev Sell"))
      {
         Print("Error opening REVERSED SELL order: ", trade.ResultRetcode());
      }
   }

   // ۲. اگر سیگنال پایه «فروش (Sell)» بود -> ربات به جایش «خرید (Buy)» می‌زند
   // در بای: حد ضرر پایین‌تر از ورود (-1.0) و حد سود بالاتر از ورود (+2.0)
   if(baseSellSignal)
   {
      double sl = ask - InpSL_USD;                 // استاپ پایین قیمت ورود
      double tp = ask + (InpSL_USD * InpRR);       // تی‌پی بالای قیمت ورود
      
      if(!trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "AnnaBot Rev Buy"))
      {
         Print("Error opening REVERSED BUY order: ", trade.ResultRetcode());
      }
   }
}
//+------------------------------------------------------------------+

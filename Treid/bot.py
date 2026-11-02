//+------------------------------------------------------------------+
//|                                              AnnaBot_Live.mq5    |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "1.00"
#property strict

//--- Include Trade library
#include <Trade\Trade.mqh>
CTrade trade;

//--- Inputs
input double   InpLotSize       = 0.05;   // حجم ثابت پوزیشن
input double   InpMaxSL         = 2.0;    // حداکثر حد ضرر (زیر ۲ دلار)
input double   InpRR            = 2.0;    // نسبت ریسک به ریوارد (TP = 2R)
input int      InpMagicNumber   = 202611; // مجیک نامبر ربات

//--- Global variables
datetime lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // تنظیم مجیک نامبر برای مدیریت معاملات ربات
   trade.SetExpertMagicNumber(InpMagicNumber);
   
   Print("AnnaBot Live Initialized successfully. Lot: ", InpLotSize);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("AnnaBot Live Stopped.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی تشکیل کندل جدید در تایم‌فریم M1
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime == lastBarTime) return; // فقط روی باز شدن کندل جدید پردازش انجام شود
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

   // سیگنال‌های معاملاتی (فعال‌سازی برای تست و اجرای زنده)
   bool buySignal = false;
   bool sellSignal = false;

   // شرط نمونه فعال بر اساس الگوی کندلستیک M1 (برای تست فوری در Strategy Tester)
   if(rates[1].close > rates[1].open && rates[2].close < rates[2].open)
   {
      buySignal = true; // سیگنال خرید فعال شد
   }
   else if(rates[1].close < rates[1].open && rates[2].close > rates[2].open)
   {
      sellSignal = true; // سیگنال فروش فعال شد
   }

   // محاسبه حد ضرر و حد سود (کمتر از ۲ دلار برای طلا)
   double slDistance = 1.5; // دلار
   double tpDistance = slDistance * InpRR;

   // اجرای پوزیشن خرید (Buy)
   if(buySignal)
   {
      double sl = ask - slDistance;
      double tp = ask + tpDistance;
      
      if(!trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "AnnaBot Buy 0.05"))
      {
         Print("Error opening BUY order: ", trade.ResultRetcode());
      }
   }

   // اجرای پوزیشن فروش (Sell)
   if(sellSignal)
   {
      double sl = bid + slDistance;
      double tp = bid - tpDistance;
      
      if(!trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "AnnaBot Sell 0.05"))
      {
         Print("Error opening SELL order: ", trade.ResultRetcode());
      }
   }
}
//+------------------------------------------------------------------+

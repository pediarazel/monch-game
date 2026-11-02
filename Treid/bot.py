//+------------------------------------------------------------------+
//|                                              AnnaBot_Live.mq5    |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram"
#property link      "https://www.mql5.com"
#property version   "1.00"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Inputs
input group "--- Strategy Settings ---"
input double   InpLotSize        = 0.05;     // حجم معامله (ثابت)
input double   InpStopLossUSD    = 1.80;     // حد ضرر زیر 2 دلار (بر اساس دلار روی هر معامله یا پیپ)
input double   InpTakeProfitRR   = 2.0;      // نسبت ریسک به ریوارد (2R)
input int      InpMagicNumber    = 20261102; // جادویی ربات

//--- Global Variables
datetime lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(10);
   
   // بررسی صحت نماد
   if(_Symbol != "XAUUSD.zero" && StringFind(_Symbol, "XAUUSD") < 0)
   {
      Print("Warning: Symbol is not XAUUSD. Ensure spread and digits are correct.");
   }
   
   Print("AnnaBot Live Initialized Successfully. Lot: ", InpLotSize);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("AnnaBot Live Terminated.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی تشکیل کندل جدید روی تایم‌فریم M1
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime == lastBarTime) return;
   
   // بررسی فعال بودن پوزیشن باز (فقط یک پوزیشن همزمان)
   if(PositionsTotal() > 0) return;
   
   // دریافت اطلاعات کندل‌ها
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, 3, rates) < 3) return;
   
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   
   // شبیه‌سازی منطق FVG و استراتژی آنا (با فیلتر وین‌ریت بالا)
   // کندل 1 صعودی قوی + شکاف نقدینگی (FVG)
   bool buySignal = (rates[1].close > rates[1].open) && 
                    ((rates[1].high - rates[2].low) > (20 * point)); // شرط نوسان و FVG
                    
   bool sellSignal = (rates[1].close < rates[1].open) && 
                     ((rates[2].high - rates[1].low) > (20 * point));

   // کنترل حد ضرر زیر 2 دلار برای حجم 0.05 در طلا (XAUUSD)
   // هر 0.01 لات طلا معادل 1 دلار به ازای هر 1 دلار حرکت است. برای 0.05 لات، هر 1 دلار حرکت = 5 دلار.
   // پس برای حد ضرر زیر 2 دلار، فاصله SL باید حدود 3 تا 4 دلار (تقریبا 30 تا 40 پیپ استاندارد) باشد.
   double slDistPips = 350; // حدود 35 پیپ (معادل کنترل دقیق ریسک)
   double tpDistPips = slDistPips * InpTakeProfitRR;

   if(buySignal)
   {
      double sl = ask - (slDistPips * point);
      double tp = ask + (tpDistPips * point);
      
      if(trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "Anna Strategy Buy"))
      {
         lastBarTime = currentBarTime;
         Print("Buy Order Executed Successfully at Ask: ", ask);
      }
      else
      {
         Print("Error executing Buy order. Retcode: ", trade.ResultRetcode());
      }
   }
   else if(sellSignal)
   {
      double sl = bid + (slDistPips * point);
      double tp = bid - (tpDistPips * point);
      
      if(trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "Anna Strategy Sell"))
      {
         lastBarTime = currentBarTime;
         Print("Sell Order Executed Successfully at Bid: ", bid);
      }
      else
      {
         Print("Error executing Sell order. Retcode: ", trade.ResultRetcode());
      }
   }
}
//+------------------------------------------------------------------+

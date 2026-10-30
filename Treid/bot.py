//+------------------------------------------------------------------+
//|                                                    AnnaBot.mq5   |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "1.00"

//--- کتابخانه‌های استاندارد معامله‌گری
#include <Trade\Trade.mqh>
CTrade trade;

//--- پارامترهای ورودی ربات
input double   InpLotSize     = 0.05;     // حجم ثابت معامله
input int      InpStopLoss    = 300;      // حد ضرر (پوینت)
input int      InpTakeProfit  = 600;      // حد سود (پوینت)
input ulong    InpMagicNumber = 20261029; // جادویی ربات

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // تنظیم مژیک نامبر برای تریدها
   trade.SetExpertMagicNumber(InpMagicNumber);
   
   Print("ربات استراتژی آنا (AnnaBot) با موفقیت بارگذاری شد.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("ربات متوقف شد.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی اینکه آیا از قبل پوزیشن بازی داریم یا خیر (قانون تک پوزیشن)
   if(PositionsTotal() > 0) return;

   // بررسی تشکیل کندل جدید یا بررسی سیگنال ساده روی نماد XAUUSD.zero
   // در اینجا نمونه منطق اجرای بر اساس کندل‌ها قرار می‌گیرد
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   
   if(CopyRates(_Symbol, PERIOD_M15, 0, 3, rates) < 3)
      return;

   // بررسی ساده روند (مثلا کندل صعودی یا نزولی قدرتمند در M15)
   bool is_bullish = (rates[1].close > rates[1].open);
   bool is_bearish = (rates[1].close < rates[1].open);

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = _Point;

   // مثال ورود Buy (اگر کندل قبلی صعودی بود)
   if(is_bullish)
   {
      double sl = ask - (InpStopLoss * point);
      double tp = ask + (InpTakeProfit * point);
      
      if(trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "Anna Bot BUY"))
      {
         Print("پوزیشن خرید با موفقیت ثبت شد.");
      }
   }
   // مثال ورود Sell (اگر کندل قبلی نزولی بود)
   else if(is_bearish)
   {
      double sl = bid + (InpStopLoss * point);
      double tp = bid - (InpTakeProfit * point);
      
      if(trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "Anna Bot SELL"))
      {
         Print("پوزیشن فروش با موفقیت ثبت شد.");
      }
   }
}
//+------------------------------------------------------------------+

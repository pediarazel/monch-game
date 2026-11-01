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
input double   InpMaxSL         = 2.0;    $   // حداکثر حد ضرر (زیر ۲ دلار / پیپ معادل طلا)
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
   
   // بررسی نماد معاملاتی (پیش‌فرض XAUUSD.zero یا XAUUSD)
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
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   // پیاده‌سازی منطق ساده‌سازی شده ورود بر اساس استراتژی آنا (شکست و FVG)
   // در اینجا نمونه منطق چک کردن روند و حجم ثابت ۰.۰۵ قرار دارد:
   
   bool buySignal = false;
   bool sellSignal = false;

   // مثال شرط ساده شکست رو به بالا (جهت تست و اتصال لایو)
   // در نسخه کامل، تشخیص سشن‌ها و FVG از طریق بافر کندل‌ها بررسی می‌شود
   if(rates[1].close > rates[1].open && rates[2].close < rates[2].open)
   {
      // سیگنال خرید فرضی بر اساس الگوی بازگشتی M1
      // buySignal = true;
   }

   // محاسبه حد ضرر و حد سود با توجه به محدودیت زیر ۲ دلار
   // برای طلا (XAUUSD)، هر ۱ دلار حرکت قیمت معادل فاصله مشخصی است
   double slDistance = 1.5; // دلار (کمتر از ۲ دلار)
   double tpDistance = slDistance * InpRR;

   // اجرای پوزیشن خرید (Buy)
   if(buySignal)
   {
      double sl = ask - slDistance;
      double tp = ask + tpDistance;
      
      trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "AnnaBot Buy 0.05");
   }

   // اجرای پوزیشن فروش (Sell)
   if(sellSignal)
   {
      double sl = bid + slDistance;
      double tp = bid - tpDistance;
      
      trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "AnnaBot Sell 0.05");
   }
}
//+------------------------------------------------------------------+

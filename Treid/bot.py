//+------------------------------------------------------------------+
//|                                           AnnaBot_Sessions.mq5 |
//|                                  Copyright 2026, Pedram & AI     |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "3.00"

#include <Trade\Trade.mqh>

//--- Inputs
input group "--- مدیریت سرمایه و ریسک ---"
input double   InpLotSize     = 0.05;    // حجم ثابت لات (Fixed Lot 0.05)
input double   InpMaxSLDist   = 2.0;     // حداکثر فاصله SL (کمتر از ۲ دلار)
input double   InpRiskReward  = 2.0;     // ضریب حد سود (RR = 2.0)

input group "--- تنظیمات زمان‌بندی و جلسات ---"
input int      InpServerOffset = -7;     // اختلاف ساعت سرور با نیویورک/UTC

input group "--- تنظیمات ربات ---"
input ulong    InpMagicNumber = 20261102; // مجیک نامبر منحصر به فرد

//--- Global Objects
CTrade         trade;
datetime       lastBarTimeM15 = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(20);
   Print("AnnaBot Sessions Initialized. Lot: ", InpLotSize, " | Sessions: Asia, London, NewYork");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("AnnaBot Sessions Stopped.");
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // تا زمانی که پوزیشن باز داریم، معامله جدیدی باز نمی‌شود
   if(PositionsTotal() > 0) return;

   // بررسی کندل جدید M15
   datetime currentM15Time = iTime(_Symbol, PERIOD_M15, 0);
   if(currentM15Time == lastBarTimeM15) return;
   lastBarTimeM15 = currentM15Time;

   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_M15, 0, 10, rates) < 10) return;

   // ۱. تبدیل ساعت سرور به ساعت محلی جلسات (نیویورک/مرجع)
   MqlDateTime dt;
   TimeToStruct(rates[1].time, dt);
   int sessionHour = (dt.hour + InpServerOffset + 24) % 24;

   // تعیین بازه جلسات معاملاتی: آسیا، لندن، نیویورک
   bool isAsiaSession     = (sessionHour >= 0  && sessionHour < 8);   // سشن آسیا
   bool isLondonSession   = (sessionHour >= 8  && sessionHour < 13);  // سشن لندن
   bool isNewYorkSession  = (sessionHour >= 13 && sessionHour < 20);  // سشن نیویورک

   // اگر خارج از این سه سشن بودیم، معامله‌ای انجام نشود
   if(!isAsiaSession && !isLondonSession && !isNewYorkSession) return;

   // ۲. تشخیص الگوهای شکست بدنه (BodyBreak) و سایه (WickSweep)
   bool isBullishBodyBreak = (rates[1].close > rates[2].high && rates[1].close > rates[1].open);
   bool isBearishBodyBreak = (rates[1].close < rates[2].low && rates[1].close < rates[1].open);
   
   bool isBullishWickSweep = (rates[1].low < rates[2].low && rates[1].close > rates[1].open);
   bool isBearishWickSweep = (rates[1].high > rates[2].high && rates[1].close < rates[1].open);

   bool buySignal  = isBullishBodyBreak || isBullishWickSweep;
   bool sellSignal = isBearishBodyBreak || isBearishWickSweep;

   if(!buySignal && !sellSignal) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double entryPrice, slPrice, tpPrice, slDist;

   if(buySignal)
   {
      entryPrice = ask;
      slPrice = rates[1].low - 0.02;
      slDist = entryPrice - slPrice;
      
      // ۳. فیلتر فاصله حد ضرر کمتر از ۲ دلار
      if(slDist < InpMaxSLDist && slDist > 0.1)
      {
         tpPrice = entryPrice + (slDist * InpRiskReward);
         
         // ۴. اجرای پوزیشن خرید با حجم ثابت 0.05
         if(trade.Buy(InpLotSize, _Symbol, entryPrice, slPrice, tpPrice, "Anna Sessions Buy"))
         {
            Print("Session BUY Opened! Price: ", entryPrice, " | SL: ", slPrice, " | TP: ", tpPrice, " | Dist: ", slDist);
         }
      }
   }
   else if(sellSignal)
   {
      entryPrice = bid;
      slPrice = rates[1].high + 0.02;
      slDist = slPrice - entryPrice;
      
      // ۳. فیلتر فاصله حد ضرر کمتر از ۲ دلار
      if(slDist < InpMaxSLDist && slDist > 0.1)
      {
         tpPrice = entryPrice - (slDist * InpRiskReward);
         
         // ۴. اجرای پوزیشن فروش با حجم ثابت 0.05
         if(trade.Sell(InpLotSize, _Symbol, entryPrice, slPrice, tpPrice, "Anna Sessions Sell"))
         {
            Print("Session SELL Opened! Price: ", entryPrice, " | SL: ", slPrice, " | TP: ", tpPrice, " | Dist: ", slDist);
         }
      }
   }
}
//+------------------------------------------------------------------+

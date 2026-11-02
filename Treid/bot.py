//+------------------------------------------------------------------+
//|                                          Anna_Strategy_Expert.mq5|
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "1.00"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Input parameters
input group "--- Risk & Money Management ---"
input double   InpLotSize       = 0.05;      // ثابت لات سیز
input double   InpStopLossUSD   = 1.80;      // حد ضرر زیر ۲ دلار (بر مبنای ارزش دلاری معامله یا پیپ معادل)
input double   InpTakeProfitRR  = 2.0;       // نسبت ریسک به ریوارد (TP = 2 * SL)

input group "--- Strategy Filters ---"
input int      InpFastEMA       = 9;         // میانگین متحرک سریع
input int      InpSlowEMA       = 21;        // میانگین متحرک کند
input int      InpRSI_Period    = 14;        // دوره RSI
input double   InpRSI_BuyLevel  = 45.0;      // سطح خرید RSI
input double   InpRSI_SellLevel = 55.0;      // سطح فروش RSI

input group "--- Trading Sessions ---"
input int      InpStartHour     = 8;         // ساعت شروع (به وقت سرور/لندن)
input int      InpEndHour       = 19;        // ساعت پایان

//--- Global variables
datetime lastBarTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   // تنظیم جادویی برای شناسایی معاملات ربات
   trade.SetExpertMagicNumber(123456);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   // پاکسازی در صورت نیاز
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی تشکیل کندل جدید
   datetime currentBarTime = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(currentBarTime == lastBarTime) return;
   
   // بررسی بازه زمانی (جلسات معاملاتی)
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(dt.hour < InpStartHour || dt.hour > InpEndHour) return;
   
   // بررسی اینکه آیا پوزیشن بازی داریم یا خیر (تک معامله همزمان)
   if(PositionsTotal() > 0) return;

   // محاسبه اندیکاتورها (EMA و RSI)
   double fastEMA[], slowEMA[], rsiValues[];
   ArraySetAsSeries(fastEMA, true);
   ArraySetAsSeries(slowEMA, true);
   ArraySetAsSeries(rsiValues, true);

   int emaFastHandle = iMA(_Symbol, PERIOD_CURRENT, InpFastEMA, 0, MODE_EMA, PRICE_CLOSE);
   int emaSlowHandle = iMA(_Symbol, PERIOD_CURRENT, InpSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   int rsiHandle     = iRSI(_Symbol, PERIOD_CURRENT, InpRSI_Period, PRICE_CLOSE);

   if(emaFastHandle == INVALID_HANDLE || emaSlowHandle == INVALID_HANDLE || rsiHandle == INVALID_HANDLE)
      return;

   CopyBuffer(emaFastHandle, 0, 0, 2, fastEMA);
   CopyBuffer(emaSlowHandle, 0, 0, 2, slowEMA);
   CopyBuffer(rsiHandle, 0, 0, 2, rsiValues);

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);

   // محاسبه حد ضرر و حد سود بر اساس دلار ($2 > SL)
   // برای لات 0.05 روی طلا، هر دلار حرکت مساوی است با ارزش تیک
   double slPoints = (InpStopLossUSD / (InpLotSize * tickValue)) * tickSize;
   if(slPoints < 50) slPoints = 150; // حداقل پوینت محافظتی برای طلا XAUUSD

   // شرط خرید (Buy)
   bool buyCondition = (fastEMA[1] > slowEMA[1]) && (fastEMA[2] <= slowEMA[2]) && (rsiValues[1] > InpRSI_BuyLevel);
   // شرط فروش (Sell)
   bool sellCondition = (fastEMA[1] < slowEMA[1]) && (fastEMA[2] >= slowEMA[2]) && (rsiValues[1] < InpRSI_SellLevel);

   if(buyCondition)
   {
      double sl = ask - slPoints * point;
      double tp = ask + (slPoints * InpTakeProfitRR) * point;
      trade.Buy(InpLotSize, _Symbol, ask, sl, tp, "Anna Strategy Buy");
      lastBarTime = currentBarTime;
   }
   else if(sellCondition)
   {
      double sl = bid + slPoints * point;
      double tp = bid - (slPoints * InpTakeProfitRR) * point;
      trade.Sell(InpLotSize, _Symbol, bid, sl, tp, "Anna Strategy Sell");
      lastBarTime = currentBarTime;
   }
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//|                                          Anna_Strategy_Expert.mq5|
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "1.01"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Input parameters
input group "--- Risk & Money Management ---"
input double   InpLotSize       = 0.05;      // ثابت لات سیز
input double   InpStopLossUSD   = 1.80;      // حد ضرر زیر ۲ دلار
input double   InpTakeProfitRR  = 2.0;       // نسبت ریسک به ریوارد (TP = 2 * SL)

input group "--- Strategy Filters ---"
input int      InpFastEMA       = 9;         // میانگین متحرک سریع
input int      InpSlowEMA       = 21;        // میانگین متحرک کند
input int      InpRSI_Period    = 14;        // دوره RSI
input double   InpRSI_BuyLevel  = 45.0;      // سطح خرید RSI
input double   InpRSI_SellLevel = 55.0;      // سطح فروش RSI

input group "--- Trading Sessions ---"
input int      InpStartHour     = 8;         // ساعت شروع (به وقت سرور)
input int      InpEndHour       = 19;        // ساعت پایان

//--- Global variables
datetime lastBarTime = 0;
int      emaFastHandle = INVALID_HANDLE;
int      emaSlowHandle = INVALID_HANDLE;
int      rsiHandle     = INVALID_HANDLE;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(123456);
   
   // ایجاد هندل اندیکاتورها یک بار در آغاز کار برای جلوگیری از خطای حافظه و افزایش سرعت
   emaFastHandle = iMA(_Symbol, PERIOD_CURRENT, InpFastEMA, 0, MODE_EMA, PRICE_CLOSE);
   emaSlowHandle = iMA(_Symbol, PERIOD_CURRENT, InpSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
   rsiHandle     = iRSI(_Symbol, PERIOD_CURRENT, InpRSI_Period, PRICE_CLOSE);
   
   if(emaFastHandle == INVALID_HANDLE || emaSlowHandle == INVALID_HANDLE || rsiHandle == INVALID_HANDLE)
   {
      Print("خطا در ایجاد هندل اندیکاتورها!");
      return(INIT_FAILED);
   }
   
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   // آزادسازی هندل‌ها
   IndicatorRelease(emaFastHandle);
   IndicatorRelease(emaSlowHandle);
   IndicatorRelease(rsiHandle);
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
   
   // بررسی اینکه آیا پوزیشن بازی داریم یا خیر
   if(PositionsTotal() > 0) return;

   // بررسی تعداد کافی کندل در تاریخچه برای جلوگیری از خطای array out of range
   if(Bars(_Symbol, PERIOD_CURRENT) < 50) return;

   double fastEMA[], slowEMA[], rsiValues[];
   ArraySetAsSeries(fastEMA, true);
   ArraySetAsSeries(slowEMA, true);
   ArraySetAsSeries(rsiValues, true);

   // کپی بافر با بررسی کامل خطا
   if(CopyBuffer(emaFastHandle, 0, 0, 3, fastEMA) < 3) return;
   if(CopyBuffer(emaSlowHandle, 0, 0, 3, slowEMA) < 3) return;
   if(CopyBuffer(rsiHandle, 0, 0, 3, rsiValues) < 3) return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);

   if(tickValue <= 0) tickValue = 1.0; // محافظت در برابر تقسیم بر صفر

   // محاسبه حد ضرر و حد سود بر اساس دلار ($1.80)
   double slPoints = (InpStopLossUSD / (InpLotSize * tickValue)) * tickSize;
   if(slPoints < 50) slPoints = 150; // حداقل پوینت محافظتی برای طلا

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

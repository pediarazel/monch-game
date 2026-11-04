//+------------------------------------------------------------------+
//|                                                     AnnaBot.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "1.08"

#include <Trade\Trade.mqh>

//--- ورودی‌ها
input double   InpLotSize            = 0.05;   // Lot Size
input double   InpRiskReward         = 2.0;    // Risk to Reward Ratio
input int      InpNYHour             = 10;     // New York Reference Hour (NY time)
input int      InpServerOffsetFromNY = 7;      // Server GMT offset minus NY offset (GMT+3 -> 7, GMT+2 -> 6)
input int      InpSessionWindowHours = 3;      // How many NY hours after ref hour to look for entries
input int      InpSlippage           = 3;      // Slippage (points)
input double   InpSLBufferPoints     = 50.0;   // SL buffer in POINTS (50 pts = 0.50 on XAUUSD 2-digit)
input double   InpFvgSLBufferPoints  = 30.0;   // FVG pinbar SL buffer in POINTS
input bool     InpDebugLog           = true;   // Print debug info to Journal

CTrade   trade;
datetime g_lastM5BarTime = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(123456);
   trade.SetDeviationInPoints(InpSlippage);
   trade.SetTypeFillingBySymbol(_Symbol);
   Print("AnnaBot 1.08 init. Symbol=", _Symbol,
         " Digits=", _Digits,
         " Point=", _Point,
         " ServerOffsetFromNY=", InpServerOffsetFromNY);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {}

//+------------------------------------------------------------------+
//| تبدیل ساعت سرور به ساعت نیویورک                                  |
//+------------------------------------------------------------------+
int ServerHourToNYHour(int serverHour)
{
   int ny = (serverHour - InpServerOffsetFromNY) % 24;
   if(ny < 0) ny += 24;
   return ny;
}

//+------------------------------------------------------------------+
void OnTick()
{
   //--- فقط یک‌بار در هر کندل M5 اجرا شو
   datetime m5Time = iTime(_Symbol, PERIOD_M5, 0);
   if(m5Time == 0) return;
   if(m5Time == g_lastM5BarTime) return;
   g_lastM5BarTime = m5Time;

   //--- اگر پوزیشن باز داریم کاری نکن
   if(PositionsTotal() > 0) return;

   //--- ساعت نیویورک الان
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   int nyHour = ServerHourToNYHour(dt.hour);

   if(InpDebugLog)
      Print("New M5 bar | ServerTime=", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES),
            " ServerHour=", dt.hour, " NYHour=", nyHour);

   //--- پنجره اجرا: از ساعت مرجع تا چند ساعت بعد (نیویورک)
   int nyEnd = InpNYHour + InpSessionWindowHours;
   bool inWindow = false;
   if(nyEnd < 24)
      inWindow = (nyHour >= InpNYHour && nyHour <= nyEnd);
   else
      inWindow = (nyHour >= InpNYHour || nyHour <= (nyEnd - 24));

   if(!inWindow)
   {
      if(InpDebugLog) Print("Outside NY window -> skip");
      return;
   }

   RunAnnaStrategy();
}

//+------------------------------------------------------------------+
void RunAnnaStrategy()
{
   MqlRates h1_rates[];
   ArraySetAsSeries(h1_rates, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 60, h1_rates) < 60)
   {
      if(InpDebugLog) Print("CopyRates H1 failed, err=", GetLastError());
      return;
   }

   //--- پیدا کردن کندل مرجع: آخرین کندلی که ساعت نیویورکش == InpNYHour
   //    (از کندل بسته‌شده قبلی به عقب می‌گردیم، index 1 = آخرین کندل بسته‌شده)
   int refIndex = -1;
   for(int i = 1; i < 48; i++)
   {
      MqlDateTime c;
      TimeToStruct(h1_rates[i].time, c);
      if(ServerHourToNYHour(c.hour) == InpNYHour)
      {
         refIndex = i;
         break;
      }
   }

   if(refIndex == -1)
   {
      if(InpDebugLog) Print("Reference H1 candle not found (NY hour=", InpNYHour, ")");
      return;
   }

   //--- قانون Inside Bar: اگر کندل مرجع داخل کندل قبلی‌اش باشد، کندل قبلی را مرجع بگیر
   if(refIndex + 1 < 60)
   {
      if(h1_rates[refIndex].high < h1_rates[refIndex+1].high &&
         h1_rates[refIndex].low  > h1_rates[refIndex+1].low)
      {
         refIndex = refIndex + 1;
      }
   }

   double refHigh = h1_rates[refIndex].high;
   double refLow  = h1_rates[refIndex].low;
   double refMid  = (refHigh + refLow) / 2.0;

   //--- کندل تأیید: آخرین کندل بسته‌شده H1
   double curClose = h1_rates[1].close;
   double curHigh  = h1_rates[1].high;
   double curLow   = h1_rates[1].low;

   if(InpDebugLog)
      Print("Anna check | RefTime=", TimeToString(h1_rates[refIndex].time, TIME_DATE|TIME_MINUTES),
            " RefHigh=", DoubleToString(refHigh, _Digits),
            " RefLow=",  DoubleToString(refLow, _Digits),
            " Close=",   DoubleToString(curClose, _Digits));

   double slBuffer  = InpSLBufferPoints * _Point;
   double fvgBuffer = InpFvgSLBufferPoints * _Point;

   //--- سناریو ۱: بسته شدن بالای سقف مرجع -> Buy
   if(curClose > refHigh)
   {
      double sl = refLow - slBuffer;
      double tp = refMid + (refMid - sl) * InpRiskReward;
      OpenBuy(sl, tp, "Anna Body Buy");
      return;
   }

   //--- سناریو ۲: بسته شدن زیر کف مرجع -> Sell
   if(curClose < refLow)
   {
      double sl = refHigh + slBuffer;
      double tp = refMid - (sl - refMid) * InpRiskReward;
      OpenSell(sl, tp, "Anna Body Sell");
      return;
   }

   //--- سناریو ۳: شکست با سایه -> تأیید M5 (FVG + Pinbar)
   bool brokeHigh = (curHigh > refHigh);
   bool brokeLow  = (curLow  < refLow);

   if(brokeHigh || brokeLow)
   {
      CheckM5FvgAndPinbar(brokeHigh, fvgBuffer);
   }
}

//+------------------------------------------------------------------+
void CheckM5FvgAndPinbar(bool isBullish, double slBuffer)
{
   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 60, m5) < 60)
   {
      if(InpDebugLog) Print("CopyRates M5 failed, err=", GetLastError());
      return;
   }

   for(int i = 2; i < 40; i++)
   {
      if(isBullish)
      {
         //--- FVG صعودی: low کندل i+2 بالاتر از high کندل i
         if(m5[i+2].low <= m5[i].high) continue;

         //--- برگشت قیمت به داخل FVG
         if(m5[i].low > m5[i+2].low) continue;

         double range = m5[i].high - m5[i].low;
         if(range <= 0) continue;

         double body = MathAbs(m5[i].close - m5[i].open);
         double lowerWick = m5[i].close - m5[i].low;

         //--- Pinbar صعودی: بدنه کوچک، سایه پایینی بلند
         if(body / range >= 0.3) continue;
         if(lowerWick <= range * 0.6) continue;

         //--- تأیید: کندل بعدی بالای high پین‌بار بسته شود
         if(m5[i-1].close <= m5[i].high) continue;

         double sl = m5[i].low - slBuffer;
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         double tp = ask + (ask - sl) * InpRiskReward;
         OpenBuy(sl, tp, "Anna M5 FVG Buy");
         return;
      }
      else
      {
         //--- FVG نزولی: high کندل i+2 پایین‌تر از low کندل i
         if(m5[i+2].high >= m5[i].low) continue;

         if(m5[i].high < m5[i+2].high) continue;

         double range = m5[i].high - m5[i].low;
         if(range <= 0) continue;

         double body = MathAbs(m5[i].close - m5[i].open);
         double upperWick = m5[i].high - m5[i].close;

         //--- Pinbar نزولی: بدنه کوچک، سایه بالایی بلند
         if(body / range >= 0.3) continue;
         if(upperWick <= range * 0.6) continue;

         if(m5[i-1].close >= m5[i].low) continue;

         double sl = m5[i].high + slBuffer;
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         double tp = bid - (sl - bid) * InpRiskReward;
         OpenSell(sl, tp, "Anna M5 FVG Sell");
         return;
      }
   }

   if(InpDebugLog) Print("M5 FVG+Pinbar not confirmed (bullish=", isBullish, ")");
}

//+------------------------------------------------------------------+
void OpenBuy(double sl, double tp, string comment)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(sl >= ask || tp <= ask)
   {
      Print("Buy rejected: invalid SL/TP. ask=", ask, " sl=", sl, " tp=", tp);
      return;
   }
   if(!trade.Buy(InpLotSize, _Symbol, ask, sl, tp, comment))
      Print("Buy failed. retcode=", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   else
      Print("BUY opened @", ask, " SL=", sl, " TP=", tp, " [", comment, "]");
}

void OpenSell(double sl, double tp, string comment)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(sl <= bid || tp >= bid)
   {
      Print("Sell rejected: invalid SL/TP. bid=", bid, " sl=", sl, " tp=", tp);
      return;
   }
   if(!trade.Sell(InpLotSize, _Symbol, bid, sl, tp, comment))
      Print("Sell failed. retcode=", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   else
      Print("SELL opened @", bid, " SL=", sl, " TP=", tp, " [", comment, "]");
}
//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
//|                                     PedramStrategy_Final_EA.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "4.00"
#property strict

#include <Trade\Trade.mqh>
CTrade trade;

//--- ورودی‌های کاربر
input group "=== تنظیمات عمومی معامله ==="
input string   InpSymbol           = "XAUUSD";      // نماد معاملاتی
input double   InpLotSize          = 0.05;          // حجم ثابت ورود
input double   InpRiskReward       = 2.0;           // ریسک به ریوارد
input ulong    InpMagicNumber      = 140503;        // مجیک نامبر
input int      InpMaxSpread        = 60;            // حداکثر اسپرد مجاز (پوینت)

input group "=== تنظیمات ساعت سرور و نیویورک ==="
input int      InpNY_Hour          = 10;            // ساعت ۱۰ نیویورک
input int      InpServerGMTOffset  = 2;             // ساعت بروکر به GMT
input int      InpNYGMTOffset      = -5;            // اختلاف نیویورک با GMT

//--- استیت‌های چرخه استراتژی
enum ENUM_STRATEGY_STATE
{
   STATE_IDLE,
   STATE_WAIT_FOR_H1_BREAK,
   STATE_M5_WAIT_FVG_BREAK,
   STATE_M5_WAIT_PULLBACK,
   STATE_M5_WAIT_DOJI,
   STATE_M5_WAIT_CONFIRMATION,
   STATE_DONE_TODAY
};

ENUM_STRATEGY_STATE currentState = STATE_IDLE;

//--- متغیرهای پایش
datetime currentDayStart     = 0;
double   refHigh             = 0.0;
double   refLow              = 0.0;
double   ref50               = 0.0;
int      sweepDirection      = 0;     // +1: شکست سایه از کف (بای) | -1: شکست سایه از سقف (سل)
double   sweepExtremeLevel   = 0.0;   // سقف یا کفی که با سایه شکسته شد (محل استاپ)
double   fvgTop              = 0.0;
double   fvgBottom           = 0.0;
datetime dojiCandleTime      = 0;

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(20);
   Print("ربات استراتژی پدرام با موفقیت فعال شد.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| تبدیل ساعت نیویورک به ساعت سرور متاتریدر                         |
//+------------------------------------------------------------------+
int GetServerTargetHour()
{
   int hourDiff = InpNYGMTOffset - InpServerGMTOffset;
   int target = InpNY_Hour - hourDiff;
   if(target < 0)  target += 24;
   if(target >= 24) target -= 24;
   return target;
}

//+------------------------------------------------------------------+
//| OnTick Event                                                     |
//+------------------------------------------------------------------+
void OnTick()
{
   // بررسی اسپرد
   if(SymbolInfoInteger(InpSymbol, SYMBOL_SPREAD) > InpMaxSpread) return;

   MqlDateTime dt;
   TimeCurrent(dt);

   // ریست در آغاز هر روز معاملاتی
   datetime today = iTime(InpSymbol, PERIOD_D1, 0);
   if(today != currentDayStart)
   {
      currentDayStart = today;
      currentState = STATE_IDLE;
      CancelAllPendingOrders(); // پاکسازی سفارشات روز قبل
   }

   int serverHour = GetServerTargetHour();

   // ۱. بعد از بسته شدن کندل ۱۰ نیویورک، سقف، کف و ۵۰٪ را ثبت کن
   if(currentState == STATE_IDLE)
   {
      int closeHour = (serverHour + 1) % 24;
      if(dt.hour == closeHour && dt.min >= 1)
      {
         CaptureReferenceCandle(serverHour);
         currentState = STATE_WAIT_FOR_H1_BREAK;
      }
   }

   // ۲. بررسی شکست در H1 (بدنه یا شدو)
   if(currentState == STATE_WAIT_FOR_H1_BREAK)
   {
      CheckH1Breakout();
   }

   // ۳. مراحل تایم‌فریم ۵ دقیقه
   if(currentState >= STATE_M5_WAIT_FVG_BREAK && currentState <= STATE_M5_WAIT_CONFIRMATION)
   {
      ProcessM5Flow();
   }
}

//+------------------------------------------------------------------+
//| تعیین کندل مرجع و بررسی کندل مادر (Inside Bar)                    |
//+------------------------------------------------------------------+
void CaptureReferenceCandle(int serverHour)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 0, 8, rates) < 4) return;

   int targetIdx = -1;
   for(int i = 1; i < 6; i++)
   {
      MqlDateTime cdt;
      TimeToStruct(rates[i].time, cdt);
      if(cdt.hour == serverHour)
      {
         targetIdx = i;
         break;
      }
   }

   if(targetIdx == -1) targetIdx = 1;

   // بررسی اینساید بار (Inside Bar)
   int motherIdx = targetIdx + 1;
   if(rates[targetIdx].high < rates[motherIdx].high && rates[targetIdx].low > rates[motherIdx].low)
   {
      refHigh = rates[motherIdx].high;
      refLow  = rates[motherIdx].low;
      Print("کندل ۱۰ در دل کندل قبل بود (Inside Bar). کندل مادر مبنا قرار گرفت.");
   }
   else
   {
      refHigh = rates[targetIdx].high;
      refLow  = rates[targetIdx].low;
   }

   ref50 = (refHigh + refLow) / 2.0;
   PrintFormat("کندل مبنا مشخص شد -> سقف: %.2f | کف: %.2f | تراز ۵۰٪: %.2f", refHigh, refLow, ref50);
}

//+------------------------------------------------------------------+
//| بررسی شکست در H1                                                  |
//+------------------------------------------------------------------+
void CheckH1Breakout()
{
   if(PositionsTotal() > 0 || OrdersTotal() > 0) return;

   MqlRates rH1[];
   ArraySetAsSeries(rH1, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 0, 3, rH1) < 3) return;

   double close = rH1[1].close;
   double high  = rH1[1].high;
   double low   = rH1[1].low;
   double point = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);

   // سناریو ۱: شکست با بدنه (Body Breakout)
   if(close > refHigh) // شکست صعودی با بدنه
   {
      double sl = refLow - (20 * point); // استاپ زیر کندل ۱۰
      double risk = ref50 - sl;
      double tp = ref50 + (risk * InpRiskReward);

      trade.BuyLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Pedram BuyLimit 50%");
      currentState = STATE_DONE_TODAY;
      Print("شکست صعودی با بدنه رخ داد. اوردر Buy Limit در تراز ۵۰٪ ثبت شد.");
      return;
   }
   else if(close < refLow) // شکست نزولی با بدنه
   {
      double sl = refHigh + (20 * point); // استاپ بالای کندل ۱۰
      double risk = sl - ref50;
      double tp = ref50 - (risk * InpRiskReward);

      trade.SellLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Pedram SellLimit 50%");
      currentState = STATE_DONE_TODAY;
      Print("شکست نزولی با بدنه رخ داد. اوردر Sell Limit در تراز ۵۰٪ ثبت شد.");
      return;
   }

   // سناریو ۲: شکست فقط با سایه (Wick Sweep)
   if(high > refHigh && close <= refHigh)
   {
      // سقف فقط با سایه زده شد -> سناریوی فروش در ۵ دقیقه
      sweepDirection = -1;
      sweepExtremeLevel = high; // استاپ پشت این سقف خواهد بود
      if(FindPreBreakFVG(sweepDirection))
      {
         currentState = STATE_M5_WAIT_FVG_BREAK;
         Print("سقف با سایه رد شد. FVG پیدا شد، منتظر شکست FVG در ۵ دقیقه...");
      }
   }
   else if(low < refLow && close >= refLow)
   {
      // کف فقط با سایه زده شد -> سناریوی خرید در ۵ دقیقه
      sweepDirection = +1;
      sweepExtremeLevel = low; // استاپ پشت این کف خواهد بود
      if(FindPreBreakFVG(sweepDirection))
      {
         currentState = STATE_M5_WAIT_FVG_BREAK;
         Print("کف با سایه رد شد. FVG پیدا شد، منتظر شکست FVG در ۵ دقیقه...");
      }
   }
}

//+------------------------------------------------------------------+
//| پیدا کردن FVG در تایم‌فریم ۵ دقیقه قبل از شکست                     |
//+------------------------------------------------------------------+
bool FindPreBreakFVG(int dir)
{
   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   int copied = CopyRates(InpSymbol, PERIOD_M5, 0, 50, m5);
   if(copied < 20) return false;

   // جستجوی FVG قبل از کندل سوئیپ
   for(int i = 2; i < 35; i++)
   {
      if(dir == -1) // سناریوی سل: FVG صعودی قبلی که قیمت باید بشکند و بریزد
      {
         if(m5[i].low > m5[i+2].high)
         {
            fvgTop = m5[i].low;
            fvgBottom = m5[i+2].high;
            PrintFormat("FVG قبل از شکست پیدا شد: از %.2f تا %.2f", fvgBottom, fvgTop);
            return true;
         }
      }
      else if(dir == +1) // سناریوی بای: FVG نزولی قبلی که قیمت باید بشکند و بالا رود
      {
         if(m5[i+2].low > m5[i].high)
         {
            fvgTop = m5[i+2].low;
            fvgBottom = m5[i].high;
            PrintFormat("FVG قبل از شکست پیدا شد: از %.2f تا %.2f", fvgBottom, fvgTop);
            return true;
         }
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| پردازش کامل سناریو ۲ در تایم ۵ دقیقه                             |
//+------------------------------------------------------------------+
void ProcessM5Flow()
{
   if(PositionsTotal() > 0) return;

   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   if(CopyRates(InpSymbol, PERIOD_M5, 0, 5, m5) < 4) return;

   double bid   = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask   = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double point = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);

   // مرحله الف: قیمت FVG را با سایه یا بدنه بشکند
   if(currentState == STATE_M5_WAIT_FVG_BREAK)
   {
      if(sweepDirection == -1) // سل: کف FVG شکسته شود به سمت پایین
      {
         if(m5[1].low < fvgBottom)
         {
            currentState = STATE_M5_WAIT_PULLBACK;
            Print("ناحیه FVG به سمت پایین شکسته شد. منتظر پولبک به FVG...");
         }
      }
      else if(sweepDirection == +1) // بای: سقف FVG شکسته شود به سمت بالا
      {
         if(m5[1].high > fvgTop)
         {
            currentState = STATE_M5_WAIT_PULLBACK;
            Print("ناحیه FVG به سمت بالا شکسته شد. منتظر پولبک به FVG...");
         }
      }
   }

   // مرحله ب: پولبک به FVG شکسته شده
   if(currentState == STATE_M5_WAIT_PULLBACK)
   {
      // آیا قیمت دوباره وارد باکس FVG شده است؟
      bool insideFVG = (m5[0].high >= fvgBottom && m5[0].low <= fvgTop);
      if(insideFVG)
      {
         currentState = STATE_M5_WAIT_DOJI;
         Print("قیمت به FVG پولبک زد. منتظر تشکیل کندل دوجی (Doji)...");
      }
   }

   // مرحله ج: کندل دوجی در پولبک تشکیل شود
   if(currentState == STATE_M5_WAIT_DOJI)
   {
      // مشخصات کندل بسته شده [1]
      double body = MathAbs(m5[1].close - m5[1].open);
      double totalRange = m5[1].high - m5[1].low;

      if(totalRange > 0)
      {
         // تعریف استاندارد دوجی: بدنه کندل بسیار کوچک و کمتر از ۲۰٪ کل رنج کندل باشد
         if((body / totalRange) <= 0.20)
         {
            dojiCandleTime = m5[1].time;
            currentState = STATE_M5_WAIT_CONFIRMATION;
            Print("کندل دوجی تایید شد! در انتظار کندل تاییدیه بعد از دوجی...");
         }
      }
   }

   // مرحله د: کندل تایید بعد از دوجی بسته شود و ورود مارکت
   if(currentState == STATE_M5_WAIT_CONFIRMATION)
   {
      // بررسی اینکه آیا کندل جدیدی بعد از دوجی بسته شده است
      if(m5[1].time > dojiCandleTime)
      {
         if(sweepDirection == -1) // سناریوی سل: کندل تایید باید نزولی باشد و کلوز زیر اوپن داشته باشد
         {
            if(m5[1].close < m5[1].open)
            {
               double sl = sweepExtremeLevel + (20 * point); // استاپ پشت سقف شکسته شده با سایه
               double risk = sl - bid;
               if(risk > 0)
               {
                  double tp = bid - (risk * InpRiskReward); // تارگت ۲ برابر استاپ
                  trade.Sell(InpLotSize, InpSymbol, bid, sl, tp, "Pedram M5 FVG+Doji Sell");
                  currentState = STATE_DONE_TODAY;
                  Print("کندل تاییدیه نزولی بسته شد. معامله SELL باز شد.");
               }
            }
         }
         else if(sweepDirection == +1) // سناریوی بای: کندل تایید باید صعودی باشد و کلوز بالای اوپن داشته باشد
         {
            if(m5[1].close > m5[1].open)
            {
               double sl = sweepExtremeLevel - (20 * point); // استاپ پشت کف شکسته شده با سایه
               double risk = ask - sl;
               if(risk > 0)
               {
                  double tp = ask + (risk * InpRiskReward); // تارگت ۲ برابر استاپ
                  trade.Buy(InpLotSize, InpSymbol, ask, sl, tp, "Pedram M5 FVG+Doji Buy");
                  currentState = STATE_DONE_TODAY;
                  Print("کندل تاییدیه صعودی بسته شد. معامله BUY باز شد.");
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| لغو اردرهای لیمیت معلق روز قبل                                  |
//+------------------------------------------------------------------+
void CancelAllPendingOrders()
{
   for(int i = OrdersTotal() - 1; i >= 0; i--)
   {
      ulong ticket = OrderGetTicket(i);
      if(ticket > 0)
      {
         if(OrderGetString(ORDER_SYMBOL) == InpSymbol && OrderGetInteger(ORDER_MAGIC) == InpMagicNumber)
         {
            trade.OrderDelete(ticket);
         }
      }
   }
}
//+------------------------------------------------------------------+

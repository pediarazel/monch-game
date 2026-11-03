//+------------------------------------------------------------------+
//|                                     PedramStrategy_Final_EA.mq5  |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Pedram Strategy"
#property link      "https://www.mql5.com"
#property version   "3.00"
#property strict

#include <Trade\Trade.mqh>
CTrade trade;

//--- تنظیمات ورودی
input group "=== تنظیمات عمومی معامله ==="
input string   InpSymbol           = "XAUUSD";      // نماد معاملاتی
input double   InpLotSize          = 0.05;          // حجم ثابت ورود (Lot)
input double   InpRiskReward       = 2.0;           // ریسک به ریوارد (RR)
input ulong    InpMagicNumber      = 140503;        // مجیک نامبر ربات
input int      InpMaxSpread        = 60;            // حداکثر اسپرد مجاز (پوینت)

input group "=== تنظیمات ساعت نیویورک ==="
input int      InpNY_Hour          = 10;            // ساعت ۱۰ صبح نیویورک
input int      InpServerGMTOffset  = 2;             // ساعت اختلاف بروکر با GMT (مثلاً +2 یا +3)
input int      InpNYGMTOffset      = -5;            // اختلاف نیویورک با GMT (زمستان -5 و تابستان -4)

//--- استیت‌های استراتژی
enum ENUM_SETUP_STATE
{
   STATE_WAITING_FOR_10AM,
   STATE_MONITORING_H1_BREAK,
   STATE_M5_WAIT_FVG_TEST,
   STATE_M5_WAIT_PINBAR,
   STATE_M5_WAIT_CONFIRMATION,
   STATE_DONE_FOR_DAY
};

ENUM_SETUP_STATE currentState = STATE_WAITING_FOR_10AM;

//--- متغیرهای پایش روزانه
datetime currentDayTime      = 0;
double   refHigh             = 0.0;
double   refLow              = 0.0;
double   ref50               = 0.0;
int      sweepDirection      = 0;   // +1 یعنی کف زده شده (منتظر بای)، -1 یعنی سقف زده شده (منتظر سل)
double   sweepExtremeLevel   = 0.0; // سقف یا کف قبل بازگشت
double   fvgHigh             = 0.0;
double   fvgLow              = 0.0;
datetime pinbarTime          = 0;
double   pinbarExtreme       = 0.0;

//+------------------------------------------------------------------+
//| Init                                                             |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(25);
   Print("Pedram Strategy Final EA loaded successfully.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Deinit                                                           |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   Print("Pedram Strategy EA stopped.");
}

//+------------------------------------------------------------------+
//| تابع تبدیل ساعت ۱۰ نیویورک به ساعت سرور                         |
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
   long spread = SymbolInfoInteger(InpSymbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpread) return;

   MqlDateTime dt;
   TimeCurrent(dt);

   // ریست روزانه (ساعت 00:00 سرور)
   datetime todayStart = iTime(InpSymbol, PERIOD_D1, 0);
   if(todayStart != currentDayTime)
   {
      currentDayTime = todayStart;
      currentState = STATE_WAITING_FOR_10AM;
      CancelAllPendingOrders(); // لغو اردرهای لیمیت روز قبل که تاچ نشدند
   }

   int targetServerHour = GetServerTargetHour();

   // ۱. وقتی کندل ۱۰ نیویورک بسته شد، مشخصات کندل را استخراج کن
   if(currentState == STATE_WAITING_FOR_10AM)
   {
      // کندل ساعت ۱۰ نیویورک دقیقاً در انتهای آن ساعت یعنی راس (targetServerHour + 1) بسته می‌شود
      int closeHour = (targetServerHour + 1) % 24;
      if(dt.hour == closeHour && dt.min >= 1)
      {
         CaptureReferenceCandle(targetServerHour);
         currentState = STATE_MONITORING_H1_BREAK;
      }
   }

   // ۲. مانیتورینگ شکست در H1 (با بدنه یا با شدو)
   if(currentState == STATE_MONITORING_H1_BREAK)
   {
      CheckH1Breakout();
   }

   // ۳. در صورتی که با شدو رد شده بود: پیگیری سناریوی M5 (FVG + پین‌بار + تاییدیه)
   if(currentState == STATE_M5_WAIT_FVG_TEST || 
      currentState == STATE_M5_WAIT_PINBAR   || 
      currentState == STATE_M5_WAIT_CONFIRMATION)
   {
      ProcessM5Strategy();
   }
}

//+------------------------------------------------------------------+
//| دریافت و فیلتر کندل ساعت ۱۰ (با احتساب کندل مادر Inside Bar)     |
//+------------------------------------------------------------------+
void CaptureReferenceCandle(int serverHour)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(InpSymbol, PERIOD_H1, 0, 10, rates);
   if(copied < 5) return;

   // پیدا کردن کندل ساعت ۱۰ در میان کندل‌های اخیر
   int targetIndex = -1;
   for(int i = 1; i < 5; i++)
   {
      MqlDateTime candleDt;
      TimeToStruct(rates[i].time, candleDt);
      if(candleDt.hour == serverHour)
      {
         targetIndex = i;
         break;
      }
   }

   if(targetIndex == -1) targetIndex = 1; // فال‌بک امن

   // نکته مهم: بررسی اینکه آیا کندل ۱۰ در دل کندل قبل از خود قرار دارد؟ (Inside Bar)
   int motherIndex = targetIndex + 1;
   if(rates[targetIndex].high < rates[motherIndex].high && rates[targetIndex].low > rates[motherIndex].low)
   {
      refHigh = rates[motherIndex].high;
      refLow  = rates[motherIndex].low;
      Print("کندل ۱۰ در دل کندل مادر بود. کندل مادر به عنوان مرجع انتخاب شد.");
   }
   else
   {
      refHigh = rates[targetIndex].high;
      refLow  = rates[targetIndex].low;
   }

   ref50 = (refHigh + refLow) / 2.0; // تراز ۵۰ درصد تعادل
   PrintFormat("کندل مبنا ثبت شد -> سقف: %.2f | کف: %.2f | تراز ۵۰٪: %.2f", refHigh, refLow, ref50);
}

//+------------------------------------------------------------------+
//| بررسی کندل‌های بعدی برای شکست بدنه یا شکست سایه                  |
//+------------------------------------------------------------------+
void CheckH1Breakout()
{
   if(PositionsTotal() > 0 || OrdersTotal() > 0) return;

   MqlRates rH1[];
   ArraySetAsSeries(rH1, true);
   if(CopyRates(InpSymbol, PERIOD_H1, 0, 3, rH1) < 3) return;

   // کندل [1] آخرین کندل بسته شده ساعتی بعد از کندل ۱۰ است
   double closePrice = rH1[1].close;
   double highPrice  = rH1[1].high;
   double lowPrice   = rH1[1].low;
   double point      = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);

   // سناریو ۱: شکست با بدنه (Body Breakout)
   if(closePrice > refHigh) // شکست سقف با بدنه -> خرید
   {
      double sl = refLow - (20 * point); // استاپ پشت کندل ۱۰
      double risk = ref50 - sl;
      double tp = ref50 + (risk * InpRiskReward);

      // ثبت Buy Limit روی تراز ۵۰٪
      trade.BuyLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Pedram BuyLimit 50%");
      currentState = STATE_DONE_FOR_DAY;
      Print("شکست صعودی با بدنه تایید شد. اوردر Buy Limit در تراز ۵۰٪ قرار گرفت.");
      return;
   }
   else if(closePrice < refLow) // شکست کف با بدنه -> فروش
   {
      double sl = refHigh + (20 * point); // استاپ پشت کندل ۱۰
      double risk = sl - ref50;
      double tp = ref50 - (risk * InpRiskReward);

      // ثبت Sell Limit روی تراز ۵۰٪
      trade.SellLimit(InpLotSize, ref50, InpSymbol, sl, tp, ORDER_TIME_DAY, 0, "Pedram SellLimit 50%");
      currentState = STATE_DONE_FOR_DAY;
      Print("شکست نزولی با بدنه تایید شد. اوردر Sell Limit در تراز ۵۰٪ قرار گرفت.");
      return;
   }

   // سناریو ۲: شکست فقط با سایه (Wick Sweep)
   if(highPrice > refHigh && closePrice <= refHigh)
   {
      // سقف رد شد ولی با سایه -> ورود به سناریوی سل در M5
      sweepDirection = -1;
      sweepExtremeLevel = highPrice;
      FindLeftFVG(sweepDirection);
      currentState = STATE_M5_WAIT_FVG_TEST;
      Print("سقف فقط با سایه رد شد (Sweep). جستجو برای FVG و ورود به تایم ۵ دقیقه...");
   }
   else if(lowPrice < refLow && closePrice >= refLow)
   {
      // کف رد شد ولی با سایه -> ورود به سناریوی بای در M5
      sweepDirection = +1;
      sweepExtremeLevel = lowPrice;
      FindLeftFVG(sweepDirection);
      currentState = STATE_M5_WAIT_FVG_TEST;
      Print("کف فقط با سایه رد شد (Sweep). جستجو برای FVG و ورود به تایم ۵ دقیقه...");
   }
}

//+------------------------------------------------------------------+
//| پیدا کردن FVG در سمت چپ چارت تایم ۵ دقیقه                       |
//+------------------------------------------------------------------+
void FindLeftFVG(int dir)
{
   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   int copied = CopyRates(InpSymbol, PERIOD_M5, 0, 50, m5);
   if(copied < 30) return;

   // الگوی گپ سه کندلی (Fair Value Gap):
   // نزولی: کف کندل i+2 بالاتر از سقف کندل i باشد -> گپ بین Low(i+2) و High(i)
   // صعودی: سقف کندل i+2 پایین‌تر از کف کندل i باشد -> گپ بین High(i+2) و Low(i)
   for(int i = 2; i < 40; i++)
   {
      if(dir == -1) // دنبال FVG نزولی در سمت چپ
      {
         if(m5[i+2].low > m5[i].high)
         {
            fvgHigh = m5[i+2].low;
            fvgLow  = m5[i].high;
            PrintFormat("FVG نزولی سمت چپ پیدا شد: محدوده %.2f تا %.2f", fvgLow, fvgHigh);
            return;
         }
      }
      else if(dir == +1) // دنبال FVG صعودی در سمت چپ
      {
         if(m5[i+2].high < m5[i].low)
         {
            fvgHigh = m5[i].low;
            fvgLow  = m5[i+2].high;
            PrintFormat("FVG صعودی سمت چپ پیدا شد: محدوده %.2f تا %.2f", fvgLow, fvgHigh);
            return;
         }
      }
   }
}

//+------------------------------------------------------------------+
//| پردازش مراحل M5: تست FVG -> پین بار -> تاییدیه با بدنه            |
//+------------------------------------------------------------------+
void ProcessM5Strategy()
{
   if(PositionsTotal() > 0) return;

   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   if(CopyRates(InpSymbol, PERIOD_M5, 0, 5, m5) < 5) return;

   double currentBid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double currentAsk = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double point      = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);

   // مرحله ۱: آیا قیمت برگشته و وارد زون FVG شده است؟
   if(currentState == STATE_M5_WAIT_FVG_TEST)
   {
      bool isInsideFVG = (m5[0].high >= fvgLow && m5[0].low <= fvgHigh);
      if(isInsideFVG)
      {
         currentState = STATE_M5_WAIT_PINBAR;
         Print("قیمت به ناحیه FVG برگشت. منتظر تشکیل پین‌بار...");
      }
   }

   // مرحله ۲: بررسی تشکیل پین بار در کندل بسته شده [1]
   if(currentState == STATE_M5_WAIT_PINBAR)
   {
      double body = MathAbs(m5[1].close - m5[1].open);
      double total = m5[1].high - m5[1].low;
      if(total <= 0) return;

      bool pinFound = false;

      // شرط پین‌بار: بدنه حداکثر ۳۰٪ کل رنج کندل باشد و شدو بلند در جهت عکس
      if((body / total) <= 0.30)
      {
         if(sweepDirection == -1) // شوتینگ استار / پین‌بار نزولی
         {
            double upperWick = m5[1].high - MathMax(m5[1].open, m5[1].close);
            if(upperWick >= (total * 0.55)) pinFound = true;
         }
         else if(sweepDirection == +1) // چکش / پین‌بار صعودی
         {
            double lowerWick = MathMin(m5[1].open, m5[1].close) - m5[1].low;
            if(lowerWick >= (total * 0.55)) pinFound = true;
         }
      }

      if(pinFound)
      {
         pinbarTime = m5[1].time;
         pinbarExtreme = (sweepDirection == -1) ? m5[1].low : m5[1].high;
         currentState = STATE_M5_WAIT_CONFIRMATION;
         Print("پین‌بار تایید شد. در انتظار کندل تاییدیه بدنه...");
      }
   }

   // مرحله ۳: کندل تاییدیه با بدنه، کلوز پین‌بار را رد کند -> ورود مارکت
   if(currentState == STATE_M5_WAIT_CONFIRMATION)
   {
      // کندل تاییدیه [1] باید بعد از کندل پین بار بسته شده باشد
      if(m5[1].time > pinbarTime)
      {
         if(sweepDirection == -1) // فروش
         {
            // کلوز کندل تاییدیه زیر کف پین بار باشد (شکست با بدنه)
            if(m5[1].close < pinbarExtreme)
            {
               double sl = sweepExtremeLevel + (20 * point); // استاپ سقف ثبت شده
               double risk = sl - currentBid;
               if(risk > 0)
               {
                  double tp = currentBid - (risk * InpRiskReward);
                  trade.Sell(InpLotSize, InpSymbol, currentBid, sl, tp, "Pedram M5 FVG+Pinbar Sell");
                  currentState = STATE_DONE_FOR_DAY;
                  Print("معامله SELL با تاییدیه بدنه باز شد.");
               }
            }
         }
         else if(sweepDirection == +1) // خرید
         {
            // کلوز کندل تاییدیه بالای سقف پین بار باشد (شکست با بدنه)
            if(m5[1].close > pinbarExtreme)
            {
               double sl = sweepExtremeLevel - (20 * point); // استاپ کف ثبت شده
               double risk = currentAsk - sl;
               if(risk > 0)
               {
                  double tp = currentAsk + (risk * InpRiskReward);
                  trade.Buy(InpLotSize, InpSymbol, currentAsk, sl, tp, "Pedram M5 FVG+Pinbar Buy");
                  currentState = STATE_DONE_FOR_DAY;
                  Print("معامله BUY با تاییدیه بدنه باز شد.");
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| لغو کلیه اردرهای لیمیت بازمانده روز قبل                          |
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

#property strict
#property version   "1.00"
#property copyright "Pedram"
#property description "استراتژی الگوهای هارمونیک ZigZag PA"

#include <Trade\Trade.mqh>

input group "تنظیمات عمومی"
input bool InpUseHA = false;                 // استفاده از کندل‌های هیکن‌آشی
input bool InpUseAltTF = true;               // استفاده از تایم‌فریم جایگزین
input ENUM_TIMEFRAMES InpAltTF = PERIOD_H1;  // تایم‌فریم جایگزین
input bool InpShowPatterns = true;            // نمایش الگوها
input double InpLot = 0.03;                   // حجم ثابت
input bool InpCloseOnOpposite = true;         // رزرو برای سازگاری؛ خروج با قوانین هدف انجام می‌شود
input bool InpAllowHedge = false;             // اجازه داشتن معاملات دوطرفه

input group "هدف اول"
input bool InpT1Active = true;
input double InpT1EwRate = 0.236;
input double InpT1TpRate = 0.618;
input double InpT1SlRate = -0.236;

input group "هدف دوم"
input bool InpT2Active = false;
input double InpT2EwRate = 0.236;
input double InpT2TpRate = 1.618;
input double InpT2SlRate = -0.236;

input group "معامله"
input long InpMagic = 20261110;
input double InpSlippagePoints = 20;

CTrade trade;
datetime lastBarTime = 0;
datetime lastAltBarTime = 0;
double cachedAltPrices[5];
datetime cachedAltTimes[5];
int cachedAltCount = 0;
string previousPatternKey = "";

struct PivotPoint
  {
   double price;
   datetime time;
  };

// بررسی قرارگرفتن نسبت در بازه مجاز
bool InRange(const double value,const double minimum,const double maximum)
  {
   return (value>=minimum && value<=maximum);
  }

// هر تابع الگو نسبت‌های XAB، XAD، ABC و BCD را دریافت می‌کند
bool isBat(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.382,0.5) && InRange(abc,0.382,0.886) && InRange(bcd,1.618,2.618) && xad<=0.618; }
bool isAntiBat(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.5,0.886) && InRange(abc,1.0,2.618) && InRange(bcd,1.618,2.618) && InRange(xad,0.886,1.0); }
bool isAltBat(double xab,double xad,double abc,double bcd)
  { return xab<=0.382 && InRange(abc,0.382,0.886) && InRange(bcd,2.0,3.618) && xad<=1.13; }
bool isButterfly(double xab,double xad,double abc,double bcd)
  { return xab<=0.786 && InRange(abc,0.382,0.886) && InRange(bcd,1.618,2.618) && InRange(xad,1.27,1.618); }
bool isAntiButterfly(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.236,0.886) && InRange(abc,1.13,2.618) && InRange(bcd,1.0,1.382) && InRange(xad,0.5,0.886); }
bool isABCD(double xab,double xad,double abc,double bcd)
  { return InRange(abc,0.382,0.886) && InRange(bcd,1.13,2.618); }
bool isGartley(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.5,0.618) && InRange(abc,0.382,0.886) && InRange(bcd,1.13,2.618) && InRange(xad,0.75,0.875); }
bool isAntiGartley(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.5,0.886) && InRange(abc,1.0,2.618) && InRange(bcd,1.5,5.0) && InRange(xad,1.0,5.0); }
bool isCrab(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.5,0.875) && InRange(abc,0.382,0.886) && InRange(bcd,2.0,5.0) && InRange(xad,1.382,5.0); }
bool isAntiCrab(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.25,0.5) && InRange(abc,1.13,2.618) && InRange(bcd,1.618,2.618) && InRange(xad,0.5,0.75); }
bool isShark(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.5,0.875) && InRange(abc,1.13,1.618) && InRange(bcd,1.27,2.24) && InRange(xad,0.886,1.13); }
bool isAntiShark(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.382,0.875) && InRange(abc,0.5,1.0) && InRange(bcd,1.25,2.618) && InRange(xad,0.5,1.25); }
bool is5o(double xab,double xad,double abc,double bcd)
  { return InRange(xab,1.13,1.618) && InRange(abc,1.618,2.24) && InRange(bcd,0.5,0.625) && InRange(xad,0.0,0.236); }
bool isWolf(double xab,double xad,double abc,double bcd)
  { return InRange(xab,1.27,1.618) && InRange(abc,0.0,5.0) && InRange(bcd,1.27,1.618) && InRange(xad,0.0,5.0); }
bool isHnS(double xab,double xad,double abc,double bcd)
  { return InRange(xab,2.0,10.0) && InRange(abc,0.9,1.1) && InRange(bcd,0.236,0.88) && InRange(xad,0.9,1.1); }
bool isConTria(double xab,double xad,double abc,double bcd)
  { return InRange(xab,0.382,0.618) && InRange(abc,0.382,0.618) && InRange(bcd,0.382,0.618) && InRange(xad,0.236,0.764); }
bool isExpTria(double xab,double xad,double abc,double bcd)
  { return InRange(xab,1.236,1.618) && InRange(abc,1.0,1.618) && InRange(bcd,1.236,2.0) && InRange(xad,2.0,2.236); }

// محاسبه نسبت‌ها و تشخیص الگوی نخست از گروه مربوطه
bool DetectPattern(const int mode,const PivotPoint &pivots[],string &pattern,
                   double &xab,double &xad,double &abc,double &bcd)
  {
   pattern="";
   if(ArraySize(pivots)<5) return false;
   double x=pivots[0].price, a=pivots[1].price, b=pivots[2].price;
   double c=pivots[3].price, d=pivots[4].price;
   double denXA=MathAbs(x-a), denAB=MathAbs(a-b), denBC=MathAbs(b-c);
   if(denXA<=0.0 || denAB<=0.0 || denBC<=0.0) return false;
   if(mode==1 && !(d<c)) return false;
   if(mode==-1 && !(d>c)) return false;
   xab=MathAbs(b-a)/denXA;
   xad=MathAbs(a-d)/denXA;
   abc=MathAbs(b-c)/denAB;
   bcd=MathAbs(c-d)/denBC;
   if(mode==1)
     {
      if(isABCD(xab,xad,abc,bcd)) pattern="ABCD";
      else if(isBat(xab,xad,abc,bcd)) pattern="Bat";
      else if(isAltBat(xab,xad,abc,bcd)) pattern="AltBat";
      else if(isButterfly(xab,xad,abc,bcd)) pattern="Butterfly";
      else if(isGartley(xab,xad,abc,bcd)) pattern="Gartley";
      else if(isCrab(xab,xad,abc,bcd)) pattern="Crab";
      else if(isShark(xab,xad,abc,bcd)) pattern="Shark";
      else if(is5o(xab,xad,abc,bcd)) pattern="5o";
      else if(isWolf(xab,xad,abc,bcd)) pattern="Wolf";
      else if(isHnS(xab,xad,abc,bcd)) pattern="HnS";
      else if(isConTria(xab,xad,abc,bcd)) pattern="ConTria";
      else if(isExpTria(xab,xad,abc,bcd)) pattern="ExpTria";
      else if(isAntiBat(xab,xad,abc,bcd)) pattern="AntiBat";
      else if(isAntiButterfly(xab,xad,abc,bcd)) pattern="AntiButterfly";
      else if(isAntiGartley(xab,xad,abc,bcd)) pattern="AntiGartley";
      else if(isAntiCrab(xab,xad,abc,bcd)) pattern="AntiCrab";
      else if(isAntiShark(xab,xad,abc,bcd)) pattern="AntiShark";
     }
   else
     {
      if(isABCD(xab,xad,abc,bcd)) pattern="ABCD";
      else if(isBat(xab,xad,abc,bcd)) pattern="Bat";
      else if(isAltBat(xab,xad,abc,bcd)) pattern="AltBat";
      else if(isButterfly(xab,xad,abc,bcd)) pattern="Butterfly";
      else if(isGartley(xab,xad,abc,bcd)) pattern="Gartley";
      else if(isCrab(xab,xad,abc,bcd)) pattern="Crab";
      else if(isShark(xab,xad,abc,bcd)) pattern="Shark";
      else if(is5o(xab,xad,abc,bcd)) pattern="5o";
      else if(isWolf(xab,xad,abc,bcd)) pattern="Wolf";
      else if(isHnS(xab,xad,abc,bcd)) pattern="HnS";
      else if(isConTria(xab,xad,abc,bcd)) pattern="ConTria";
      else if(isExpTria(xab,xad,abc,bcd)) pattern="ExpTria";
      else if(isAntiBat(xab,xad,abc,bcd)) pattern="AntiBat";
      else if(isAntiButterfly(xab,xad,abc,bcd)) pattern="AntiButterfly";
      else if(isAntiGartley(xab,xad,abc,bcd)) pattern="AntiGartley";
      else if(isAntiCrab(xab,xad,abc,bcd)) pattern="AntiCrab";
      else if(isAntiShark(xab,xad,abc,bcd)) pattern="AntiShark";
     }
   return (pattern!="");
  }

// آرایه نقاط برگشتی را از تاریخچه کندل‌ها می‌سازد
int BuildPivots(const ENUM_TIMEFRAMES timeframe,const bool useHA,PivotPoint &outPivots[])
  {
   MqlRates rates[];
   ArraySetAsSeries(rates,true);
   int copied=CopyRates(_Symbol,timeframe,0,700,rates);
   if(copied<6) return 0;
   double haOpen[],haClose[],haHigh[],haLow[];
   ArrayResize(haOpen,copied); ArrayResize(haClose,copied);
   ArrayResize(haHigh,copied); ArrayResize(haLow,copied);
   ArraySetAsSeries(haOpen,true); ArraySetAsSeries(haClose,true);
   ArraySetAsSeries(haHigh,true); ArraySetAsSeries(haLow,true);
   for(int i=copied-1;i>=0;i--)
     {
      haClose[i]=(rates[i].open+rates[i].high+rates[i].low+rates[i].close)/4.0;
      if(i==copied-1) haOpen[i]=(rates[i].open+rates[i].close)/2.0;
      else haOpen[i]=(haOpen[i+1]+haClose[i+1])/2.0;
      haHigh[i]=MathMax(rates[i].high,MathMax(haOpen[i],haClose[i]));
      haLow[i]=MathMin(rates[i].low,MathMin(haOpen[i],haClose[i]));
     }
   int direction=0;
   bool prevUp=false,prevDown=false;
   double revPrice[];
   datetime revTime[];
   ArrayResize(revPrice,0); ArrayResize(revTime,0);
   // از قدیمی‌ترین کندل کامل به جدیدترین کندل کامل
   for(int i=copied-1;i>=1;i--)
     {
      double op=useHA ? haOpen[i] : rates[i].open;
      double cl=useHA ? haClose[i] : rates[i].close;
      bool isUp=(cl>=op), isDown=(cl<=op);
      bool pivot=false;
      double pivotPrice=0.0;
      int pivotIndex=-1;
      int nextDirection=direction;
      if(prevUp && isDown)
        {
         nextDirection=-1;
         if(direction!=-1)
           {
            int earlier=i+1;
            double currentHigh=(useHA ? haHigh[i] : rates[i].high);
            double earlierHigh=(useHA ? haHigh[earlier] : rates[earlier].high);
            pivotIndex=(currentHigh>=earlierHigh ? i : earlier);
            pivotPrice=(useHA ? haHigh[pivotIndex] : rates[pivotIndex].high);
            pivot=true;
           }
        }
      else if(prevDown && isUp)
        {
         nextDirection=1;
         if(direction!=1)
           {
            int earlier=i+1;
            double currentLow=(useHA ? haLow[i] : rates[i].low);
            double earlierLow=(useHA ? haLow[earlier] : rates[earlier].low);
            pivotIndex=(currentLow<=earlierLow ? i : earlier);
            pivotPrice=(useHA ? haLow[pivotIndex] : rates[pivotIndex].low);
            pivot=true;
           }
        }
      direction=nextDirection;
      if(pivot)
        {
         int n=ArraySize(revPrice);
         ArrayResize(revPrice,n+1); ArrayResize(revTime,n+1);
         revPrice[n]=pivotPrice; revTime[n]=rates[pivotIndex].time;
        }
      prevUp=isUp; prevDown=isDown;
     }
   int total=ArraySize(revPrice);
   int keep=(total<5 ? total : 5);
   ArrayResize(outPivots,keep);
   for(int j=0;j<keep;j++)
     {
      int source=total-keep+j;
      outPivots[j].price=revPrice[source];
      outPivots[j].time=revTime[source];
     }
   return keep;
  }

// نگهداری خروجی تایم‌فریم جایگزین فقط هنگام آغاز کندل جدید آن
void RefreshAltPivots()
  {
   datetime current=iTime(_Symbol,InpAltTF,0);
   if(current==0 || current==lastAltBarTime) return;
   lastAltBarTime=current;
   PivotPoint pivots[];
   int count=BuildPivots(InpAltTF,InpUseHA,pivots);
   cachedAltCount=count;
   for(int i=0;i<5;i++)
     {
      cachedAltPrices[i]=0.0; cachedAltTimes[i]=0;
      if(i<count) { cachedAltPrices[i]=pivots[i].price; cachedAltTimes[i]=pivots[i].time; }
     }
  }

// دریافت آخرین پنج پیوت فعال برای منطق جاری
int GetCurrentPivots(PivotPoint &pivots[])
  {
   if(InpUseAltTF)
     {
      RefreshAltPivots();
      ArrayResize(pivots,cachedAltCount);
      for(int i=0;i<cachedAltCount;i++)
        { pivots[i].price=cachedAltPrices[i]; pivots[i].time=cachedAltTimes[i]; }
      return cachedAltCount;
     }
   return BuildPivots((ENUM_TIMEFRAMES)_Period,InpUseHA,pivots);
  }

double FibPrice(const double d,const double c,const double rate)
  {
   double range=MathAbs(d-c);
   return (d>c ? d-range*rate : d+range*rate);
  }

double LotNormalize(double lot)
  {
   double minimum=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN);
   double maximum=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=minimum;
   lot=MathMax(minimum,MathMin(maximum,lot));
   lot=MathFloor(lot/step+1e-8)*step;
   int digits=2;
   if(step<0.1) digits=3;
   if(step<0.01) digits=4;
   return NormalizeDouble(lot,digits);
  }

bool HasPosition(const ENUM_POSITION_TYPE wanted,const bool anyDirection=false)
  {
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=_Symbol) continue;
      if((long)PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      if(anyDirection || type==wanted) return true;
     }
   return false;
  }

// مدیریت خروج معامله بر اساس برچسب هدف و جهت پوزیشن
void ManagePositions(const double high,const double low,const double c,const double d)
  {
   double t1tp=FibPrice(d,c,InpT1TpRate), t1sl=FibPrice(d,c,InpT1SlRate);
   double t2tp=FibPrice(d,c,InpT2TpRate), t2sl=FibPrice(d,c,InpT2SlRate);
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0 || PositionGetString(POSITION_SYMBOL)!=_Symbol || (long)PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      string tag=PositionGetString(POSITION_COMMENT);
      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      bool closeNow=false;
      if(StringFind(tag,"02")>=0 && InpT2Active)
        closeNow=(type==POSITION_TYPE_BUY ? (high>=t2tp || low<=t2sl) : (low<=t2tp || high>=t2sl));
      else if(StringFind(tag,"01")>=0 && InpT1Active)
        closeNow=(type==POSITION_TYPE_BUY ? (high>=t1tp || low<=t1sl) : (low<=t1tp || high>=t1sl));
      if(closeNow && !trade.PositionClose(ticket))
         Print("خطا در بستن پوزیشن، ticket=",ticket," کد=",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
     }
  }

void DrawPattern(const PivotPoint &d,const string key,const int mode)
  {
   if(!InpShowPatterns) return;
   string name="ZZPA_"+IntegerToString((long)d.time)+"_"+key;
   if(ObjectFind(0,name)>=0) return;
   ENUM_OBJECT objectType=(mode==1 ? OBJ_ARROW_UP : OBJ_ARROW_DOWN);
   if(!ObjectCreate(0,name,objectType,0,d.time,d.price)) return;
   ObjectSetInteger(0,name,OBJPROP_COLOR,(mode==1 ? clrLimeGreen : clrTomato));
   ObjectSetInteger(0,name,OBJPROP_WIDTH,1);
   ObjectSetString(0,name,OBJPROP_TOOLTIP,key);
   // پاکسازی نشانه‌های قدیمی‌تر از حدود ۲۰۰۰ کندل
   datetime cutoff=iTime(_Symbol,(ENUM_TIMEFRAMES)_Period,2000);
   if(cutoff>0)
     for(int i=ObjectsTotal(0)-1;i>=0;i--)
       {
        string obj=ObjectName(0,i);
        if(StringFind(obj,"ZZPA_")==0 && (datetime)ObjectGetInteger(0,obj,OBJPROP_TIME)<cutoff) ObjectDelete(0,obj);
       }
  }

void TryOpen(const bool isBuy,const int target,const string pattern,const double entryWindow,
             const double tp,const double sl)
  {
   ENUM_POSITION_TYPE desired=(isBuy ? POSITION_TYPE_BUY : POSITION_TYPE_SELL);
   if(HasPosition(desired)) return;
   if(!InpAllowHedge && HasPosition(desired==POSITION_TYPE_BUY ? POSITION_TYPE_SELL : POSITION_TYPE_BUY)) return;
   double lots=LotNormalize(InpLot);
   string side=(isBuy ? "buy" : "sell");
   string tag=side+(target==1 ? " 01" : " 02");
   Print("سیگنال ",pattern," جهت ",side," هدف ",target," | پنجره ورود=",DoubleToString(entryWindow,_Digits),
         " TP=",DoubleToString(tp,_Digits)," SL=",DoubleToString(sl,_Digits));
   bool sent=(isBuy ? trade.Buy(lots,_Symbol,0.0,0.0,0.0,tag) : trade.Sell(lots,_Symbol,0.0,0.0,0.0,tag));
   if(sent)
      Print("سفارش ارسال شد: ",tag," الگو=",pattern," حجم=",DoubleToString(lots,2)," قیمت بازار");
   else
      Print("ارسال سفارش ناموفق: ",tag," کد=",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
  }

void EvaluateStrategy()
  {
   PivotPoint pivots[];
   if(GetCurrentPivots(pivots)<5) { previousPatternKey=""; return; }
   double xab=0,xad=0,abc=0,bcd=0;
   string buyPattern="",sellPattern="";
   bool buyPatternFound=DetectPattern(1,pivots,buyPattern,xab,xad,abc,bcd);
   double sxab=0,sxad=0,sabc=0,sbcd=0;
   bool sellPatternFound=DetectPattern(-1,pivots,sellPattern,sxab,sxad,sabc,sbcd);
   string visualKey="";
   int visualMode=0;
   if(buyPatternFound) { visualKey="buy_"+buyPattern; visualMode=1; }
   else if(sellPatternFound) { visualKey="sell_"+sellPattern; visualMode=-1; }
   if(visualKey!="" && visualKey!=previousPatternKey) DrawPattern(pivots[4],visualKey,visualMode);
   previousPatternKey=visualKey;

   double close=iClose(_Symbol,PERIOD_CURRENT,1);
   double high=iHigh(_Symbol,PERIOD_CURRENT,1);
   double low=iLow(_Symbol,PERIOD_CURRENT,1);
   if(close==0 || high==0 || low==0) return;
   double c=pivots[3].price, d=pivots[4].price;
   ManagePositions(high,low,c,d);

   double t1Entry=FibPrice(d,c,InpT1EwRate), t1TP=FibPrice(d,c,InpT1TpRate), t1SL=FibPrice(d,c,InpT1SlRate);
   double t2Entry=FibPrice(d,c,InpT2EwRate), t2TP=FibPrice(d,c,InpT2TpRate), t2SL=FibPrice(d,c,InpT2SlRate);
   // ورود در کندل بعد از سیگنال (معادل رفتار Pine بدون process_orders_on_close)
   if(InpT1Active && buyPatternFound && close<=t1Entry)
      TryOpen(true,1,buyPattern,t1Entry,t1TP,t1SL);
   else if(InpT1Active && sellPatternFound && close>=t1Entry)
      TryOpen(false,1,sellPattern,t1Entry,t1TP,t1SL);
   else if(InpT2Active && buyPatternFound && close<=t2Entry)
      TryOpen(true,2,buyPattern,t2Entry,t2TP,t2SL);
   else if(InpT2Active && sellPatternFound && close>=t2Entry)
      TryOpen(false,2,sellPattern,t2Entry,t2TP,t2SL);
  }

int OnInit()
  {
   trade.SetExpertMagicNumber((ulong)InpMagic);
   trade.SetDeviationInPoints((ulong)MathMax(0.0,InpSlippagePoints));
   trade.SetTypeFillingBySymbol(_Symbol);
   lastBarTime=iTime(_Symbol,PERIOD_CURRENT,0);
   if(InpUseAltTF) RefreshAltPivots();
   return INIT_SUCCEEDED;
  }

void OnTick()
  {
   datetime current=iTime(_Symbol,PERIOD_CURRENT,0);
   if(current==0 || current==lastBarTime) return;
   lastBarTime=current;
   EvaluateStrategy();
  }

void OnDeinit(const int reason)
  {
   for(int i=ObjectsTotal(0)-1;i>=0;i--)
     {
      string name=ObjectName(0,i);
      if(StringFind(name,"ZZPA_")==0) ObjectDelete(0,name);
     }
  }

/*
راهنمای نصب:
۱) این فایل را در پوشه MQL5/Experts کپی کنید و در MetaEditor با کلید F7 کامپایل کنید.
۲) حجم معامله ثابت و پیش‌فرض آن ۰٫۰۳ لات است؛ مقدار ورودی را می‌توان تغییر داد.
۳) ورود در قیمت آغاز کندل بعد از کندلی انجام می‌شود که سیگنال آن در بسته‌شدن ارزیابی شده است.
۴) باگ تقدم عملگرهای شرط بستن هدف دوم اصلاح شده و شرط‌های TP/SL داخل پرانتز هستند.
۵) هدف دوم به‌صورت پیش‌فرض خاموش است.
*/

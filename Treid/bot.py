//+------------------------------------------------------------------+
//| AnnaBot Expert Advisor                                           |
//| توضیح فارسی ورودی‌ها و نگاشت به Pine:                             |
//| InpOBLen: طول پیوت/ATR بلوک سفارش (Pine: len؛ بازه ۱ تا ۲۰).       |
//| InpOBMode: ساخت محدوده با ATR یا کل کندل (Pine: OB mode).          |
//| InpMitigation: روش مصرف محدوده، سایه/بسته‌شدن/میانه (Pine: mit).    |
//| InpOverlap: حذف بلوک‌های هم‌پوشان (Pine: overlap).                  |
//| InpExtSens / InpIntSens: حساسیت ساختار خارجی/داخلی (Pine: sens).   |
//| InpShowExt / InpShowInt: فعال‌سازی لایه‌های ساختار (Pine: show).    |
//| InpDrawStructure: رسم خطوط ساختار (Pine: نمایش خطوط/برچسب‌ها).      |
//| InpUseCHoCHFilter: فیلتر جهت CHoCH (افزوده‌شده برای اجرای معامله). |
//| InpLots, InpMagic, InpSlippage: حجم، شناسه و لغزش سفارش MT5.        |
//| InpMaxSpread: بیشینه اسپرد مجاز؛ صفر یعنی غیرفعال.                  |
//| InpOnePositionPerSymbol: جلوگیری از سفارش/پوزیشن تکراری نماد.      |
//| InpUseLimit: ورود لیمیت در میانه بلوک، یا ورود بازار.               |
//| InpSLBufferATR / InpRR: بافر حدضرر ATR و نسبت سود به ریسک.          |
//| InpMaxBars: سقف تاریخچه درخواستی برای محاسبه.                       |
//|                                                                      |
//| English summary:                                                   |
//| Detects order blocks with Wilder ATR and volume pivots.              |
//| Tracks external and internal market structure and draws breaks.     |
//| Provides a configurable, placeholder bullish order execution layer.  |
//+------------------------------------------------------------------+
#property copyright "AnnaBot"
#property version   "1.10"
#property description "Order Blocks (Andicator-1H) + Dual Market Structure (Andicator1min)"
#include <Trade/Trade.mqh>

enum ENUM_OB_MODE { OB_MODE_LENGTH=0, OB_MODE_FULL=1 };
enum ENUM_MITIGATION { MIT_CLOSE=0, MIT_WICK=1, MIT_AVG=2 };

input int             InpOBLen            = 5;      // OB: pivot/ATR length (1..20)
input ENUM_OB_MODE    InpOBMode           = OB_MODE_LENGTH;
input ENUM_MITIGATION InpMitigation       = MIT_WICK;
input bool            InpOverlap          = true;
input int             InpExtSens          = 25;     // External structure sensitivity (any int>=2)
input int             InpIntSens          = 3;      // Internal structure sensitivity (any int>=2)
input bool            InpShowExt          = true;
input bool            InpShowInt          = true;
input bool            InpDrawStructure    = true;
input bool            InpUseCHoCHFilter   = false;
input double          InpLots             = 0.01;
input long            InpMagic            = 250501;
input int             InpSlippage         = 10;
input int             InpMaxSpread        = 0;      // 0 = disabled
input bool            InpOnePositionPerSymbol = true;
input bool            InpUseLimit         = true;
input double          InpSLBufferATR      = 0.25;
input double          InpRR               = 2.0;
input int             InpMaxBars          = 3000;   // history bars loaded

struct OBZone { int type; double top; double bottom; double mid; datetime time; long volume; };
struct StructureLayer { int sens; int intra; int moving; int upFlag; int dnFlag; double upaxis; double dnaxis; datetime upTime; datetime dnTime; int lastDir; datetime lastTime; };

OBZone gBull[]; OBZone gBear[];
StructureLayer gExt; StructureLayer gInt;
CTrade gTrade;
datetime gLastBar = 0;
int gOBDir = 0;          // persistent OB direction state (-1/0/1) — MUST be saved/loaded
bool gChanged = false;
double gATR = 0.0;
ulong gOrderTicketForZone[]; // parallel array NOT used; instead use order comment = zone id string

void AddFront(OBZone &arr[], const OBZone &z)
{
   int count=ArraySize(arr);
   if(ArrayResize(arr,count+1)!=count+1) return;
   for(int i=count;i>0;i--) arr[i]=arr[i-1];
   arr[0]=z;
}

void RemoveAtIdx(OBZone &arr[], int idx)
{
   int count=ArraySize(arr);
   if(idx<0 || idx>=count) return;
   for(int i=idx;i<count-1;i++) arr[i]=arr[i+1];
   ArrayResize(arr,count-1);
}

string ZoneId(const OBZone &z)
{
   return IntegerToString((long)z.time) + "_" + IntegerToString(z.type);
}

string StateFileName()
{
   return "AnnaBot_" + _Symbol + ".state";
}

void SaveState()
{
   int fh=FileOpen(StateFileName(),FILE_WRITE|FILE_CSV|FILE_ANSI,';');
   if(fh==INVALID_HANDLE) return;
   // Reverse order pairs with AddFront during loading, preserving newest-first arrays.
   for(int i=ArraySize(gBull)-1;i>=0;i--)
   {
      OBZone z=gBull[i];
      FileWrite(fh,"OB",IntegerToString(z.type),DoubleToString(z.top,_Digits),DoubleToString(z.bottom,_Digits),DoubleToString(z.mid,_Digits),IntegerToString((long)z.time),IntegerToString(z.volume));
   }
   for(int i=ArraySize(gBear)-1;i>=0;i--)
   {
      OBZone z=gBear[i];
      FileWrite(fh,"OB",IntegerToString(z.type),DoubleToString(z.top,_Digits),DoubleToString(z.bottom,_Digits),DoubleToString(z.mid,_Digits),IntegerToString((long)z.time),IntegerToString(z.volume));
   }
   FileWrite(fh,"ST","EXT",DoubleToString(gExt.upaxis,_Digits),DoubleToString(gExt.dnaxis,_Digits),IntegerToString(gExt.moving),IntegerToString(gExt.upFlag),IntegerToString(gExt.dnFlag),IntegerToString(gExt.intra),IntegerToString((long)gExt.upTime),IntegerToString((long)gExt.dnTime),IntegerToString(gExt.lastDir),IntegerToString((long)gExt.lastTime));
   FileWrite(fh,"ST","INT",DoubleToString(gInt.upaxis,_Digits),DoubleToString(gInt.dnaxis,_Digits),IntegerToString(gInt.moving),IntegerToString(gInt.upFlag),IntegerToString(gInt.dnFlag),IntegerToString(gInt.intra),IntegerToString((long)gInt.upTime),IntegerToString((long)gInt.dnTime),IntegerToString(gInt.lastDir),IntegerToString((long)gInt.lastTime));
   FileWrite(fh,"DIR",IntegerToString(gOBDir));
   FileClose(fh);
}

void LoadState()
{
   int fh=FileOpen(StateFileName(),FILE_READ|FILE_CSV|FILE_ANSI,';');
   if(fh==INVALID_HANDLE) return;
   ArrayResize(gBull,0); ArrayResize(gBear,0);
   while(!FileIsEnding(fh))
   {
      string tag=FileReadString(fh);
      if(FileIsEnding(fh) && tag=="") break;
      if(tag=="OB")
      {
         OBZone z;
         z.type=(int)StringToInteger(FileReadString(fh));
         z.top=StringToDouble(FileReadString(fh));
         z.bottom=StringToDouble(FileReadString(fh));
         z.mid=StringToDouble(FileReadString(fh));
         z.time=(datetime)StringToInteger(FileReadString(fh));
         z.volume=(long)StringToInteger(FileReadString(fh));
         if(z.type==1) AddFront(gBull,z); else if(z.type==-1) AddFront(gBear,z);
      }
      else if(tag=="ST")
      {
         string layer=FileReadString(fh);
         double up=StringToDouble(FileReadString(fh));
         double dn=StringToDouble(FileReadString(fh));
         int moving=(int)StringToInteger(FileReadString(fh));
         int upFlag=(int)StringToInteger(FileReadString(fh));
         int dnFlag=(int)StringToInteger(FileReadString(fh));
         int intra=(int)StringToInteger(FileReadString(fh));
         datetime upTime=(datetime)StringToInteger(FileReadString(fh));
         datetime dnTime=(datetime)StringToInteger(FileReadString(fh));
         int lastDir=(int)StringToInteger(FileReadString(fh));
         datetime lastTime=(datetime)StringToInteger(FileReadString(fh));
         if(layer=="EXT") { gExt.upaxis=up; gExt.dnaxis=dn; gExt.moving=moving; gExt.upFlag=upFlag; gExt.dnFlag=dnFlag; gExt.intra=intra; gExt.upTime=upTime; gExt.dnTime=dnTime; gExt.lastDir=lastDir; gExt.lastTime=lastTime; }
         else if(layer=="INT") { gInt.upaxis=up; gInt.dnaxis=dn; gInt.moving=moving; gInt.upFlag=upFlag; gInt.dnFlag=dnFlag; gInt.intra=intra; gInt.upTime=upTime; gInt.dnTime=dnTime; gInt.lastDir=lastDir; gInt.lastTime=lastTime; }
      }
      else if(tag=="DIR") gOBDir=(int)StringToInteger(FileReadString(fh));
      else
      {
         // Unknown tags are ignored through the end of their CSV record.
         while(!FileIsEnding(fh) && !FileIsLineEnding(fh)) FileReadString(fh);
      }
   }
   FileClose(fh);
}

double TrueRangeAt(const MqlRates &r[], int i, int n)
{
   if(i<0 || i+1>=n) return 0.0;
   double priorClose=r[i+1].close;
   double a=r[i].high-r[i].low;
   double b=MathAbs(r[i].high-priorClose);
   double c=MathAbs(r[i].low-priorClose);
   return MathMax(a,MathMax(b,c));
}

double WilderATR(const MqlRates &r[], int period, int n)
{
   if(period<=0 || n<period+2) return 0.0;
   // Series bars 1..n-2 are closed bars with an available previous close.
   double seed=0.0;
   for(int k=0;k<period;k++)
   {
      int idx=n-2-k;
      seed+=TrueRangeAt(r,idx,n);
   }
   double atr=seed/period;
   for(int idx=n-2-period;idx>=1;idx--)
      atr=(atr*(period-1)+TrueRangeAt(r,idx,n))/period;
   return atr;
}

bool IsVolumePivotHigh(const MqlRates &r[], int idx, int len, int n)
{
   if(len<1 || idx-len<0 || idx+len>=n) return false;
   for(int k=1;k<=len;k++)
      if(r[idx].tick_volume<=r[idx-k].tick_volume || r[idx].tick_volume<=r[idx+k].tick_volume) return false;
   return true;
}

void RemoveOrdersForZoneId(const string zid)
{
   for(int i=OrdersTotal()-1;i>=0;i--)
   {
      ulong ticket=OrderGetTicket(i);
      if(ticket==0) continue;
      if(OrderGetString(ORDER_SYMBOL)==_Symbol && (long)OrderGetInteger(ORDER_MAGIC)==InpMagic && OrderGetString(ORDER_COMMENT)==zid)
         gTrade.OrderDelete(ticket);
   }
}

bool ZoneMitigated(const OBZone &z, const MqlRates &r[], int fromBar, int toBar, int n)
{
   if(fromBar<0) fromBar=0;
   if(toBar>=n) toBar=n-1;
   for(int j=fromBar;j<=toBar;j++)
   {
      if(r[j].time==z.time) continue; // Do not mitigate a zone on its own formation bar.
      if(z.type==1)
      {
         // MIT_WICK implements the user's "wick-or-body touch consumes the OB" rule; an exact boundary touch counts.
         if(InpMitigation==MIT_WICK && r[j].low<=z.bottom) return true;
         if(InpMitigation==MIT_CLOSE && MathMin(r[j].open,r[j].close)<z.bottom) return true;
         if(InpMitigation==MIT_AVG && r[j].low<z.mid) return true;
      }
      else if(z.type==-1)
      {
         // Exact boundary touch also consumes bearish zones in wick mode.
         if(InpMitigation==MIT_WICK && r[j].high>=z.top) return true;
         if(InpMitigation==MIT_CLOSE && MathMax(r[j].open,r[j].close)>z.top) return true;
         if(InpMitigation==MIT_AVG && r[j].high>z.mid) return true;
      }
   }
   return false;
}

void MitigateList(OBZone &arr[], const MqlRates &r[], int n, int fromBar, int toBar)
{
   for(int i=ArraySize(arr)-1;i>=0;i--)
   {
      if(ZoneMitigated(arr[i],r,fromBar,toBar,n))
      {
         RemoveOrdersForZoneId(ZoneId(arr[i]));
         RemoveAtIdx(arr,i);
         gChanged=true;
      }
   }
}

void RemoveOverlaps(OBZone &arr[])
{
   if(ArraySize(arr)<2) return;
   OBZone c=arr[0];
   for(int i=ArraySize(arr)-1;i>=1;i--)
   {
      OBZone z=arr[i];
      bool hit=(z.bottom>c.bottom && z.bottom<c.top)
            || (z.top<c.top && z.bottom>c.bottom)
            || (z.top>c.top && z.bottom<c.bottom)
            || (z.top<c.top && z.top>c.bottom);
      if(hit) RemoveAtIdx(arr,i);
   }
}

void DrawStructureLine(const string prefix, const string label, datetime t1, double price, int dir)
{
   if(!InpDrawStructure) return;
   string name="Anna_"+prefix+"_"+IntegerToString((long)t1)+"_"+label;
   if(ObjectFind(0,name)>=0) return;
   color lineColor=(dir>0 ? clrLime : clrTomato);
   if(ObjectCreate(0,name,OBJ_TREND,0,t1,price,TimeCurrent(),price))
   {
      ObjectSetInteger(0,name,OBJPROP_STYLE,STYLE_DASH);
      ObjectSetInteger(0,name,OBJPROP_RAY_RIGHT,true);
      ObjectSetInteger(0,name,OBJPROP_COLOR,lineColor);
      ObjectSetInteger(0,name,OBJPROP_WIDTH,1);
   }
   string textName=name+"_text";
   if(ObjectCreate(0,textName,OBJ_TEXT,0,t1,price))
   {
      ObjectSetString(0,textName,OBJPROP_TEXT,label);
      ObjectSetInteger(0,textName,OBJPROP_COLOR,lineColor);
      ObjectSetInteger(0,textName,OBJPROP_FONTSIZE,8);
      if(ObjectFind(0,textName)>=0) ObjectSetInteger(0,textName,OBJPROP_ANCHOR,ANCHOR_LEFT);
   }
}

void ResetLayer(StructureLayer &s, int sens)
{
   s.sens=sens; s.intra=0; s.moving=0; s.upFlag=0; s.dnFlag=0;
   s.upaxis=0.0; s.dnaxis=0.0; s.upTime=0; s.dnTime=0; s.lastDir=0; s.lastTime=0;
}

void ProcessOB(const MqlRates &r[], int n)
{
   if(n<2*InpOBLen+3) return;
   int len=InpOBLen;
   gATR=WilderATR(r,len,n);
   double hi=r[1].high, lo=r[1].low;
   for(int i=1;i<=len;i++) { hi=MathMax(hi,r[i].high); lo=MathMin(lo,r[i].low); }
   int oldDir=gOBDir;
   if(r[len].high>hi) gOBDir=-1;
   else if(r[len].low<lo) gOBDir=1;
   if(gOBDir!=oldDir) gChanged=true;
   if(IsVolumePivotHigh(r,len,len,n) && gOBDir!=0)
   {
      double btmP,topP;
      if(InpOBMode==OB_MODE_LENGTH)
      {
         btmP=MathMax(r[len].high-gATR,r[len].low);
         topP=MathMin(r[len].low+gATR,r[len].high);
      }
      else { btmP=r[len].low; topP=r[len].high; }
      OBZone z; z.time=r[len].time; z.volume=(long)r[len].tick_volume;
      if(gOBDir==1) { z.type=1; z.top=topP; z.bottom=r[len].low; }
      else { z.type=-1; z.top=r[len].high; z.bottom=btmP; }
      z.mid=(z.top+z.bottom)/2.0;
      if(z.top>z.bottom)
      {
         if(z.type==1) AddFront(gBull,z); else AddFront(gBear,z);
         gChanged=true;
      }
   }
   // Evaluate closed bars only; ZoneMitigated excludes the zone's own formation bar.
   MitigateList(gBull,r,n,1,len);
   MitigateList(gBear,r,n,1,len);
   if(InpOverlap) { RemoveOverlaps(gBull); RemoveOverlaps(gBear); }
}

void UpdateLayer(StructureLayer &s, const MqlRates &r[], int n, bool enabled, const string prefix)
{
   if(!enabled) return;
   int L=s.sens; if(n<L+4) return;
   double up=r[1].high, dn=r[1].low;
   for(int i=2;i<=L;i++) { up=MathMax(up,r[i].high); dn=MathMin(dn,r[i].low); }
   double cHi=r[L+1].high, cLo=r[L+1].low;
   int prevIntra=s.intra;
   if(cHi>up) s.intra=0; else if(cLo<dn) s.intra=1;
   double topSwing=(s.intra==0 && prevIntra!=0) ? cHi : 0.0;
   double botSwing=(s.intra==1 && prevIntra!=1) ? cLo : 0.0;
   if(topSwing!=0.0) { s.upaxis=topSwing; s.upFlag=1; s.upTime=r[L+1].time; gChanged=true; }
   if(botSwing!=0.0) { s.dnaxis=botSwing; s.dnFlag=1; s.dnTime=r[L+1].time; gChanged=true; }
   double prevClose=r[2].close, close=r[1].close;
   if(s.upFlag!=0 && prevClose<=s.upaxis && close>s.upaxis)
   {
      string label=(s.moving<0 ? "CHoCH" : "BoS");
      if(label=="CHoCH") { s.lastDir=1; s.lastTime=r[1].time; }
      DrawStructureLine(prefix,label,s.upTime,s.upaxis,1);
      s.upFlag=0; s.moving=1; gChanged=true;
   }
   if(s.dnFlag!=0 && prevClose>=s.dnaxis && close<s.dnaxis)
   {
      string label=(s.moving>0 ? "CHoCH" : "BoS");
      if(label=="CHoCH") { s.lastDir=-1; s.lastTime=r[1].time; }
      DrawStructureLine(prefix,label,s.dnTime,s.dnaxis,-1);
      s.dnFlag=0; s.moving=-1; gChanged=true;
   }
   // Labels are one-time consumed via upFlag/dnFlag reset (Pine "upside"/"downside" flags).
}

bool IsCHoCHActive(int dir)
{
   return (InpShowExt && gExt.lastDir==dir) || (InpShowInt && gInt.lastDir==dir);
}

bool HasPositionOrOrder(void)
{
   if(!InpOnePositionPerSymbol) return false;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      if(PositionGetSymbol(i)==_Symbol && (long)PositionGetInteger(POSITION_MAGIC)==InpMagic) return true;
   }
   for(int j=OrdersTotal()-1;j>=0;j--)
   {
      ulong ticket=OrderGetTicket(j);
      if(ticket!=0 && OrderGetString(ORDER_SYMBOL)==_Symbol && (long)OrderGetInteger(ORDER_MAGIC)==InpMagic) return true;
   }
   return false;
}

// Adjustable placeholder execution layer: currently demonstrates bullish OB entries only.
void ExecutePlaceholder(const MqlRates &r[], int n)
{
   if(n<InpOBLen+4) return;
   if(HasPositionOrOrder()) return;
   if(InpMaxSpread>0 && (int)SymbolInfoInteger(_Symbol,SYMBOL_SPREAD)>InpMaxSpread) return;
   if(InpUseCHoCHFilter && !IsCHoCHActive(1)) return;
   if(ArraySize(gBull)==0) return;
   OBZone z=gBull[0];
   double ask=SymbolInfoDouble(_Symbol,SYMBOL_ASK); if(ask<=0) return;
   if(ask<z.bottom || ask>z.top) return;
   double atr=gATR; if(atr<=0) atr=WilderATR(r,InpOBLen,n);
   double sl=NormalizeDouble(z.bottom-InpSLBufferATR*atr,_Digits);
   double entry=InpUseLimit ? NormalizeDouble(z.mid,_Digits) : ask;
   if(InpUseLimit && entry>=ask) return;
   double tp=NormalizeDouble(entry+(entry-sl)*InpRR,_Digits);
   string zid=ZoneId(z);
   gTrade.SetExpertMagicNumber(InpMagic); gTrade.SetDeviationInPoints(InpSlippage);
   if(InpUseLimit) gTrade.BuyLimit(InpLots,entry,_Symbol,sl,tp,ORDER_TIME_GTC,0,zid);
   else gTrade.Buy(InpLots,_Symbol,0.0,sl,tp,zid);
}

int OnInit()
{
   if(InpOBLen<1 || InpOBLen>20) return INIT_PARAMETERS_INCORRECT;
   if(InpExtSens<2 || InpIntSens<2) return INIT_PARAMETERS_INCORRECT;
   if(InpLots<=0 || InpRR<=0) return INIT_PARAMETERS_INCORRECT;
   ResetLayer(gExt,InpExtSens); ResetLayer(gInt,InpIntSens);
   LoadState();
   gTrade.SetExpertMagicNumber(InpMagic); gTrade.SetDeviationInPoints(InpSlippage); gTrade.SetTypeFillingBySymbol(_Symbol);
   Print("AnnaBot initialized: ",_Symbol," / ",EnumToString(_Period),", OB length=",InpOBLen);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   SaveState();
   if(reason==REASON_REMOVE) ObjectsDeleteAll(0,"Anna_",-1,-1);
}

void OnTick()
{
   datetime bar=iTime(_Symbol,_Period,0); if(bar==0 || bar==gLastBar) return; gLastBar=bar;
   MqlRates rates[]; ArraySetAsSeries(rates,true);
   int need=MathMax(InpMaxBars,MathMax(2*InpExtSens,2*InpIntSens)+3*InpOBLen+10);
   int n=CopyRates(_Symbol,_Period,0,need,rates); if(n<2*InpOBLen+4) return;
   ProcessOB(rates,n);
   UpdateLayer(gExt,rates,n,InpShowExt,"EXT");
   UpdateLayer(gInt,rates,n,InpShowInt,"INT");
   ExecutePlaceholder(rates,n);
   if(gChanged) { SaveState(); gChanged=false; }
}

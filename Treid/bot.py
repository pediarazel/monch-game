//+------------------------------------------------------------------+
//| AnnaBot.mq5                                                      |
//| راهبرد: نواحی Order Block در H1 و شکست ساختار CHoCH در M1.       |
//| همه محاسبات بر پایه کندل‌های بسته‌شده و داده CopyRates هستند.     |
//| هر معامله مستقل است؛ اکسپرت فقط پوزیشن‌های دارای مجیک خود را می‌شمارد.|
//+------------------------------------------------------------------+
#property version   "1.00"
#property description "H1 Order Block zones with M1 external structure entries"

#include <Trade/Trade.mqh>

input group "General"
input string InpSymbol="EURUSD_o";
input ulong  InpMagic=51425001;
input int    InpMaxOpenTrades=0;       // 0 = unlimited
input bool   InpOneTradePerZone=false;
input bool   InpRequireCHoCH=true;

input group "Risk and execution"
input double InpLots=0.03;
input int    InpSwingLookback=3;       // Selects the M1 swing pivot (1 = most recent).
input double InpRR=4.0;

#define ZONE_MAX 200
#define OB_LEN 5
#define EXT_LEN 25

struct Zone
  {
   double top;
   double bottom;
   double average;
   datetime startTime;
   bool bullish;
   bool used;
  };

CTrade trade;
string g_symbol="";
Zone g_zones[ZONE_MAX];
int g_zoneCount=0;
datetime g_lastM1Bar=0;
datetime g_lastH1Bar=0;

//+------------------------------------------------------------------+
//| Utilities                                                        |
//+------------------------------------------------------------------+
bool IsNewBar(const ENUM_TIMEFRAMES period)
  {
   datetime t=iTime(g_symbol,period,0);
   if(t<=0) return false;
   if(period==PERIOD_M1)
     {
      if(t==g_lastM1Bar) return false;
      g_lastM1Bar=t;
      return true;
     }
   if(period==PERIOD_H1)
     {
      if(t==g_lastH1Bar) return false;
      g_lastH1Bar=t;
      return true;
     }
   return false;
  }

// SMA of true range, including the indexed H1 bar.
double ATR_H1(MqlRates &r[],const int index,const int length)
  {
   if(length<1 || index-length+1<1) return 0.0;
   double sum=0.0;
   for(int k=index-length+1;k<=index;k++)
     {
      double a=r[k].high-r[k].low;
      double b=MathAbs(r[k].high-r[k-1].close);
      double c=MathAbs(r[k].low-r[k-1].close);
      sum+=MathMax(a,MathMax(b,c));
     }
   return sum/(double)length;
  }

bool IsPivotHigh(MqlRates &r[],const int j,const int length)
  {
   if(j-length<0 || j+length>=ArraySize(r)) return false;
   for(int k=1;k<=length;k++)
     {
      if(r[j].high<=r[j-k].high || r[j].high<r[j+k].high) return false;
     }
   return true;
  }

bool IsPivotLow(MqlRates &r[],const int j,const int length)
  {
   if(j-length<0 || j+length>=ArraySize(r)) return false;
   for(int k=1;k<=length;k++)
     {
      if(r[j].low>=r[j-k].low || r[j].low>r[j+k].low) return false;
     }
   return true;
  }

bool WasZoneUsed(Zone &oldZones[],const int oldCount,const datetime t,const bool bull)
  {
   for(int q=0;q<oldCount;q++)
      if(oldZones[q].startTime==t && oldZones[q].bullish==bull)
         return oldZones[q].used;
   return false;
  }

void AddZone(const double top,const double bottom,const datetime start,
             const bool bull,Zone &oldZones[],const int oldCount)
  {
   if(top<bottom || top<=0.0 || bottom<=0.0) return;
   if(g_zoneCount>=ZONE_MAX)
     {
      for(int q=1;q<g_zoneCount;q++) g_zones[q-1]=g_zones[q];
      g_zoneCount--;
     }
   g_zones[g_zoneCount].top=top;
   g_zones[g_zoneCount].bottom=bottom;
   g_zones[g_zoneCount].average=(top+bottom)*0.5;
   g_zones[g_zoneCount].startTime=start;
   g_zones[g_zoneCount].bullish=bull;
   g_zones[g_zoneCount].used=WasZoneUsed(oldZones,oldCount,start,bull);
   g_zoneCount++;
  }

// Rebuild all active H1 zones from recent history; mitigation is by candle body.
void BuildZones()
  {
   Zone oldZones[ZONE_MAX];
   int oldCount=g_zoneCount;
   if(oldCount>ZONE_MAX) oldCount=ZONE_MAX;
   for(int q=0;q<oldCount;q++) oldZones[q]=g_zones[q];
   g_zoneCount=0;

   MqlRates r[];
   ArraySetAsSeries(r,false);
   int copied=CopyRates(g_symbol,PERIOD_H1,0,300,r);
   if(copied<=3*OB_LEN+2)
     {
      Print("BuildZones: insufficient H1 history.");
      return;
     }
   int last=copied-2; // newest completed candle; final element is forming
   int direction=0;
   for(int i=0;i<=last;i++)
     {
      if(i>=OB_LEN*3-1)
        {
         int target=i-OB_LEN;
         // Compare the delayed bar against the five candles preceding it.
         // Including target itself in highest/lowest makes both strict tests
         // mathematically impossible, so exclude it to preserve the intended
         // direction-change behavior of the Order Block construction.
         double highest=r[target-OB_LEN].high;
         double lowest=r[target-OB_LEN].low;
         for(int x=target-OB_LEN+1;x<target;x++)
           {
            if(r[x].high>highest) highest=r[x].high;
            if(r[x].low<lowest) lowest=r[x].low;
           }
         if(r[target].high>highest) direction=-1;
         else if(r[target].low<lowest) direction=1;
        }

      double bodyLow=MathMin(r[i].open,r[i].close);
      double bodyHigh=MathMax(r[i].open,r[i].close);
      for(int z=g_zoneCount-1;z>=0;z--)
        {
         bool remove=(g_zones[z].bullish && bodyLow<g_zones[z].bottom) ||
                     (!g_zones[z].bullish && bodyHigh>g_zones[z].top);
         if(remove)
           {
            for(int m=z+1;m<g_zoneCount;m++) g_zones[m-1]=g_zones[m];
            g_zoneCount--;
           }
        }

      int j=i-OB_LEN;
      if(j<OB_LEN || j+OB_LEN>i || direction==0) continue;
      bool pivot=true;
      for(int k=1;k<=OB_LEN;k++)
        {
         // Pine-style volume pivot: strict on left, non-strict on right.
         if(r[j].tick_volume<=r[j-k].tick_volume ||
            r[j].tick_volume<r[j+k].tick_volume)
           { pivot=false; break; }
        }
      if(!pivot) continue;
      double atr=ATR_H1(r,j,OB_LEN);
      if(atr<=0.0) continue;
      if(direction==1)
        {
         double top=MathMin(r[j].low+atr,r[j].high);
         AddZone(top,r[j].low,r[j].time,true,oldZones,oldCount);
        }
      else if(direction==-1)
        {
         double bottom=MathMax(r[j].high-atr,r[j].low);
         AddZone(r[j].high,bottom,r[j].time,false,oldZones,oldCount);
        }
     }
   Print("BuildZones: active zones=",g_zoneCount);
  }

// Return a signal only when the newest completed M1 bar makes a qualifying break.
bool DetectM1Signal(int &side,bool &isChoch,double &barLow,double &barHigh,
                    int &signalIndex,MqlRates &rates[])
  {
   side=0; isChoch=false; barLow=0.0; barHigh=0.0; signalIndex=-1;
   ArraySetAsSeries(rates,false);
   int copied=CopyRates(g_symbol,PERIOD_M1,0,400,rates);
   if(copied<=2*EXT_LEN+3) return false;
   int last=copied-2;
   double upAxis=0.0,dnAxis=0.0;
   bool upArmed=false,dnArmed=false;
   int moving=0;
   int eventSide=0;
   bool eventChoch=false;
   for(int i=0;i<=last;i++)
     {
      int j=i-EXT_LEN;
      if(j>=EXT_LEN && j+EXT_LEN<=i)
        {
         bool ph=true,pl=true;
         for(int k=1;k<=EXT_LEN;k++)
           {
            if(rates[j].high<=rates[j-k].high || rates[j].high<rates[j+k].high) ph=false;
            if(rates[j].low>=rates[j-k].low || rates[j].low>rates[j+k].low) pl=false;
           }
         if(ph) { upAxis=rates[j].high; upArmed=true; }
         if(pl) { dnAxis=rates[j].low; dnArmed=true; }
        }
      eventSide=0; eventChoch=false;
      if(i>0 && upArmed && upAxis>0.0 &&
         rates[i-1].close<=upAxis && rates[i].close>upAxis)
        {
         eventSide=1; eventChoch=(moving<0); moving=1; upArmed=false;
        }
      else if(i>0 && dnArmed && dnAxis>0.0 &&
              rates[i-1].close>=dnAxis && rates[i].close<dnAxis)
        {
         eventSide=-1; eventChoch=(moving>0); moving=-1; dnArmed=false;
        }
     }
   if(eventSide==0) return false;
   if(InpRequireCHoCH && !eventChoch) return false;
   side=eventSide; isChoch=eventChoch;
   barLow=rates[last].low; barHigh=rates[last].high;
   signalIndex=last;
   return true;
  }

// Find the extreme of the latest confirmed external swing pivots.
double CalcSL(const int side,const int signalIndex,const double fallback,
              MqlRates &rates[])
  {
   int wanted=InpSwingLookback;
   if(wanted<1) wanted=1;
   double swings[];
   ArrayResize(swings,0);
   int lastPivot=signalIndex-EXT_LEN;
   for(int j=EXT_LEN;j<=lastPivot;j++)
     {
      bool pivot=(side>0 ? IsPivotLow(rates,j,EXT_LEN) : IsPivotHigh(rates,j,EXT_LEN));
      if(!pivot) continue;
      int n=ArraySize(swings);
      ArrayResize(swings,n+1);
      swings[n]=(side>0 ? rates[j].low : rates[j].high);
     }
   double result=fallback;
   int count=ArraySize(swings);
   if(count>0)
     {
      int start=count-wanted;
      if(start<0) start=0;
      result=swings[start];
      for(int q=start+1;q<count;q++)
        {
         if(side>0 && swings[q]<result) result=swings[q];
         if(side<0 && swings[q]>result) result=swings[q];
        }
     }
   return NormalizeDouble(result,(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS));
  }

double CalcTP(const int side,const double entry,const double sl)
  {
   double distance=MathAbs(entry-sl);
   double tp=(side>0 ? entry+InpRR*distance : entry-InpRR*distance);
   return NormalizeDouble(tp,(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS));
  }

double NormalizeLots(const double requested)
  {
   double minimum=SymbolInfoDouble(g_symbol,SYMBOL_VOLUME_MIN);
   double maximum=SymbolInfoDouble(g_symbol,SYMBOL_VOLUME_MAX);
   double step=SymbolInfoDouble(g_symbol,SYMBOL_VOLUME_STEP);
   if(step<=0.0) step=minimum;
   double lots=MathMax(minimum,MathMin(maximum,requested));
   lots=MathFloor(lots/step+0.5)*step;
   int digits=0;
   double test=step;
   while(digits<8 && MathAbs(test-MathRound(test))>1e-8)
     { test*=10.0; digits++; }
   return NormalizeDouble(MathMax(minimum,MathMin(maximum,lots)),digits);
  }

int CountOwnPositions()
  {
   int count=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
     {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0) continue;
      if(PositionGetString(POSITION_SYMBOL)==g_symbol &&
         (ulong)PositionGetInteger(POSITION_MAGIC)==InpMagic) count++;
     }
   return count;
  }

bool ZoneInteracts(const Zone &z,const double lo,const double hi,const double cl)
  {
   return ((lo<=z.top && hi>=z.bottom) || (cl>=z.bottom && cl<=z.top));
  }

void TryEntry()
  {
   MqlRates m1[];
   int side=0,signalIndex=-1;
   bool choch=false;
   double barLow=0.0,barHigh=0.0;
   if(!DetectM1Signal(side,choch,barLow,barHigh,signalIndex,m1)) return;
   if(InpMaxOpenTrades>0 && CountOwnPositions()>=InpMaxOpenTrades) return;
   double closePrice=m1[signalIndex].close;
   int zoneIndex=-1;
   for(int z=0;z<g_zoneCount;z++)
     {
      if(g_zones[z].bullish!=(side>0)) continue;
      if(InpOneTradePerZone && g_zones[z].used) continue;
      if(!ZoneInteracts(g_zones[z],barLow,barHigh,closePrice)) continue;
      // The structure shift candle must itself touch/reach the zone edge.
      if(side>0 && barLow>g_zones[z].top) continue;
      if(side<0 && barHigh<g_zones[z].bottom) continue;
      zoneIndex=z; break;
     }
   if(zoneIndex<0) return;

   MqlTick tick;
   if(!SymbolInfoTick(g_symbol,tick)) return;
   double entry=(side>0 ? tick.ask : tick.bid);
   double sl=CalcSL(side,signalIndex,(side>0 ? barLow : barHigh),m1);
   if((side>0 && sl>=entry) || (side<0 && sl<=entry))
     { Print("Signal skipped: invalid SL side."); return; }
   double tp=CalcTP(side,entry,sl);
   double lots=NormalizeLots(InpLots);
   string comment=(side>0 ? "AnnaBot-L" : "AnnaBot-S");
   bool sent=(side>0 ? trade.Buy(lots,g_symbol,0.0,sl,tp,comment)
                     : trade.Sell(lots,g_symbol,0.0,sl,tp,comment));
   if(sent && (trade.ResultRetcode()==TRADE_RETCODE_DONE ||
               trade.ResultRetcode()==TRADE_RETCODE_PLACED))
     {
      g_zones[zoneIndex].used=true;
      Print("Trade opened: ",comment," lots=",DoubleToString(lots,2),
            " SL=",DoubleToString(sl,_Digits)," TP=",DoubleToString(tp,_Digits),
            " zone=",TimeToString(g_zones[zoneIndex].startTime));
     }
   else
      Print("Trade failed: retcode=",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
  }

//+------------------------------------------------------------------+
//| Expert lifecycle                                                 |
//+------------------------------------------------------------------+
int OnInit()
  {
   g_symbol=(InpSymbol=="" ? _Symbol : InpSymbol);
   if(!SymbolSelect(g_symbol,true))
     {
      Print("Initialization failed: symbol is unavailable: ",g_symbol);
      return INIT_FAILED;
     }
   if(InpLots<=0.0 || InpRR<=0.0 || InpSwingLookback<1)
     {
      Print("Initialization failed: invalid risk inputs.");
      return INIT_PARAMETERS_INCORRECT;
     }
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(30);
   if(!trade.SetTypeFillingBySymbol(g_symbol))
      Print("Warning: unable to set symbol filling mode automatically.");
   g_zoneCount=0;
   g_lastM1Bar=0;
   g_lastH1Bar=0;
   Print("AnnaBot initialized. Symbol=",g_symbol," Lots=",DoubleToString(InpLots,2),
         " RR=",DoubleToString(InpRR,2)," MaxOpen=",InpMaxOpenTrades);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   Print("AnnaBot stopped. Reason=",reason);
  }

void OnTick()
  {
   bool newH1=IsNewBar(PERIOD_H1);
   bool newM1=IsNewBar(PERIOD_M1);
   if(newH1) BuildZones();
   if(newM1) TryEntry();
  }
//+------------------------------------------------------------------+

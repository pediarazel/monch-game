//+------------------------------------------------------------------+
//| AnnaBot_v1_11.mq5                                                |
//| H1 Order Block zones + M1 CHoCH entries, axis SL, zone lock.     |
//| Adds: chart visualization + panel, per-bar signal guard,         |
//|       input validation, ATR caching.                             |
//+------------------------------------------------------------------+
#property version   "1.11"
#property description "H1 OB zones + M1 CHoCH, SL on exact M1 swing axis, zone lock, visualization"

#include <Trade/Trade.mqh>

input group "General"
input string InpSymbol="EURUSD_o";
input ulong  InpMagic=51425001;
input int    InpMaxOpenTrades=0;          // 0 = unlimited
input bool   InpOneTradePerZone=true;     // zone lock
input bool   InpRequireCHoCH=true;

input group "Risk and execution"
input double InpLots=0.03;
input int    InpSwingLookback=3;          // M1 swing length AND pivot length
input double InpRR=4.0;

input group "Visualization"
input bool   InpDrawZones=true;
input bool   InpDrawSignals=true;
input bool   InpShowPanel=true;

#define ZONE_MAX 200
#define OB_LEN   5
#define PFX      "ANNA_"

struct Zone
  {
   double   top;
   double   bottom;
   double   average;
   datetime startTime;
   bool     bullish;
   bool     used;
   bool     armed;
   int      objIndex;
  };

CTrade   trade;
string   g_symbol="";
Zone     g_zones[ZONE_MAX];
int      g_zoneCount=0;
datetime g_lastM1Bar=0;
datetime g_lastH1Bar=0;
datetime g_lastSignalBar=0;
int      g_swingLen=3;
int      g_digits=5;
double   g_point=0.0;
int      g_sigCount=0;
string   g_lastInfo="waiting";

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
   if(length<1) return false;
   if(j-length<0 || j+length>=ArraySize(r)) return false;
   for(int k=1;k<=length;k++)
      if(r[j].high<=r[j-k].high || r[j].high<r[j+k].high) return false;
   return true;
  }

bool IsPivotLow(MqlRates &r[],const int j,const int length)
  {
   if(length<1) return false;
   if(j-length<0 || j+length>=ArraySize(r)) return false;
   for(int k=1;k<=length;k++)
      if(r[j].low>=r[j-k].low || r[j].low>r[j+k].low) return false;
   return true;
  }

//+------------------------------------------------------------------+
//| Zone management                                                  |
//+------------------------------------------------------------------+
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
      ObjectDelete(0,PFX+"ZONE_"+IntegerToString(g_zones[0].objIndex));
      for(int q=1;q<g_zoneCount;q++) g_zones[q-1]=g_zones[q];
      g_zoneCount--;
     }
   int idx=g_zoneCount+1;
   g_zones[g_zoneCount].top=top;
   g_zones[g_zoneCount].bottom=bottom;
   g_zones[g_zoneCount].average=(top+bottom)*0.5;
   g_zones[g_zoneCount].startTime=start;
   g_zones[g_zoneCount].bullish=bull;
   g_zones[g_zoneCount].used=WasZoneUsed(oldZones,oldCount,start,bull);
   g_zones[g_zoneCount].armed=false;
   g_zones[g_zoneCount].objIndex=idx;
   g_zoneCount++;
  }

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
   int last=copied-2;
   int direction=0;
   for(int i=0;i<=last;i++)
     {
      if(i>=OB_LEN*3-1)
        {
         int target=i-OB_LEN;
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
            ObjectDelete(0,PFX+"ZONE_"+IntegerToString(g_zones[z].objIndex));
            for(int m=z+1;m<g_zoneCount;m++) g_zones[m-1]=g_zones[m];
            g_zoneCount--;
           }
        }

      int j=i-OB_LEN;
      if(j<OB_LEN || j+OB_LEN>i || direction==0) continue;
      bool pivot=true;
      for(int k=1;k<=OB_LEN;k++)
        {
         if(r[j].tick_volume<=r[j-k].tick_volume ||
            r[j].tick_volume<r[j+k].tick_volume)
           { pivot=false; break; }
        }
      if(!pivot) continue;
      double atr=ATR_H1(r,j,OB_LEN);   // cached per pivot bar, not per zone
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
   DrawZones();
   Print("BuildZones: active zones=",g_zoneCount);
  }

//+------------------------------------------------------------------+
//| M1 signal: only the newest CLOSED bar may break an armed axis.    |
//| axisLevel is the exact broken swing level -> used directly as SL. |
//+------------------------------------------------------------------+
bool DetectM1Signal(int &side,bool &isChoch,double &barLow,double &barHigh,
                    int &signalIndex,double &axisLevel,MqlRates &rates[])
  {
   side=0; isChoch=false; barLow=0.0; barHigh=0.0; signalIndex=-1; axisLevel=0.0;
   ArraySetAsSeries(rates,false);
   int need=4*g_swingLen+10;
   int copied=CopyRates(g_symbol,PERIOD_M1,0,need,rates);
   if(copied<2*g_swingLen+4) return false;

   int last=copied-2;
   int startI=last-g_swingLen;
   double upAxis=0.0,dnAxis=0.0;
   bool upArmed=false,dnArmed=false;
   int moving=0;

   for(int i=0;i<startI;i++)
     {
      int j=i-g_swingLen;
      if(j>=g_swingLen)
        {
         if(IsPivotHigh(rates,j,g_swingLen)) { upAxis=rates[j].high; upArmed=true; }
         if(IsPivotLow (rates,j,g_swingLen)) { dnAxis=rates[j].low;  dnArmed=true; }
        }
      if(i>0 && upArmed && rates[i-1].close<=upAxis && rates[i].close>upAxis)
        { moving=1;  upArmed=false; }
      else if(i>0 && dnArmed && rates[i-1].close>=dnAxis && rates[i].close<dnAxis)
        { moving=-1; dnArmed=false; }
     }

   int j=startI-g_swingLen;
   if(j>=g_swingLen)
     {
      if(IsPivotHigh(rates,j,g_swingLen)) { upAxis=rates[j].high; upArmed=true; }
      if(IsPivotLow (rates,j,g_swingLen)) { dnAxis=rates[j].low;  dnArmed=true; }
     }

   int i=last;
   if(upArmed && upAxis>0.0 && rates[i-1].close<=upAxis && rates[i].close>upAxis)
     {
      side=1; axisLevel=upAxis; isChoch=(moving<0);
     }
   else if(dnArmed && dnAxis>0.0 && rates[i-1].close>=dnAxis && rates[i].close<dnAxis)
     {
      side=-1; axisLevel=dnAxis; isChoch=(moving>0);
     }

   if(side==0) return false;
   if(InpRequireCHoCH && !isChoch) return false;
   barLow=rates[last].low;
   barHigh=rates[last].high;
   signalIndex=last;
   return true;
  }

double CalcTP(const int side,const double entry,const double sl)
  {
   double distance=MathAbs(entry-sl);
   double tp=(side>0 ? entry+InpRR*distance : entry-InpRR*distance);
   return NormalizeDouble(tp,g_digits);
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

//+------------------------------------------------------------------+
//| Zone lock: after an entry the zone is disabled until price leaves |
//| it and comes back (re-arm), then the next CHoCH may fire again.   |
//| Re-arm is evaluated on closed M1 bars, not on every tick.         |
//+------------------------------------------------------------------+
void UpdateZoneLocks()
  {
   MqlRates m1[];
   ArraySetAsSeries(m1,true);
   if(CopyRates(g_symbol,PERIOD_M1,0,2,m1)<1) return;
   double price=m1[0].close;   // last closed M1 bar
   bool changed=false;
   for(int z=0;z<g_zoneCount;z++)
     {
      if(!g_zones[z].used) continue;
      if(!g_zones[z].armed && (price>g_zones[z].top || price<g_zones[z].bottom))
        { g_zones[z].armed=true; changed=true; }
      if(g_zones[z].armed && price>=g_zones[z].bottom && price<=g_zones[z].top)
        {
         g_zones[z].used=false;
         g_zones[z].armed=false;
         changed=true;
         Print("Zone re-armed: ",TimeToString(g_zones[z].startTime));
        }
     }
   if(changed) DrawZones();
  }

//+------------------------------------------------------------------+
//| Visualization                                                    |
//+------------------------------------------------------------------+
void DrawZones()
  {
   if(!InpDrawZones) return;
   datetime tRight=TimeCurrent()+PeriodSeconds(PERIOD_H1)*3;
   for(int z=0;z<g_zoneCount;z++)
     {
      string name=PFX+"ZONE_"+IntegerToString(g_zones[z].objIndex);
      if(ObjectFind(0,name)<0)
        {
         ObjectCreate(0,name,OBJ_RECTANGLE,0,g_zones[z].startTime,g_zones[z].top,
                      tRight,g_zones[z].bottom);
         ObjectSetInteger(0,name,OBJPROP_SELECTABLE,false);
         ObjectSetInteger(0,name,OBJPROP_HIDDEN,true);
         ObjectSetInteger(0,name,OBJPROP_BACK,true);
         ObjectSetInteger(0,name,OBJPROP_FILL,true);
        }
      color clr=(g_zones[z].bullish ? clrDodgerBlue : clrTomato);
      if(g_zones[z].used) clr=clrGray;
      ObjectMove(0,name,0,g_zones[z].startTime,g_zones[z].top);
      ObjectMove(0,name,1,tRight,g_zones[z].bottom);
      ObjectSetInteger(0,name,OBJPROP_COLOR,clr);
      ObjectSetString(0,name,OBJPROP_TOOLTIP,
         (g_zones[z].bullish?"Bull ":"Bear ")+TimeToString(g_zones[z].startTime)+
         (g_zones[z].used?(g_zones[z].armed?" [armed]":" [used]"):" [free]"));
     }
   ChartRedraw(0);
  }

void DrawSignalLevels(const int side,const double axis,const double entry,
                      const double sl,const double tp,const datetime tBar)
  {
   if(!InpDrawSignals) return;
   datetime t1=tBar, t2=tBar+PeriodSeconds(PERIOD_M1)*60;

   // Axis (the exact broken M1 swing level = SL)
   string ax=PFX+"AXIS";
   if(ObjectFind(0,ax)<0) ObjectCreate(0,ax,OBJ_TREND,0,t1,axis,t2,axis);
   ObjectMove(0,ax,0,t1,axis);
   ObjectMove(0,ax,1,t2,axis);
   ObjectSetInteger(0,ax,OBJPROP_COLOR,clrGold);
   ObjectSetInteger(0,ax,OBJPROP_WIDTH,2);
   ObjectSetInteger(0,ax,OBJPROP_RAY_RIGHT,false);
   ObjectSetInteger(0,ax,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,ax,OBJPROP_HIDDEN,true);

   // CHoCH / BOS marker
   string ch=PFX+"CHOCH";
   if(ObjectFind(0,ch)<0) ObjectCreate(0,ch,OBJ_ARROW,0,t1,axis);
   ObjectMove(0,ch,0,t1,axis);
   ObjectSetInteger(0,ch,OBJPROP_ARROWCODE,side>0?233:234);
   ObjectSetInteger(0,ch,OBJPROP_COLOR,side>0?clrLime:clrRed);
   ObjectSetInteger(0,ch,OBJPROP_WIDTH,2);
   ObjectSetInteger(0,ch,OBJPROP_SELECTABLE,false);
   ObjectSetInteger(0,ch,OBJPROP_HIDDEN,true);

   // Entry / SL / TP
   int    codes[3]={159,159,159};
   double prices[3]={entry,sl,tp};
   color  cols[3]={clrWhite,clrRed,clrLime};
   string tags[3]={"ENTRY","SL","TP"};
   for(int k=0;k<3;k++)
     {
      string nm=PFX+tags[k];
      if(ObjectFind(0,nm)<0) ObjectCreate(0,nm,OBJ_TREND,0,t1,prices[k],t2,prices[k]);
      ObjectMove(0,nm,0,t1,prices[k]);
      ObjectMove(0,nm,1,t2,prices[k]);
      ObjectSetInteger(0,nm,OBJPROP_COLOR,cols[k]);
      ObjectSetInteger(0,nm,OBJPROP_STYLE,STYLE_DOT);
      ObjectSetInteger(0,nm,OBJPROP_WIDTH,1);
      ObjectSetInteger(0,nm,OBJPROP_RAY_RIGHT,false);
      ObjectSetInteger(0,nm,OBJPROP_SELECTABLE,false);
      ObjectSetInteger(0,nm,OBJPROP_HIDDEN,true);
     }
   ChartRedraw(0);
  }

void DrawPanel()
  {
   if(!InpShowPanel) return;
   int used=0,free_=0;
   for(int z=0;z<g_zoneCount;z++)
      if(g_zones[z].used) used++; else free_++;
   string txt="AnnaBot v1.11  |  "+g_symbol+"\n"+
              "Zones: "+IntegerToString(g_zoneCount)+
              "  free="+IntegerToString(free_)+
              "  used="+IntegerToString(used)+"\n"+
              "Open positions: "+IntegerToString(CountOwnPositions())+
              "   Signals: "+IntegerToString(g_sigCount)+"\n"+
              "Lots="+DoubleToString(InpLots,2)+
              "  RR="+DoubleToString(InpRR,1)+
              "  Swing="+IntegerToString(g_swingLen)+"\n"+
              "Last: "+g_lastInfo;
   Comment(txt);
  }

//+------------------------------------------------------------------+
//| Entry                                                            |
//+------------------------------------------------------------------+
void TryEntry()
  {
   UpdateZoneLocks();

   MqlRates m1[];
   int side=0,signalIndex=-1;
   bool choch=false;
   double barLow=0.0,barHigh=0.0,axisLevel=0.0;
   if(!DetectM1Signal(side,choch,barLow,barHigh,signalIndex,axisLevel,m1))
     { DrawPanel(); return; }

   // Per-bar guard: a closed M1 bar may produce at most one entry attempt.
   datetime sigTime=m1[signalIndex].time;
   if(sigTime==g_lastSignalBar) { DrawPanel(); return; }
   g_lastSignalBar=sigTime;

   if(InpMaxOpenTrades>0 && CountOwnPositions()>=InpMaxOpenTrades)
     { g_lastInfo="skip: max trades"; DrawPanel(); return; }

   double closePrice=m1[signalIndex].close;
   int zoneIndex=-1;
   for(int z=0;z<g_zoneCount;z++)
     {
      if(g_zones[z].bullish!=(side>0)) continue;
      if(InpOneTradePerZone && g_zones[z].used) continue;
      if(!ZoneInteracts(g_zones[z],barLow,barHigh,closePrice)) continue;
      if(side>0 && barLow>g_zones[z].top) continue;
      if(side<0 && barHigh<g_zones[z].bottom) continue;
      zoneIndex=z; break;
     }
   if(zoneIndex<0) { g_lastInfo="skip: no zone"; DrawPanel(); return; }

   MqlTick tick;
   if(!SymbolInfoTick(g_symbol,tick)) return;
   double entry=(side>0 ? tick.ask : tick.bid);
   double sl=NormalizeDouble(axisLevel,g_digits);   // exact axis, no buffer
   if((side>0 && sl>=entry) || (side<0 && sl<=entry))
     {
      Print("Signal skipped: invalid SL side (axis=",DoubleToString(sl,g_digits),").");
      g_lastInfo="skip: invalid SL side";
      DrawPanel();
      return;
     }
   double tp=CalcTP(side,entry,sl);
   double lots=NormalizeLots(InpLots);
   string comment=(side>0 ? "AnnaBot-L" : "AnnaBot-S");
   bool sent=(side>0 ? trade.Buy(lots,g_symbol,0.0,sl,tp,comment)
                     : trade.Sell(lots,g_symbol,0.0,sl,tp,comment));
   if(sent && (trade.ResultRetcode()==TRADE_RETCODE_DONE ||
               trade.ResultRetcode()==TRADE_RETCODE_PLACED))
     {
      g_zones[zoneIndex].used=true;
      g_zones[zoneIndex].armed=false;
      g_sigCount++;
      g_lastInfo=(side>0?"BUY ":"SELL ")+TimeToString(sigTime);
      DrawSignalLevels(side,axisLevel,entry,sl,tp,sigTime);
      DrawZones();
      Print("Trade opened: ",comment," lots=",DoubleToString(lots,2),
            " SL(axis)=",DoubleToString(sl,g_digits)," TP=",DoubleToString(tp,g_digits),
            " zone=",TimeToString(g_zones[zoneIndex].startTime));
     }
   else
     {
      g_lastInfo="trade failed "+IntegerToString((int)trade.ResultRetcode());
      Print("Trade failed: retcode=",trade.ResultRetcode()," ",trade.ResultRetcodeDescription());
     }
   DrawPanel();
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
   if(InpLots<=0.0 || InpRR<=0.0 || InpSwingLookback<1 || InpSwingLookback>20)
     {
      Print("Initialization failed: invalid risk inputs (Lots>0, RR>0, 1<=Swing<=20).");
      return INIT_PARAMETERS_INCORRECT;
     }
   g_swingLen=InpSwingLookback;
   g_digits=(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS);
   g_point=SymbolInfoDouble(g_symbol,SYMBOL_POINT);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(30);
   if(!trade.SetTypeFillingBySymbol(g_symbol))
      Print("Warning: unable to set symbol filling mode automatically.");
   g_zoneCount=0;
   g_lastM1Bar=0;
   g_lastH1Bar=0;
   g_lastSignalBar=0;
   g_sigCount=0;
   BuildZones();
   DrawPanel();
   Print("AnnaBot v1.11 initialized. Symbol=",g_symbol," Lots=",DoubleToString(InpLots,2),
         " RR=",DoubleToString(InpRR,2)," Swing=",g_swingLen," MaxOpen=",InpMaxOpenTrades);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   ObjectsDeleteAll(0,PFX);
   Comment("");
   ChartRedraw(0);
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

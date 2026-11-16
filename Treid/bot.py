//+------------------------------------------------------------------+
//|                                                  AnnaBot_v4.mq5  |
//|  H1 Order Block (one-time use) + M1 CHoCH entry, axis SL, RR TP  |
//+------------------------------------------------------------------+
#property copyright "Pedram Strategy"
#property version   "4.00"
#property description "H1 OB zones consumed on first reaction; M1 CHoCH entry; SL on broken axis; TP by RR"

#include <Trade/Trade.mqh>

input group "General"
input string InpSymbol           = "EURUSD_o";
input ulong  InpMagic            = 51425001;
input int    InpMaxOpenTrades    = 0;      // 0 = unlimited
input bool   InpOneTradePerZone  = true;   // zone is one-time use
input bool   InpRequireCHoCH     = true;

input group "Risk and execution"
input double InpLots             = 0.03;   // fixed lot for EURUSD_o
input int    InpSwingLookback    = 3;      // M1 swing length AND pivot length
input double InpRR               = 4.0;

#define ZONE_MAX 200
#define OB_LEN   5
#define SWING_LEN 3

//--- zone states
#define Z_ARMED   0      // waiting for first reaction
#define Z_CONSUMED 1     // reacted once -> dead forever

struct Zone
  {
   double   top;
   double   bottom;
   double   average;
   datetime startTime;
   bool     bullish;
   int      state;     // Z_ARMED / Z_CONSUMED
  };

CTrade   trade;
string   g_symbol    = "";
Zone     g_zones[ZONE_MAX];
int      g_zoneCount = 0;
datetime g_lastM1Bar = 0;
datetime g_lastH1Bar = 0;
int      g_swingLen  = SWING_LEN;

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
bool IsNewBar(const ENUM_TIMEFRAMES period)
  {
   datetime t = iTime(g_symbol, period, 0);
   if(t <= 0) return false;
   if(period == PERIOD_M1)
     {
      if(t == g_lastM1Bar) return false;
      g_lastM1Bar = t;
      return true;
     }
   if(period == PERIOD_H1)
     {
      if(t == g_lastH1Bar) return false;
      g_lastH1Bar = t;
      return true;
     }
   return false;
  }

double ATR_H1(MqlRates &r[], const int index, const int length)
  {
   if(length < 1 || index - length + 1 < 1) return 0.0;
   double sum = 0.0;
   for(int k = index - length + 1; k <= index; k++)
     {
      double a = r[k].high - r[k].low;
      double b = MathAbs(r[k].high - r[k-1].close);
      double c = MathAbs(r[k].low  - r[k-1].close);
      sum += MathMax(a, MathMax(b, c));
     }
   return sum / (double)length;
  }

bool IsPivotHigh(MqlRates &r[], const int j, const int length)
  {
   if(length < 1) return false;
   if(j - length < 0 || j + length >= ArraySize(r)) return false;
   for(int k = 1; k <= length; k++)
      if(r[j].high <= r[j-k].high || r[j].high < r[j+k].high) return false;
   return true;
  }

bool IsPivotLow(MqlRates &r[], const int j, const int length)
  {
   if(length < 1) return false;
   if(j - length < 0 || j + length >= ArraySize(r)) return false;
   for(int k = 1; k <= length; k++)
      if(r[j].low >= r[j-k].low || r[j].low > r[j+k].low) return false;
   return true;
  }

//--- carry the consumption state across H1 rebuilds: never re-arm
int WasZoneState(Zone &oldZones[], const int oldCount, const datetime t, const bool bull)
  {
   for(int q = 0; q < oldCount; q++)
      if(oldZones[q].startTime == t && oldZones[q].bullish == bull)
         return oldZones[q].state;
   return Z_ARMED;
  }

void AddZone(const double top, const double bottom, const datetime start,
             const bool bull, Zone &oldZones[], const int oldCount)
  {
   if(top < bottom || top <= 0.0 || bottom <= 0.0) return;
   if(g_zoneCount >= ZONE_MAX)
     {
      for(int q = 1; q < g_zoneCount; q++) g_zones[q-1] = g_zones[q];
      g_zoneCount--;
     }
   g_zones[g_zoneCount].top       = top;
   g_zones[g_zoneCount].bottom    = bottom;
   g_zones[g_zoneCount].average   = (top + bottom) * 0.5;
   g_zones[g_zoneCount].startTime = start;
   g_zones[g_zoneCount].bullish   = bull;
   g_zones[g_zoneCount].state     = WasZoneState(oldZones, oldCount, start, bull);
   g_zoneCount++;
  }

//+------------------------------------------------------------------+
//| H1 zones                                                         |
//+------------------------------------------------------------------+
void BuildZones()
  {
   Zone oldZones[ZONE_MAX];
   int oldCount = g_zoneCount;
   if(oldCount > ZONE_MAX) oldCount = ZONE_MAX;
   for(int q = 0; q < oldCount; q++) oldZones[q] = g_zones[q];
   g_zoneCount = 0;

   MqlRates r[];
   ArraySetAsSeries(r, false);
   int copied = CopyRates(g_symbol, PERIOD_H1, 0, 300, r);
   if(copied <= 3 * OB_LEN + 2)
     {
      Print("BuildZones: insufficient H1 history.");
      return;
     }

   int last = copied - 2;          // last closed H1 bar
   int direction = 0;

   for(int i = 0; i <= last; i++)
     {
      if(i >= OB_LEN * 3 - 1)
        {
         int target = i - OB_LEN;
         double highest = r[target - OB_LEN].high;
         double lowest  = r[target - OB_LEN].low;
         for(int x = target - OB_LEN + 1; x < target; x++)
           {
            if(r[x].high > highest) highest = r[x].high;
            if(r[x].low  < lowest ) lowest  = r[x].low;
           }
         if(r[target].high > highest)      direction = -1;
         else if(r[target].low < lowest)   direction =  1;
        }

      //--- invalidate zones violated by a closed body
      double bodyLow  = MathMin(r[i].open, r[i].close);
      double bodyHigh = MathMax(r[i].open, r[i].close);
      for(int z = g_zoneCount - 1; z >= 0; z--)
        {
         bool remove = ( g_zones[z].bullish && bodyLow  < g_zones[z].bottom) ||
                       (!g_zones[z].bullish && bodyHigh > g_zones[z].top);
         if(remove)
           {
            for(int m = z + 1; m < g_zoneCount; m++) g_zones[m-1] = g_zones[m];
            g_zoneCount--;
           }
        }

      int j = i - OB_LEN;
      if(j < OB_LEN || j + OB_LEN > i || direction == 0) continue;

      bool pivot = true;
      for(int k = 1; k <= OB_LEN; k++)
        {
         if(r[j].tick_volume <= r[j-k].tick_volume ||
            r[j].tick_volume <  r[j+k].tick_volume)
           { pivot = false; break; }
        }
      if(!pivot) continue;

      double atr = ATR_H1(r, j, OB_LEN);
      if(atr <= 0.0) continue;

      if(direction == 1)
        {
         double top = MathMin(r[j].low + atr, r[j].high);
         AddZone(top, r[j].low, r[j].time, true, oldZones, oldCount);
        }
      else
        {
         double bottom = MathMax(r[j].high - atr, r[j].low);
         AddZone(r[j].high, bottom, r[j].time, false, oldZones, oldCount);
        }
     }

   Print("BuildZones: active zones=", g_zoneCount);
  }

//+------------------------------------------------------------------+
//| Zone reaction (first touch consumes the zone permanently)        |
//+------------------------------------------------------------------+
bool ZoneInteracts(const Zone &z, const double lo, const double hi, const double cl)
  {
   return ((lo <= z.top && hi >= z.bottom) || (cl >= z.bottom && cl <= z.top));
  }

//+------------------------------------------------------------------+
//| M1 CHoCH detection                                               |
//+------------------------------------------------------------------+
bool DetectM1Signal(int &side, bool &isChoch, double &barLow, double &barHigh,
                    int &signalIndex, double &axisLevel, MqlRates &rates[])
  {
   side = 0; isChoch = false; barLow = 0.0; barHigh = 0.0;
   signalIndex = -1; axisLevel = 0.0;

   ArraySetAsSeries(rates, false);
   int need = 4 * g_swingLen + 10;
   int copied = CopyRates(g_symbol, PERIOD_M1, 0, need, rates);
   if(copied < 2 * g_swingLen + 4) return false;

   int last   = copied - 2;             // newest closed M1 bar
   int startI = last - g_swingLen;      // last bar where a pivot can be confirmed
   double upAxis = 0.0, dnAxis = 0.0;
   bool upArmed = false, dnArmed = false;
   int moving = 0;                      // -1 = last break was bearish, +1 bullish

   for(int i = 0; i < startI; i++)
     {
      int j = i - g_swingLen;
      if(j >= g_swingLen)
        {
         if(IsPivotHigh(rates, j, g_swingLen)) { upAxis = rates[j].high; upArmed = true; }
         if(IsPivotLow (rates, j, g_swingLen)) { dnAxis = rates[j].low;  dnArmed = true; }
        }
      if(i > 0 && upArmed && rates[i-1].close <= upAxis && rates[i].close > upAxis)
        { moving = 1;  upArmed = false; }
      else if(i > 0 && dnArmed && rates[i-1].close >= dnAxis && rates[i].close < dnAxis)
        { moving = -1; dnArmed = false; }
     }

   int jp = startI - g_swingLen;
   if(jp >= g_swingLen)
     {
      if(IsPivotHigh(rates, jp, g_swingLen)) { upAxis = rates[jp].high; upArmed = true; }
      if(IsPivotLow (rates, jp, g_swingLen)) { dnAxis = rates[jp].low;  dnArmed = true; }
     }

   int i = last;
   if(upArmed && upAxis > 0.0 && rates[i-1].close <= upAxis && rates[i].close > upAxis)
     {
      side = 1; axisLevel = upAxis; isChoch = (moving < 0);
     }
   else if(dnArmed && dnAxis > 0.0 && rates[i-1].close >= dnAxis && rates[i].close < dnAxis)
     {
      side = -1; axisLevel = dnAxis; isChoch = (moving > 0);
     }

   if(side == 0) return false;
   if(InpRequireCHoCH && !isChoch) return false;

   barLow      = rates[last].low;
   barHigh     = rates[last].high;
   signalIndex = last;
   return true;
  }

double CalcTP(const int side, const double entry, const double sl)
  {
   double distance = MathAbs(entry - sl);
   double tp = (side > 0 ? entry + InpRR * distance : entry - InpRR * distance);
   return NormalizeDouble(tp, (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS));
  }

double NormalizeLots(const double requested)
  {
   double minimum = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MIN);
   double maximum = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_MAX);
   double step    = SymbolInfoDouble(g_symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0.0) step = minimum;
   double lots = MathMax(minimum, MathMin(maximum, requested));
   lots = MathFloor(lots / step + 0.5) * step;
   int digits = 0;
   double test = step;
   while(digits < 8 && MathAbs(test - MathRound(test)) > 1e-8)
     { test *= 10.0; digits++; }
   return NormalizeDouble(MathMax(minimum, MathMin(maximum, lots)), digits);
  }

int CountOwnPositions()
  {
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) == g_symbol &&
         (ulong)PositionGetInteger(POSITION_MAGIC) == InpMagic) count++;
     }
   return count;
  }

//+------------------------------------------------------------------+
//| Entry                                                            |
//+------------------------------------------------------------------+
void TryEntry()
  {
   MqlRates m1[];
   int side = 0, signalIndex = -1;
   bool choch = false;
   double barLow = 0.0, barHigh = 0.0, axisLevel = 0.0;
   if(!DetectM1Signal(side, choch, barLow, barHigh, signalIndex, axisLevel, m1)) return;
   if(InpMaxOpenTrades > 0 && CountOwnPositions() >= InpMaxOpenTrades) return;

   double closePrice = m1[signalIndex].close;

   //--- find the first matching zone that has NOT reacted yet
   int zoneIndex = -1;
   for(int z = 0; z < g_zoneCount; z++)
     {
      if(g_zones[z].bullish != (side > 0)) continue;
      if(InpOneTradePerZone && g_zones[z].state != Z_ARMED) continue;
      if(!ZoneInteracts(g_zones[z], barLow, barHigh, closePrice)) continue;
      if(side > 0 && barLow  > g_zones[z].top)    continue;
      if(side < 0 && barHigh < g_zones[z].bottom) continue;
      zoneIndex = z;
      break;
     }
   if(zoneIndex < 0) return;

   //--- first reaction: consume the zone before anything else can use it
   if(InpOneTradePerZone)
     {
      g_zones[zoneIndex].state = Z_CONSUMED;
      Print("Zone consumed on first reaction: ", TimeToString(g_zones[zoneIndex].startTime),
            " dir=", (g_zones[zoneIndex].bullish ? "bull" : "bear"));
     }

   MqlTick tick;
   if(!SymbolInfoTick(g_symbol, tick)) return;
   double entry = (side > 0 ? tick.ask : tick.bid);
   double sl = NormalizeDouble(axisLevel, (int)SymbolInfoInteger(g_symbol, SYMBOL_DIGITS));
   if((side > 0 && sl >= entry) || (side < 0 && sl <= entry))
     {
      Print("Signal skipped: invalid SL side (axis=", DoubleToString(sl, _Digits), ").");
      return;
     }

   double tp    = CalcTP(side, entry, sl);
   double lots  = NormalizeLots(InpLots);
   string comment = (side > 0 ? "AnnaBot-L" : "AnnaBot-S");

   bool sent = (side > 0 ? trade.Buy (lots, g_symbol, 0.0, sl, tp, comment)
                         : trade.Sell(lots, g_symbol, 0.0, sl, tp, comment));

   if(sent && (trade.ResultRetcode() == TRADE_RETCODE_DONE ||
               trade.ResultRetcode() == TRADE_RETCODE_PLACED))
      Print("Trade opened: ", comment, " lots=", DoubleToString(lots, 2),
            " SL(axis)=", DoubleToString(sl, _Digits), " TP=", DoubleToString(tp, _Digits),
            " zone=", TimeToString(g_zones[zoneIndex].startTime));
   else
      Print("Trade failed: retcode=", trade.ResultRetcode(), " ",
            trade.ResultRetcodeDescription());
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   g_symbol = (InpSymbol == "" ? _Symbol : InpSymbol);
   if(!SymbolSelect(g_symbol, true))
     {
      Print("Initialization failed: symbol is unavailable: ", g_symbol);
      return INIT_FAILED;
     }
   if(InpLots <= 0.0 || InpRR <= 0.0 || InpSwingLookback < 1)
     {
      Print("Initialization failed: invalid risk inputs.");
      return INIT_PARAMETERS_INCORRECT;
     }

   g_swingLen = InpSwingLookback;
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(30);
   if(!trade.SetTypeFillingBySymbol(g_symbol))
      Print("Warning: unable to set symbol filling mode automatically.");

   g_zoneCount = 0;
   g_lastM1Bar = 0;
   g_lastH1Bar = 0;

   Print("AnnaBot v4.00 initialized. Symbol=", g_symbol,
         " Lots=", DoubleToString(InpLots, 2),
         " RR=", DoubleToString(InpRR, 2),
         " Swing=", g_swingLen,
         " MaxOpen=", InpMaxOpenTrades,
         " OneTradePerZone=", (InpOneTradePerZone ? "true" : "false"));
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   Print("AnnaBot stopped. Reason=", reason);
  }

void OnTick()
  {
   if(IsNewBar(PERIOD_H1)) BuildZones();
   if(IsNewBar(PERIOD_M1)) TryEntry();
  }
//+------------------------------------------------------------------+

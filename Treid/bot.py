//+------------------------------------------------------------------+
//|                                                 AnnaBot_v5.mq5   |
//|                                  Copyright 2026, Pedram Strategy |
//|                                             https://www.mql5.com |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026"
#property link      "https://www.mql5.com"
#property version   "5.00"
#property strict

#include <Trade\Trade.mqh>
CTrade trade;

//--- Inputs
input group "=== Risk & Money Management ==="
input double   InpRiskPercent    = 2.0;       // Risk Percent per Trade
input double   InpMinRR          = 3.0;       // Minimum Risk-to-Reward (RR)
input double   InpMaxRR          = 5.0;       // Maximum Risk-to-Reward (RR - Clamped)
input ulong    InpMagic          = 20261118;  // Magic Number

input group "=== Strategy Parameters ==="
input int      InpSwingLen       = 2;         // Fractal/Swing Length (2 bars left/right)
input int      InpZoneLegLen     = 20;        // Leg length for Demand/Supply zone
input int      InpMaxZones       = 10;        // Max stored active zones
input int      InpBiasMaxBars    = 200;       // H4 bias max age in H4 bars
input int      InpTenkan         = 9;         // Ichimoku Tenkan-sen
input int      InpKijun          = 26;        // Ichimoku Kijun-sen
input int      InpSenkou         = 52;        // Ichimoku Senkou-sen B
input bool     InpRequireTimeBreak = false;   // Optional Temporal Violation filter

input group "=== Execution & Filters ==="
input int      InpMaxSpreadPoints= 50;        // Max allowed spread in points
input int      InpMaxSlPoints    = 1000;      // Max SL in points
input int      InpMinSlPoints    = 50;        // Min SL in points
input bool     InpShowPanel      = true;      // Show Info Panel on Chart

//--- Global Handles
int handleH4_Ichimoku = INVALID_HANDLE;
int handleM15_Ichimoku = INVALID_HANDLE;
int handleM5_Ichimoku = INVALID_HANDLE;

//--- Time tracking for New Bar
datetime lastBarH4  = 0;
datetime lastBarM15 = 0;
datetime lastBarM5  = 0;

//--- Zone struct
struct SZone {
   double top;
   double bottom;
   datetime time;
   bool used;
};

SZone m15_demand_zones[];
SZone h4_supply_zones[];

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   
   // Initialize Ichimoku handles
   handleH4_Ichimoku  = iIchimoku(_Symbol, PERIOD_H4, InpTenkan, InpKijun, InpSenkou);
   handleM15_Ichimoku = iIchimoku(_Symbol, PERIOD_M15, InpTenkan, InpKijun, InpSenkou);
   handleM5_Ichimoku  = iIchimoku(_Symbol, PERIOD_M5, InpTenkan, InpKijun, InpSenkou);
   
   if(handleH4_Ichimoku == INVALID_HANDLE || handleM15_Ichimoku == INVALID_HANDLE || handleM5_Ichimoku == INVALID_HANDLE)
   {
      Print("[AnnaBot v5] Error creating Ichimoku indicator handles.");
      return(INIT_FAILED);
   }

   ArrayResize(m15_demand_zones, 0);
   ArrayResize(h4_supply_zones, 0);

   Print("[AnnaBot v5] Initialized successfully.");
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(handleH4_Ichimoku);
   IndicatorRelease(handleM15_Ichimoku);
   IndicatorRelease(handleM5_Ichimoku);
}

//+------------------------------------------------------------------+
//| Check for New Bar                                                |
//+------------------------------------------------------------------+
bool IsNewBar(ENUM_TIMEFRAMES tf, datetime &lastTime)
{
   datetime currTime = (datetime)SeriesInfoInteger(_Symbol, tf, SERIES_LASTBAR_DATE);
   if(currTime > lastTime)
   {
      lastTime = currTime;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Swing High Finder                                                |
//+------------------------------------------------------------------+
bool FindSwingHigh(ENUM_TIMEFRAMES tf, int shift, int len, double &swHigh)
{
   HighRate:
   if(shift + len >= iBars(_Symbol, tf)) return false;
   double h = iHigh(_Symbol, tf, shift);
   for(int i = 1; i <= len; i++)
   {
      if(iHigh(_Symbol, tf, shift + i) > h) return false;
      if(iHigh(_Symbol, tf, shift - i) > h) return false;
   }
   swHigh = h;
   return true;
}

//+------------------------------------------------------------------+
//| Swing Low Finder                                                 |
//+------------------------------------------------------------------+
bool FindSwingLow(ENUM_TIMEFRAMES tf, int shift, int len, double &swLow)
{
   if(shift + len >= iBars(_Symbol, tf)) return false;
   double l = iLow(_Symbol, tf, shift);
   for(int i = 1; i <= len; i++)
   {
      if(iLow(_Symbol, tf, shift + i) < l) return false;
      if(iLow(_Symbol, tf, shift - i) < l) return false;
   }
   swLow = l;
   return true;
}

//+------------------------------------------------------------------+
//| Detect Bullish CHoCH                                             |
//+------------------------------------------------------------------+
bool DetectBullishCHoCH(ENUM_TIMEFRAMES tf, int len, int &chochBarIndex, double &brokenHigh, double &originLow)
{
   int totalBars = iBars(_Symbol, tf);
   if(totalBars < 100) return false;
   
   double lastSH = 0;
   int shShift = -1;
   
   // Find most recent confirmed swing high
   for(int i = len + 1; i < 50; i++)
   {
      double val = 0;
      if(FindSwingHigh(tf, i, len, val))
      {
         lastSH = val;
         shShift = i;
         break;
      }
   }
   
   if(shShift < 0) return false;
   
   // Check if any bar from shift 1 to shShift-1 closed above lastSH
   for(int i = shShift - 1; i >= 1; i--)
   {
      if(iClose(_Symbol, tf, i) > lastSH)
      {
         chochBarIndex = i;
         brokenHigh = lastSH;
         
         // Origin low is the lowest low between the swing high and the CHoCH bar
         double minL = iLow(_Symbol, tf, i);
         for(int j = i; j <= shShift; j++)
         {
            if(iLow(_Symbol, tf, j) < minL) minL = iLow(_Symbol, tf, j);
         }
         originLow = minL;
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Ichimoku Bullish Confirmation (Corrected Senkou Offset)          |
//+------------------------------------------------------------------+
bool CheckIchimokuBullish(ENUM_TIMEFRAMES tf, int handle, int shift)
{
   double tenkan[], kijun[], senkouA[], senkouB[];
   ArraySetAsSeries(tenkan, true);
   ArraySetAsSeries(kijun, true);
   ArraySetAsSeries(senkouA, true);
   ArraySetAsSeries(senkouB, true);
   
   // Senkou buffers in MT5 Ichimoku are shifted forward by Kijun periods (InpKijun)
   int dataShift = shift + InpKijun;
   
   if(CopyBuffer(handle, 0, shift, 1, tenkan) <= 0) return false;
   if(CopyBuffer(handle, 1, shift, 1, kijun) <= 0) return false;
   if(CopyBuffer(handle, 2, dataShift, 1, senkouA) <= 0) return false;
   if(CopyBuffer(handle, 3, dataShift, 1, senkouB) <= 0) return false;
   
   double c = iClose(_Symbol, tf, shift);
   double kumoTop = MathMax(senkouA[0], senkouB[0]);
   
   // Conditions: Price > Kumo Top, Tenkan > Kijun, Tenkan > Kumo Top
   if(c > kumoTop && tenkan[0] > kijun[0] && tenkan[0] > kumoTop)
   {
      if(InpRequireTimeBreak)
      {
         double oldClose = iClose(_Symbol, tf, shift + InpKijun);
         if(c <= oldClose) return false; // Temporal violation check
      }
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Add Demand/Supply Zone                                           |
//+------------------------------------------------------------------+
void AddZone(SZone &arr[], double top, double bottom, datetime time)
{
   int size = ArraySize(arr);
   if(size >= InpMaxZones)
   {
      // Shift array left
      for(int i = 0; i < size - 1; i++) arr[i] = arr[i+1];
      size = InpMaxZones - 1;
      ArrayResize(arr, size);
   }
   ArrayResize(arr, size + 1);
   arr[size].top = top;
   arr[size].bottom = bottom;
   arr[size].time = time;
   arr[size].used = false;
}

//+------------------------------------------------------------------+
//| Check if Price Touches Zone                                      |
//+------------------------------------------------------------------+
bool PriceTouchesZone(ENUM_TIMEFRAMES tf, int shift, const SZone &zone)
{
   double c = iClose(_Symbol, tf, shift);
   double h = iHigh(_Symbol, tf, shift);
   double l = iLow(_Symbol, tf, shift);
   
   // Overlap or close inside
   return ((l <= zone.top && h >= zone.bottom) || (c >= zone.bottom && c <= zone.top));
}

//+------------------------------------------------------------------+
//| Calculate Lot Size based on Risk %                               |
//+------------------------------------------------------------------+
double CalculateLots(double slPoints)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * (InpRiskPercent / 100.0);
   
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   double point     = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   
   if(tickValue <= 0 || tickSize <= 0 || point <= 0 || slPoints <= 0) return 0.01;
   
   double riskPerLot = (slPoints * point / tickSize) * tickValue;
   if(riskPerLot <= 0) return 0.01;
   
   double lots = riskMoney / riskPerLot;
   
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   
   lots = MathFloor(lots / lotStep) * lotStep;
   if(lots < minLot) lots = minLot;
   if(lots > maxLot) lots = maxLot;
   
   return lots;
}

//+------------------------------------------------------------------+
//| Get H4 Supply Zone Target (RR between 3 and 5)                   |
//+------------------------------------------------------------------+
bool GetH4SupplyTarget(double entry, double sl, double &outTP, double &outRR)
{
   double riskDist = entry - sl;
   if(riskDist <= 0) return false;
   
   double bestSupplyTop = 0;
   int size = ArraySize(h4_supply_zones);
   
   // Find nearest unmitigated H4 supply zone above entry
   for(int i = size - 1; i >= 0; i--)
   {
      if(!h4_supply_zones[i].used && h4_supply_zones[i].bottom > entry)
      {
         bestSupplyTop = h4_supply_zones[i].bottom; // conservative target at zone bottom
         break;
      }
   }
   
   if(bestSupplyTop <= entry)
   {
      // Fallback if no H4 supply zone stored yet: use InpMinRR * risk
      outTP = entry + (InpMinRR * riskDist);
      outRR = InpMinRR;
      return true;
   }
   
   double rewardDist = bestSupplyTop - entry;
   double rr = rewardDist / riskDist;
   
   if(rr < InpMinRR) return false; // Below min RR, skip trade
   
   if(rr > InpMaxRR)
   {
      // Clamp TP to Max RR
      outTP = entry + (InpMaxRR * riskDist);
      outRR = InpMaxRR;
   }
   else
   {
      outTP = bestSupplyTop;
      outRR = rr;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Count Open Positions for this Magic                              |
//+------------------------------------------------------------------+
int CountOpenPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
      {
         if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   // Check spread filter
   double spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPoints) return;
   
   // Only allow 1 open position at a time
   if(CountOpenPositions() > 0)
   {
      UpdatePanel("POSITION ACTIVE", 0, 0, 0, 3.0);
      return;
   }
   
   // --- 1. H4 Bias Check (New H4 bar or periodic check)
   if(IsNewBar(PERIOD_H4, lastBarH4))
   {
      int chochBar = 0;
      double brokenH = 0, originL = 0;
      if(DetectBullishCHoCH(PERIOD_H4, InpSwingLen, chochBar, brokenH, originL))
      {
         // Add H4 supply zone (from last up leg before CHoCH)
         double supTop = iHigh(_Symbol, PERIOD_H4, chochBar + 5);
         double supBot = iLow(_Symbol, PERIOD_H4, chochBar + 1);
         AddZone(h4_supply_zones, supTop, supBot, iTime(_Symbol, PERIOD_H4, chochBar));
      }
   }
   
   // --- 2. M15 State & Pullback Check
   if(IsNewBar(PERIOD_M15, lastBarM15))
   {
      int chochBarM15 = 0;
      double brokenHM15 = 0, originLM15 = 0;
      
      // Check M15 Ichimoku & CHoCH
      if(CheckIchimokuBullish(PERIOD_M15, handleM15_Ichimoku, 1))
      {
         if(DetectBullishCHoCH(PERIOD_M15, InpSwingLen, chochBarM15, brokenHM15, originLM15))
         {
            // Create M15 demand zone
            double zoneTop = brokenHM15;
            double zoneBot = originLM15;
            AddZone(m15_demand_zones, zoneTop, zoneBot, iTime(_Symbol, PERIOD_M15, chochBarM15));
         }
      }
   }
   
   // --- 3. M5 Execution Check (Every M5 bar)
   if(IsNewBar(PERIOD_M5, lastBarM5))
   {
      // Check M5 Ichimoku
      if(!CheckIchimokuBullish(PERIOD_M5, handleM5_Ichimoku, 1)) return;
      
      // Check M5 CHoCH
      int chochBarM5 = 0;
      double brokenHM5 = 0, originLM5 = 0;
      if(!DetectBullishCHoCH(PERIOD_M5, InpSwingLen, chochBarM5, brokenHM5, originLM5)) return;
      
      // Verify price touched an active M15 demand zone
      bool inZone = false;
      int m15Size = ArraySize(m15_demand_zones);
      for(int i = 0; i < m15Size; i++)
      {
         if(!m15_demand_zones[i].used && PriceTouchesZone(PERIOD_M5, chochBarM5, m15_demand_zones[i]))
         {
            inZone = true;
            m15_demand_zones[i].used = true; // Mark zone as tested/used
            break;
         }
      }
      
      if(!inZone && m15Size > 0) return; // Must respect M15 zone pullback
      
      // Setup Entry, SL and TP
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl = originLM5 - (5 * _Point); // SL below M5 swing low origin
      
      // Validate SL distance
      double slPoints = (ask - sl) / _Point;
      if(slPoints < InpMinSlPoints || slPoints > InpMaxSlPoints) return;
      
      double tp = 0, rr = 0;
      if(!GetH4SupplyTarget(ask, sl, tp, rr)) return;
      
      double lots = CalculateLots(slPoints);
      
      // Execute Buy Order
      if(trade.Buy(lots, _Symbol, ask, sl, tp, "AnnaBot v5 Long"))
      {
         Print("[AnnaBot v5] Buy order executed successfully. Lots: ", lots, ", SL: ", sl, ", TP: ", tp, ", RR: ", rr);
      }
      else
      {
         Print("[AnnaBot v5] Order failed. Error: ", GetLastError());
      }
   }
   
   if(InpShowPanel) UpdatePanel("SEARCHING SETUP", 0, 0, 0, 0);
}

//+------------------------------------------------------------------+
//| Update Info Panel on Chart                                       |
//+------------------------------------------------------------------+
void UpdatePanel(string status, double sl, double tp, double rr, double lots)
{
   string comment = "==============================\n";
   comment += "       ANNA BOT v5 (MQL5)     \n";
   comment += "==============================\n";
   comment += "Status: " + status + "\n";
   comment += "Spread: " + DoubleToString(SymbolInfoInteger(_Symbol, SYMBOL_SPREAD), 0) + " pts\n";
   comment += "Active Zones M15: " + IntegerToString(ArraySize(m15_demand_zones)) + "\n";
   comment += "Active Zones H4: " + IntegerToString(ArraySize(h4_supply_zones)) + "\n";
   comment += "==============================\n";
   Comment(comment);
}


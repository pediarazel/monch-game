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

SZone m15_supply_zones[];
SZone h4_demand_zones[];

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagic);
   
   handleH4_Ichimoku  = iIchimoku(_Symbol, PERIOD_H4, InpTenkan, InpKijun, InpSenkou);
   handleM15_Ichimoku = iIchimoku(_Symbol, PERIOD_M15, InpTenkan, InpKijun, InpSenkou);
   handleM5_Ichimoku  = iIchimoku(_Symbol, PERIOD_M5, InpTenkan, InpKijun, InpSenkou);
   
   if(handleH4_Ichimoku == INVALID_HANDLE || handleM15_Ichimoku == INVALID_HANDLE || handleM5_Ichimoku == INVALID_HANDLE)
   {
      Print("[AnnaBot v5 Inverted] Error creating Ichimoku indicator handles.");
      return(INIT_FAILED);
   }

   ArrayResize(m15_supply_zones, 0);
   ArrayResize(h4_demand_zones, 0);

   Print("[AnnaBot v5 Inverted] Initialized successfully.");
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
//| Detect Bearish CHoCH (Inverted)                                  |
//+------------------------------------------------------------------+
bool DetectBearishCHoCH(ENUM_TIMEFRAMES tf, int len, int &chochBarIndex, double &brokenLow, double &originHigh)
{
   int totalBars = iBars(_Symbol, tf);
   if(totalBars < 100) return false;
   
   double lastSL = 0;
   int slShift = -1;
   
   // Find most recent confirmed swing low
   for(int i = len + 1; i < 50; i++)
   {
      double val = 0;
      if(FindSwingLow(tf, i, len, val))
      {
         lastSL = val;
         slShift = i;
         break;
      }
   }
   
   if(slShift < 0) return false;
   
   // Check if any bar from shift 1 to slShift-1 closed below lastSL
   for(int i = slShift - 1; i >= 1; i--)
   {
      if(iClose(_Symbol, tf, i) < lastSL)
      {
         chochBarIndex = i;
         brokenLow = lastSL;
         
         // Origin high is the highest high between the swing low and the CHoCH bar
         double maxH = iHigh(_Symbol, tf, i);
         for(int j = i; j <= slShift; j++)
         {
            if(iHigh(_Symbol, tf, j) > maxH) maxH = iHigh(_Symbol, tf, j);
         }
         originHigh = maxH;
         return true;
      }
   }
   return false;
}

//+------------------------------------------------------------------+
//| Ichimoku Bearish Confirmation (Inverted)                         |
//+------------------------------------------------------------------+
bool CheckIchimokuBearish(ENUM_TIMEFRAMES tf, int handle, int shift)
{
   double tenkan[], kijun[], senkouA[], senkouB[];
   ArraySetAsSeries(tenkan, true);
   ArraySetAsSeries(kijun, true);
   ArraySetAsSeries(senkouA, true);
   ArraySetAsSeries(senkouB, true);
   
   int dataShift = shift + InpKijun;
   
   if(CopyBuffer(handle, 0, shift, 1, tenkan) <= 0) return false;
   if(CopyBuffer(handle, 1, shift, 1, kijun) <= 0) return false;
   if(CopyBuffer(handle, 2, dataShift, 1, senkouA) <= 0) return false;
   if(CopyBuffer(handle, 3, dataShift, 1, senkouB) <= 0) return false;
   
   double c = iClose(_Symbol, tf, shift);
   double kumoBottom = MathMin(senkouA[0], senkouB[0]);
   
   // Conditions for Bearish: Price < Kumo Bottom, Tenkan < Kijun, Tenkan < Kumo Bottom
   if(c < kumoBottom && tenkan[0] < kijun[0] && tenkan[0] < kumoBottom)
   {
      if(InpRequireTimeBreak)
      {
         double oldClose = iClose(_Symbol, tf, shift + InpKijun);
         if(c >= oldClose) return false;
      }
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| Add Zone                                                         |
//+------------------------------------------------------------------+
void AddZone(SZone &arr[], double top, double bottom, datetime time)
{
   int size = ArraySize(arr);
   if(size >= InpMaxZones)
   {
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
   return ((l <= zone.top && h >= zone.bottom) || (c >= zone.bottom && c <= zone.top));
}

//+------------------------------------------------------------------+
//| Calculate Lot Size                                               |
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
//| Get H4 Demand Zone Target for Sell (Inverted RR 3 to 5)          |
//+------------------------------------------------------------------+
bool GetH4DemandTarget(double entry, double sl, double &outTP, double &outRR)
{
   double riskDist = sl - entry; // For Sell, SL is above entry
   if(riskDist <= 0) return false;
   
   double bestDemandBottom = 0;
   int size = ArraySize(h4_demand_zones);
   
   // Find nearest unmitigated H4 demand zone below entry
   for(int i = size - 1; i >= 0; i--)
   {
      if(!h4_demand_zones[i].used && h4_demand_zones[i].top < entry)
      {
         bestDemandBottom = h4_demand_zones[i].top; // conservative target at zone top
         break;
      }
   }
   
   if(bestDemandBottom >= entry || bestDemandBottom == 0)
   {
      outTP = entry - (InpMinRR * riskDist);
      outRR = InpMinRR;
      return true;
   }
   
   double rewardDist = entry - bestDemandBottom;
   double rr = rewardDist / riskDist;
   
   if(rr < InpMinRR) return false;
   
   if(rr > InpMaxRR)
   {
      outTP = entry - (InpMaxRR * riskDist);
      outRR = InpMaxRR;
   }
   else
   {
      outTP = bestDemandBottom;
      outRR = rr;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Count Open Positions (Sell)                                      |
//+------------------------------------------------------------------+
int CountOpenPositions()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
      {
         if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL) count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   double spread = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   if(spread > InpMaxSpreadPoints) return;
   
   if(CountOpenPositions() > 0)
   {
      UpdatePanel("POSITION ACTIVE", 0, 0, 0, 3.0);
      return;
   }
   
   // --- 1. H4 Bias Check (Bearish)
   if(IsNewBar(PERIOD_H4, lastBarH4))
   {
      int chochBar = 0;
      double brokenL = 0, originH = 0;
      if(DetectBearishCHoCH(PERIOD_H4, InpSwingLen, chochBar, brokenL, originH))
      {
         double demTop = iHigh(_Symbol, PERIOD_H4, chochBar + 1);
         double demBot = iLow(_Symbol, PERIOD_H4, chochBar + 5);
         AddZone(h4_demand_zones, demTop, demBot, iTime(_Symbol, PERIOD_H4, chochBar));
      }
   }
   
   // --- 2. M15 State & Pullback Check (Bearish)
   if(IsNewBar(PERIOD_M15, lastBarM15))
   {
      int chochBarM15 = 0;
      double brokenLM15 = 0, originHM15 = 0;
      
      if(CheckIchimokuBearish(PERIOD_M15, handleM15_Ichimoku, 1))
      {
         if(DetectBearishCHoCH(PERIOD_M15, InpSwingLen, chochBarM15, brokenLM15, originHM15))
         {
            double zoneTop = originHM15;
            double zoneBot = brokenLM15;
            AddZone(m15_supply_zones, zoneTop, zoneBot, iTime(_Symbol, PERIOD_M15, chochBarM15));
         }
      }
   }
   
   // --- 3. M5 Execution Check (Sell Setup)
   if(IsNewBar(PERIOD_M5, lastBarM5))
   {
      if(!CheckIchimokuBearish(PERIOD_M5, handleM5_Ichimoku, 1)) return;
      
      int chochBarM5 = 0;
      double brokenLM5 = 0, originHM5 = 0;
      if(!DetectBearishCHoCH(PERIOD_M5, InpSwingLen, chochBarM5, brokenLM5, originHM5)) return;
      
      bool inZone = false;
      int m15Size = ArraySize(m15_supply_zones);
      for(int i = 0; i < m15Size; i++)
      {
         if(!m15_supply_zones[i].used && PriceTouchesZone(PERIOD_M5, chochBarM5, m15_supply_zones[i]))
         {
            inZone = true;
            m15_supply_zones[i].used = true;
            break;
         }
      }
      
      if(!inZone && m15Size > 0) return;
      
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl = originHM5 + (5 * _Point); // SL above M5 swing high origin for Sell
      
      double slPoints = (sl - bid) / _Point;
      if(slPoints < InpMinSlPoints || slPoints > InpMaxSlPoints) return;
      
      double tp = 0, rr = 0;
      if(!GetH4DemandTarget(bid, sl, tp, rr)) return;
      
      double lots = CalculateLots(slPoints);
      
      // Execute Sell Order
      if(trade.Sell(lots, _Symbol, bid, sl, tp, "AnnaBot v5 Inverted Short"))
      {
         Print("[AnnaBot v5 Inverted] Sell order executed successfully. Lots: ", lots, ", SL: ", sl, ", TP: ", tp, ", RR: ", rr);
      }
      else
      {
         Print("[AnnaBot v5 Inverted] Order failed. Error: ", GetLastError());
      }
   }
   
   if(InpShowPanel) UpdatePanel("SEARCHING SETUP (SHORT)", 0, 0, 0, 0);
}

//+------------------------------------------------------------------+
//| Update Info Panel on Chart                                       |
//+------------------------------------------------------------------+
void UpdatePanel(string status, double sl, double tp, double rr, double lots)
{
   string comment = "==============================\n";
   comment += "   ANNA BOT v5 INVERTED (SHORT) \n";
   comment += "==============================\n";
   comment += "Status: " + status + "\n";
   comment += "Spread: " + DoubleToString(SymbolInfoInteger(_Symbol, SYMBOL_SPREAD), 0) + " pts\n";
   comment += "Active Zones M15 Supply: " + IntegerToString(ArraySize(m15_supply_zones)) + "\n";
   comment += "Active Zones H4 Demand: " + IntegerToString(ArraySize(h4_demand_zones)) + "\n";
   comment += "==============================\n";
   Comment(comment);
}

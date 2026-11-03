//+------------------------------------------------------------------+
//|                                                     AnnaBot.mq5  |
//|  Anna Strategy: NY 10:00 H1 reference candle + Inside Bar        |
//|  Scenario A: body breakout -> entry @ 50% of reference candle    |
//|  Scenario B: wick breakout -> M5 FVG break-through + retest      |
//|              + pin bar + body close -> entry on M5               |
//|  TP = 2R measured from the REAL entry price. Fixed lot.          |
//+------------------------------------------------------------------+
#property strict
#property version   "1.10"
#property description "Anna Strategy EA - NY 10:00 H1 reference, Inside Bar, M5 FVG retest"

//=========================== INPUTS ================================
input group "=== Symbol / Lots ==="
input string   InpSymbol            = "XAUUSD.zero";  // Symbol (blank = chart symbol)
input double   InpLots              = 0.05;           // Fixed lot size
input ulong    InpMagic             = 26102501;       // Magic number
input int      InpDeviationPoints   = 30;             // Max deviation (points)

input group "=== Reference Candle (New York) ==="
input int      InpNyOpenHour        = 10;             // NY reference hour (New York time)
input int      InpServerToNyOffset  = 7;              // Server hour + offset = NY hour
input bool     InpUseInsideBar      = true;           // Apply Inside Bar / mother bar rule

input group "=== Risk / Targets ==="
input double   InpRewardRisk        = 2.00;           // TP = R multiple of entry
input double   InpMaxStopPriceUnits = 4.00;           // Max SL distance in price units (0 = off)
input double   InpMinStopPriceUnits = 0.20;           // Min SL distance in price units
input double   InpBufferPriceUnits  = 0.05;           // Extra buffer beyond swing / candle

input group "=== Scenario Switches ==="
input bool     InpEnableScenarioA   = true;           // Body breakout @ 50% midline
input bool     InpEnableScenarioB   = true;           // Wick breakout + M5 FVG retest
input int      InpSetupValidHours   = 8;              // Setup lifetime after ref candle (hours)

input group "=== M5 FVG / Pin Bar ==="
input int      InpFvgLookbackBars   = 60;             // M5 bars scanned for FVG
input double   InpFvgMinSize        = 0.10;           // Min FVG height (price units)
input double   InpPinBarWickRatio   = 2.00;           // Wick >= ratio * body
input int      InpSwingLookback     = 5;              // Bars each side for local swing
input int      InpMaxEntryAttempts  = 3;              // Retries per setup

input group "=== Trading Window ==="
input bool     InpOneTradePerDay    = true;           // One position per day
input int      InpTradeEndHourNy    = 18;             // No new entries after this NY hour

//=========================== GLOBALS ===============================
int      g_atrHandle   = INVALID_HANDLE;
string   g_sym         = "";
datetime g_lastH1Bar   = 0;
datetime g_lastM5Bar   = 0;

// Reference candle state
bool     g_refValid    = false;
datetime g_refTime     = 0;      // start time of reference candle
datetime g_dayStamp    = 0;      // date of the reference candle
double   g_refHigh     = 0.0;
double   g_refLow      = 0.0;
double   g_refOpen     = 0.0;
double   g_refClose    = 0.0;
double   g_refMid      = 0.0;

// Scenario state
bool     g_scenAActive = false;  // waiting for body breakout
bool     g_scenBActive = false;  // waiting for FVG retest setup
int      g_biasA       = 0;      // +1 long / -1 short once triggered
int      g_scenBDir    = 0;      // direction of the wick breakout
bool     g_fvgBroken   = false;  // price crossed through the FVG
bool     g_fvgRetested = false;  // price came back to the broken FVG
double   g_fvgHigh     = 0.0;    // active FVG boundaries
double   g_fvgLow      = 0.0;
double   g_extreme     = 0.0;    // extreme beyond the FVG (for invalidation)
int      g_attempts    = 0;
datetime g_lastTradeDay = 0;

//=========================== HELPERS ===============================
double AbsV(const double v) { return (v < 0.0 ? -v : v); }

int DigitsSym() { return (int)SymbolInfoInteger(g_sym, SYMBOL_DIGITS); }

double NormPrice(const double p) { return NormalizeDouble(p, DigitsSym()); }

double TickSize()
{
   double t = 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_TRADE_TICK_SIZE, t) || t <= 0.0)
   {
      if(!SymbolInfoDouble(g_sym, SYMBOL_POINT, t)) return 0.0;
   }
   return t;
}

int VolumeDigits(const double step)
{
   for(int n = 0; n <= 8; n++)
      if(AbsV(step - NormalizeDouble(step, n)) < 1e-9) return n;
   return 2;
}

// Fixed lot: accept only if broker volume limits allow it exactly.
double NormalizeLots(const double lots)
{
   double vmin = 0.0, vmax = 0.0, step = 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MIN, vmin)) return 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_VOLUME_MAX, vmax)) return 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_VOLUME_STEP, step)) return 0.0;
   if(step <= 0.0 || vmin <= 0.0) return 0.0;
   if(lots < vmin - 1e-9 || lots > vmax + 1e-9) return 0.0;
   double aligned = MathFloor((lots - vmin) / step + 1e-8) * step + vmin;
   if(AbsV(aligned - lots) > 1e-7) return 0.0;
   return NormalizeDouble(lots, VolumeDigits(step));
}

bool HasOurPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != g_sym) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;
      return true;
   }
   return false;
}

// New York hour from server time.
int NyHour(const datetime t)
{
   MqlDateTime s;
   TimeToStruct(t, s);
   int h = s.hour + InpServerToNyOffset;
   h %= 24;
   if(h < 0) h += 24;
   return h;
}

datetime DayStart(const datetime t)
{
   MqlDateTime s;
   TimeToStruct(t, s);
   s.hour = 0; s.min = 0; s.sec = 0;
   return StructToTime(s);
}

//=========================== ORDER =================================
bool OpenTrade(const int direction, const double slPrice, const string tag)
{
   double lots = NormalizeLots(InpLots);
   if(lots <= 0.0)
   {
      Print("Order rejected: fixed lot invalid for broker volume limits/step.");
      return false;
   }

   double ask = 0.0, bid = 0.0, point = 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_ASK, ask)) return false;
   if(!SymbolInfoDouble(g_sym, SYMBOL_BID, bid)) return false;
   if(!SymbolInfoDouble(g_sym, SYMBOL_POINT, point)) return false;
   if(ask <= 0.0 || bid <= 0.0 || point <= 0.0) return false;

   double entry = (direction > 0 ? ask : bid);
   double sl    = NormPrice(slPrice);
   double dist  = AbsV(entry - sl);
   if(dist < InpMinStopPriceUnits)
   {
      PrintFormat("Order skipped: SL distance %.2f below minimum %.2f.",
                  dist, InpMinStopPriceUnits);
      return false;
   }
   if(InpMaxStopPriceUnits > 0.0 && dist > InpMaxStopPriceUnits)
   {
      PrintFormat("Order skipped: SL distance %.2f above maximum %.2f.",
                  dist, InpMaxStopPriceUnits);
      return false;
   }

   // TP measured from the REAL entry price, not from refMid.
   double tp = (direction > 0 ? entry + InpRewardRisk * dist
                              : entry - InpRewardRisk * dist);
   tp = NormPrice(tp);

   long stopsLevel = SymbolInfoInteger(g_sym, SYMBOL_TRADE_STOPS_LEVEL);
   if(stopsLevel > 0 && dist < (double)stopsLevel * point)
   {
      Print("Order skipped: broker stops level exceeds SL distance.");
      return false;
   }

   long fillFlags = SymbolInfoInteger(g_sym, SYMBOL_FILLING_MODE);
   ENUM_ORDER_TYPE_FILLING filling;
   if((fillFlags & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC)      filling = ORDER_FILLING_IOC;
   else if((fillFlags & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) filling = ORDER_FILLING_FOK;
   else
   {
      Print("Order skipped: no IOC/FOK filling mode reported.");
      return false;
   }

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);
   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = g_sym;
   req.magic        = InpMagic;
   req.volume       = lots;
   req.type         = (direction > 0 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
   req.price        = NormPrice(entry);
   req.sl           = sl;
   req.tp           = tp;
   req.deviation    = (ulong)InpDeviationPoints;
   req.type_filling = filling;
   req.type_time    = ORDER_TIME_GTC;
   req.comment      = tag;

   bool sent = OrderSend(req, res);
   if(!sent || (res.retcode != TRADE_RETCODE_DONE &&
                res.retcode != TRADE_RETCODE_PLACED &&
                res.retcode != TRADE_RETCODE_DONE_PARTIAL))
   {
      PrintFormat("Order failed: sent=%s retcode=%u comment=%s",
                  (sent ? "true" : "false"), res.retcode, res.comment);
      return false;
   }

   PrintFormat("Anna %s opened. lots=%.2f entry=%.2f SL=%.2f TP=%.2f (risk=%.2f price units, %.2fR)",
               tag, lots, req.price, sl, tp, dist, InpRewardRisk);
   return true;
}

//=========================== REFERENCE CANDLE ======================
// Build H1 reference candle for the NY 10:00 bar of the current day.
bool BuildReference()
{
   MqlRates h1[];
   ArraySetAsSeries(h1, true);
   if(CopyRates(g_sym, PERIOD_H1, 0, 120, h1) < 30) return false;

   int idx = -1;
   for(int i = 1; i < ArraySize(h1); i++)
   {
      if(NyHour(h1[i].time) == InpNyOpenHour)
      {
         idx = i;
         break;
      }
   }
   if(idx < 0) return false;

   datetime refTime = h1[idx].time;
   if(refTime == g_refTime) return true;   // already built

   // Reset state for the new reference candle.
   g_refTime     = refTime;
   g_dayStamp    = DayStart(refTime);
   g_refHigh     = h1[idx].high;
   g_refLow      = h1[idx].low;
   g_refOpen     = h1[idx].open;
   g_refClose    = h1[idx].close;
   g_refMid      = (g_refHigh + g_refLow) / 2.0;
   g_refValid    = true;

   // Inside Bar: if the 10:00 candle is inside the previous H1 candle,
   // the mother bar becomes the reference.
   if(InpUseInsideBar && idx + 1 < ArraySize(h1))
   {
      MqlRates prev = h1[idx + 1];
      bool inside = (g_refHigh <= prev.high && g_refLow >= prev.low);
      if(inside)
      {
         g_refHigh  = prev.high;
         g_refLow   = prev.low;
         g_refOpen  = prev.open;
         g_refClose = prev.close;
         g_refMid   = (g_refHigh + g_refLow) / 2.0;
         PrintFormat("Inside Bar detected at %s -> mother bar used as reference (H=%.2f L=%.2f)",
                     TimeToString(refTime, TIME_DATE|TIME_MINUTES), g_refHigh, g_refLow);
      }
   }

   g_scenAActive = InpEnableScenarioA;
   g_scenBActive = InpEnableScenarioB;
   g_biasA       = 0;
   g_scenBDir    = 0;
   g_fvgBroken   = false;
   g_fvgRetested = false;
   g_fvgHigh     = 0.0;
   g_fvgLow      = 0.0;
   g_extreme     = 0.0;
   g_attempts    = 0;
   return true;
}

bool SetupExpired(const datetime now)
{
   if(!g_refValid) return true;
   if(now - g_refTime > (datetime)(InpSetupValidHours * 3600)) return true;
   if(NyHour(now) >= InpTradeEndHourNy) return true;
   return false;
}

//=========================== SCENARIO A ============================
// Body breakout beyond the reference candle -> entry at 50% midline.
void CheckScenarioA()
{
   if(!g_scenAActive || !g_refValid) return;

   MqlRates h1[];
   ArraySetAsSeries(h1, true);
   if(CopyRates(g_sym, PERIOD_H1, 0, 3, h1) < 3) return;

   MqlRates c = h1[1];                    // last closed H1 bar
   if(c.time <= g_refTime) return;        // must be after the reference candle

   double tick = TickSize();
   if(tick <= 0.0) return;

   int dir = 0;
   if(c.close > g_refHigh && c.close > c.open)      dir = 1;
   else if(c.close < g_refLow && c.close < c.open)  dir = -1;
   if(dir == 0) return;

   g_scenAActive = false;                 // one attempt for scenario A
   g_biasA       = dir;

   // Entry at the 50% midpoint of the reference candle.
   double entry = g_refMid;
   double sl    = (dir > 0 ? g_refLow - tick - InpBufferPriceUnits
                           : g_refHigh + tick + InpBufferPriceUnits);

   // Sanity: price must actually be on the breakout side of the midline.
   double bid = 0.0, ask = 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_BID, bid)) return;
   if(!SymbolInfoDouble(g_sym, SYMBOL_ASK, ask)) return;
   if(dir > 0 && ask < entry) return;
   if(dir < 0 && bid > entry) return;

   if(OpenTrade(dir, sl, (dir > 0 ? "Anna A long" : "Anna A short")))
      g_lastTradeDay = g_dayStamp;
   else
      Print("Scenario A signal present but order was not opened.");
}

//=========================== SCENARIO B ============================
// Detect the newest M5 FVG in the breakout direction.
bool FindFvg(const int dir, double &fvgHigh, double &fvgLow)
{
   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   int need = InpFvgLookbackBars + 3;
   if(CopyRates(g_sym, PERIOD_M5, 0, need, m5) < need) return false;

   // FVG: bar[i] and bar[i+2] gap; middle bar i+1 is the displacement candle.
   for(int i = 1; i < InpFvgLookbackBars; i++)
   {
      double lo = m5[i + 2].low;
      double hi = m5[i + 2].high;
      // Bullish FVG: low of newer bar above high of older bar
      if(dir > 0)
      {
         if(m5[i].low > m5[i + 2].high)
         {
            double gapLow  = m5[i + 2].high;
            double gapHigh = m5[i].low;
            if(gapHigh - gapLow < InpFvgMinSize) continue;
            fvgLow  = gapLow;
            fvgHigh = gapHigh;
            return true;
         }
      }
      else
      {
         if(m5[i].high < m5[i + 2].low)
         {
            double gapHigh = m5[i + 2].low;
            double gapLow  = m5[i].high;
            if(gapHigh - gapLow < InpFvgMinSize) continue;
            fvgLow  = gapLow;
            fvgHigh = gapHigh;
            return true;
         }
      }
      if(lo == 0.0 && hi == 0.0) break;
   }
   return false;
}

bool IsPinBar(const MqlRates &b, const int dir)
{
   double body = AbsV(b.close - b.open);
   double range = b.high - b.low;
   if(range <= 0.0) return false;

   double upperWick = b.high - MathMax(b.open, b.close);
   double lowerWick = MathMin(b.open, b.close) - b.low;
   double minBody   = range * 0.05;

   if(dir > 0)
   {
      // Bullish pin: long lower wick, small body near the top.
      if(body < minBody) body = minBody;
      if(lowerWick < InpPinBarWickRatio * body) return false;
      if(upperWick > lowerWick) return false;
      return true;
   }
   else
   {
      if(body < minBody) body = minBody;
      if(upperWick < InpPinBarWickRatio * body) return false;
      if(lowerWick > upperWick) return false;
      return true;
   }
}

double LocalSwingLow(const MqlRates &m5[], const int centerIdx)
{
   double low = m5[centerIdx].low;
   for(int k = centerIdx - InpSwingLookback; k <= centerIdx + InpSwingLookback; k++)
   {
      if(k < 0 || k >= ArraySize(m5)) continue;
      if(m5[k].low < low) low = m5[k].low;
   }
   return low;
}

double LocalSwingHigh(const MqlRates &m5[], const int centerIdx)
{
   double high = m5[centerIdx].high;
   for(int k = centerIdx - InpSwingLookback; k <= centerIdx + InpSwingLookback; k++)
   {
      if(k < 0 || k >= ArraySize(m5)) continue;
      if(m5[k].high > high) high = m5[k].high;
   }
   return high;
}

void CheckScenarioB()
{
   if(!g_scenBActive || !g_refValid) return;

   MqlRates m5[];
   ArraySetAsSeries(m5, true);
   int need = InpFvgLookbackBars + 10;
   if(CopyRates(g_sym, PERIOD_M5, 0, need, m5) < need) return;

   MqlRates last = m5[1];                 // last closed M5 bar
   if(last.time <= g_refTime) return;

   double tick = TickSize();
   if(tick <= 0.0) return;

   // --- Phase 1: wick breakout of the reference candle ---
   if(g_scenBDir == 0)
   {
      // Only a wick-based breakout (body breakout belongs to scenario A).
      if(last.high > g_refHigh && last.close <= g_refHigh && last.close < last.open)
         g_scenBDir = -1;
      else if(last.low < g_refLow && last.close >= g_refLow && last.close > last.open)
         g_scenBDir = 1;
      else
         return;

      if(!FindFvg(g_scenBDir, g_fvgHigh, g_fvgLow))
      {
         Print("Scenario B: wick breakout without a valid M5 FVG - setup dropped.");
         g_scenBActive = false;
         g_scenBDir    = 0;
         return;
      }

      g_fvgBroken   = false;
      g_fvgRetested = false;
      g_extreme     = (g_scenBDir > 0 ? g_fvgLow : g_fvgHigh);
      PrintFormat("Scenario B armed: dir=%d FVG %.2f-%.2f",
                  g_scenBDir, g_fvgLow, g_fvgHigh);
      return;
   }

   // --- Phase 2: price must cross THROUGH the FVG ---
   if(!g_fvgBroken)
   {
      if(g_scenBDir > 0)
      {
         // Close fully above the FVG = crossed through it.
         if(last.close > g_fvgHigh + InpBufferPriceUnits)
         {
            g_fvgBroken = true;
            g_extreme   = last.high;
            Print("Scenario B: bullish FVG crossed, waiting for retest.");
         }
         // Invalidation: price closes back below the FVG.
         else if(last.close < g_fvgLow - InpBufferPriceUnits)
         {
            Print("Scenario B invalidated: price closed back below the FVG.");
            g_scenBActive = false;
            g_scenBDir    = 0;
         }
      }
      else
      {
         if(last.close < g_fvgLow - InpBufferPriceUnits)
         {
            g_fvgBroken = true;
            g_extreme   = last.low;
            Print("Scenario B: bearish FVG crossed, waiting for retest.");
         }
         else if(last.close > g_fvgHigh + InpBufferPriceUnits)
         {
            Print("Scenario B invalidated: price closed back above the FVG.");
            g_scenBActive = false;
            g_scenBDir    = 0;
         }
      }
      return;
   }

   // --- Phase 3: return to the broken FVG (retest) ---
   if(!g_fvgRetested)
   {
      bool touched = (last.low <= g_fvgHigh && last.high >= g_fvgLow);
      if(touched)
      {
         g_fvgRetested = true;
         Print("Scenario B: price returned to the broken FVG - awaiting pin bar.");
      }
      // Track the extreme for invalidation.
      if(g_scenBDir > 0 && last.high > g_extreme) g_extreme = last.high;
      if(g_scenBDir < 0 && last.low  < g_extreme) g_extreme = last.low;
      return;
   }

   // --- Phase 4: pin bar + body close confirmation ---
   if(!IsPinBar(last, g_scenBDir)) return;

   bool bodyConfirm = (g_scenBDir > 0 ? last.close > last.open
                                      : last.close < last.open);
   if(!bodyConfirm) return;

   double sl = 0.0;
   if(g_scenBDir > 0)
      sl = LocalSwingLow(m5, 1) - InpBufferPriceUnits - tick;
   else
      sl = LocalSwingHigh(m5, 1) + InpBufferPriceUnits + tick;

   // Entry price must be on the correct side of the FVG retest.
   double bid = 0.0, ask = 0.0;
   if(!SymbolInfoDouble(g_sym, SYMBOL_BID, bid)) return;
   if(!SymbolInfoDouble(g_sym, SYMBOL_ASK, ask)) return;
   if(g_scenBDir > 0 && ask < g_fvgLow) return;
   if(g_scenBDir < 0 && bid > g_fvgHigh) return;

   g_attempts++;
   if(OpenTrade(g_scenBDir, sl, (g_scenBDir > 0 ? "Anna B long" : "Anna B short")))
   {
      g_lastTradeDay = g_dayStamp;
      g_scenBActive  = false;
   }
   else if(g_attempts >= InpMaxEntryAttempts)
   {
      Print("Scenario B: max entry attempts reached - setup dropped.");
      g_scenBActive = false;
   }
}

//=========================== LIFECYCLE =============================
int OnInit()
{
   g_sym = (InpSymbol == "" ? _Symbol : InpSymbol);

   if(InpLots <= 0.0 || InpRewardRisk <= 0.0 ||
      InpFvgLookbackBars < 5 || InpSwingLookback < 1 ||
      InpPinBarWickRatio <= 0.0 || InpSetupValidHours <= 0)
      return INIT_PARAMETERS_INCORRECT;

   if(!SymbolSelect(g_sym, true))
   {
      Print("Cannot select symbol: ", g_sym);
      return INIT_FAILED;
   }

   g_atrHandle = iATR(g_sym, PERIOD_H1, 14);
   if(g_atrHandle == INVALID_HANDLE)
   {
      Print("Could not create ATR handle.");
      return INIT_FAILED;
   }

   g_lastH1Bar = iTime(g_sym, PERIOD_H1, 0);
   g_lastM5Bar = iTime(g_sym, PERIOD_M5, 0);

   PrintFormat("AnnaBot v1.10 started on %s. NY ref hour=%d, server->NY offset=%d, lots=%.2f",
               g_sym, InpNyOpenHour, InpServerToNyOffset, InpLots);
   Print("Attach to any chart; logic runs on H1 + M5 data of the configured symbol.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(g_atrHandle != INVALID_HANDLE) IndicatorRelease(g_atrHandle);
}

void OnTick()
{
   // ---- H1 layer: reference candle ----
   datetime h1Time = iTime(g_sym, PERIOD_H1, 0);
   if(h1Time > 0 && h1Time != g_lastH1Bar)
   {
      g_lastH1Bar = h1Time;
      BuildReference();
   }
   else if(!g_refValid)
   {
      BuildReference();
   }

   if(!g_refValid) return;

   datetime now = TimeCurrent();
   if(SetupExpired(now))
   {
      if(g_scenAActive || g_scenBActive)
         Print("Setup window closed for the current reference candle.");
      g_scenAActive = false;
      g_scenBActive = false;
      return;
   }

   if(HasOurPosition()) return;
   if(InpOneTradePerDay && g_lastTradeDay == g_dayStamp) return;

   // ---- H1 layer: scenario A (body breakout) ----
   CheckScenarioA();

   // ---- M5 layer: scenario B (FVG retest + pin bar) ----
   datetime m5Time = iTime(g_sym, PERIOD_M5, 0);
   if(m5Time > 0 && m5Time != g_lastM5Bar)
   {
      g_lastM5Bar = m5Time;
      if(!HasOurPosition() && !(InpOneTradePerDay && g_lastTradeDay == g_dayStamp))
         CheckScenarioB();
   }
}
//+------------------------------------------------------------------+

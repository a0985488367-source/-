//+------------------------------------------------------------------+
//| MT5_SymbolProbe.mq5 — 目標券商 XAUUSD 商品規格探針                 |
//|                                                                  |
//| 開發第一步：先在目標帳戶跑這支，取得 volumeMin / volumeStep /      |
//| contractSize / tickValue / stopsLevel，並判定該帳戶在指定風險下    |
//| 能否下出合法手數。                                                |
//|                                                                  |
//| 注意：這裡用 MT5 內建 iATR 估算停損距離，它是 True Range 的「簡單  |
//| 平均」，與 EA / 研究程式使用的 Wilder 平滑（ewm alpha=1/14）不同，  |
//| 數值會有幾個百分點的差異。本探針的用途是回報券商規格與粒度是否可行， |
//| 不是重現策略訊號；實際每筆訊號的風險檢查由 EA 內的                 |
//| OS_CalcRiskVolumeEx 依當下真實停損距離執行。                       |
//+------------------------------------------------------------------+
#property strict
#property script_show_inputs

input string InpSymbol = "";
input double InpEquityOverride = 60.0;   // 0 = use live account equity
input double InpRiskPct = 6.0;
input ENUM_TIMEFRAMES InpATRTimeframe = PERIOD_M15;
input int InpATRPeriod = 14;
input double InpStopATR = 2.0;

int VolumeDigits(double step)
{
   int d=0;
   while(d<8 && MathAbs(step*MathPow(10,d)-MathRound(step*MathPow(10,d)))>1e-9) d++;
   return d;
}

double FloorVolume(string symbol,double raw)
{
   double step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   double vmin=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double vmax=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   if(step<=0.0) return 0.0;
   double v=MathFloor((raw+1e-12)/step)*step;
   v=MathMin(v,vmax);
   if(v+1e-12<vmin) return 0.0;
   return NormalizeDouble(v,VolumeDigits(step));
}

void OnStart()
{
   string symbol=(InpSymbol=="" ? _Symbol : InpSymbol);
   if(!SymbolSelect(symbol,true)) { Print("FAIL: cannot select symbol ",symbol); return; }
   MqlTick t;
   if(!SymbolInfoTick(symbol,t)) { Print("FAIL: no tick for ",symbol); return; }

   double equity=(InpEquityOverride>0.0 ? InpEquityOverride : AccountInfoDouble(ACCOUNT_EQUITY));
   double risk_money=equity*InpRiskPct/100.0;
   int h=iATR(symbol,InpATRTimeframe,InpATRPeriod);
   if(h==INVALID_HANDLE) { Print("FAIL: iATR handle"); return; }
   double a[1];
   if(CopyBuffer(h,0,1,1,a)!=1 || a[0]<=0.0) { Print("FAIL: ATR unavailable"); IndicatorRelease(h); return; }
   IndicatorRelease(h);

   double stop_dist=InpStopATR*a[0];
   double entry=t.ask;
   double stop=entry-stop_dist;
   double pnl1=0.0;
   if(!OrderCalcProfit(ORDER_TYPE_BUY,symbol,1.0,entry,stop,pnl1))
   { Print("FAIL: OrderCalcProfit error ",GetLastError()); return; }
   double one_lot_loss=MathAbs(pnl1);
   double raw=(one_lot_loss>0.0 ? risk_money/one_lot_loss : 0.0);
   double vol=FloorVolume(symbol,raw);

   double vmin=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double vstep=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   double csize=SymbolInfoDouble(symbol,SYMBOL_TRADE_CONTRACT_SIZE);
   double ticksize=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);
   double tvloss=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_VALUE_LOSS);
   long stops=SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL);
   long freeze=SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL);
   double minloss=0.0;
   OrderCalcProfit(ORDER_TYPE_BUY,symbol,vmin,entry,stop,minloss);
   minloss=MathAbs(minloss);
   double margin=0.0;
   if(vol>0.0) OrderCalcMargin(ORDER_TYPE_BUY,symbol,vol,entry,margin);

   Print("=== ONE SHOT V2 SYMBOL PROBE ===");
   Print("symbol=",symbol," equity=",DoubleToString(equity,2)," riskMoney=",DoubleToString(risk_money,2));
   Print("contractSize=",csize," volumeMin=",vmin," volumeStep=",vstep," tickSize=",ticksize," tickValueLoss=",tvloss);
   Print("stopsLevel(points)=",stops," freezeLevel(points)=",freeze);
   Print("ATR=",a[0]," stopDistance=",stop_dist," 1lotStopLoss=",one_lot_loss);
   Print("rawVolume=",raw," executableVolume=",vol," minVolumeStopLoss=",minloss," marginForExecutableVolume=",margin);

   if(vol<=0.0)
      Print("RESULT=FAIL_RISK_GRANULARITY: minimum lot exceeds allowed ",InpRiskPct,"% risk. Do NOT force 0.01 lot.");
   else if(minloss>risk_money*1.0001)
      Print("RESULT=FAIL_MIN_LOT_RISK: min-lot stop loss exceeds risk budget.");
   else
      Print("RESULT=PASS_SIZE_GRANULARITY (margin/free-margin still must be checked by EA before each order)");
}

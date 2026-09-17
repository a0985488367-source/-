//+------------------------------------------------------------------+
//| RiskSizing.mqh — ONE SHOT V2 風險倉位計算                          |
//|                                                                  |
//| 硬性規則（來自 修正版_未解決點處理報告.md）：                        |
//|  - 倉位必須以 OrderCalcProfit 依券商真實商品規格計算，              |
//|    不得硬寫 contract size，也不得假設 0.01 lot 一定可用。           |
//|  - 四捨五入後的實際風險不得超過風險預算；超過就跳過該筆訊號。        |
//|  - 最小手數若超過風險預算，回傳失敗，由 EA 記錄 SKIP 而非強制下單。  |
//+------------------------------------------------------------------+
#ifndef __ONE_SHOT_RISK_SIZING_MQH__
#define __ONE_SHOT_RISK_SIZING_MQH__

//--- 完整計算結果，供 EA 寫入日誌（交接文件第 7 點要求的欄位）
struct OS_SizingResult
{
   double volume;          // 實際可下單手數；0 = 不可下單
   double raw_volume;      // 未經 step 取整的理論手數
   double min_volume;      // 券商最小手數
   double volume_step;     // 手數級距
   double one_lot_loss;    // 1 lot 打到停損的虧損（帳戶貨幣）
   double min_lot_loss;    // 最小手數打到停損的虧損（帳戶貨幣）
   double actual_risk;     // 取整後實際風險（帳戶貨幣）
   double margin;          // 該手數所需保證金
   double free_margin;     // 目前可用保證金
   string reason;          // 失敗原因；成功時為空字串
};

void OS_ResetSizing(OS_SizingResult &r)
{
   r.volume=0.0; r.raw_volume=0.0; r.min_volume=0.0; r.volume_step=0.0;
   r.one_lot_loss=0.0; r.min_lot_loss=0.0; r.actual_risk=0.0;
   r.margin=0.0; r.free_margin=0.0; r.reason="";
}

int OS_VolumeDigits(double step)
{
   int d=0;
   while(d<8 && MathAbs(step*MathPow(10,d)-MathRound(step*MathPow(10,d)))>1e-9) d++;
   return d;
}

double OS_FloorVolume(const string symbol,const double raw)
{
   double step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   double vmin=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double vmax=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   if(step<=0.0 || raw<=0.0) return 0.0;
   double v=MathFloor((raw+1e-12)/step)*step;
   v=MathMin(v,vmax);
   if(v+1e-12<vmin) return 0.0;
   return NormalizeDouble(v,OS_VolumeDigits(step));
}

//+------------------------------------------------------------------+
//| 詳細版：回傳所有中間值，失敗時 reason 說明原因                      |
//+------------------------------------------------------------------+
bool OS_CalcRiskVolumeEx(const string symbol,
                         const ENUM_ORDER_TYPE type,
                         const double entry,
                         const double stop,
                         const double risk_money,
                         const double max_margin_fraction,
                         OS_SizingResult &out)
{
   OS_ResetSizing(out);
   out.min_volume  = SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   out.volume_step = SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   out.free_margin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);

   if(risk_money<=0.0 || entry<=0.0 || stop<=0.0 || entry==stop)
   { out.reason="invalid inputs"; return false; }

   double pnl1=0.0;
   if(!OrderCalcProfit(type,symbol,1.0,entry,stop,pnl1))
   { out.reason=StringFormat("OrderCalcProfit failed (err=%d)",GetLastError()); return false; }
   out.one_lot_loss=MathAbs(pnl1);
   if(out.one_lot_loss<=0.0) { out.reason="zero one-lot stop loss"; return false; }

   //--- 最小手數的風險，用於診斷「商品粒度太粗」
   double minloss=0.0;
   if(out.min_volume>0.0 && OrderCalcProfit(type,symbol,out.min_volume,entry,stop,minloss))
      out.min_lot_loss=MathAbs(minloss);

   out.raw_volume=risk_money/out.one_lot_loss;
   double v=OS_FloorVolume(symbol,out.raw_volume);
   if(v<=0.0)
   {
      out.reason=StringFormat("min lot/step too coarse: minLotLoss=%.4f > riskBudget=%.4f",
                              out.min_lot_loss,risk_money);
      return false;
   }

   double actual=0.0;
   if(!OrderCalcProfit(type,symbol,v,entry,stop,actual))
   { out.reason=StringFormat("OrderCalcProfit(actual) failed (err=%d)",GetLastError()); return false; }
   out.actual_risk=MathAbs(actual);
   if(out.actual_risk>risk_money*1.0001)
   {
      out.reason=StringFormat("rounded volume risk %.4f exceeds budget %.4f",out.actual_risk,risk_money);
      return false;
   }

   if(!OrderCalcMargin(type,symbol,v,entry,out.margin))
   { out.reason=StringFormat("OrderCalcMargin failed (err=%d)",GetLastError()); return false; }
   if(max_margin_fraction>0.0 && out.margin>out.free_margin*max_margin_fraction)
   {
      out.reason=StringFormat("margin %.2f exceeds %.0f%% of free margin %.2f",
                              out.margin,max_margin_fraction*100.0,out.free_margin);
      return false;
   }

   out.volume=v;
   return true;
}

//+------------------------------------------------------------------+
//| 相容舊介面                                                        |
//+------------------------------------------------------------------+
bool OS_CalcRiskVolume(const string symbol,
                       const ENUM_ORDER_TYPE type,
                       const double entry,
                       const double stop,
                       const double risk_money,
                       const double max_margin_fraction,
                       double &volume,
                       string &reason)
{
   OS_SizingResult r;
   bool ok=OS_CalcRiskVolumeEx(symbol,type,entry,stop,risk_money,max_margin_fraction,r);
   volume=r.volume; reason=r.reason;
   return ok;
}

#endif

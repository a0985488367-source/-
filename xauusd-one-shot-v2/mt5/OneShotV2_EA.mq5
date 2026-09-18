//+------------------------------------------------------------------+
//|                    XAUUSD ONE SHOT V2 — Expert Advisor            |
//|                                                                  |
//| 本 EA 嚴格實作 research/修正版_未解決點處理報告.md 所凍結的規則：    |
//|                                                                  |
//|  Entry（M15 收盤判定，下一根 M5 開盤進場）                          |
//|    H4 : (EMA50-EMA200)/ATR14 >  1.00 做多 ; < -1.00 做空           |
//|    H1 : (EMA20-EMA50 )/ATR14 >  0.25 做多 ; < -0.25 做空           |
//|    M15: pos32 > 0.70 做多 ; < 0.30 做空                            |
//|    M15: body = (close-open)/ATR14 > 0.30 做多 ; < -0.30 做空        |
//|    M15: ATR / 前 50 根 ATR 均值 介於 0.8 ~ 1.8                      |
//|    只在 UTC 12:00~21:59 接受訊號                                   |
//|    一次只持有一個部位，不重疊                                       |
//|                                                                  |
//|  Exit                                                            |
//|    初始停損 = 2 x M15 ATR ; TP = 5R                                |
//|    M5 收盤確認浮盈 >= +1.5R 後，「下一根」才把停損移到進場價         |
//|    + InpBreakevenOffsetR（預設 0.10R）。移到剛好進場價會讓這些單    |
//|    子以 -0.01R 出場而被計為虧損；設 0 即還原為原始凍結版。          |
//|    真 48 個「曆時」小時逾時（不是 576 根 M5），到期後第一個可取得    |
//|    報價出場                                                       |
//|                                                                  |
//|  倉位                                                            |
//|    一律用 OrderCalcProfit 依券商真實商品規格計算                    |
//|    算不出合法手數 → 記錄 SKIP_MIN_VOLUME_RISK，不下單               |
//|    禁止 Martingale、禁止虧損加倉、禁止強制抬到 0.01 lot             |
//|                                                                  |
//| 預設為「翻身模式」：單筆風險 10%，權益碰到 10000U 後自動降到 2%。    |
//| 60U 起始的自助法實測：達標率 45.1%，但有 31.3% 的路徑會掉到 20U      |
//| 以下。想要保守得多的走法，把 InpRiskPct 設 5、InpTargetEquity 設     |
//| 1000——達標率 75.1%，掉到 20U 以下只有 3.8%。                        |
//|                                                                  |
//| 注意：策略尚未通過真實 Bid/Ask external holdout，請先跑             |
//|       Strategy Tester / Demo，不要直接接真實資金。                  |
//+------------------------------------------------------------------+
#property copyright "XAUUSD ONE SHOT V2"
#property link      ""
#property version   "2.00"
#property strict

#include <Trade/Trade.mqh>
#include "RiskSizing.mqh"

//--- 商品 / 身分
input group             "=== 商品與身分 ==="
input string            InpSymbol              = "";        // 交易商品（空白 = 當前圖表）
input ulong             InpMagic               = 20260917;  // Magic number

//--- 凍結的進場參數（除非重新做完整驗證，否則不要動）
input group             "=== 凍結 Entry 參數 ==="
input double            InpH4MacroMin          = 1.00;      // H4 (EMA50-EMA200)/ATR 門檻
input double            InpH1TrendMin          = 0.25;      // H1 (EMA20-EMA50)/ATR 門檻
input double            InpPos32Long           = 0.70;      // M15 32 根區間位置（多）
input double            InpPos32Short          = 0.30;      // M15 32 根區間位置（空）
input double            InpBodyMin             = 0.30;      // M15 實體/ATR 門檻
input double            InpAtrRelLo            = 0.80;      // ATR 相對前 50 根均值 下限
input double            InpAtrRelHi            = 1.80;      // ATR 相對前 50 根均值 上限
input int               InpHourFromUTC         = 12;        // 允許訊號起始小時（UTC，含）
input int               InpHourToUTC           = 21;        // 允許訊號結束小時（UTC，含）

//--- 凍結的出場參數
input group             "=== 凍結 Exit 參數 ==="
input double            InpStopATRMult         = 2.00;      // 初始停損 = N x M15 ATR
input double            InpTakeProfitR         = 5.00;      // 目標（R）
input double            InpBreakevenR          = 1.50;      // 觸發保本的浮盈（R，收盤確認）
input double            InpBreakevenOffsetR    = 0.00;      // 保本停損墊高幅度（R）；0 = 剛好進場價（原始凍結版）
input int               InpMaxHoldHours        = 48;        // 最長持有（真曆時小時）

//--- 風險
input group             "=== 風險與倉位 ==="
input double            InpRiskPct             = 10.0;      // 單筆名義風險（% 權益）；翻身模式實測最佳點
input double            InpMaxMarginFraction   = 0.50;      // 保證金上限（可用保證金比例）
input int               InpSlippagePoints      = 50;        // 允許滑點（point）

//--- 翻身模式：高風險衝到目標，達標後自動降風險
//    2000~4000 條自助法路徑（60U 起始、目標 10000U、達標即停）實測：
//      風險  5% -> 達標 20.2%，掉到<20U  3.8%
//      風險 10% -> 達標 45.1%，掉到<20U 31.3%   <-- 最高點
//      風險 15% -> 達標 30.3%，掉到<20U 62.2%
//      風險 30% -> 達標  5.6%，掉到<20U 94.4%
//    超過 10% 之後倉位放大殺死帳戶的速度比複利更快。歷史最糟單筆 -2.60R
//    （跳空穿過停損），單筆風險超過 38.5% 時那一筆會直接打穿本金。
input group             "=== 翻身模式（達標後自動降風險） ==="
input double            InpTargetEquity        = 10000.0;   // 目標權益（U）；0 = 停用
input double            InpPostTargetRiskPct   = 2.0;       // 達標後的單筆風險（%）；0 = 完全停止交易

//--- 里程碑鎖底（研究報告的資金模型；實測反而拉低達標率，預設關閉）
//    同樣 60U/目標 10000U，10% 風險下：鎖底達標 8.8% vs 固定比例 45.1%。
//    底線會變成吸收壁——權益貼近底線時 (權益-底線)/1.15 趨近 0，倉位縮到
//    無法交易，路徑就卡在底線上。
input group             "=== 里程碑鎖底 ratchet（不建議，預設關閉） ==="
input bool              InpUseRatchet          = false;     // 啟用里程碑鎖底
input double            InpRatchetFloor0       = 20.0;      // 初始底線（U）
input double            InpRatchetBuffer       = 1.15;      // 成本/超額虧損緩衝係數

//--- 環境
input group             "=== 環境與日誌 ==="
input double            InpServerUTCOffsetHrs  = -99.0;     // 伺服器時間-UTC 時差（-99 = 自動偵測）
input int               InpH1Bars              = 2000;      // H1 載入根數（H1 趨勢用）
input int               InpH1BarsForH4         = 8000;      // H1 載入根數（聚合 H4，EMA200 暖機）
input int               InpM15Bars             = 1500;      // M15 載入根數
input bool              InpLogRejects          = false;     // 連未成立的訊號也寫入日誌
input string            InpLogFile             = "OneShotV2_log.csv"; // 日誌檔名（MQL5/Files）

//+------------------------------------------------------------------+
//| 全域狀態                                                          |
//+------------------------------------------------------------------+
CTrade   g_trade;
string   g_symbol       = "";
int      g_digits       = 2;
double   g_point        = 0.01;
int      g_utc_off_sec  = 0;

datetime g_last_m5      = 0;
datetime g_last_m15     = 0;
datetime g_last_exit_bar= 0;

//--- 目前持倉
bool     g_has_pos      = false;
ulong    g_pos_id       = 0;
int      g_side         = 0;
double   g_entry        = 0.0;
double   g_dist         = 0.0;
double   g_risk_money   = 0.0;
double   g_volume       = 0.0;
datetime g_entry_bar    = 0;
datetime g_deadline     = 0;
datetime g_signal_time  = 0;
double   g_peak_r       = 0.0;
bool     g_be_done      = false;
datetime g_be_time      = 0;

//--- ratchet
double   g_floor        = 0.0;
bool     g_ratchet_done = false;

//--- 翻身模式：達標後閂住，權益之後回落也不再切回高風險
bool     g_target_hit   = false;

//+------------------------------------------------------------------+
//| 訊號                                                              |
//+------------------------------------------------------------------+
struct OS_Signal
{
   int      side;
   double   atr;
   datetime bar_time;
   datetime close_time;
   double   h4_macro;
   double   h1_trend;
   double   pos32;
   double   body;
   double   atrrel;
   int      utc_hour;
   string   note;
};

//+------------------------------------------------------------------+
//| 日誌列                                                            |
//+------------------------------------------------------------------+
struct OS_LogRow
{
   string   event;
   datetime signal_utc;
   int      side;
   datetime entry_bar;
   double   entry_price;
   double   stop_price;
   double   tp_price;
   double   stop_dist;
   double   risk_money;
   double   raw_volume;
   double   volume;
   double   min_volume;
   double   volume_step;
   double   one_lot_loss;
   double   min_lot_loss;
   double   actual_risk;
   double   margin;
   double   free_margin;
   string   skip_reason;
   datetime be_time;
   datetime deadline_utc;
   datetime exit_time;
   string   exit_reason;
   double   net_pnl;
   double   r_price;
   double   r_money;
   double   equity;
   double   h4_macro;
   double   h1_trend;
   double   pos32;
   double   body;
   double   atrrel;
   int      utc_hour;
};

void OS_ClearLog(OS_LogRow &r)
{
   r.event=""; r.signal_utc=0; r.side=0; r.entry_bar=0;
   r.entry_price=0; r.stop_price=0; r.tp_price=0; r.stop_dist=0;
   r.risk_money=0; r.raw_volume=0; r.volume=0; r.min_volume=0; r.volume_step=0;
   r.one_lot_loss=0; r.min_lot_loss=0; r.actual_risk=0; r.margin=0; r.free_margin=0;
   r.skip_reason=""; r.be_time=0; r.deadline_utc=0; r.exit_time=0; r.exit_reason="";
   r.net_pnl=0; r.r_price=0; r.r_money=0; r.equity=0;
   r.h4_macro=0; r.h1_trend=0; r.pos32=0; r.body=0; r.atrrel=0; r.utc_hour=-1;
}

//+------------------------------------------------------------------+
//| 時間：伺服器 <-> UTC                                              |
//+------------------------------------------------------------------+
void RefreshUTCOffset()
{
   if(InpServerUTCOffsetHrs>-90.0)
   { g_utc_off_sec=(int)MathRound(InpServerUTCOffsetHrs*3600.0); return; }
   long diff=(long)TimeTradeServer()-(long)TimeGMT();
   //--- 券商時差一律是 30 分鐘的倍數；四捨五入可吸收 GMT 取樣誤差，並自動跟隨夏令時
   g_utc_off_sec=(int)(MathRound((double)diff/1800.0)*1800.0);
}

datetime ServerToUTC(const datetime t) { return (datetime)((long)t-(long)g_utc_off_sec); }

string FmtUTC(const datetime server_t)
{
   if(server_t==0) return "";
   return TimeToString(ServerToUTC(server_t),TIME_DATE|TIME_MINUTES|TIME_SECONDS);
}

//+------------------------------------------------------------------+
//| 日誌                                                              |
//+------------------------------------------------------------------+
void EnsureLogHeader()
{
   if(InpLogFile=="") return;
   if(FileIsExist(InpLogFile)) return;
   int h=FileOpen(InpLogFile,FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h==INVALID_HANDLE) { Print("WARN: cannot create log file ",InpLogFile," err=",GetLastError()); return; }
   FileWriteString(h,
      "event,server_time,signal_time_utc,side,entry_bar_utc,entry_price,stop_price,tp_price,"
      "stop_distance,risk_money,raw_volume,rounded_volume,min_volume,volume_step,one_lot_loss,"
      "min_lot_loss,actual_risk,margin,free_margin,skip_reason,be_time_utc,deadline_utc,"
      "exit_time_utc,exit_reason,net_pnl,r_price,r_money,equity,"
      "h4_macro,h1_trend,pos32,body,atrrel,utc_hour\n");
   FileClose(h);
}

void WriteLog(OS_LogRow &r)
{
   if(InpLogFile=="") return;
   int h=FileOpen(InpLogFile,FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI);
   if(h==INVALID_HANDLE) { Print("WARN: cannot open log file err=",GetLastError()); return; }
   FileSeek(h,0,SEEK_END);
   string line=StringFormat(
      "%s,%s,%s,%d,%s,%s,%s,%s,%.5f,%.4f,%.6f,%.6f,%.6f,%.6f,%.4f,%.4f,%.4f,%.2f,%.2f,"
      "%s,%s,%s,%s,%s,%.4f,%.4f,%.4f,%.2f,%.4f,%.4f,%.4f,%.4f,%.4f,%d\n",
      r.event,
      TimeToString(TimeTradeServer(),TIME_DATE|TIME_MINUTES|TIME_SECONDS),
      FmtUTC(r.signal_utc), r.side, FmtUTC(r.entry_bar),
      DoubleToString(r.entry_price,g_digits),
      DoubleToString(r.stop_price,g_digits),
      DoubleToString(r.tp_price,g_digits),
      r.stop_dist, r.risk_money, r.raw_volume, r.volume, r.min_volume, r.volume_step,
      r.one_lot_loss, r.min_lot_loss, r.actual_risk, r.margin, r.free_margin,
      r.skip_reason, FmtUTC(r.be_time), FmtUTC(r.deadline_utc), FmtUTC(r.exit_time),
      r.exit_reason, r.net_pnl, r.r_price, r.r_money, r.equity,
      r.h4_macro, r.h1_trend, r.pos32, r.body, r.atrrel, r.utc_hour);
   FileWriteString(h,line);
   FileClose(h);
}

//+------------------------------------------------------------------+
//| 序列指標                                                          |
//|                                                                  |
//| 研究程式用 pandas ewm(alpha=1/14, adjust=False) 計算 ATR，         |
//| 也就是 Wilder 平滑（RMA）。MT5 內建 iATR 是 TR 的「簡單平均」，     |
//| 兩者數值不同，因此這裡自己算，確保與回測口徑一致。                  |
//+------------------------------------------------------------------+
bool SeriesATR(const MqlRates &rates[],const int n,const int period,double &atr[])
{
   if(n<2 || period<1) return false;
   if(ArrayResize(atr,n)!=n) return false;
   double alpha=1.0/(double)period;
   //--- tr[0] 沒有前收盤，與 pandas 一致取 high-low，並以它做遞迴種子
   double prev_atr=rates[0].high-rates[0].low;
   atr[0]=prev_atr;
   for(int i=1;i<n;i++)
   {
      double pc=rates[i-1].close;
      double tr=MathMax(rates[i].high-rates[i].low,
                MathMax(MathAbs(rates[i].high-pc),MathAbs(rates[i].low-pc)));
      prev_atr=prev_atr+alpha*(tr-prev_atr);
      atr[i]=prev_atr;
   }
   return true;
}

//--- 等同 pandas ewm(span=N, adjust=False)：alpha = 2/(N+1)，以第一根收盤為種子
bool SeriesEMA(const MqlRates &rates[],const int n,const int span,double &ema[])
{
   if(n<1 || span<1) return false;
   if(ArrayResize(ema,n)!=n) return false;
   double alpha=2.0/((double)span+1.0);
   double e=rates[0].close;
   ema[0]=e;
   for(int i=1;i<n;i++) { e=e+alpha*(rates[i].close-e); ema[i]=e; }
   return true;
}

//--- 只載入「已收盤」的 K 棒：start_pos=1 跳過目前正在形成的那根
int LoadClosedRates(const ENUM_TIMEFRAMES tf,const int count,MqlRates &out[])
{
   ArraySetAsSeries(out,false);
   int got=CopyRates(g_symbol,tf,1,count,out);
   return (got>0 ? got : 0);
}

//+------------------------------------------------------------------+
//| 由 H1 聚合出「以 UTC 00:00 為錨點」的 H4                            |
//|                                                                  |
//| 研究程式是對 UTC 序列做 resample('4h')，邊界固定落在 UTC          |
//| 00/04/08/12/16/20。MT5 內建的 H4 K 棒卻以「券商伺服器時間」午夜    |
//| 為錨點——券商若是 UTC+2/+3，整組邊界就位移，EMA50/EMA200 會是      |
//| 另一條序列。因此這裡用 H1 自行重組，維持與回測相同的邊界。         |
//| 回傳的 h4[].time 是該區塊起點的 UTC 時間。                         |
//+------------------------------------------------------------------+
int BuildH4FromH1(const MqlRates &h1[],const int n1,MqlRates &h4[])
{
   if(n1<=0) return 0;
   //--- 上限取 n1：週末與收盤造成的不完整區塊會讓區塊數超過 n1/4，
   //--- 估太小會在迴圈中截斷「最新」的區塊，h4_macro 就會取到過舊的值
   int cap=n1;
   if(ArrayResize(h4,cap)!=cap) return 0;
   int cnt=0;
   long cur=-1;
   for(int i=0;i<n1;i++)
   {
      long utc=(long)ServerToUTC(h1[i].time);
      if(utc<0) continue;
      long blk=(utc/14400)*14400;
      if(blk!=cur)
      {
         if(cnt>=cap) break;
         cur=blk;
         h4[cnt].time =(datetime)blk;
         h4[cnt].open =h1[i].open;
         h4[cnt].high =h1[i].high;
         h4[cnt].low  =h1[i].low;
         h4[cnt].close=h1[i].close;
         cnt++;
      }
      else
      {
         int k=cnt-1;
         if(h1[i].high>h4[k].high) h4[k].high=h1[i].high;
         if(h1[i].low <h4[k].low ) h4[k].low =h1[i].low;
         h4[k].close=h1[i].close;
      }
   }
   ArrayResize(h4,cnt);
   return cnt;
}

//+------------------------------------------------------------------+
//| (EMAfast - EMAslow) / ATR14，只使用「收盤時間 <= 決策時點」的 K 棒 |
//| 等同研究程式的 h.index += rule 之後 ffill 到 M15 收盤時點          |
//+------------------------------------------------------------------+
bool TrendValue(const MqlRates &r[],const int n,const int period_sec,
                const long decision_ts,const int fast_span,const int slow_span,
                const string tag,double &value,string &err)
{
   int last=-1;
   for(int i=n-1;i>=0;i--)
      if((long)r[i].time+(long)period_sec<=decision_ts) { last=i; break; }
   if(last<0) { err=tag+": no closed bar at decision time"; return false; }

   int m=last+1;
   int need=(int)MathMax(slow_span*5,300);
   if(m<need)
   { err=StringFormat("%s history too short: %d < %d bars",tag,m,need); return false; }

   double atr[],fast[],slow[];
   if(!SeriesATR(r,m,14,atr) || !SeriesEMA(r,m,fast_span,fast) || !SeriesEMA(r,m,slow_span,slow))
   { err=tag+": indicator alloc failed"; return false; }
   if(!(atr[last]>0.0)) { err=tag+": ATR not positive"; return false; }

   value=(fast[last]-slow[last])/atr[last];
   return true;
}

//+------------------------------------------------------------------+
//| 評估 M15 訊號                                                     |
//+------------------------------------------------------------------+
bool EvaluateSignal(OS_Signal &s)
{
   s.side=0; s.atr=0; s.bar_time=0; s.close_time=0;
   s.h4_macro=0; s.h1_trend=0; s.pos32=0; s.body=0; s.atrrel=0; s.utc_hour=-1; s.note="";

   string err="";

   MqlRates m[];
   int n=LoadClosedRates(PERIOD_M15,InpM15Bars,m);
   if(n<300) { s.note=StringFormat("M15 history too short: %d",n); return false; }

   double atr[];
   if(!SeriesATR(m,n,14,atr)) { s.note="M15 ATR alloc failed"; return false; }

   int k=n-1;                       // 剛收盤的 M15 訊號 K
   if(k-51<0) { s.note="M15 warmup insufficient"; return false; }
   if(!(atr[k]>0.0)) { s.note="M15 ATR not positive"; return false; }

   //--- pos32：訊號 K「之前」32 根的高低區間（對應 shift(1).rolling(32)）
   double lo32=m[k-1].low, hi32=m[k-1].high;
   for(int i=k-32;i<=k-1;i++)
   { if(m[i].low<lo32) lo32=m[i].low; if(m[i].high>hi32) hi32=m[i].high; }
   double range=hi32-lo32;
   if(range<=0.0) { s.note="degenerate 32-bar range"; return false; }

   //--- atrrel：訊號 K「之前」50 根 ATR 的均值（對應 atr.shift().rolling(50).mean()）
   double sum=0.0;
   for(int i=k-50;i<=k-1;i++) sum+=atr[i];
   double denom=sum/50.0;
   if(!(denom>0.0)) { s.note="degenerate ATR mean"; return false; }

   s.atr        = atr[k];
   s.bar_time   = m[k].time;
   s.close_time = (datetime)((long)m[k].time+(long)PeriodSeconds(PERIOD_M15));
   s.pos32      = (m[k].close-lo32)/range;
   s.body       = (m[k].close-m[k].open)/s.atr;
   s.atrrel     = s.atr/denom;
   s.utc_hour   = (int)(((long)ServerToUTC(s.close_time)/3600)%24);

   //--- 高週期偏向：決策時點固定為 M15 訊號 K 的收盤時間
   MqlRates h1[];
   int n1=LoadClosedRates(PERIOD_H1,InpH1Bars,h1);
   if(!TrendValue(h1,n1,3600,(long)s.close_time,20,50,"H1",s.h1_trend,err))
   { s.note=err; return false; }

   MqlRates h1src[],h4[];
   int nsrc=LoadClosedRates(PERIOD_H1,InpH1BarsForH4,h1src);
   int n4=BuildH4FromH1(h1src,nsrc,h4);
   if(!TrendValue(h4,n4,14400,(long)ServerToUTC(s.close_time),50,200,"H4",s.h4_macro,err))
   { s.note=err; return false; }

   bool session = (s.utc_hour>=InpHourFromUTC && s.utc_hour<=InpHourToUTC);
   bool vol_ok  = (s.atrrel>=InpAtrRelLo && s.atrrel<=InpAtrRelHi);

   bool longs  = (s.h4_macro> InpH4MacroMin) && (s.h1_trend> InpH1TrendMin)
              && (s.pos32  > InpPos32Long)   && (s.body    > InpBodyMin)
              && vol_ok && session;
   bool shorts = (s.h4_macro<-InpH4MacroMin) && (s.h1_trend<-InpH1TrendMin)
              && (s.pos32  < InpPos32Short)  && (s.body    <-InpBodyMin)
              && vol_ok && session;

   s.side = longs ? 1 : (shorts ? -1 : 0);
   return true;
}

//+------------------------------------------------------------------+
//| 狀態持久化（重啟 / 換圖後仍能接手既有持倉）                         |
//+------------------------------------------------------------------+
string GV(const string key) { return "OSV2_"+IntegerToString((long)InpMagic)+"_"+key; }

void SaveState()
{
   GlobalVariableSet(GV("has_pos"),      g_has_pos?1.0:0.0);
   GlobalVariableSet(GV("pos_id"),       (double)g_pos_id);
   GlobalVariableSet(GV("side"),         (double)g_side);
   GlobalVariableSet(GV("entry"),        g_entry);
   GlobalVariableSet(GV("dist"),         g_dist);
   GlobalVariableSet(GV("risk_money"),   g_risk_money);
   GlobalVariableSet(GV("volume"),       g_volume);
   GlobalVariableSet(GV("entry_bar"),    (double)g_entry_bar);
   GlobalVariableSet(GV("deadline"),     (double)g_deadline);
   GlobalVariableSet(GV("signal_time"),  (double)g_signal_time);
   GlobalVariableSet(GV("peak_r"),       g_peak_r);
   GlobalVariableSet(GV("be_done"),      g_be_done?1.0:0.0);
   GlobalVariableSet(GV("be_time"),      (double)g_be_time);
   GlobalVariableSet(GV("last_exit"),    (double)g_last_exit_bar);
   GlobalVariableSet(GV("floor"),        g_floor);
   GlobalVariableSet(GV("ratchet_done"), g_ratchet_done?1.0:0.0);
   GlobalVariableSet(GV("target_hit"),   g_target_hit?1.0:0.0);
}

double GVGet(const string key,const double def)
{
   string name=GV(key);
   if(!GlobalVariableCheck(name)) return def;
   return GlobalVariableGet(name);
}

void LoadState()
{
   g_has_pos      = (GVGet("has_pos",0.0)>0.5);
   g_pos_id       = (ulong)GVGet("pos_id",0.0);
   g_side         = (int)GVGet("side",0.0);
   g_entry        = GVGet("entry",0.0);
   g_dist         = GVGet("dist",0.0);
   g_risk_money   = GVGet("risk_money",0.0);
   g_volume       = GVGet("volume",0.0);
   g_entry_bar    = (datetime)(long)GVGet("entry_bar",0.0);
   g_deadline     = (datetime)(long)GVGet("deadline",0.0);
   g_signal_time  = (datetime)(long)GVGet("signal_time",0.0);
   g_peak_r       = GVGet("peak_r",0.0);
   g_be_done      = (GVGet("be_done",0.0)>0.5);
   g_be_time      = (datetime)(long)GVGet("be_time",0.0);
   g_last_exit_bar= (datetime)(long)GVGet("last_exit",0.0);
   g_floor        = GVGet("floor",InpRatchetFloor0);
   g_ratchet_done = (GVGet("ratchet_done",0.0)>0.5);
   g_target_hit   = (GVGet("target_hit",0.0)>0.5);
}

void ClearPositionState()
{
   g_has_pos=false; g_pos_id=0; g_side=0; g_entry=0; g_dist=0;
   g_risk_money=0; g_volume=0; g_entry_bar=0; g_deadline=0; g_signal_time=0;
   g_peak_r=0; g_be_done=false; g_be_time=0;
   SaveState();
}

//+------------------------------------------------------------------+
//| 找出本 EA 的持倉                                                  |
//+------------------------------------------------------------------+
bool FindOurPosition(ulong &ticket)
{
   ticket=0;
   for(int i=PositionsTotal()-1;i>=0;i--)
   {
      ulong t=PositionGetTicket(i);
      if(t==0) continue;
      if(PositionGetString(POSITION_SYMBOL)!=g_symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC)!=InpMagic) continue;
      ticket=t;
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| 風險預算                                                          |
//| 固定百分比；啟用 ratchet 時額外受「權益 - 底線」限制。             |
//| 永遠只用「目前權益」計算，因此虧損後倉位自動縮小：                  |
//| 不存在 Martingale，也不會對虧損部位加倉。                          |
//+------------------------------------------------------------------+
void UpdateRatchetFloor(const double eq)
{
   if(eq>=10000.0) { g_ratchet_done=true; g_floor=MathMax(g_floor,5000.0); }
   else if(eq>=3000.0) g_floor=MathMax(g_floor,1500.0);
   else if(eq>=1000.0) g_floor=MathMax(g_floor, 500.0);
   else if(eq>= 300.0) g_floor=MathMax(g_floor, 150.0);
   else if(eq>= 100.0) g_floor=MathMax(g_floor,  60.0);
}

double RiskBudget(string &reason)
{
   reason="";
   double eq=AccountInfoDouble(ACCOUNT_EQUITY);
   double pct=InpRiskPct;

   //--- 翻身模式：碰到目標就閂住，之後一律用降級後的風險，不因回落而切回
   if(InpTargetEquity>0.0)
   {
      if(!g_target_hit && eq>=InpTargetEquity)
      {
         g_target_hit=true; SaveState();
         PrintFormat("TARGET REACHED: equity %.2f >= %.2f — switching risk %.2f%% -> %.2f%%",
                     eq,InpTargetEquity,InpRiskPct,InpPostTargetRiskPct);
      }
      if(g_target_hit)
      {
         if(InpPostTargetRiskPct<=0.0)
         { reason="TARGET_REACHED: post-target risk is 0, trading stopped"; return 0.0; }
         pct=InpPostTargetRiskPct;
      }
   }

   double base=eq*pct/100.0;
   if(!InpUseRatchet) return base;

   UpdateRatchetFloor(eq);
   if(g_ratchet_done) { reason="RATCHET_COMPLETE: equity reached 10000, high-risk mode stopped"; return 0.0; }
   double capped=(eq-g_floor)/InpRatchetBuffer;
   double v=MathMin(base,capped);
   if(v<=0.0) reason=StringFormat("RATCHET_FLOOR_BREACH: equity %.2f at/below floor %.2f",eq,g_floor);
   return MathMax(0.0,v);
}

//+------------------------------------------------------------------+
//| 出場原因                                                          |
//+------------------------------------------------------------------+
string DealReasonText(const long reason)
{
   switch((int)reason)
   {
      case DEAL_REASON_SL:     return "SL";
      case DEAL_REASON_TP:     return "TP";
      case DEAL_REASON_SO:     return "STOPOUT";
      case DEAL_REASON_EXPERT: return "EXPERT";
      case DEAL_REASON_CLIENT: return "MANUAL";
      default:                 return "OTHER";
   }
}

//+------------------------------------------------------------------+
//| 部位已平倉 → 結算並寫日誌                                          |
//+------------------------------------------------------------------+
void HandleClosedPosition(const string forced_reason)
{
   OS_LogRow row; OS_ClearLog(row);
   row.event="EXIT";
   row.signal_utc=g_signal_time; row.side=g_side; row.entry_bar=g_entry_bar;
   row.entry_price=g_entry; row.stop_dist=g_dist; row.risk_money=g_risk_money;
   row.volume=g_volume; row.be_time=g_be_time; row.deadline_utc=g_deadline;
   row.exit_reason=forced_reason;

   double net=0.0, exit_price=0.0;
   datetime exit_time=0;

   //--- 同步平倉後成交不保證已寫入歷史；先試一次，沒有 OUT 成交就刷新整段歷史再試
   for(int attempt=0;attempt<2 && exit_time==0;attempt++)
   {
      if(attempt==1) HistorySelect(0,TimeTradeServer()+60);
      if(g_pos_id==0 || !HistorySelectByPosition(g_pos_id)) continue;
      net=0.0;
      int total=HistoryDealsTotal();
      for(int i=0;i<total;i++)
      {
         ulong d=HistoryDealGetTicket(i);
         if(d==0) continue;
         net += HistoryDealGetDouble(d,DEAL_PROFIT)
              + HistoryDealGetDouble(d,DEAL_SWAP)
              + HistoryDealGetDouble(d,DEAL_COMMISSION);
         if((ENUM_DEAL_ENTRY)HistoryDealGetInteger(d,DEAL_ENTRY)==DEAL_ENTRY_IN) continue;
         exit_price=HistoryDealGetDouble(d,DEAL_PRICE);
         exit_time =(datetime)HistoryDealGetInteger(d,DEAL_TIME);
         if(forced_reason=="")
            row.exit_reason=DealReasonText(HistoryDealGetInteger(d,DEAL_REASON));
      }
   }
   if(exit_time==0)
      Print("WARN: closing deal not found in history; net P/L in log may be incomplete");
   if(row.exit_reason=="") row.exit_reason="UNKNOWN";

   row.exit_time=exit_time;
   row.net_pnl=net;
   row.equity=AccountInfoDouble(ACCOUNT_EQUITY);
   if(g_dist>0.0 && exit_price>0.0) row.r_price=g_side*(exit_price-g_entry)/g_dist;
   if(g_risk_money>0.0)             row.r_money=net/g_risk_money;
   WriteLog(row);

   PrintFormat("EXIT %s side=%d net=%.2f R(money)=%.3f R(price)=%.3f",
               row.exit_reason,g_side,net,row.r_money,row.r_price);

   //--- 研究口徑：出場當根 M5 不得再進場（i > last_exit）
   if(exit_time>0) g_last_exit_bar=(datetime)(((long)exit_time/300)*300);
   else            g_last_exit_bar=iTime(g_symbol,PERIOD_M5,0);

   ClearPositionState();
   if(InpUseRatchet) { UpdateRatchetFloor(AccountInfoDouble(ACCOUNT_EQUITY)); SaveState(); }
}

//+------------------------------------------------------------------+
//| 目前點差（價格單位）                                              |
//+------------------------------------------------------------------+
double SpreadPrice()
{
   double ask=SymbolInfoDouble(g_symbol,SYMBOL_ASK);
   double bid=SymbolInfoDouble(g_symbol,SYMBOL_BID);
   if(ask>0.0 && bid>0.0 && ask>=bid) return ask-bid;
   return (double)SymbolInfoInteger(g_symbol,SYMBOL_SPREAD)*g_point;
}

double NP(const double price) { return NormalizeDouble(price,g_digits); }

//--- 前向宣告（ManagePosition 會先呼叫它）
void AdoptPosition(const ulong ticket);

//+------------------------------------------------------------------+
//| 持倉管理（每根新的 M5 執行一次）                                   |
//|                                                                  |
//| 順序完全對齊回測迴圈：                                            |
//|   1. 套用上一根收盤所觸發的保本（研究是 pending → 下一根生效）      |
//|   2. 真 48 曆時小時逾時 → 以本根開盤出場                           |
//|   3. SL / TP 由券商在盤中執行                                     |
//|   4. 本根收盤後再更新浮盈高點（下一根才可能觸發保本）              |
//+------------------------------------------------------------------+
void ManagePosition(const datetime bar_time)
{
   ulong ticket=0;
   bool exists=FindOurPosition(ticket);

   if(g_has_pos && !exists) { HandleClosedPosition(""); return; }
   if(!g_has_pos) { if(exists) AdoptPosition(ticket); return; }
   if(!exists) return;

   //--- 1 & 4：用「剛收盤」那根 M5 的收盤價更新浮盈高點，達標即刻移到保本，
   //---        等同回測中「這一根收盤觸發、下一根開始生效」
   double mark=iClose(g_symbol,PERIOD_M5,1);
   if(mark>0.0 && g_dist>0.0)
   {
      if(g_side==-1) mark+=SpreadPrice();     // 空單的不利報價是 Ask
      double exc=g_side*(mark-g_entry)/g_dist;
      if(exc>g_peak_r) g_peak_r=exc;

      if(!g_be_done && g_peak_r>=InpBreakevenR && PositionSelectByTicket(ticket))
      {
         //--- 停損移到「進場價 + 墊高幅度」。移到剛好進場價會讓這些單子以
         //--- -0.01R（付掉成本）出場而被計為虧損；墊高一點才真正打平。
         double be_price=NP(g_entry+g_side*InpBreakevenOffsetR*g_dist);
         double tp=PositionGetDouble(POSITION_TP);
         if(g_trade.PositionModify(ticket,be_price,tp))
         {
            g_be_done=true; g_be_time=bar_time;
            OS_LogRow row; OS_ClearLog(row);
            row.event="BE"; row.signal_utc=g_signal_time; row.side=g_side;
            row.entry_bar=g_entry_bar; row.entry_price=g_entry; row.stop_price=be_price;
            row.tp_price=tp; row.stop_dist=g_dist; row.risk_money=g_risk_money;
            row.volume=g_volume; row.be_time=g_be_time; row.deadline_utc=g_deadline;
            row.equity=AccountInfoDouble(ACCOUNT_EQUITY);
            WriteLog(row);
            PrintFormat("BE: stop moved to %s (entry %s + %.2fR, peak %.2fR)",
                        DoubleToString(be_price,g_digits),DoubleToString(g_entry,g_digits),
                        InpBreakevenOffsetR,g_peak_r);
         }
         else
            PrintFormat("WARN: breakeven modify failed err=%d, will retry next bar",
                        g_trade.ResultRetcode());
      }
      SaveState();
   }

   //--- 2：真正的曆時逾時
   if(g_deadline>0 && bar_time>=g_deadline && bar_time>g_entry_bar)
   {
      if(g_trade.PositionClose(ticket,InpSlippagePoints))
         HandleClosedPosition("TIME");
      else
         PrintFormat("WARN: time-exit close failed err=%d, will retry next bar",
                     g_trade.ResultRetcode());
   }
}

//+------------------------------------------------------------------+
//| 接手未知來源的持倉（EA 重啟且狀態遺失時的保守復原）                 |
//+------------------------------------------------------------------+
void AdoptPosition(const ulong ticket)
{
   if(!PositionSelectByTicket(ticket)) return;
   g_has_pos     = true;
   g_pos_id      = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   g_side        = (PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY ? 1 : -1);
   g_entry       = PositionGetDouble(POSITION_PRICE_OPEN);
   g_volume      = PositionGetDouble(POSITION_VOLUME);
   datetime open_time=(datetime)PositionGetInteger(POSITION_TIME);
   g_entry_bar   = (datetime)(((long)open_time/300)*300);
   g_deadline    = (datetime)((long)open_time+(long)InpMaxHoldHours*3600);
   g_signal_time = g_entry_bar;

   double sl=PositionGetDouble(POSITION_SL);
   double tp=PositionGetDouble(POSITION_TP);
   //--- 停損已在進場價「之上（多）/之下（空）」→ 視為保本已觸發
   if(sl>0.0 && g_side*(sl-g_entry)>=-g_point) { g_be_done=true; g_be_time=open_time; }
   if(!g_be_done && sl>0.0)      g_dist=MathAbs(g_entry-sl);
   else if(tp>0.0)               g_dist=MathAbs(tp-g_entry)/InpTakeProfitR;
   g_risk_money=0.0;             // 無法可靠回推，R(money) 於日誌留 0
   g_peak_r=g_be_done?InpBreakevenR:0.0;

   PrintFormat("ADOPT: took over position #%s side=%d entry=%s dist=%s deadline=%s UTC",
               IntegerToString((long)ticket),g_side,
               DoubleToString(g_entry,g_digits),DoubleToString(g_dist,g_digits),
               FmtUTC(g_deadline));
   SaveState();
}

//+------------------------------------------------------------------+
//| 進場                                                              |
//+------------------------------------------------------------------+
void LogSkip(OS_Signal &s,const string reason,OS_SizingResult &sz,const double risk_money)
{
   OS_LogRow row; OS_ClearLog(row);
   row.event="SKIP";
   row.signal_utc=s.close_time; row.side=s.side; row.entry_bar=iTime(g_symbol,PERIOD_M5,0);
   row.stop_dist=InpStopATRMult*s.atr; row.risk_money=risk_money;
   row.raw_volume=sz.raw_volume; row.volume=sz.volume; row.min_volume=sz.min_volume;
   row.volume_step=sz.volume_step; row.one_lot_loss=sz.one_lot_loss;
   row.min_lot_loss=sz.min_lot_loss; row.actual_risk=sz.actual_risk;
   row.margin=sz.margin; row.free_margin=sz.free_margin;
   row.skip_reason=reason;
   row.equity=AccountInfoDouble(ACCOUNT_EQUITY);
   row.h4_macro=s.h4_macro; row.h1_trend=s.h1_trend; row.pos32=s.pos32;
   row.body=s.body; row.atrrel=s.atrrel; row.utc_hour=s.utc_hour;
   WriteLog(row);
   Print("SKIP ",reason);
}

void TryEntry(const datetime bar_time,const bool m15_just_closed)
{
   if(!m15_just_closed) return;
   if(g_has_pos) return;
   if(bar_time<=g_last_exit_bar) return;      // 出場當根不重新進場

   OS_Signal s;
   OS_SizingResult sz; OS_ResetSizing(sz);

   if(!EvaluateSignal(s))
   {
      if(InpLogRejects) LogSkip(s,"NO_EVAL: "+s.note,sz,0.0);
      return;
   }
   if(s.side==0)
   {
      if(InpLogRejects) LogSkip(s,"NO_SIGNAL",sz,0.0);
      return;
   }

   //--- 只在「M15 收盤時點的那一根 M5」進場。資料缺口、週末或終端重啟後
   //--- 第一根 M5 可能已經離訊號很遠，研究回測不會接這種單，EA 也不追。
   if(bar_time!=s.close_time)
   {
      LogSkip(s,StringFormat("SKIP_STALE_SIGNAL: entry bar %s != signal close %s",
              FmtUTC(bar_time),FmtUTC(s.close_time)),sz,0.0);
      return;
   }

   string rb_reason="";
   double risk_money=RiskBudget(rb_reason);
   if(risk_money<=0.0) { LogSkip(s,rb_reason=="" ? "SKIP_ZERO_RISK_BUDGET" : rb_reason,sz,risk_money); return; }

   ENUM_ORDER_TYPE type = (s.side==1 ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
   double price = (s.side==1 ? SymbolInfoDouble(g_symbol,SYMBOL_ASK)
                             : SymbolInfoDouble(g_symbol,SYMBOL_BID));
   if(price<=0.0) { LogSkip(s,"SKIP_NO_QUOTE",sz,risk_money); return; }

   double dist = InpStopATRMult*s.atr;
   double stop = NP(price - s.side*dist);
   double tp   = NP(price + s.side*InpTakeProfitR*dist);

   //--- 券商最小停損距離
   long stops_lvl=SymbolInfoInteger(g_symbol,SYMBOL_TRADE_STOPS_LEVEL);
   if(stops_lvl>0 && dist < (double)stops_lvl*g_point)
   {
      LogSkip(s,StringFormat("SKIP_STOPS_LEVEL: dist %s < broker minimum %s",
              DoubleToString(dist,g_digits),
              DoubleToString((double)stops_lvl*g_point,g_digits)),sz,risk_money);
      return;
   }

   //--- 倉位：一律依券商真實規格計算；不合法就跳過，絕不強制 0.01 lot
   if(!OS_CalcRiskVolumeEx(g_symbol,type,price,stop,risk_money,InpMaxMarginFraction,sz))
   {
      LogSkip(s,"SKIP_MIN_VOLUME_RISK: "+sz.reason,sz,risk_money);
      return;
   }

   g_trade.SetDeviationInPoints(InpSlippagePoints);
   bool sent = (s.side==1)
             ? g_trade.Buy (sz.volume,g_symbol,0.0,stop,tp,"OSV2")
             : g_trade.Sell(sz.volume,g_symbol,0.0,stop,tp,"OSV2");

   //--- 部分「市價執行」帳戶不接受下單時就帶 SL/TP；改為裸單後立刻補掛
   bool stops_attached=sent;
   if(!sent && g_trade.ResultRetcode()==TRADE_RETCODE_INVALID_STOPS)
   {
      PrintFormat("INFO: broker rejected inline stops (%d); retrying as bare market order",
                  g_trade.ResultRetcode());
      sent = (s.side==1)
           ? g_trade.Buy (sz.volume,g_symbol,0.0,0.0,0.0,"OSV2")
           : g_trade.Sell(sz.volume,g_symbol,0.0,0.0,0.0,"OSV2");
   }
   if(!sent)
   {
      LogSkip(s,StringFormat("SKIP_ORDER_FAILED: retcode=%d %s",
              g_trade.ResultRetcode(),g_trade.ResultRetcodeDescription()),sz,risk_money);
      return;
   }

   ulong ticket=0;
   if(!FindOurPosition(ticket) || !PositionSelectByTicket(ticket))
   {
      Print("WARN: order sent but position not found; will adopt on next bar");
      return;
   }

   //--- 依「實際成交價」重算停損/目標，讓 1R 與實單一致
   g_entry   = PositionGetDouble(POSITION_PRICE_OPEN);
   g_dist    = dist;
   double sl2=NP(g_entry - s.side*dist);
   double tp2=NP(g_entry + s.side*InpTakeProfitR*dist);
   if(!stops_attached || MathAbs(sl2-stop)>g_point*0.5 || MathAbs(tp2-tp)>g_point*0.5)
   {
      if(!g_trade.PositionModify(ticket,sl2,tp2))
      {
         PrintFormat("ERROR: could not set SL/TP on position err=%d %s",
                     g_trade.ResultRetcode(),g_trade.ResultRetcodeDescription());
         if(!stops_attached)
         {
            //--- 沒有停損的部位不可留在市場上
            Print("FATAL: position has no stop loss; closing immediately");
            if(g_trade.PositionClose(ticket,InpSlippagePoints))
            {
               LogSkip(s,"SKIP_NO_STOP_ATTACHED: closed unprotected position",sz,risk_money);
               g_last_exit_bar=bar_time;
               return;
            }
            Print("FATAL: could not close unprotected position — MANUAL INTERVENTION REQUIRED");
         }
      }
   }

   g_has_pos     = true;
   g_pos_id      = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
   g_side        = s.side;
   g_volume      = PositionGetDouble(POSITION_VOLUME);
   g_risk_money  = risk_money;
   g_entry_bar   = bar_time;
   g_deadline    = (datetime)((long)bar_time+(long)InpMaxHoldHours*3600); // 真曆時小時
   g_signal_time = s.close_time;
   g_peak_r      = 0.0;
   g_be_done     = false;
   g_be_time     = 0;
   SaveState();

   OS_LogRow row; OS_ClearLog(row);
   row.event="ENTRY";
   row.signal_utc=s.close_time; row.side=s.side; row.entry_bar=bar_time;
   row.entry_price=g_entry; row.stop_price=sl2; row.tp_price=tp2; row.stop_dist=dist;
   row.risk_money=risk_money; row.raw_volume=sz.raw_volume; row.volume=g_volume;
   row.min_volume=sz.min_volume; row.volume_step=sz.volume_step;
   row.one_lot_loss=sz.one_lot_loss; row.min_lot_loss=sz.min_lot_loss;
   row.actual_risk=sz.actual_risk; row.margin=sz.margin; row.free_margin=sz.free_margin;
   row.deadline_utc=g_deadline; row.equity=AccountInfoDouble(ACCOUNT_EQUITY);
   row.h4_macro=s.h4_macro; row.h1_trend=s.h1_trend; row.pos32=s.pos32;
   row.body=s.body; row.atrrel=s.atrrel; row.utc_hour=s.utc_hour;
   WriteLog(row);

   PrintFormat("ENTRY side=%d vol=%s entry=%s stop=%s tp=%s risk=%.2f deadline=%s UTC",
               s.side,DoubleToString(g_volume,3),
               DoubleToString(g_entry,g_digits),DoubleToString(sl2,g_digits),
               DoubleToString(tp2,g_digits),risk_money,FmtUTC(g_deadline));
}

//+------------------------------------------------------------------+
//| 生命週期                                                          |
//+------------------------------------------------------------------+
int OnInit()
{
   g_symbol=(InpSymbol=="" ? _Symbol : InpSymbol);
   if(!SymbolSelect(g_symbol,true))
   { PrintFormat("FATAL: cannot select symbol %s",g_symbol); return INIT_FAILED; }

   g_digits=(int)SymbolInfoInteger(g_symbol,SYMBOL_DIGITS);
   g_point =SymbolInfoDouble(g_symbol,SYMBOL_POINT);
   if(g_point<=0.0) { Print("FATAL: invalid point size"); return INIT_FAILED; }

   if(InpHourFromUTC<0 || InpHourToUTC>23 || InpHourFromUTC>InpHourToUTC)
   { Print("FATAL: invalid UTC session window"); return INIT_PARAMETERS_INCORRECT; }
   if(InpBreakevenOffsetR<0.0 || InpBreakevenOffsetR>=InpBreakevenR)
   { Print("FATAL: breakeven offset must be >= 0 and < breakeven trigger"); return INIT_PARAMETERS_INCORRECT; }
   if(InpStopATRMult<=0.0 || InpTakeProfitR<=0.0 || InpMaxHoldHours<=0)
   { Print("FATAL: invalid exit parameters"); return INIT_PARAMETERS_INCORRECT; }
   if(InpRiskPct<=0.0 || InpRiskPct>100.0)
   { Print("FATAL: invalid risk percent"); return INIT_PARAMETERS_INCORRECT; }
   if(InpTargetEquity<0.0 || InpPostTargetRiskPct<0.0 || InpPostTargetRiskPct>100.0)
   { Print("FATAL: invalid turnaround-mode parameters"); return INIT_PARAMETERS_INCORRECT; }
   if(InpRiskPct>38.0)
   { Print("FATAL: risk above 38% — one historical -2.60R gap trade would wipe the account");
     return INIT_PARAMETERS_INCORRECT; }
   if(InpUseRatchet && InpRatchetBuffer<1.0)
   { Print("FATAL: ratchet buffer must be >= 1.0"); return INIT_PARAMETERS_INCORRECT; }

   g_trade.SetExpertMagicNumber(InpMagic);
   g_trade.SetDeviationInPoints(InpSlippagePoints);
   g_trade.SetTypeFillingBySymbol(g_symbol);

   RefreshUTCOffset();
   EnsureLogHeader();
   LoadState();
   if(g_floor<=0.0) g_floor=InpRatchetFloor0;

   //--- 不要在啟動當下的半根 K 上動作
   g_last_m5 =iTime(g_symbol,PERIOD_M5,0);
   g_last_m15=iTime(g_symbol,PERIOD_M15,0);

   ulong ticket=0;
   if(FindOurPosition(ticket))
   {
      if(!g_has_pos || g_pos_id!=(ulong)PositionGetInteger(POSITION_IDENTIFIER))
         AdoptPosition(ticket);
      else
         PrintFormat("RESUME: position #%s restored, deadline=%s UTC",
                     IntegerToString((long)ticket),FmtUTC(g_deadline));
   }
   else if(g_has_pos)
   {
      Print("WARN: stored state had a position but none is open; clearing state");
      ClearPositionState();
   }

   PrintFormat("=== XAUUSD ONE SHOT V2 === symbol=%s digits=%d serverUTCoffset=%+.1fh",
               g_symbol,g_digits,(double)g_utc_off_sec/3600.0);
   PrintFormat("Entry(locked): H4|%.2f H1|%.2f pos32 %.2f/%.2f body %.2f atrRel %.2f-%.2f UTC %02d-%02d",
               InpH4MacroMin,InpH1TrendMin,InpPos32Long,InpPos32Short,InpBodyMin,
               InpAtrRelLo,InpAtrRelHi,InpHourFromUTC,InpHourToUTC);
   PrintFormat("Exit: stop=%.2fxATR tp=%.1fR be=%.1fR(+%.2fR) hold=%dh(calendar)",
               InpStopATRMult,InpTakeProfitR,InpBreakevenR,InpBreakevenOffsetR,InpMaxHoldHours);
   PrintFormat("Risk: %.2f%% per trade, ratchet=%s, maxMarginFraction=%.2f",
               InpRiskPct,(InpUseRatchet?"ON":"OFF"),InpMaxMarginFraction);
   if(InpTargetEquity>0.0)
      PrintFormat("Turnaround mode: target=%.2f, post-target risk=%.2f%%, already reached=%s",
                  InpTargetEquity,InpPostTargetRiskPct,(g_target_hit?"YES":"no"));
   Print("NOTE: external true Bid/Ask holdout NOT completed — run Strategy Tester / Demo only.");

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
      Print("WARN: algo trading is disabled in the terminal; EA will analyse but cannot trade.");
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
      Print("WARN: expert trading is disabled for this account.");

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { SaveState(); }

void OnTick()
{
   datetime m5=iTime(g_symbol,PERIOD_M5,0);
   if(m5==0) return;
   if(m5==g_last_m5) return;        // 全部決策只在新的 M5 K 開盤時做一次
   g_last_m5=m5;

   RefreshUTCOffset();

   datetime m15=iTime(g_symbol,PERIOD_M15,0);
   bool m15_just_closed=(g_last_m15!=0 && m15!=0 && m15!=g_last_m15);
   if(m15!=0) g_last_m15=m15;

   ManagePosition(m5);              // 先出場
   TryEntry(m5,m15_just_closed);    // 再進場（出場當根會被擋掉）
}
//+------------------------------------------------------------------+

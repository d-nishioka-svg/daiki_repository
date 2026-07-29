import React from "react";
import { History, CheckCircle, AlertCircle, Loader2, ArrowUpRight, Ban, Eye } from "lucide-react";
import { ScanHistoryEntry, SpreadsheetInfo } from "../types";

interface HistoryListProps {
  entries: ScanHistoryEntry[];
  selectedSheet: SpreadsheetInfo | null;
  onClearHistory: () => void;
  onSaveEntry?: (entry: ScanHistoryEntry) => void;
}

export const HistoryList: React.FC<HistoryListProps> = ({
  entries,
  selectedSheet,
  onClearHistory,
  onSaveEntry,
}) => {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-slate-100 rounded-xl text-slate-705">
            <History className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">3. 撮影履歴フィード / Live Intake Feed</h2>
            <p className="text-xs text-slate-500 font-medium font-sans">
              スキャンした順番に上からパッパッパッと1行ずつ増えていきます。サムネイルで服タグの画像も確認できます。
            </p>
          </div>
        </div>

        {entries.length > 0 && (
          <button
            onClick={onClearHistory}
            className="text-xs text-slate-500 hover:text-red-600 transition-colors cursor-pointer border border-slate-200 hover:border-red-100 rounded-lg px-3 py-2 bg-white hover:bg-red-50/50 font-semibold min-h-[38px]"
          >
            履歴クリア / Clear
          </button>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400 text-center border border-dashed border-slate-200 rounded-xl bg-slate-50/30">
          <p className="font-bold text-sm text-slate-500 uppercase tracking-widest font-mono">履歴はまだありません / Queue is Empty</p>
          <p className="text-xs text-slate-450 max-w-xs px-6 mt-1 leading-normal font-sans">
            タグの解析・保存が正常に完了すると、このセッションログにリアルタイムで反映されます。
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-6">
          <table className="w-full text-left border-collapse min-w-[500px]">
            <thead>
              <tr className="border-b border-gray-200 text-[10px] font-black uppercase text-gray-450 tracking-widest bg-slate-50/55">
                <th className="px-5 py-3 text-center w-12 font-mono">タグ画像 / IMG</th>
                <th className="px-4 py-3 font-mono">店舗 / STORE</th>
                <th className="px-4 py-3 font-mono">時間 / TIME</th>
                <th className="px-4 py-3 font-mono">品番・型番 / PART CODE</th>
                <th className="px-4 py-3 font-mono">サイズ / SIZE</th>
                <th className="px-4 py-3 font-mono">カラー / COLOR</th>
                <th className="px-5 py-3 text-right font-mono">同期・保存状態 / STATUS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-xs text-slate-600">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-slate-50 transition-all duration-150 bg-white">
                  {/* Thumbnail Image component column */}
                  <td className="px-5 py-2.5 text-center">
                    {entry.previewImage ? (
                      <div className="relative inline-block w-10 h-10 rounded-lg overflow-hidden border border-slate-200 shadow-3xs bg-slate-100">
                        <img
                          src={entry.previewImage}
                          alt="clothes tag"
                          className="w-full h-full object-cover rounded-lg"
                          referrerPolicy="no-referrer"
                        />
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-lg border border-slate-150 bg-slate-50 flex items-center justify-center text-slate-350 mx-auto">
                        <History className="w-4 h-4" />
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center px-2 py-1 rounded bg-slate-100 text-slate-800 font-bold font-sans text-[11px] border border-slate-200">
                      {entry.store || "共通"}
                    </span>
                  </td>

                  <td className="px-4 py-3.5 text-slate-400 font-medium font-mono text-[11px]">{entry.time}</td>
                  
                  <td className="px-4 py-3.5 font-bold text-slate-800 font-mono text-sm uppercase">
                    {entry.status === "extracting" ? (
                      <span className="text-blue-500 font-bold animate-pulse">AI解析中 (Reading...)</span>
                    ) : (
                      entry.partNumber || <span className="text-slate-300 font-normal">—</span>
                    )}
                  </td>

                  <td className="px-4 py-3.5">
                    {entry.status === "extracting" ? (
                      <span className="text-slate-300 font-sans">...</span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-1 rounded bg-blue-50/80 text-blue-700 font-bold font-mono text-[11px] border border-blue-100">
                        {entry.size || "—"}
                      </span>
                    )}
                  </td>

                  <td className="px-4 py-3.5">
                    {entry.status === "extracting" ? (
                      <span className="text-slate-300 font-sans">...</span>
                    ) : (
                      <span className="font-bold text-slate-705 uppercase tracking-wide">{entry.color || "—"}</span>
                    )}
                  </td>

                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2.5">
                      {entry.status === "extracting" && (
                        <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px] text-blue-600 bg-blue-50/50 border border-blue-200 px-2.5 py-1 rounded-md animate-pulse">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" /> AI-READING
                        </span>
                      )}
                      
                      {entry.status === "saving" && (
                        <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wider text-[10px] text-indigo-600 bg-indigo-50/50 border border-indigo-200 px-2.5 py-1 rounded-md animate-pulse">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" /> EXPORTING
                        </span>
                      )}
                      
                      {entry.status === "saved" && (
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold text-green-700 bg-green-50 px-2.5 py-1 rounded border border-green-200 uppercase tracking-widest">
                          ✓ 保存完了 (SYNCED)
                        </span>
                      )}

                      {entry.status === "pending" && (
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded border border-amber-200 uppercase">
                            確認中 (PENDING)
                          </span>
                          {onSaveEntry && (
                            <button
                              onClick={() => onSaveEntry(entry)}
                              className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-[10px] font-bold shadow-3xs hover:shadow-2xs transition-all cursor-pointer flex items-center gap-1 min-h-[28px]"
                            >
                              保存
                            </button>
                          )}
                        </div>
                      )}

                      {entry.status === "failed" && (
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center gap-1 font-mono text-[10px] font-bold text-red-650 bg-red-50 px-2.5 py-1 rounded border border-red-200 uppercase tracking-widest cursor-help"
                            title={entry.error || "Save error occurred"}
                          >
                            ⚠ 失敗 (FAILED)
                          </span>
                          {onSaveEntry && (
                            <button
                              onClick={() => onSaveEntry(entry)}
                              className="px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded-md text-[10px] font-bold transition-all cursor-pointer min-h-[28px]"
                              title="Retry Export"
                            >
                              再試行
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedSheet && entries.length > 0 && (
        <div className="mt-5 p-4 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-between text-xs text-slate-600 flex-wrap gap-2">
          <span className="font-medium text-slate-705">スプレッドシート本体に保存された全データを確認しますか？</span>
          <a
            href={selectedSheet.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 text-slate-800 border border-slate-250 hover:border-slate-350 bg-white font-bold rounded-lg px-4 py-2.5 shadow-xs transition-colors min-h-[40px] cursor-pointer"
          >
            Googleスプレッドシートを開く <ArrowUpRight className="w-4 h-4 text-slate-500" />
          </a>
        </div>
      )}
    </div>
  );
};

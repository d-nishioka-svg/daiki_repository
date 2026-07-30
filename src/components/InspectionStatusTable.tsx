import React from "react";
import { Plus, Minus, RotateCcw, ClipboardCheck, Info, Sparkles, Package } from "lucide-react";
import { InspectionListItem } from "../types";

interface InspectionStatusTableProps {
  selectedStore: string;
  comparisonRows: Array<InspectionListItem & { actualQty: number }>;
  extraScannedItems: Array<{
    partNumber: string;
    size: string;
    color: string;
    actualQty: number;
  }>;
  changedQtyOverrides: Record<string, number>;
  onQtyOverrideChange: (rowId: string, val: number) => void;
  onAdjustQty: (partNumber: string, size: string, color: string, increment: boolean) => void;
  onClearHistory: () => void;
}

export const InspectionStatusTable: React.FC<InspectionStatusTableProps> = ({
  selectedStore,
  comparisonRows,
  extraScannedItems,
  changedQtyOverrides,
  onQtyOverrideChange,
  onAdjustQty,
  onClearHistory,
}) => {
  // Check if overall condition is OK
  const allMasterMatched = comparisonRows.length > 0 && comparisonRows.every((row) => {
    const changedQty = changedQtyOverrides[row.id] ?? row.expectedQty;
    return row.actualQty === changedQty;
  });
  const hasExtraItems = extraScannedItems.length > 0;
  const overallStatus = (allMasterMatched && !hasExtraItems) ? "OK" : "検品中";

  // Quick stats
  const totalExpected = comparisonRows.reduce((sum, row) => sum + (changedQtyOverrides[row.id] ?? row.expectedQty), 0);
  const totalActual = comparisonRows.reduce((sum, row) => sum + row.actualQty, 0) + 
                       extraScannedItems.reduce((sum, r) => sum + r.actualQty, 0);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200/80 overflow-hidden font-sans transition-all duration-300">
      
      {/* 1. Header with Modern Badge */}
      <div className="p-5 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10px] uppercase font-black tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md">
              INSPECTION LEDGER
            </span>
            <div className="flex items-center gap-1.5 bg-indigo-50/75 text-indigo-700 text-[11px] font-bold px-2 py-0.5 rounded-md">
              <Package className="w-3.5 h-3.5 text-indigo-600" />
              {selectedStore}
            </div>
          </div>
          <h2 className="text-lg font-bold text-slate-800 tracking-tight flex items-center gap-2">
            店舗別 検品状況テーブル
          </h2>
        </div>

        {/* Clear/Reset button and Overall status */}
        <div className="flex items-center gap-3">
          <button
            onClick={onClearHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 font-bold rounded-lg transition-colors cursor-pointer"
            title="検品状況リセット"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            検品リセット
          </button>

          <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-black tracking-wider shadow-2xs ${
            overallStatus === "OK" 
              ? "bg-emerald-500 text-white animate-pulse" 
              : "bg-amber-50 text-amber-800 border border-amber-200"
          }`}>
            <span>状況: {overallStatus}</span>
          </span>
        </div>
      </div>

      {/* 3. Sleek Table Grid View */}
      <div className="p-4 overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[700px]">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500 text-xs font-bold h-10">
              <th className="pb-2.5 px-3 font-semibold text-slate-600">品番</th>
              <th className="pb-2.5 px-3 font-semibold text-slate-600">カラー</th>
              <th className="pb-2.5 px-3 font-semibold text-slate-600 text-center w-24">サイズ</th>
              <th className="pb-2.5 px-2 font-semibold text-slate-600 text-center w-16">予定数</th>
              <th className="pb-2.5 px-2 font-semibold text-slate-600 text-center w-20">変更数</th>
              <th className="pb-2.5 px-2 font-semibold text-slate-600 text-center w-32">検品数</th>
              <th className="pb-2.5 px-2 font-semibold text-slate-600 text-center w-20">未検品数</th>
              <th className="pb-2.5 px-3 font-semibold text-slate-600 text-center w-24">状況</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-slate-700 text-xs">
            {comparisonRows.length === 0 && extraScannedItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-slate-400">
                  <div className="flex flex-col items-center gap-2 justify-center">
                    <Info className="w-8 h-8 text-slate-300" />
                    <p className="font-bold text-slate-500 text-sm">検品照合データがありません</p>
                    <p className="max-w-md text-xs text-slate-400">
                      「仕入マスターCSVファイルをインポート」するか、対象スプレッドシートを選択してください。
                    </p>
                  </div>
                </td>
              </tr>
            ) : (
              <>
                {/* Master Scheduled Rows */}
                {comparisonRows.map((row) => {
                  const changedQty = changedQtyOverrides[row.id] ?? row.expectedQty;
                  const uninspectedQty = Math.max(0, changedQty - row.actualQty);
                  const isMatch = row.actualQty === changedQty;
                  const isZero = row.actualQty === 0;

                  return (
                    <tr key={row.id} className="h-11 hover:bg-slate-50/60 transition-colors font-medium">
                      {/* 品番 */}
                      <td className="px-3 py-2 font-mono font-bold text-slate-800">
                        <span className="bg-slate-100 px-2 py-1 rounded-md text-[11px] border border-slate-200 text-slate-700">
                          {row.partNumber}
                        </span>
                      </td>

                      {/* カラー */}
                      <td className="px-3 py-2 text-slate-700">
                        {row.color || "F"}
                      </td>

                      {/* サイズ */}
                      <td className="px-2 py-2 text-center text-slate-600 font-bold font-mono">
                        {row.size}
                      </td>

                      {/* 予定数 */}
                      <td className="px-2 py-2 text-center font-bold text-slate-400">
                        {row.expectedQty}
                      </td>

                      {/* 変更数 */}
                      <td className="px-2 py-2 text-center">
                        <input
                          type="number"
                          min="0"
                          value={changedQty}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            onQtyOverrideChange(row.id, isNaN(val) ? 0 : val);
                          }}
                          className="w-12 bg-white hover:bg-slate-50 border border-slate-200 rounded-md text-center py-1 font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-xs transition-all"
                        />
                      </td>

                      {/* 検品数 (Interactive +/- adjusts) */}
                      <td className="px-2 py-2 text-center">
                        <div className="inline-flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg p-1">
                          <button
                            onClick={() => onAdjustQty(row.partNumber, row.size, row.color, false)}
                            disabled={row.actualQty <= 0}
                            className="w-5 h-5 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-100 text-slate-600 flex items-center justify-center rounded-md cursor-pointer disabled:opacity-30 disabled:pointer-events-none transition-colors"
                            title="検品数を1減らす"
                          >
                            <Minus className="w-3 h-3 text-slate-500" />
                          </button>
                          
                          <span className="text-xs font-black min-w-5 text-center text-indigo-700">
                            {row.actualQty}
                          </span>

                          <button
                            onClick={() => onAdjustQty(row.partNumber, row.size, row.color, true)}
                            className="w-5 h-5 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-100 text-slate-600 flex items-center justify-center rounded-md cursor-pointer transition-colors"
                            title="検品数を1増やす"
                          >
                            <Plus className="w-3 h-3 text-slate-500" />
                          </button>
                        </div>
                      </td>

                      {/* 未検品数 */}
                      <td className={`px-2 py-2 text-center font-bold font-mono ${
                        uninspectedQty > 0 ? "text-amber-600" : "text-slate-400"
                      }`}>
                        {uninspectedQty}
                      </td>

                      {/* 状況 */}
                      <td className="px-3 py-2 text-center">
                        {isMatch ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-50 text-emerald-700 tracking-wider">
                            OK
                          </span>
                        ) : isZero ? (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-400">
                            未検品
                          </span>
                        ) : (
                          <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-black bg-amber-50 text-amber-700 tracking-wider">
                            残有({uninspectedQty})
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Extra Scanned Item Rows (Items not present in master sheet) */}
                {extraScannedItems.map((row, idx) => (
                  <tr key={`extra_${idx}`} className="h-11 bg-rose-50/20 hover:bg-rose-50/45 transition-colors text-xs font-medium">
                    {/* 品番 */}
                    <td className="px-3 py-2 font-mono font-bold text-rose-700">
                      <span className="bg-rose-50 px-2 py-1 rounded-md text-[11px] border border-rose-100 text-rose-600 block w-max">
                        {row.partNumber}
                      </span>
                    </td>

                    {/* カラー */}
                    <td className="px-3 py-2 text-rose-600">
                      {row.color}
                    </td>

                    {/* サイズ */}
                    <td className="px-2 py-2 text-center text-rose-600 font-bold font-mono">
                      {row.size}
                    </td>

                    {/* 予定数 */}
                    <td className="px-2 py-2 text-center font-semibold text-slate-300">
                      0
                    </td>

                    {/* 変更数 */}
                    <td className="px-2 py-2 text-center font-semibold text-slate-300">
                      0
                    </td>

                    {/* 検品数 & 手動訂正 */}
                    <td className="px-2 py-2 text-center">
                      <div className="inline-flex items-center gap-2 bg-rose-50/60 border border-rose-200 rounded-lg p-1">
                        <button
                          onClick={() => onAdjustQty(row.partNumber, row.size, row.color, false)}
                          className="w-5 h-5 bg-white border border-rose-200 hover:bg-rose-100 text-rose-700 flex items-center justify-center rounded-md cursor-pointer transition-colors"
                          title="検品数を1減らす"
                        >
                          <Minus className="w-3 h-3 text-rose-500" />
                        </button>
                        
                        <span className="text-xs font-black min-w-5 text-center text-rose-700">
                          {row.actualQty}
                        </span>

                        <button
                          onClick={() => onAdjustQty(row.partNumber, row.size, row.color, true)}
                          className="w-5 h-5 bg-white border border-rose-200 hover:bg-rose-100 text-rose-700 flex items-center justify-center rounded-md cursor-pointer transition-colors"
                          title="検品数を1増やす"
                        >
                          <Plus className="w-3 h-3 text-rose-500" />
                        </button>
                      </div>
                    </td>

                    {/* 未検品数 */}
                    <td className="px-2 py-2 text-center text-rose-600 font-bold font-mono">
                      +{row.actualQty}
                    </td>

                    {/* 状況 */}
                    <td className="px-3 py-2 text-center">
                      <span className="inline-block px-2 py-0.5 rounded-full text-[9px] font-black bg-rose-100 text-rose-700 tracking-wider">
                        マスタ外
                      </span>
                    </td>
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* 4. Elegant Minimalist Summary Bar */}
      <div className="bg-slate-50 p-4 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between text-slate-500 text-xs font-bold gap-4">
        <div className="flex items-center gap-6">
          <p className="flex items-center gap-1.5">
            <ClipboardCheck className="w-4 h-4 text-emerald-500" />
            総予定数: <span className="font-extrabold text-slate-800 text-[13px]">{totalExpected} 点</span>
          </p>
          <p className="flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-indigo-500" />
            総検品済: <span className="font-extrabold text-indigo-700 text-[13px]">{totalActual} 点</span>
          </p>
        </div>
        <p className="text-[11px] font-normal text-slate-400">
          スキャンされた衣類タグ情報とスプレッドシートの品番・色・サイズをリアルタイム自動突合中
        </p>
      </div>

    </div>
  );
};

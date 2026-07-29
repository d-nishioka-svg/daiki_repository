import React, { useState, useEffect } from "react";
import { Send, CheckCircle2, RotateCcw, PenTool, Loader2 } from "lucide-react";
import { TagData, SpreadsheetInfo } from "../types";

interface ScanResultFormProps {
  initialData: TagData | null;
  onSave: (finalData: TagData) => Promise<void>;
  onReset: () => void;
  selectedSheet: SpreadsheetInfo | null;
  isSaving: boolean;
  isExtracting: boolean;
}

export const ScanResultForm: React.FC<ScanResultFormProps> = ({
  initialData,
  onSave,
  onReset,
  selectedSheet,
  isSaving,
  isExtracting,
}) => {
  const [partNumber, setPartNumber] = useState("");
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const [submitted, setSubmitted] = useState(false);

  // Sync state values when new AI extracted properties arrive
  useEffect(() => {
    if (initialData) {
      setPartNumber(initialData.partNumber || "");
      setSize(initialData.size || "");
      setColor(initialData.color || "");
      setSubmitted(false);
    } else {
      setPartNumber("");
      setSize("");
      setColor("");
    }
  }, [initialData]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSheet) return;

    setSubmitted(true);
    await onSave({
      partNumber: partNumber.trim(),
      size: size.trim(),
      color: color.trim(),
    });
  };

  const isFormValid = partNumber.trim() !== "" || size.trim() !== "" || color.trim() !== "";

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 flex flex-col h-full justify-between">
      <div>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-slate-100 rounded-xl text-slate-700">
              <PenTool className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">2. 規格内容の確認・手動編集 / Review &amp; Edit</h2>
              <p className="text-xs text-slate-500">AIが抽出した衣料品タグデータを確認・修正してください</p>
            </div>
          </div>
        </div>

        {isExtracting ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
            <p className="text-sm font-bold text-slate-705">Geminiが衣服タグを高速読取中...</p>
            <p className="text-xs text-slate-400 font-medium text-center">AIが品番（NO）・サイズ（SIZE）・カラー（COL）を瞬時に分類・抽出しています</p>
          </div>
        ) : !initialData ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400 text-center gap-2.5 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
            <p className="font-bold text-sm text-slate-600 font-sans">画像がまだ読み込まれていません</p>
            <p className="text-xs text-slate-400 max-w-xs px-4 leading-normal">
              「スキャン」タブまたはライブカメラでタグを撮影するか、画像をアップロードしてください。
            </p>
          </div>
        ) : (
          <div className="p-5 bg-blue-50/50 rounded-xl border border-blue-150 space-y-4">
            <div className="flex justify-between items-center pb-2 border-b border-blue-100">
               <span className="bg-blue-600 text-white text-[10px] font-bold px-2 py-0.5 rounded tracking-wider uppercase">Recent Read</span>
               <span className="text-[10px] text-blue-500 font-mono font-bold">#PRO-ACTIVE</span>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[10px] text-blue-500 font-bold mb-1.5 uppercase tracking-wider font-mono">
                  品番 / Part Number
                </label>
                <input
                  type="text"
                  value={partNumber}
                  onChange={(e) => setPartNumber(e.target.value)}
                  placeholder="e.g. 460912, FD1029-010"
                  className="w-full text-lg font-mono font-bold text-slate-800 px-3.5 py-2.5 bg-white border border-blue-150 outline-none focus:border-blue-500 rounded-xl"
                  disabled={isSaving}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] text-blue-500 font-bold mb-1.5 uppercase tracking-wider font-mono">
                    サイズ / Size
                  </label>
                  <input
                    type="text"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    placeholder="e.g. L, 130, M"
                    className="w-full text-base font-mono font-bold text-slate-800 px-3.5 py-2.5 bg-white border border-blue-150 outline-none focus:border-blue-500 rounded-xl"
                    disabled={isSaving}
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-blue-500 font-bold mb-1.5 uppercase tracking-wider font-mono">
                    カラー / Color
                  </label>
                  <input
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="e.g. 09 BLACK, WHITE"
                    className="w-full text-base font-mono font-bold text-slate-800 px-3.5 py-2.5 bg-white border border-blue-150 outline-none focus:border-blue-500 rounded-xl"
                    disabled={isSaving}
                  />
                </div>
              </div>
            </form>
          </div>
        )}
      </div>

      {initialData && !isExtracting && (
        <div className="mt-6 flex gap-3 border-t border-slate-100 pt-6">
          <button
            type="button"
            onClick={onReset}
            disabled={isSaving}
            className="px-4 py-3 border border-slate-250 hover:border-slate-350 text-slate-600 hover:text-slate-900 font-bold text-xs md:text-sm rounded-xl transition-colors cursor-pointer flex items-center gap-1.5 bg-white min-h-[48px]"
          >
            <RotateCcw className="w-4 h-4 text-slate-500" /> クリア / RESET
          </button>
          
          <button
            type="button"
            onClick={() => handleSubmit()}
            disabled={!isFormValid || !selectedSheet || isSaving}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-bold uppercase tracking-wider text-xs md:text-sm rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 cursor-pointer min-h-[48px]"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> 保存中 (Inserting)...
              </>
            ) : submitted ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" /> スプレッドシートへ保存完了
              </>
            ) : (
              <>
                <Send className="w-4 h-4" /> スプレッドシートに保存 / SAVE RECORD
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};


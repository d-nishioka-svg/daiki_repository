import React, { useState } from "react";
import { motion } from "motion/react";
import { FileSpreadsheet, Plus, Link2, Check, ExternalLink, Loader2 } from "lucide-react";
import { SpreadsheetInfo } from "../types";
import { createSpreadsheet, fetchSpreadsheetInfo } from "../lib/sheets";

interface SheetSelectorProps {
  accessToken: string;
  onSheetSelected: (sheet: SpreadsheetInfo) => void;
  selectedSheet: SpreadsheetInfo | null;
}

export const SheetSelector: React.FC<SheetSelectorProps> = ({
  accessToken,
  onSheetSelected,
  selectedSheet,
}) => {
  const [activeTab, setActiveTab] = useState<"create" | "connect">("create");
  const [newTitle, setNewTitle] = useState("Clothing Tag Records / 服タグ抽出履歴");
  const [existingId, setExistingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const sheet = await createSpreadsheet(accessToken, newTitle);
      onSheetSelected(sheet);
    } catch (err: any) {
      setError(err.message || "Failed to create spreadsheet.");
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!existingId.trim()) return;

    setLoading(true);
    setError(null);
    try {
      // Direct extract of sheet ID from copy-pasted URL if the user pastes a full link
      let sheetId = existingId.trim();
      const match = sheetId.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        sheetId = match[1];
      }

      const sheet = await fetchSpreadsheetInfo(accessToken, sheetId);
      onSheetSelected(sheet);
    } catch (err: any) {
      setError(err.message || "Failed to verify or connect to spreadsheet.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 bg-emerald-50 rounded-xl text-emerald-600 border border-emerald-100">
          <FileSpreadsheet className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-800">1. Googleスプレッドシート接続設定 / Connections</h2>
          <p className="text-xs text-slate-450 font-medium whitespace-normal">データの自動保存先となるGoogleスプレッドシートを設定・自動作成します</p>
        </div>
      </div>

      {selectedSheet ? (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-emerald-50/50 border border-emerald-150 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-3xs"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 bg-emerald-100 rounded-lg text-emerald-600 mt-0.5">
              <Check className="w-4 h-4 animate-bounce" />
            </div>
            <div>
              <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest font-mono">データ保存先 接続完了 / Connected Instance</span>
              <h3 className="font-bold text-slate-800 text-sm md:text-base leading-snug line-clamp-1">
                {selectedSheet.name}
              </h3>
              <p className="text-xs text-slate-400 max-w-sm line-clamp-1 font-mono mt-0.5">ID: {selectedSheet.id}</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
            <a
              href={selectedSheet.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 hover:bg-emerald-100/90 transition-colors rounded-lg border border-emerald-200 min-h-[40px] shadow-3xs"
            >
              シートを確認する / View Sheet <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={() => {
                if(window.confirm("接続を解除しても、Googleドライブ内のスプレッドシート本体は削除されません。システムから接続を解除しますか？")) {
                  onSheetSelected(null as any);
                }
              }}
              className="px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-605 hover:text-slate-900 border border-slate-250 hover:border-slate-350 transition-all rounded-lg bg-white min-h-[40px] cursor-pointer"
            >
              接続解除 / Disconnect
            </button>
          </div>
        </motion.div>
      ) : (
        <div>
          <div className="flex flex-col sm:flex-row gap-2 p-1 bg-slate-100 rounded-xl mb-4 border border-slate-200/50">
            <button
              type="button"
              onClick={() => {
                setActiveTab("create");
                setError(null);
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                activeTab === "create" ? "bg-white text-emerald-705 shadow-3xs" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <Plus className="w-3.5 h-3.5 text-emerald-600" /> 新規シート自動作成 / NEW SHEET
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab("connect");
                setError(null);
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                activeTab === "connect" ? "bg-white text-emerald-705 shadow-3xs" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <Link2 className="w-3.5 h-3.5 text-emerald-600" /> 既存シートに接続 / CONNECT SHEET
            </button>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-100 rounded-xl text-xs font-semibold text-red-650 mb-4 whitespace-normal break-words">
              {error}
            </div>
          )}

          {activeTab === "create" ? (
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-550 mb-1.5">作成するGoogleスプレッドシート名 / Sheet Title</label>
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. 衣料品スキャン記録 / Garments Records"
                  className="w-full text-sm font-semibold px-3.5 py-3 border border-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-xl text-slate-805 transition-all bg-slate-50/20 min-h-[48px]"
                  disabled={loading}
                />
              </div>
              <button
                type="submit"
                disabled={loading || !newTitle.trim()}
                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-slate-150 disabled:text-slate-400 text-white font-bold uppercase tracking-wider text-xs md:text-sm rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xs min-h-[48px]"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                自動作成して接続 / GENERATE &amp; CONNECT
              </button>
            </form>
          ) : (
            <form onSubmit={handleConnect} className="space-y-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-550 mb-1.5">
                  共有リンク(URL) または スプレッドシートID / Link or ID
                </label>
                <input
                  type="text"
                  value={existingId}
                  onChange={(e) => setExistingId(e.target.value)}
                  placeholder="共有URL、またはd/以降の長いIDを入力してください"
                  className="w-full text-xs md:text-sm font-mono px-3.5 py-3 border border-slate-200 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-xl text-slate-805 transition-all bg-slate-50/20 min-h-[48px]"
                  disabled={loading}
                />
              </div>
              <button
                type="submit"
                disabled={loading || !existingId.trim()}
                className="w-full py-3 px-4 bg-slate-805 hover:bg-slate-900 active:bg-slate-950 disabled:bg-slate-150 disabled:text-slate-400 text-white font-bold uppercase tracking-wider text-xs md:text-sm rounded-xl transition-all cursor-pointer flex items-center justify-center gap-2 shadow-xs min-h-[48px]"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                スプレッドシートを認証して接続 / CONNECT SHEET
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};

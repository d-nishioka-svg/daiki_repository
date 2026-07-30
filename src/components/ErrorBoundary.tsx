import React from "react";
import { AlertCircle, RefreshCw, Trash2 } from "lucide-react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Without a boundary any throw during render or in an effect unmounts the whole
 * React root, leaving the operator with a blank page and no way back. This keeps
 * the failure on screen and offers a recovery that clears the scan history, which
 * is the one piece of stored state large enough to fail on its own.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled error in Tag Extractor:", error, info);
  }

  private handleClearHistoryAndReload = () => {
    try {
      localStorage.removeItem("tag_extractor_history");
    } catch (err) {
      console.warn("Could not clear stored history:", err);
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center border border-red-100 shrink-0">
              <AlertCircle className="w-5 h-5" />
            </div>
            <h1 className="text-base font-extrabold text-slate-800">
              予期しないエラーが発生しました
            </h1>
          </div>

          <p className="text-sm text-slate-600 leading-relaxed">
            画面の描画中にエラーが発生したため、処理を中断しました。
            スプレッドシートに保存済みのデータは失われていません。
          </p>

          <pre className="text-[11px] font-mono text-slate-500 bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>

          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              onClick={() => window.location.reload()}
              className="flex-1 py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              再読み込み
            </button>
            <button
              onClick={this.handleClearHistoryAndReload}
              className="flex-1 py-2.5 px-4 border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4 text-slate-500" />
              スキャン履歴を消して再読み込み
            </button>
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            ※「再読み込み」で復旧しない場合は、履歴を消してからお試しください。検品マスターと接続先スプレッドシートの設定は保持されます。
          </p>
        </div>
      </div>
    );
  }
}

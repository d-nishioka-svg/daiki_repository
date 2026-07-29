import React, { useState, useRef, useEffect, useMemo } from "react";
import {
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle,
  HelpCircle,
  Folder,
  Search,
  FolderOpen,
  Store,
  Layers,
  ArrowRight,
  Download,
  Trash2,
} from "lucide-react";
import { InspectionListItem } from "../types";

interface CsvImporterProps {
  onImport: (items: InspectionListItem[]) => void;
  onSelectStore?: (storeName: string) => void;
  currentlyLoadedCount: number;
  currentlyLoadedStoresCount: number;
  selectedStore: string;
  inspectionList: InspectionListItem[];
}

interface CachedFileInfo {
  fileName: string;
  items: InspectionListItem[];
  storeName: string;
}

// Store values arrive as "211:北エリア", so the leading digit run is the store code.
// Anchored on a non-digit boundary, otherwise "2110:西エリア" would collapse into
// the same code as "211:北エリア" and one of the two stores becomes unreachable.
export const storeCodeOf = (store: string): string | null => {
  const match = (store || "").trim().match(/^(\d+)(?=\D|$)/);
  return match ? match[1] : null;
};

// Helper to parse CSV text into InspectionListItem array
export const parseCsvText = (text: string, defaultFileName: string = ""): { items: InspectionListItem[]; storeName: string } => {
  const rawLines = text.split(/\r?\n/).map((line) => line.trim());
  
  // Check line 2 for store info like "納品先,211:北エリア（店舗名）"
  let storeFromLine2 = "";
  if (rawLines.length > 1) {
    const line2Cols = rawLines[1].split(",");
    if (line2Cols.length >= 2 && line2Cols[1]?.trim()) {
      storeFromLine2 = line2Cols[1].trim();
    }
  }

  // Find header line (typically 3rd non-empty line)
  let headerLineIndex = 2;
  let headerLine = rawLines[headerLineIndex];

  if (!headerLine || headerLine.replace(/,/g, "").trim().length === 0) {
    const indices: number[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      if (rawLines[i].replace(/,/g, "").trim().length > 0) {
        indices.push(i);
      }
    }
    if (indices.length >= 3) {
      headerLineIndex = indices[2];
      headerLine = rawLines[headerLineIndex];
    }
  }

  if (!headerLine) {
    return { items: [], storeName: "" };
  }

  const separator = text.includes("\t") ? "\t" : ",";

  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === separator && !inQuotes) {
        result.push(current.trim().replace(/^"|"$/g, ""));
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim().replace(/^"|"$/g, ""));
    return result;
  };

  const headers = parseCSVLine(headerLine).map((h) => h.trim().toLowerCase());

  let storeIdx = headers.findIndex((h) => h === "店舗名" || h === "店名" || h === "店舗名（漢字）");
  if (storeIdx === -1) storeIdx = headers.findIndex((h) => h.includes("店舗名") || h.includes("店名"));
  if (storeIdx === -1) storeIdx = headers.findIndex((h) => (h.includes("店舗") && !h.includes("コード") && !h.includes("cd")) || h.includes("店") || h.includes("store"));
  if (storeIdx === -1) storeIdx = headers.findIndex((h) => h.includes("店舗"));

  let partNumIdx = headers.findIndex((h) => h === "品番" || h === "型番" || h === "メーカー品番");
  if (partNumIdx === -1) partNumIdx = headers.findIndex((h) => h.includes("品番") || h.includes("型番") || h.includes("商品") || h.includes("コード"));

  let sizeIdx = headers.findIndex((h) => h === "サイズ" || h === "サイズ名" || h === "size");
  if (sizeIdx === -1) sizeIdx = headers.findIndex((h) => h.includes("サイズ") || h.includes("寸法") || h.includes("size"));

  let colorIdx = headers.findIndex((h) => h === "カラー" || h === "カラー名" || h === "color");
  if (colorIdx === -1) colorIdx = headers.findIndex((h) => h.includes("カラー") || h.includes("色") || h.includes("color"));

  let qtyIdx = headers.findIndex((h) => h === "枚数" || h === "数量" || h === "予定数" || h === "予定数量");
  if (qtyIdx === -1) qtyIdx = headers.findIndex((h) => h.includes("枚数") || h.includes("予定") || h.includes("数量") || h.includes("個数") || h.includes("qty"));

  if (headers.length >= 20) {
    if (partNumIdx === -1) partNumIdx = 7;
    if (colorIdx === -1) colorIdx = 8;
    if (sizeIdx === -1) sizeIdx = 9;
    if (qtyIdx === -1) qtyIdx = 11;
  }

  // Only the narrow store,part,size,color,qty layout gets a positional store
  // default. A wide layout leaves storeIdx at -1 instead of guessing: index 0
  // there is 納品日, and guessing a column produced one phantom store per
  // distinct value in it. The 納品先 preamble and the filename prefix below name
  // the store in that case. A column that only carries a store *code* is kept as
  // found — a bare "211" identifies the store perfectly well.
  if (storeIdx === -1 && headers.length < 20) storeIdx = 0;
  if (partNumIdx === -1) partNumIdx = 1;
  if (sizeIdx === -1) sizeIdx = 2;
  if (colorIdx === -1) colorIdx = 3;
  if (qtyIdx === -1) qtyIdx = 4;

  const parsedItems: InspectionListItem[] = [];
  let detectedStoreName = storeFromLine2;

  // Try extracting store number from filename e.g. "211店別納品一覧表.CSV"
  const matchStoreNumInFile = defaultFileName.match(/^(\d{3})/);
  let storePrefix = matchStoreNumInFile ? matchStoreNumInFile[1] : "";

  for (let i = headerLineIndex + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || line.replace(/,/g, "").trim().length === 0) continue;

    const cols = parseCSVLine(line);
    // storeIdx is deliberately excluded: it may be absent, and a header row wider
    // than the data rows would otherwise fail this check for every row and parse
    // the whole file as empty. The other four columns have no fallback.
    if (cols.length <= Math.max(partNumIdx, sizeIdx, colorIdx, qtyIdx)) continue;

    let store = (storeIdx >= 0 ? cols[storeIdx]?.trim() : "") || detectedStoreName || "共通";
    
    // If store is just digits or needs formatting
    if (storePrefix && !store.startsWith(storePrefix)) {
      store = `${storePrefix}:${store}`;
    }

    if (!detectedStoreName) detectedStoreName = store;

    const partNumber = cols[partNumIdx]?.trim() || "";
    const size = cols[sizeIdx]?.trim() || "フリー";
    const color = cols[colorIdx]?.trim() || "アソート";
    const qtyStr = cols[qtyIdx]?.trim() || "1";
    const expectedQty = parseInt(qtyStr, 10);

    if (!partNumber || partNumber === "品番" || partNumber.includes("メーカー") || partNumber.includes("コード")) {
      continue;
    }

    parsedItems.push({
      id: `csv_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 4)}`,
      store,
      partNumber,
      size,
      color,
      expectedQty: isNaN(expectedQty) ? 1 : expectedQty,
      actualQty: 0,
    });
  }

  return { items: parsedItems, storeName: detectedStoreName };
};

export const CsvImporter: React.FC<CsvImporterProps> = ({
  onImport,
  onSelectStore,
  currentlyLoadedCount,
  currentlyLoadedStoresCount,
  selectedStore,
  inspectionList,
}) => {
  // Network folder path & store code state
  const [folderPath, setFolderPath] = useState<string>(() => {
    return localStorage.getItem("tag_extractor_folder_path") || "\\\\192.0.1.10\\e\\CSV\\";
  });
  const [targetStoreCode, setTargetStoreCode] = useState<string>("211");
  
  // Multi-CSV file cache map: storeCode -> file contents or parsed items.
  // Only holds files picked during this session; it is intentionally not persisted.
  const [loadedFilesCache, setLoadedFilesCache] = useState<Record<string, CachedFileInfo>>({});

  // Store code -> store info derived from the master list, which IS persisted to
  // localStorage by App. loadedFilesCache is empty after a page reload, so this is
  // what keeps store switching working without re-picking the CSV files.
  const storeGroups = useMemo(() => {
    const groups: Record<string, { storeName: string; count: number }> = {};
    inspectionList.forEach((item) => {
      const store = (item.store || "").trim();
      if (!store) return;
      const key = storeCodeOf(store) ?? store;
      if (!groups[key]) {
        groups[key] = { storeName: store, count: 0 };
      }
      groups[key].count += 1;
    });
    return groups;
  }, [inspectionList]);

  // Every store the operator can switch to right now: files loaded this session
  // take precedence, and the persisted master list fills in the rest.
  const switchableStores = useMemo(() => {
    const merged: Record<string, { storeName: string; count: number }> = { ...storeGroups };
    (Object.entries(loadedFilesCache) as [string, CachedFileInfo][]).forEach(([code, file]) => {
      // Cache keys come from the filename while storeGroups keys come from the store
      // value. Normalise to the store's own code so one store cannot render as two
      // badges with the row count claimed twice.
      const key = storeCodeOf(file.storeName) ?? storeCodeOf(code) ?? code;
      merged[key] = { storeName: file.storeName, count: file.items.length };
    });
    return Object.entries(merged).sort(([a], [b]) => a.localeCompare(b));
  }, [storeGroups, loadedFilesCache]);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showHelper, setShowHelper] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Save folder path preference
  useEffect(() => {
    localStorage.setItem("tag_extractor_folder_path", folderPath);
  }, [folderPath]);

  // Decode array buffer with UTF-8 / Shift-JIS fallback
  const decodeCsvBuffer = (buffer: ArrayBuffer): string => {
    const uint8Array = new Uint8Array(buffer);
    let text = "";
    try {
      const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
      text = utf8Decoder.decode(uint8Array);
      if (text.includes("\uFFFD")) {
        throw new Error("Contains replacement characters, falling back to Shift-JIS");
      }
    } catch (err) {
      try {
        text = new TextDecoder("shift-jis").decode(uint8Array);
      } catch (sjisErr) {
        console.warn("Shift-JIS decoding fallback failed:", sjisErr);
        text = new TextDecoder("utf-8").decode(uint8Array);
      }
    }
    return text;
  };

  // Handle single or multiple file uploads
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    setError(null);
    setSuccess(null);

    const fileList = Array.from(files).filter(
      (f) => f.name.toLowerCase().endsWith(".csv") || f.type.includes("csv") || f.type.includes("text")
    );

    if (fileList.length === 0) {
      setError("選択されたフォルダ内にCSVファイルが見つかりませんでした。");
      return;
    }

    let processedCount = 0;
    const allParsedItems: InspectionListItem[] = [];
    const newCache = { ...loadedFilesCache };

    fileList.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target?.result as ArrayBuffer;
        if (buffer) {
          const text = decodeCsvBuffer(buffer);
          const { items, storeName } = parseCsvText(text, file.name);

          if (items.length > 0) {
            allParsedItems.push(...items);

            // Extract store code digits (e.g. 211)
            const codeMatch = file.name.match(/^(\d{3})/);
            const key = codeMatch ? codeMatch[1] : file.name;

            newCache[key] = {
              fileName: file.name,
              items,
              storeName: storeName || key,
            };
          }
        }

        processedCount++;
        if (processedCount === fileList.length) {
          setLoadedFilesCache(newCache);

          if (allParsedItems.length === 0) {
            setError("有効な検品データが含まれるCSVファイルが見つかりませんでした。");
            return;
          }

          // Import all loaded items into main state
          onImport(allParsedItems);

          // Find if there is a match for current target store code (e.g., 211)
          const targetKey = targetStoreCode.trim();
          const targetData = newCache[targetKey];

          if (targetData && onSelectStore) {
            onSelectStore(targetData.storeName);
            setSuccess(
              `フォルダから${fileList.length}個のCSVを登録完了！ 「${targetKey}店 (${targetData.storeName})」の検品リスト(${targetData.items.length}件)を即時セットしました。`
            );
          } else {
            const uniqueStoresCount = new Set(allParsedItems.map((i) => i.store)).size;
            setSuccess(
              `フォルダ/ファイルから計${fileList.length}個のCSVを読み込みました！（全${allParsedItems.length}件 / 店舗数:${uniqueStoresCount}）`
            );
          }
        }
      };
      reader.readAsArrayBuffer(file);
    });
  };

  // Switch store by 3-digit store code (e.g. "211")
  const handleApplyStoreByCode = (code: string) => {
    // Badges can be keyed by a store name rather than a code, and stuffing that into
    // the digits-only field built a nonsense 対象ファイル指定 path out of it.
    if (/^\d*$/.test(code.trim())) {
      setTargetStoreCode(code);
    }
    setError(null);
    setSuccess(null);

    const cleanCode = code.trim();
    if (!cleanCode) return;

    // Look up in loaded files cache first
    const cached = loadedFilesCache[cleanCode];
    if (cached) {
      if (onSelectStore) {
        onSelectStore(cached.storeName);
      }
      setSuccess(`「${cleanCode}店 (${cached.storeName})」の検品リスト（${cached.items.length}件）に切り替えました。`);
      return;
    }

    // Then the persisted master list, so switching still works after a reload
    const group = storeGroups[cleanCode];
    if (group && onSelectStore) {
      onSelectStore(group.storeName);
      setSuccess(`「${cleanCode}店 (${group.storeName})」の検品リスト（${group.count}件）に切り替えました。`);
      return;
    }

    // Finally match on the store's own leading code. This used to be a bare
    // `includes(cleanCode)`, which matched the code anywhere in the string: entering
    // "211" selected "305:第211倉庫", and a single digit "silently succeeded" against
    // an arbitrary store.
    const matchingItems = [
      ...(Object.values(loadedFilesCache) as CachedFileInfo[]).flatMap((c) => c.items),
      ...inspectionList,
    ].filter((i) => storeCodeOf(i.store) === cleanCode || i.store.trim() === cleanCode);

    if (matchingItems.length > 0 && onSelectStore) {
      const foundStoreName = matchingItems[0].store;
      onSelectStore(foundStoreName);
      setSuccess(`「${cleanCode}店 (${foundStoreName})」の検品データを適用しました。`);
    } else {
      setError(
        `「${cleanCode}店」のデータがキャッシュに見つかりません。下部の【CSV一括選択】または【${folderPath}${cleanCode}店別納品一覧表.CSV】を選択して読み込んでください。`
      );
    }
  };

  const currentExpectedFileName = `${folderPath.endsWith("\\") || folderPath.endsWith("/") ? folderPath : folderPath + "\\"}${targetStoreCode}店別納品一覧表.CSV`;

  const downloadSampleCsv = () => {
    // Real 店別納品一覧表 exports carry two preamble lines ahead of the header, and
    // parseCsvText looks for the header on the third line. The previous sample
    // started straight at the header, so re-importing it parsed as empty.
    const sampleCode = targetStoreCode.trim() || "211";
    const sampleStore = `${sampleCode}:北エリア`;
    const csvContent =
`店別納品一覧表
納品先,${sampleStore}
納品日,得意先商品コード,,,,,,メーカー品番,カラー,サイズ,,枚数,,,,,,,,店舗名
2026/3/30,4527311856981,,,,,,10573,ブラック,110,,2,,,,,,,,${sampleStore}
2026/3/30,4527311856981,,,,,,10573,モカグレー,110,,63,,,,,,,,${sampleStore}
2026/3/30,4527311856677,,,,,,1793,アイボリー,130,,17,,,,,,,,${sampleStore}
2026/3/30,4527311856684,,,,,,1773,ブラック,120,,2,,,,,,,,${sampleStore}
2026/3/30,4527311865396,,,,,,3763-1,ピンク,120,,6,,,,,,,,${sampleStore}
`;
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${targetStoreCode || "211"}店別納品一覧表.CSV`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-6 mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl border border-blue-100">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-extrabold text-slate-850 text-base md:text-lg leading-snug">
              店舗別納品CSVマスター設定（共有フォルダ連携）
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 font-medium">
              共有フォルダ内の「◯◯◯店別納品一覧表.CSV」を店舗番号で指定して即時に検品できます。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          <button
            onClick={() => setShowHelper(!showHelper)}
            className="text-xs text-slate-600 hover:text-slate-900 p-2 border border-slate-200 hover:border-slate-350 rounded-lg bg-white flex items-center gap-1.5 transition-colors cursor-pointer font-bold"
          >
            <HelpCircle className="w-4 h-4 text-slate-400" />
            使い方ガイド
          </button>
          
          <button
            onClick={downloadSampleCsv}
            className="text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50/50 p-2 border border-blue-200 rounded-lg bg-white flex items-center gap-1.5 transition-colors cursor-pointer font-bold"
          >
            <Download className="w-4 h-4" />
            サンプルCSV({targetStoreCode || "211"})
          </button>
        </div>
      </div>

      {showHelper && (
        <div className="mb-5 p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-650 leading-relaxed space-y-2">
          <p className="font-bold text-slate-800">💡 フォルダパス＆店舗番号入力システムの使い方：</p>
          <ol className="list-decimal list-inside space-y-1.5 pl-1 font-medium">
            <li>
              <strong>【フォルダパス設定】</strong>：お使いの共有フォルダ（例: <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-800">\\192.0.1.10\e\CSV\</code>）のパスを入力・確認します。
            </li>
            <li>
              <strong>【店舗番号指定】</strong>：検品したい店舗の3桁の数字（例: <code className="bg-slate-200 px-1 py-0.5 rounded text-slate-800">211</code>）を入力します。対象のファイル名（例: <code className="bg-blue-100 text-blue-800 px-1 py-0.5 rounded">211店別納品一覧表.CSV</code>）が自動構成されます。
            </li>
            <li>
              <strong>【CSV一括読み込み】</strong>：「CSVフォルダを選択」またはファイルを一度ドロップすると、フォルダ内の全店舗CSVが登録され、店舗コード（211, 212等）の入力や切り替えだけで該当店舗の検品マスタが瞬時に読み込まれます！
            </li>
          </ol>
        </div>
      )}

      {/* 1. Network Folder Path & Store Code Quick Selector Box */}
      <div className="bg-slate-900 rounded-xl p-4 md:p-5 text-white mb-5 shadow-xs space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          
          {/* Folder Path Input */}
          <div className="lg:col-span-7 space-y-1.5">
            <label className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Folder className="w-3.5 h-3.5 text-blue-400" />
              対象フォルダパス（控え用メモ）
            </label>
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="\\192.0.1.10\e\CSV\"
              className="w-full bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-lg px-3 py-2 text-xs md:text-sm font-mono text-slate-100 focus:outline-none transition-all"
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">
              ※ブラウザの制約上、このパスから自動でCSVを読み込むことはできません。実際の読み込みは下部の【CSVフォルダを一括選択】から行ってください。
            </p>
          </div>

          {/* Store Code Input (3 Digits) */}
          <div className="lg:col-span-5 space-y-1.5">
            <label className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Store className="w-3.5 h-3.5 text-emerald-400" />
              検品対象の店舗番号（数字3桁）
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  maxLength={10}
                  value={targetStoreCode}
                  onChange={(e) => {
                    const val = e.target.value;
                    setTargetStoreCode(val);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleApplyStoreByCode(targetStoreCode);
                    }
                  }}
                  placeholder="211"
                  className="w-full bg-slate-800 border border-slate-700 focus:border-emerald-500 rounded-lg pl-3 pr-8 py-2 text-sm font-extrabold font-mono text-emerald-400 tracking-wider focus:outline-none transition-all"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                  店
                </span>
              </div>
              
              <button
                onClick={() => handleApplyStoreByCode(targetStoreCode)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs rounded-lg flex items-center gap-1.5 transition-all cursor-pointer shrink-0 active:scale-95 shadow-sm"
              >
                <Search className="w-3.5 h-3.5" />
                店舗切替
              </button>
            </div>
          </div>

        </div>

        {/* Target File Name Indicator */}
        <div className="pt-2 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between text-xs text-slate-400 gap-2 font-mono">
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="text-slate-400 shrink-0 font-bold font-sans">対象ファイル指定:</span>
            <span className="text-blue-300 bg-slate-850 border border-slate-700 px-2.5 py-1 rounded-md text-[11px] truncate font-bold">
              {currentExpectedFileName}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] text-slate-400 font-sans">現在検品選択中:</span>
            <span className="text-emerald-400 font-extrabold font-sans bg-emerald-950/60 border border-emerald-800/80 px-2 py-0.5 rounded">
              {selectedStore || `${targetStoreCode}店`}
            </span>
          </div>
        </div>
      </div>

      {/* CSV Status Summary */}
      {currentlyLoadedCount > 0 && (
        <div className="mb-4 px-4 py-3 bg-emerald-50 border border-emerald-150 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between text-xs text-emerald-800 font-medium gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span>
              検品マスター登録中: <strong>{currentlyLoadedCount}型番</strong> ({currentlyLoadedStoresCount}店舗分キャッシュ済)
            </span>
          </div>
          <button
            onClick={() => {
              if (window.confirm("現在読み込まれている全店舗の検品マスターデータをクリアしますか？")) {
                onImport([]);
                setLoadedFilesCache({});
                setSuccess(null);
                setError(null);
              }
            }}
            className="text-[11px] text-rose-600 hover:text-rose-700 font-bold border border-rose-200 bg-white hover:bg-rose-50 px-3 py-1 rounded-lg transition-colors cursor-pointer self-start sm:self-auto flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            マスター全クリア
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start gap-2 leading-relaxed">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
          <span>{error}</span>
        </div>
      )}

      {success && (
        <div className="mb-4 p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 flex items-start gap-2 leading-relaxed">
          <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
          <span>{success}</span>
        </div>
      )}

      {/* Loaded Stores Fast Switch Badges (If multi CSVs loaded) */}
      {switchableStores.length > 0 && (
        <div className="mb-5 p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-blue-600" />
            切替可能な店舗一覧 ({switchableStores.length}店舗):
            <span className="text-[10px] text-slate-400 font-normal">（クリックでその店舗の検品に切り替え可能）</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {switchableStores.map(([codeKey, storeData]) => {
              // Compare on the store's own code, not `selectedStore.includes(codeKey)`:
              // that matched a code anywhere in the name, so selecting "305:第211倉庫"
              // lit up the 211 badge as well.
              const isSelected =
                storeCodeOf(selectedStore) === codeKey || selectedStore === storeData.storeName;
              return (
                <button
                  key={codeKey}
                  onClick={() => handleApplyStoreByCode(codeKey)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-extrabold transition-all cursor-pointer flex items-center gap-1.5 ${
                    isSelected
                      ? "bg-emerald-600 text-white shadow-xs scale-105 ring-2 ring-emerald-300"
                      : "bg-white text-slate-700 border border-slate-200 hover:border-slate-350 hover:bg-slate-100"
                  }`}
                  title={storeData.storeName}
                >
                  <span>{/^\d{3}$/.test(codeKey) ? `${codeKey}店` : codeKey}</span>
                  <span className={`text-[10px] font-normal ${isSelected ? "text-emerald-100" : "text-slate-400"}`}>
                    ({storeData.count}件)
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. Upload / Folder Drop Action Panel */}
      <div className="border-2 border-dashed border-slate-200 hover:border-blue-400 rounded-xl p-5 bg-slate-50/50 hover:bg-blue-50/20 transition-all text-center">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id="csv-files-input"
        />

        <input
          ref={folderInputRef}
          type="file"
          // @ts-ignore - webkitdirectory is non-standard HTML attribute supported by modern browsers
          webkitdirectory="true"
          // @ts-ignore
          directory="true"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
          id="csv-folder-input"
        />

        <div className="max-w-md mx-auto space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-blue-100 text-blue-600 flex items-center justify-center border border-blue-200">
            <FolderOpen className="w-6 h-6" />
          </div>

          <div>
            <h4 className="font-extrabold text-slate-800 text-sm">
              共有フォルダ内のCSVファイル（{targetStoreCode}店別納品一覧表.CSV）を読み込む
            </h4>
            <p className="text-xs text-slate-500 mt-1">
              フォルダ内の「◯◯◯店別納品一覧表.CSV」を一括で選択またはドロップすると、全店舗の検品マスタを保持できます。
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              onClick={() => folderInputRef.current?.click()}
              className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-extrabold rounded-xl text-xs flex items-center gap-2 transition-all cursor-pointer shadow-xs active:scale-95"
            >
              <FolderOpen className="w-4 h-4 text-white" />
              CSVフォルダを一括選択
            </button>

            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl text-xs flex items-center gap-2 transition-all cursor-pointer shadow-xs active:scale-95"
            >
              <Upload className="w-4 h-4 text-white/80" />
              単一/複数CSVファイル選択 ({targetStoreCode}店別納品一覧表.CSV)
            </button>
          </div>

          <p className="text-[11px] text-slate-400 font-medium">
            ※または対象のCSVファイル（例: 211店別納品一覧表.CSV）をここに直接ドラッグ＆ドロップできます
          </p>
        </div>
      </div>
    </div>
  );
};

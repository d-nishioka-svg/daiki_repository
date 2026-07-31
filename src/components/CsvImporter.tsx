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
import {
  clearFolderHandle,
  ensureReadPermission,
  isFolderAccessSupported,
  listStoreCodes,
  loadFolderHandle,
  pickFolder,
  readStoreCsv,
} from "../lib/folderAccess";

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
  
  // Check line 2 for store info like "取引先名,211:北海道三喜【手入力】"
  let storeFromLine2 = "";
  if (rawLines.length > 1) {
    const line2Cols = rawLines[1].split(",");
    if (line2Cols.length >= 2 && line2Cols[1]?.trim()) {
      // Drop the 【手入力】-style annotation so the same customer always produces the
      // same store name regardless of how the export was generated.
      storeFromLine2 = line2Cols[1].replace(/【[^】]*】/g, "").trim();
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

  // 店別発注一覧表 exports do not line their header row up with their data rows:
  // the quantity sits under the ｶﾗｰ heading at index 11 while 数量計 at index 15 is
  // blank, and the JAN code at index 1 is headed 相手先商品ｺｰﾄﾞ while the part
  // number is 自社品番 at index 7. Searching by name therefore picks the JAN code
  // (it contains "商品") and an empty quantity column, which imported every row as
  // "part number = barcode, quantity = 1" — nothing a scanned tag could ever match.
  // For this layout the column positions are authoritative, not the headings.
  const isOrderSheetLayout =
    headers.length >= 20 &&
    headers.some((h) => h.includes("自社品番")) &&
    headers.some((h) => h.includes("店舗"));

  if (isOrderSheetLayout) {
    partNumIdx = 7;
    colorIdx = 8;
    sizeIdx = 9;
    qtyIdx = 11;
    // One file is one delivery for one customer code, so the file itself is the
    // inspection unit. The row-level 店舗名 names the branch inside it and must not
    // split the master into several stores.
    storeIdx = -1;
  } else if (headers.length >= 20) {
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

  // Collapses repeats of the same store/part/size/colour into one master row.
  const aggregated = new Map<string, InspectionListItem>();

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

    // One garment spec is one master row. These files repeat the same
    // part/size/colour once per branch, and the reconciliation matches on those
    // three fields, so leaving them as separate rows made every scan count against
    // each copy. Sum them instead.
    //
    // The id is derived from the row's own contents rather than Date.now() and a
    // random suffix: 変更数 overrides are keyed by it and persisted, so a re-import
    // of the same file used to orphan every override and silently revert a
    // corrected "not delivered: 0" back to the CSV quantity.
    const identity = `${store}|${partNumber}|${size}|${color}`;
    const qty = isNaN(expectedQty) ? 1 : expectedQty;
    const existing = aggregated.get(identity);

    if (existing) {
      existing.expectedQty += qty;
    } else {
      aggregated.set(identity, {
        id: `csv_${identity}`,
        store,
        partNumber,
        size,
        color,
        expectedQty: qty,
        actualQty: 0,
      });
    }
  }

  parsedItems.push(...aggregated.values());

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

  // Handle to the shared CSV folder. Once granted, entering a store code reads
  // that store's file straight out of the folder with no further dialog.
  const [folderHandle, setFolderHandle] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [folderCodes, setFolderCodes] = useState<string[]>([]);
  const [isReadingFolder, setIsReadingFolder] = useState(false);
  const folderAccessSupported = isFolderAccessSupported();

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
  const [confirmClearMaster, setConfirmClearMaster] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Save folder path preference
  useEffect(() => {
    localStorage.setItem("tag_extractor_folder_path", folderPath);
  }, [folderPath]);

  // Restore the previously chosen folder. Only re-list it when the permission is
  // still live — asking for it here would be outside a user gesture and fail.
  useEffect(() => {
    if (!folderAccessSupported) return;
    let cancelled = false;

    (async () => {
      const handle = await loadFolderHandle();
      if (!handle || cancelled) return;
      setFolderHandle(handle);
      if (await ensureReadPermission(handle, { promptIfNeeded: false })) {
        const codes = await listStoreCodes(handle);
        if (!cancelled) setFolderCodes(codes);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [folderAccessSupported]);

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

  const handleChooseFolder = async () => {
    setError(null);
    setSuccess(null);

    const handle = await pickFolder();
    if (!handle) return;

    setFolderHandle(handle);
    const codes = await listStoreCodes(handle);
    setFolderCodes(codes);
    setSuccess(
      codes.length > 0
        ? `フォルダ「${handle.name}」を登録しました。${codes.length}店舗ぶんのCSVが見つかりました。以後は店舗番号を入れるだけで読み込めます。`
        : `フォルダ「${handle.name}」を登録しました。ただし「◯◯◯店別納品一覧表.CSV」形式のファイルは見つかりませんでした。`,
    );
  };

  const handleForgetFolder = async () => {
    await clearFolderHandle();
    setFolderHandle(null);
    setFolderCodes([]);
    setSuccess("登録済みフォルダを解除しました。");
  };

  /**
   * Reads that store's CSV straight out of the registered folder. This is the
   * path the operator actually wants: type 211, get 211's delivery list.
   */
  const handleLoadFromFolder = async (code: string): Promise<boolean> => {
    const cleanCode = code.trim();
    if (!folderHandle || !cleanCode) return false;

    setIsReadingFolder(true);
    try {
      if (!(await ensureReadPermission(folderHandle))) {
        setError(
          "フォルダへのアクセスが許可されませんでした。「フォルダを選択」からもう一度許可してください。",
        );
        return false;
      }

      const csv = await readStoreCsv(folderHandle, cleanCode);
      if (!csv) {
        setError(
          `フォルダ「${folderHandle.name}」内に「${cleanCode}店別納品一覧表.CSV」が見つかりません。` +
            (folderCodes.length > 0
              ? `（見つかっている店舗番号: ${folderCodes.join(", ")}）`
              : ""),
        );
        return false;
      }

      const { items, storeName } = parseCsvText(decodeCsvBuffer(csv.buffer), csv.fileName);
      if (items.length === 0) {
        setError(`「${csv.fileName}」から有効な検品データを読み取れませんでした。`);
        return false;
      }

      const resolvedStore = storeName || `${cleanCode}店`;
      setLoadedFilesCache((prev) => ({
        ...prev,
        [cleanCode]: { fileName: csv.fileName, items, storeName: resolvedStore },
      }));
      onImport(items);
      if (onSelectStore) onSelectStore(resolvedStore);

      const totalQty = items.reduce((sum, item) => sum + item.expectedQty, 0);
      setSuccess(
        `「${csv.fileName}」を読み込みました。${resolvedStore} / ${items.length}型番 / 予定 ${totalQty}点 の検品を開始できます。`,
      );
      return true;
    } catch (err: any) {
      console.error("Reading the store CSV from the folder failed:", err);
      setError(`フォルダからの読み込みに失敗しました: ${err?.message ?? err}`);
      return false;
    } finally {
      setIsReadingFolder(false);
    }
  };

  // Switch store by 3-digit store code (e.g. "211")
  const handleApplyStoreByCode = async (code: string) => {
    // Badges can be keyed by a store name rather than a code, and stuffing that into
    // the digits-only field built a nonsense 対象ファイル指定 path out of it.
    if (/^\d*$/.test(code.trim())) {
      setTargetStoreCode(code);
    }
    setError(null);
    setSuccess(null);

    const cleanCode = code.trim();
    if (!cleanCode) return;

    // The registered folder is the authority: it always has the current file, so
    // read it rather than serving a master list left over from an earlier import.
    if (folderHandle && /^\d{3}$/.test(cleanCode)) {
      if (await handleLoadFromFolder(cleanCode)) return;
      // Reading failed and said why; fall through to whatever is already loaded.
    }

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
            <h3 className="font-extrabold text-slate-800 text-base md:text-lg leading-snug">
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
            className="text-xs text-slate-600 hover:text-slate-900 p-2 border border-slate-200 hover:border-slate-300 rounded-lg bg-white flex items-center gap-1.5 transition-colors cursor-pointer font-bold"
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
        <div className="mb-5 p-4 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-600 leading-relaxed space-y-2">
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
              対象フォルダパス
            </label>
            <input
              type="text"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="\\192.0.1.10\e\CSV\"
              className="w-full bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-lg px-3 py-2 text-xs md:text-sm font-mono text-slate-100 focus:outline-none transition-all"
            />

            {/* A browser cannot open a typed path — there is no API for it. The
                operator grants access to that folder once here, and from then on
                the store code alone is enough to read the file. */}
            {folderAccessSupported ? (
              folderHandle ? (
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-800/80 px-2.5 py-1 rounded-md">
                    <CheckCircle className="w-3.5 h-3.5" />
                    フォルダ登録済: {folderHandle.name}
                    {folderCodes.length > 0 && `（${folderCodes.length}店舗）`}
                  </span>
                  <button
                    onClick={handleChooseFolder}
                    className="text-[11px] font-bold text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    変更
                  </button>
                  <button
                    onClick={handleForgetFolder}
                    className="text-[11px] font-bold text-slate-400 hover:text-rose-300 px-1.5 py-1 rounded-md transition-colors cursor-pointer"
                  >
                    解除
                  </button>
                </div>
              ) : (
                <div className="pt-0.5 space-y-1.5">
                  <button
                    onClick={handleChooseFolder}
                    className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-lg flex items-center gap-2 transition-all cursor-pointer active:scale-95 shadow-sm"
                  >
                    <FolderOpen className="w-4 h-4" />
                    このフォルダを登録する（初回のみ）
                  </button>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    ※ブラウザはパス文字列だけではフォルダを開けません。一度だけ上のボタンで
                    上記フォルダを選んで許可すると、以降は店舗番号を入れるだけで該当CSVを直接読み込めます。
                  </p>
                </div>
              )
            ) : (
              <p className="text-[10px] text-amber-300/90 leading-relaxed pt-0.5">
                ※このブラウザはフォルダ登録に対応していません（Chrome / Edge のみ）。
                下部の【CSVフォルダを一括選択】から読み込んでください。
              </p>
            )}
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
                disabled={isReadingFolder}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white font-extrabold text-xs rounded-lg flex items-center gap-1.5 transition-all cursor-pointer shrink-0 active:scale-95 shadow-sm"
              >
                <Search className={`w-3.5 h-3.5 ${isReadingFolder ? "animate-pulse" : ""}`} />
                {isReadingFolder ? "読込中..." : folderHandle ? "読み込む" : "店舗切替"}
              </button>
            </div>
          </div>

        </div>

        {/* Target File Name Indicator */}
        <div className="pt-2 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between text-xs text-slate-400 gap-2 font-mono">
          <div className="flex items-center gap-2 overflow-hidden">
            <span className="text-slate-400 shrink-0 font-bold font-sans">対象ファイル指定:</span>
            <span className="text-blue-300 bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-md text-[11px] truncate font-bold">
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
        <div className="mb-4 px-4 py-3 bg-emerald-50 border border-emerald-100 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between text-xs text-emerald-800 font-medium gap-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span>
              検品マスター登録中: <strong>{currentlyLoadedCount}型番</strong> ({currentlyLoadedStoresCount}店舗分キャッシュ済)
            </span>
          </div>
          {/* Confirmed inline rather than with window.confirm: the app is served
              inside a sandboxed iframe that blocks native dialogs, and a blocked
              confirm returns false, so the button silently did nothing. */}
          {confirmClearMaster ? (
            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
              <span className="text-[11px] font-bold text-rose-700">
                全{currentlyLoadedStoresCount}店舗分を削除します。よろしいですか？
              </span>
              <button
                onClick={() => {
                  onImport([]);
                  setLoadedFilesCache({});
                  setError(null);
                  setSuccess("検品マスターデータをすべてクリアしました。");
                  setConfirmClearMaster(false);
                }}
                className="text-[11px] text-white font-extrabold bg-rose-600 hover:bg-rose-700 px-3 py-1 rounded-lg transition-colors cursor-pointer"
              >
                削除する
              </button>
              <button
                onClick={() => setConfirmClearMaster(false)}
                className="text-[11px] text-slate-600 hover:text-slate-900 font-bold border border-slate-200 bg-white hover:bg-slate-50 px-3 py-1 rounded-lg transition-colors cursor-pointer"
              >
                やめる
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClearMaster(true)}
              className="text-[11px] text-rose-600 hover:text-rose-700 font-bold border border-rose-200 bg-white hover:bg-rose-50 px-3 py-1 rounded-lg transition-colors cursor-pointer self-start sm:self-auto flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              マスター全クリア
            </button>
          )}
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
                      : "bg-white text-slate-700 border border-slate-200 hover:border-slate-300 hover:bg-slate-100"
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

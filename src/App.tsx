import React, { useState, useEffect } from "react";
import { User } from "firebase/auth";
import { initAuth, googleSignIn, logout, isEmbedded } from "./lib/auth";
import { appendRow, isAuthError } from "./lib/sheets";
import { playTone } from "./lib/audio";
import { TagData, ScanHistoryEntry, SpreadsheetInfo, InspectionListItem } from "./types";
import { SheetSelector } from "./components/SheetSelector";
import { CameraStream } from "./components/CameraStream";
import { ManualUpload } from "./components/ManualUpload";
import { ScanResultForm } from "./components/ScanResultForm";
import { HistoryList } from "./components/HistoryList";
import { CsvImporter } from "./components/CsvImporter";
import { InspectionStatusTable } from "./components/InspectionStatusTable";
import {
  Sparkles,
  LogOut,
  Camera,
  FileUp,
  AlertCircle,
  Settings,
  CheckCircle,
  HelpCircle,
  History,
  PenTool,
  Upload,
  ArrowRight,
  RefreshCw,
  MapPin,
  ListCheck,
  CheckCircle2,
  ChevronRight,
  Trash2,
} from "lucide-react";

// The desktop and mobile workspaces were both mounted and merely hidden with CSS
// (`hidden lg:grid` / `block lg:hidden`), so two CameraStream instances opened the
// camera and each ran its own auto-capture loop. Render only the visible one.
// 1024px is Tailwind's `lg` breakpoint.
const useIsDesktop = () => {
  const query = "(min-width: 1024px)";
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) =>
      setIsDesktop(event.matches);
    setIsDesktop(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isDesktop;
};

// Google will only hand a sign-in result back to an address it has been told to
// trust, and the AI Studio preview is served from a throwaway host whose name
// changes every time the app is rebuilt, so it can never be on that list. That
// leaves the preview stuck on the login screen even though the rest of the app
// works there. Vite sets DEV only when the dev server is serving, so this is
// false in the published build and the bypass cannot reach production.
const isPreviewEnvironment = (): boolean => import.meta.env.DEV === true;

// A localStorage write must never take the app down. These run inside effects, so
// a QuotaExceededError propagates out of the commit phase and unmounts the React
// root: the operator gets a blank screen and loses the session mid-inspection.
const persist = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch (err) {
    console.warn(`Could not persist "${key}" to localStorage:`, err);
  }
};

export default function App() {
  const isDesktop = useIsDesktop();
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);
  // Google OAuth access tokens last about an hour and nothing refreshes them, so
  // mid-shift every save starts failing. Failed rows are excluded from the counts,
  // which made the ledger quietly stop advancing while the header still claimed
  // the sheet was connected. Surface it and offer an in-place re-auth.
  const [tokenExpired, setTokenExpired] = useState<boolean>(false);
  // Signed-out preview of the interface, for working on the app where sign-in
  // cannot complete. Everything that needs Google stays disabled.
  const [previewMode, setPreviewMode] = useState<boolean>(false);

  // App settings state
  const [selectedSheet, setSelectedSheet] = useState<SpreadsheetInfo | null>(
    null,
  );
  const [inputTab, setInputTab] = useState<"camera" | "upload">("camera");
  const [batchModeEnabled, setBatchModeEnabled] = useState<boolean>(false);
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<
    "settings" | "scan" | "edit" | "history" | "inspection_csv"
  >("scan");
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);

  // New inspection list & store tracking workflow states
  const [inspectionList, setInspectionList] = useState<InspectionListItem[]>([]);
  const [selectedStore, setSelectedStore] = useState<string>("新宿店");
  const [workflowStep, setWorkflowStep] = useState<"store_select" | "scanning" | "results">("store_select");

  // Retro Terminal UI specific states
  const [orderNo, setOrderNo] = useState<string>("011602");
  const [packingNo, setPackingNo] = useState<string>("555760001282");
  const [processingDate, setProcessingDate] = useState<string>("2026/05/21");
  const [changedQtyOverrides, setChangedQtyOverrides] = useState<Record<string, number>>({});

  // History row the review form is editing, so saving updates that row instead of
  // appending a second one for the same physical garment.
  const [pendingEntryId, setPendingEntryId] = useState<string | null>(null);

  // Deduplication state for continuous scanning flow. Keyed on part+size+colour so
  // a different colour of the same style is not mistaken for a re-read.
  const [lastScannedIdentity, setLastScannedIdentity] = useState<string | null>(
    null,
  );
  const [lastScanTime, setLastScanTime] = useState<number>(0);

  // Scanning engine state
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<TagData | null>(null);
  const [capturedImageBase64, setCapturedImageBase64] = useState<string | null>(
    null,
  );
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Session scanning history
  const [history, setHistory] = useState<ScanHistoryEntry[]>([]);

  // Feedback tones. These go through the shared AudioContext in lib/audio: a fresh
  // context per beep hit the browser's concurrent-context cap after a few scans
  // and every sound went silently dead.
  const playWarningBeep = () => {
    playTone(440, 0.15, { gain: 0.12, type: "sawtooth" });
    playTone(330, 0.25, { delay: 0.1, gain: 0.12, type: "sawtooth" });
  };

  const playSuccessChirp = () => {
    playTone(587.33, 0.12, { gain: 0.08 });
    playTone(880, 0.25, { delay: 0.08, gain: 0.08 });
  };

  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const [overscanAlert, setOverscanAlert] = useState<{
    partNumber: string;
    size: string;
    color: string;
    expectedQty: number;
    scannedQty: number;
    onAccept: () => void;
    onCancel: () => void;
  } | null>(null);

  const [uninspectedAlert, setUninspectedAlert] = useState<{
    uninspectedCount: number;
    onConfirm: () => void;
  } | null>(null);

  const [nonMasterAlert, setNonMasterAlert] = useState<{
    partNumber: string;
    size: string;
    color: string;
    onAccept: () => void;
    onCancel: () => void;
  } | null>(null);

  // 1. Initial Authentication Check
  useEffect(() => {
    const unsubscribe = initAuth(
      (currentUser, cachedToken) => {
        setUser(currentUser);
        setToken(cachedToken);
        setNeedsAuth(false);
      },
      () => {
        setNeedsAuth(true);
      },
    );

    // Load preferences from localStorage if exists
    try {
      const storedSheet = localStorage.getItem("tag_extractor_sheet");
      if (storedSheet) {
        setSelectedSheet(JSON.parse(storedSheet));
      }
      const storedBatchMode = localStorage.getItem("tag_extractor_batchmode");
      if (storedBatchMode) {
        setBatchModeEnabled(storedBatchMode === "true");
      }
      const storedAutoScan = localStorage.getItem("tag_extractor_autoscan");
      if (storedAutoScan) {
        setAutoScanEnabled(storedAutoScan === "true");
      }
      const storedHistory = localStorage.getItem("tag_extractor_history");
      if (storedHistory) {
        setHistory(JSON.parse(storedHistory));
      }
      const storedInspectionList = localStorage.getItem("tag_extractor_inspection_list");
      if (storedInspectionList) {
        setInspectionList(JSON.parse(storedInspectionList));
      }
      const storedSelectedStore = localStorage.getItem("tag_extractor_selected_store");
      if (storedSelectedStore) {
        setSelectedStore(storedSelectedStore);
      }
      const storedStep = localStorage.getItem("tag_extractor_step");
      if (storedStep) {
        setWorkflowStep(storedStep as any);
      }
      const storedOrderNo = localStorage.getItem("tag_extractor_order_no");
      if (storedOrderNo) {
        setOrderNo(storedOrderNo);
      }
      const storedPackingNo = localStorage.getItem("tag_extractor_packing_no");
      if (storedPackingNo) {
        setPackingNo(storedPackingNo);
      }
      const storedProcessingDate = localStorage.getItem("tag_extractor_processing_date");
      if (storedProcessingDate) {
        setProcessingDate(storedProcessingDate);
      }
      const storedQtyOverrides = localStorage.getItem("tag_extractor_changed_qty_overrides");
      if (storedQtyOverrides) {
        setChangedQtyOverrides(JSON.parse(storedQtyOverrides));
      }
    } catch (e) {
      console.warn("Could not load stored state of Tag Extractor settings:", e);
    }

    return () => {
      unsubscribe();
    };
  }, []);

  // Save selected spreadsheet coordinates to persistent client localstorage
  useEffect(() => {
    persist(
      "tag_extractor_sheet",
      selectedSheet ? JSON.stringify(selectedSheet) : null,
    );
  }, [selectedSheet]);

  // Save auto-save configuration state to localstorage
  useEffect(() => {
    persist("tag_extractor_batchmode", batchModeEnabled ? "true" : "false");
  }, [batchModeEnabled]);

  // Save auto-scan configuration state to localstorage
  useEffect(() => {
    persist("tag_extractor_autoscan", autoScanEnabled ? "true" : "false");
  }, [autoScanEnabled]);

  // Save history state to localstorage
  useEffect(() => {
    if (history.length > 0) {
      // previewImage is a base64 JPEG worth tens of KB per scan. Persisting it
      // exhausted the ~5MB quota after a few dozen scans, and because the failed
      // write also survives a reload the app could not be started again. The
      // thumbnails stay in memory for the session; HistoryList already falls back
      // to a placeholder icon for entries without one.
      const withoutPreviews = history.map(
        ({ previewImage, ...entry }) => entry,
      );
      persist("tag_extractor_history", JSON.stringify(withoutPreviews));
    } else {
      persist("tag_extractor_history", null);
    }
  }, [history]);

  // Save inspection list configuration state to localstorage
  useEffect(() => {
    persist(
      "tag_extractor_inspection_list",
      inspectionList.length > 0 ? JSON.stringify(inspectionList) : null,
    );
  }, [inspectionList]);

  // Save selected store state to localstorage
  useEffect(() => {
    persist("tag_extractor_selected_store", selectedStore || null);
  }, [selectedStore]);

  // Save active workflow step to localstorage
  useEffect(() => {
    persist("tag_extractor_step", workflowStep);
  }, [workflowStep]);

  // Save retro settings to localstorage when they change
  useEffect(() => {
    persist("tag_extractor_order_no", orderNo);
  }, [orderNo]);

  useEffect(() => {
    persist("tag_extractor_packing_no", packingNo);
  }, [packingNo]);

  useEffect(() => {
    persist("tag_extractor_processing_date", processingDate);
  }, [processingDate]);

  const handleQtyOverrideChange = (rowId: string, val: number) => {
    const updated = { ...changedQtyOverrides, [rowId]: val };
    setChangedQtyOverrides(updated);
    persist("tag_extractor_changed_qty_overrides", JSON.stringify(updated));
  };

  const handleAdjustQty = (partNumber: string, size: string, color: string, increment: boolean) => {
    const normP = partNumber.trim().toUpperCase();
    const normS = (size || "").trim().toUpperCase();
    const normC = (color || "").trim().toUpperCase();

    // The table renders a blank size or colour as "ー", but the history entry it
    // has to match still holds the empty string, so accept either spelling.
    const matchesAdjustTarget = (entry: ScanHistoryEntry) => {
      const entrySize = (entry.size || "").trim().toUpperCase();
      const entryColor = (entry.color || "").trim().toUpperCase();
      const sizeMatches = entrySize === normS || (!entrySize && normS === "ー");
      const colorMatches = entryColor === normC || (!entryColor && normC === "ー");
      return (
        entry.store === selectedStore &&
        entry.partNumber.trim().toUpperCase() === normP &&
        sizeMatches &&
        colorMatches
      );
    };

    if (increment) {
      const timestamp = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const newEntry: ScanHistoryEntry = {
        id: "adj_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
        time: timestamp,
        partNumber: partNumber,
        size: size || "ー",
        color: color || "ー",
        // A manual bump writes nothing to the spreadsheet, so it must not claim to
        // be synced. "pending" still counts towards the ledger and the history feed
        // offers a 保存 button to push it to the sheet.
        status: "pending",
        store: selectedStore,
      };
      setHistory((prev) => [newEntry, ...prev]);
      setSuccessMessage(
        `「${partNumber} (${size} / ${color})」の検品数を1増やしました。スプレッドシートへは履歴の「保存」から反映してください。`,
      );
    } else {
      // Resolve the row inside the updater: computing an index against the closure's
      // history and applying it to a later array deleted a different SKU's row
      // whenever a scan prepended an entry in the same batch. Prefer a row that was
      // never written to the sheet so the local count cannot drift below it, and
      // never touch one whose append is still in flight.
      const removable = (entry: ScanHistoryEntry) =>
        matchesAdjustTarget(entry) &&
        entry.status !== "failed" &&
        entry.status !== "extracting" &&
        entry.status !== "saving";

      if (!history.some(removable)) {
        setGeneralError("減らせる検品済レコードが見つかりません。");
        return;
      }

      setHistory((prev) => {
        const candidates = prev.filter(removable);
        if (candidates.length === 0) return prev;
        const target =
          candidates.find((entry) => entry.status === "pending") ?? candidates[0];
        return prev.filter((entry) => entry !== target);
      });
      setSuccessMessage(
        `「${partNumber} (${size} / ${color})」の検品数を1減らしました。`,
      );
    }
  };

  const handleClearStoreHistory = () => {
    setConfirmModal({
      title: "店舗検品リセット",
      message: `${selectedStore}の検品スキャン結果をリセットし、現在数を0に戻しますか？ (※スプレッドシートの過去ログは消えません)`,
      onConfirm: () => {
        setHistory((prev) => prev.filter((e) => e.store !== selectedStore));
        setSuccessMessage(`「${selectedStore}」の検品スキャン結果をリセットしました。`);
        setConfirmModal(null);
      }
    });
  };

  const handleProceedToResults = () => {
    // Check for uninspected items
    const storeItems = inspectionList.filter(item => item.store === selectedStore);
    const storeHistory = history.filter(
      entry => entry.store === selectedStore && entry.status !== "failed" && entry.status !== "extracting"
    );

    const uninspectedRows = storeItems.filter(masterItem => {
      const normP = masterItem.partNumber.trim().toUpperCase();
      const normS = (masterItem.size || "").trim().toUpperCase();
      const normC = (masterItem.color || "").trim().toUpperCase();

      const matchedQty = storeHistory.filter(entry => {
        return (
          entry.partNumber.trim().toUpperCase() === normP &&
          (entry.size || "").trim().toUpperCase() === normS &&
          (entry.color || "").trim().toUpperCase() === normC
        );
      }).length;

      const expected = changedQtyOverrides[masterItem.id] ?? masterItem.expectedQty;
      return matchedQty < expected;
    });

    if (uninspectedRows.length > 0) {
      playWarningBeep();
      const totalShort = uninspectedRows.reduce((sum, masterItem) => {
        const normP = masterItem.partNumber.trim().toUpperCase();
        const normS = (masterItem.size || "").trim().toUpperCase();
        const normC = (masterItem.color || "").trim().toUpperCase();

        const matchedQty = storeHistory.filter(entry => {
          return (
            entry.partNumber.trim().toUpperCase() === normP &&
            (entry.size || "").trim().toUpperCase() === normS &&
            (entry.color || "").trim().toUpperCase() === normC
          );
        }).length;

        const expected = changedQtyOverrides[masterItem.id] ?? masterItem.expectedQty;
        return sum + (expected - matchedQty);
      }, 0);

      setUninspectedAlert({
        uninspectedCount: totalShort,
        onConfirm: () => {
          setUninspectedAlert(null);
          setWorkflowStep("results");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    } else {
      setWorkflowStep("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // 2. Authentication handlers
  const handleLogin = async () => {
    setIsLoggingIn(true);
    setGeneralError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setToken(result.accessToken);
        setNeedsAuth(false);
      } else {
        // null means redirect fallback was triggered due to popup block
        setGeneralError("Popup blocked. Redirecting to Google Sign-in...");
      }
    } catch (err: any) {
      console.error("Login failed:", err);
      if (err.code === "app/embedded-auth-unavailable") {
        setGeneralError(
          "プレビュー（埋め込み表示）のままではGoogleサインインを完了できません。下の「新しいタブで開く」からアプリを単独のタブで開いてサインインしてください。",
        );
      } else if (err.code === "auth/popup-blocked") {
        setGeneralError(
          "Popup blocked by your browser. Attempting redirect fallback...",
        );
      } else if (err.code === "auth/unauthorized-domain") {
        setGeneralError(
          "このドメインがFirebaseの承認済みドメインに登録されていません。Firebaseコンソールの Authentication → Settings → Authorized domains に現在のドメインを追加してください。",
        );
      } else {
        setGeneralError(
          "Authentication failed. Please verify your Google Account settings.",
        );
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Mint a fresh OAuth token without signing out, so an hour-old token does not
  // cost the operator the scan counts held in this session. Google normally
  // completes this without showing the consent screen again.
  const handleReauth = async () => {
    setIsLoggingIn(true);
    setGeneralError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setToken(result.accessToken);
        setTokenExpired(false);
        setSuccessMessage(
          "スプレッドシート接続を更新しました。保存に失敗した項目は履歴の「再試行」から保存できます。",
        );
      }
    } catch (err) {
      console.error("Re-authentication failed:", err);
      setGeneralError(
        "再接続に失敗しました。右上のSIGN OUTからサインインし直してください。",
      );
    } finally {
      setIsLoggingIn(false);
    }
  };

  // A Sheets write rejected with 401/403 means the token died rather than the data
  // being bad, and that needs different wording and a different remedy.
  const noteSaveFailure = (err: unknown) => {
    if (isAuthError(err)) setTokenExpired(true);
  };

  const handleLogout = async () => {
    try {
      await logout();
      setUser(null);
      setToken(null);
      setTokenExpired(false);
      setNeedsAuth(true);
      setSelectedSheet(null);
      setScanResult(null);
      setCapturedImageBase64(null);
    } catch (err) {
      console.error("Sign out fail:", err);
    }
  };

  // 3. Scan Image Parser via Server-Side Gemini API
  const handleImageCapture = async (base64: string, mimeType: string) => {
    const targetId = "scan_" + Date.now();
    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const fullTimestamp = new Date().toLocaleString("ja-JP");

    setCapturedImageBase64(base64);
    setIsExtracting(true);
    setScanResult(null);
    setGeneralError(null);
    setSuccessMessage(null);

    // Immediate interactive feed append: Add an analyzing placeholder row directly into session history
    const tempEntry: ScanHistoryEntry = {
      id: targetId,
      time: timestamp,
      partNumber: "タグ解析中 / Analyzing...",
      size: "...",
      color: "...",
      status: "extracting",
      previewImage: base64,
      store: selectedStore,
    };
    setHistory((prev) => [tempEntry, ...prev]);

    try {
      // The endpoint spends the server's Gemini quota, so it verifies this token
      // rather than serving anyone who knows the URL.
      const idToken = user ? await user.getIdToken() : null;

      const response = await fetch("/api/extract", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          imageBase64: base64,
          mimeType: mimeType,
        }),
      });

      if (!response.ok) {
        // Express's own error handler answers with HTML for oversized or malformed
        // bodies, so response.json() throws there and the operator used to see
        // "Unexpected token '<'" instead of what actually went wrong.
        const errorData = await response
          .json()
          .catch(() => ({ error: `読み取りに失敗しました (HTTP ${response.status})` }));
        throw new Error(errorData.error || "Failed to analyze tag image.");
      }

      const result: TagData = await response.json();
      const pNum = (result.partNumber || "").trim();
      const sz = (result.size || "").trim();
      const col = (result.color || "").trim();

      // Guards against the auto-scan loop reading the same physical tag twice while
      // the camera lingers on it. It used to compare the part number alone over a
      // 12 second window, which rejected the very next garment whenever it shared a
      // part number — a different colour or size of the same style, which the
      // project's own sample CSV contains — and made a row of 63 identical pieces
      // take a minimum of 12.6 minutes. Compare the full identity and keep the
      // window short; CameraStream separately requires the frame to change before
      // it re-arms, which is what actually stops a re-read of the same tag.
      const scanIdentity = `${pNum}|${sz}|${col}`.toUpperCase();
      if (
        autoScanEnabled &&
        pNum &&
        scanIdentity === lastScannedIdentity &&
        Date.now() - lastScanTime < 2500
      ) {
        console.log(`[Deduplication] Blocked duplicate read for: ${scanIdentity}`);
        setHistory((prev) => prev.filter((e) => e.id !== targetId));
        setSuccessMessage(
          `自動重複防止: 同じタグ「${pNum}（${sz || "ー"} / ${col || "ー"}）」を連続で読み取ったため1件にまとめました。`,
        );
        setIsExtracting(false);
        return;
      }

      const normP = pNum.trim().toUpperCase();
      const normS = (sz || "").trim().toUpperCase();
      const normC = (col || "").trim().toUpperCase();

      const storeItems = inspectionList.filter(item => item.store === selectedStore);
      const matchingMaster = storeItems.find(item => {
        return (
          item.partNumber.trim().toUpperCase() === normP &&
          (item.size || "").trim().toUpperCase() === normS &&
          (item.color || "").trim().toUpperCase() === normC
        );
      });

      const storeHistory = history.filter(
        entry => entry.store === selectedStore && entry.status !== "failed" && entry.status !== "extracting" && entry.id !== targetId
      );

      const currentScannedQty = storeHistory.filter(entry => {
        return (
          entry.partNumber.trim().toUpperCase() === normP &&
          (entry.size || "").trim().toUpperCase() === normS &&
          (entry.color || "").trim().toUpperCase() === normC
        );
      }).length;

      const expected = matchingMaster 
        ? (changedQtyOverrides[matchingMaster.id] ?? matchingMaster.expectedQty)
        : 0;

      const isOverScan = matchingMaster ? (currentScannedQty >= expected) : false;
      const isNonMaster = !matchingMaster;

      const saveScannedItem = async () => {
        setScanResult({
          partNumber: pNum,
          size: sz,
          color: col,
        });

        if (pNum) {
          setLastScannedIdentity(scanIdentity);
          setLastScanTime(Date.now());
        }

        playSuccessChirp();

        // Check if continuous Auto-Save option is active to speed up high-capacity operations
        if (batchModeEnabled) {
          // Transition state to saving...
          setHistory((prev) =>
            prev.map((e) =>
              e.id === targetId
                ? {
                    ...e,
                    partNumber: pNum || "品番不明",
                    size: sz || "ー",
                    color: col || "ー",
                    status: "saving",
                  }
                : e,
            ),
          );

          try {
            if (isPreviewEnvironment() && previewMode) {
              throw new Error(
                "開発プレビューのためスプレッドシートには保存していません。検品数のカウントは有効です。",
              );
            }
            if (!token || !selectedSheet) {
              throw new Error(
                "Google Spreadsheet target sheet coordination is not active.",
              );
            }

            // Non-blocking auto commit to Google Cloud Storage sheets
            await appendRow(token, selectedSheet.id, [
              fullTimestamp,
              selectedStore,
              pNum || "品番不明",
              sz || "ー",
              col || "ー",
            ]);

            // Saved successfully! Mark it green
            setHistory((prev) =>
              prev.map((e) =>
                e.id === targetId ? { ...e, status: "saved" } : e,
              ),
            );
            setTokenExpired(false);
            setSuccessMessage(
              `「${pNum || "製品"}」情報がスプレッドシートへ自動保存されました。`,
            );

            // Clear current screen edit buffer back to scanning state so user does not need to swipe screens
            setScanResult(null);
            setCapturedImageBase64(null);
          } catch (autoSaveErr: any) {
            console.error(
              "Continuous auto-save failed in background:",
              autoSaveErr,
            );
            setHistory((prev) =>
              prev.map((e) =>
                e.id === targetId
                  ? { ...e, status: "failed", error: autoSaveErr.message }
                  : e,
              ),
            );
            noteSaveFailure(autoSaveErr);
            setGeneralError(
              isAuthError(autoSaveErr)
                ? "Googleの接続の有効期限が切れたため保存できませんでした。下の「接続を更新」から再接続してください。"
                : `自動保存に失敗しました: ${autoSaveErr.message}`,
            );
          }
        } else {
          // Soft review flow (batchModeEnabled is false)
          setHistory((prev) =>
            prev.map((e) =>
              e.id === targetId
                ? {
                    ...e,
                    partNumber: pNum || "確認・調整待ち",
                    size: sz || "ー",
                    color: col || "ー",
                    status: "pending",
                  }
                : e,
            ),
          );

          // Remember which row the form is about to edit so the save updates it
          setPendingEntryId(targetId);

          // Turn down to edit view to let operator correct OCR outputs manually
          setMobileTab("edit");
        }
      };

      if (isNonMaster) {
        playWarningBeep();
        setNonMasterAlert({
          partNumber: pNum,
          size: sz,
          color: col,
          onAccept: () => {
            saveScannedItem();
            setNonMasterAlert(null);
          },
          onCancel: () => {
            setHistory((prev) => prev.filter((e) => e.id !== targetId));
            setScanResult(null);
            setCapturedImageBase64(null);
            setNonMasterAlert(null);
          }
        });
      } else if (isOverScan) {
        playWarningBeep();
        setOverscanAlert({
          partNumber: pNum,
          size: sz,
          color: col,
          expectedQty: expected,
          scannedQty: currentScannedQty,
          onAccept: () => {
            saveScannedItem();
            setOverscanAlert(null);
          },
          onCancel: () => {
            setHistory((prev) => prev.filter((e) => e.id !== targetId));
            setScanResult(null);
            setCapturedImageBase64(null);
            setOverscanAlert(null);
          }
        });
      } else {
        await saveScannedItem();
      }

    } catch (err: any) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        console.log("Extraction aborted by user.");
        return;
      }
      console.error("Extraction error:", err);
      setHistory((prev) =>
        prev.map((e) =>
          e.id === targetId
            ? {
                ...e,
                partNumber: "タグの読み取りエラー / Extraction Failed",
                status: "failed",
                error: err.message || "Failed to analyze tag",
              }
            : e,
        ),
      );
      setGeneralError(
        err.message ||
          "洋服タグの読み取り中にエラーが発生しました。別の明るい場所で再試行してください。",
      );
    } finally {
      setIsExtracting(false);
    }
  };

  // 4. Persistence Handler for Exporting Form Input to Sheets
  const handleSaveToSheet = async (finalData: TagData): Promise<boolean> => {
    if (isPreviewEnvironment() && previewMode) {
      setGeneralError(
        "開発プレビューではスプレッドシートに保存できません。保存まで確認する場合はPublish版をご利用ください。",
      );
      return false;
    }
    if (!token || !selectedSheet) {
      setGeneralError("Authentication or target spreadsheet is missing.");
      return false;
    }

    // The scan already created a row and left it "pending", and pending rows are
    // counted. Prepending a second row here counted one garment twice while
    // writing a single sheet row, so reuse that row when it is still present.
    const pendingEntry = pendingEntryId
      ? history.find((e) => e.id === pendingEntryId)
      : undefined;

    // The same row can also be saved from the history feed's own button; don't
    // write it to the sheet a second time from here.
    if (pendingEntry?.status === "saved" || pendingEntry?.status === "saving") {
      setScanResult(null);
      setCapturedImageBase64(null);
      setPendingEntryId(null);
      setMobileTab("scan");
      setSuccessMessage("この項目はすでに保存済みです。");
      return true;
    }

    setIsSaving(true);
    setGeneralError(null);
    setSuccessMessage(null);

    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const fullTimestamp = new Date().toLocaleString("ja-JP");
    const existingId = pendingEntry ? pendingEntry.id : null;
    const targetEntryId = existingId ?? Date.now().toString();

    if (existingId) {
      setHistory((prev) =>
        prev.map((e) =>
          e.id === existingId
            ? {
                ...e,
                partNumber: finalData.partNumber,
                size: finalData.size,
                color: finalData.color,
                status: "saving",
              }
            : e,
        ),
      );
    } else {
      setHistory((prev) => [
        {
          id: targetEntryId,
          time: timestamp,
          partNumber: finalData.partNumber,
          size: finalData.size,
          color: finalData.color,
          status: "saving",
          previewImage: capturedImageBase64 || undefined,
          store: selectedStore,
        },
        ...prev,
      ]);
    }

    try {
      // Append row to active Google Sheet
      await appendRow(token, selectedSheet.id, [
        fullTimestamp,
        selectedStore,
        finalData.partNumber,
        finalData.size,
        finalData.color,
      ]);

      // Update intermediate log entry state to saved
      setHistory((prev) =>
        prev.map((e) => (e.id === targetEntryId ? { ...e, status: "saved" } : e)),
      );

      setTokenExpired(false);
      setSuccessMessage(
        "スプレッドシートへ書き込みが正常に完了しました。 / Exported successfully.",
      );
      // Soft reset the scanning viewport for the next item
      setScanResult(null);
      setCapturedImageBase64(null);
      setPendingEntryId(null);

      // Return back to uploader/live camera tab on mobile for continuous scanning workflow
      setMobileTab("scan");
      return true;
    } catch (err: any) {
      console.error("Save to sheet failed:", err);
      setHistory((prev) =>
        prev.map((e) =>
          e.id === targetEntryId
            ? { ...e, status: "failed", error: err.message || "Insert failed" }
            : e,
          ),
        );
        noteSaveFailure(err);
        setGeneralError(
          isAuthError(err)
            ? "Googleの接続の有効期限が切れたため保存できませんでした。下の「接続を更新」から再接続してください。"
            : `Export failed: ${err.message || "Unable to update Google Sheet row."}`,
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    };

  // 4.5 Persistence Handler for saving specific queued historical item directly
  const handleSaveHistoryItem = async (entry: ScanHistoryEntry) => {
    if (isPreviewEnvironment() && previewMode) {
      setGeneralError(
        "開発プレビューではスプレッドシートに保存できません。保存まで確認する場合はPublish版をご利用ください。",
      );
      return;
    }
    if (!token || !selectedSheet) {
      setGeneralError("スプレッドシート接続が見つかりません。");
      return;
    }

    if (entry.status === "saved" || entry.status === "saving") return;

    setHistory((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, status: "saving" } : e)),
    );

    try {
      const fullTimestamp = new Date().toLocaleString("ja-JP");
      await appendRow(token, selectedSheet.id, [
        fullTimestamp,
        entry.store || selectedStore,
        entry.partNumber,
        entry.size,
        entry.color,
      ]);

      setHistory((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, status: "saved" } : e)),
      );
      setTokenExpired(false);
      setSuccessMessage(
        `「${entry.partNumber || "製品"}」情報をスプレッドシートに保存しました。`,
      );
    } catch (err: any) {
      console.error("Save historical item failed:", err);
      setHistory((prev) =>
        prev.map((e) =>
          e.id === entry.id
            ? { ...e, status: "failed", error: err.message || "Export failed" }
            : e,
        ),
      );
      noteSaveFailure(err);
      setGeneralError(
        isAuthError(err)
          ? "Googleの接続の有効期限が切れたため保存できませんでした。下の「接続を更新」から再接続してください。"
          : `保存に失敗しました: ${err.message || "Unable to update Google Sheet."}`,
      );
    }
  };

  const handleClearHistory = () => {
    setConfirmModal({
      title: "全店舗の履歴クリアの確認",
      // This wipes every store, not just the selected one, and the counts it
      // destroys are the shift's inspection totals. The old wording said only
      // "セッション履歴" and gave no hint of the scope.
      message: `全${new Set(history.map((e) => e.store)).size}店舗ぶん、合計${history.length}件のスキャン履歴をすべて削除し、各店舗の検品数を0に戻します。よろしいですか？ (Googleスプレッドシート本体のデータは削除されません。現在の店舗だけを消す場合は検品テーブルの「検品リセット」を使ってください)`,
      onConfirm: () => {
        setHistory([]);
        setConfirmModal(null);
        setSuccessMessage("セッション履歴をクリアしました。");
      }
    });
  };

  const handleResetScan = () => {
    // Discarding the form also discards the row it was editing, which would
    // otherwise stay "pending" forever and keep counting towards the store total
    // with nothing ever written to the sheet.
    if (pendingEntryId) {
      setHistory((prev) =>
        prev.filter((e) => !(e.id === pendingEntryId && e.status === "pending")),
      );
      setPendingEntryId(null);
    }
    setScanResult(null);
    setCapturedImageBase64(null);
    setGeneralError(null);
    setSuccessMessage(null);
  };

  const handleCameraError = (err: any) => {
    const msg = err?.message || err?.name || String(err);
    if (msg.includes("Permission dismissed") || msg.includes("NotAllowedError") || msg.includes("Permission denied")) {
      setGeneralError("カメラのアクセス権限が拒否されたためライブカメラは利用できませんでした。写真アップロードから画像を送信してください。 / Camera permission dismissed, switched to upload tab.");
    } else {
      setGeneralError(`カメラの起動に失敗しました: ${msg}`);
    }
    // Switch completely to the file upload tab to avoid recurring permission prompts
    setInputTab("upload");
  };

  // RENDER LOGIN SCREEN (Unauthenticated state)
  if (needsAuth) {
    return (
      <div className="min-h-screen bg-slate-50/50 flex flex-col items-center justify-center p-6 select-none font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl border border-slate-100 shadow-xl p-8 flex flex-col items-center text-center relative overflow-hidden">
          {/* Accent decoration */}
          <div className="absolute top-0 left-0 right-0 h-2 bg-slate-900" />

          <div className="p-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 mb-6 flex items-center justify-center">
            <Camera className="w-8 h-8 text-slate-800" />
          </div>

          <h1 className="text-2xl font-bold text-slate-800 tracking-tight leading-snug">
            Tag Extractor
          </h1>
          <p className="text-slate-500 text-sm mt-2.5 max-w-sm">
            Scan garment tags of clothing instantly with a camera or photo,
            isolate parts/sizes/colors, and export them seamlessly into
            high-efficiency Google Spreadsheets.
          </p>

          <div className="w-full border-t border-slate-100/80 my-7" />

          {generalError && (
            <div className="w-full p-3.5 bg-red-50 border border-red-100 rounded-2xl text-xs text-red-600 mb-5 text-left flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{generalError}</span>
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full py-3 px-4 bg-white hover:bg-slate-50 border border-slate-200/80 hover:border-slate-300 rounded-xl font-medium text-slate-700 shadow-sm flex items-center justify-center gap-3 transition-all cursor-pointer text-sm disabled:opacity-60 active:scale-[0.995]"
          >
            {isLoggingIn ? (
              <div className="w-5 h-5 border-2 border-slate-400 border-t-slate-800 rounded-full animate-spin" />
            ) : (
              <svg
                className="w-5 h-5"
                viewBox="0 0 48 48"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
            )}
            Sign in with Google
          </button>

          {/* Sign-in cannot complete on the development host, so offer a way to
              reach the interface anyway. Never rendered in the published build. */}
          {isPreviewEnvironment() && (
            <div className="w-full mt-4 p-3.5 bg-amber-50 border border-amber-200 rounded-2xl text-left space-y-2.5">
              <p className="text-xs text-amber-800 font-bold leading-relaxed">
                開発プレビューではGoogleサインインを完了できません
              </p>
              <p className="text-[11px] text-amber-700 leading-relaxed">
                この画面のURLは作り直すたびに変わる一時的なもので、Googleの許可済みアドレスに登録できないためです。
                サインインせずに画面と検品機能を確認できます。CSVの読み込み・タグ読取・数量の突合はそのまま試せます。
              </p>
              <button
                onClick={() => {
                  setPreviewMode(true);
                  setNeedsAuth(false);
                  setGeneralError(null);
                }}
                className="w-full py-2.5 px-4 bg-amber-600 hover:bg-amber-700 text-white font-extrabold text-xs rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-2"
              >
                <ArrowRight className="w-4 h-4" />
                サインインせずに画面を開く
              </button>
              <p className="text-[10px] text-amber-600 leading-relaxed">
                ※スプレッドシートへの保存だけは行えません。保存まで確認する場合はPublishしてください。
              </p>
            </div>
          )}

          <p className="text-[11px] text-slate-400 mt-5 leading-normal max-w-xs">
            Tag Extractor connects directly to Google Drive/Sheets on your
            behalf and requests authorization with user permission.
          </p>
        </div>
      </div>
    );
  }

  // RENDER BOTTOM FOOTER STATIC/METRIC STATE
  const currentTimestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .substring(0, 19);

  // Derived calculations for logistics inspection workflow
  const distinctStores: string[] = inspectionList.length > 0 
    ? Array.from(new Set(inspectionList.map(item => item.store)))
    : ["新宿店", "渋谷店", "銀座店", "オンライン倉庫"];

  const storeItems = inspectionList.filter(item => item.store === selectedStore);
  const storeHistory = history.filter(
    entry => entry.store === selectedStore && entry.status !== "failed" && entry.status !== "extracting"
  );

  const comparisonRows = storeItems.map((masterItem) => {
    const normP = masterItem.partNumber.trim().toUpperCase();
    const normS = (masterItem.size || "").trim().toUpperCase();
    const normC = (masterItem.color || "").trim().toUpperCase();

    const matches = storeHistory.filter(entry => {
      return (
        entry.partNumber.trim().toUpperCase() === normP &&
        (entry.size || "").trim().toUpperCase() === normS &&
        (entry.color || "").trim().toUpperCase() === normC
      );
    });

    return {
      ...masterItem,
      actualQty: matches.length,
    };
  });

  const extraScannedItems: {
    partNumber: string;
    size: string;
    color: string;
    actualQty: number;
  }[] = [];

  storeHistory.forEach(entry => {
    const normP = entry.partNumber.trim().toUpperCase();
    const normS = (entry.size || "").trim().toUpperCase();
    const normC = (entry.color || "").trim().toUpperCase();

    const isMatched = comparisonRows.some(masterItem => {
      return (
        masterItem.partNumber.trim().toUpperCase() === normP &&
        (masterItem.size || "").trim().toUpperCase() === normS &&
        (masterItem.color || "").trim().toUpperCase() === normC
      );
    });

    if (!isMatched) {
      const existingIndex = extraScannedItems.findIndex(extra => 
        extra.partNumber.trim().toUpperCase() === normP &&
        extra.size.trim().toUpperCase() === normS &&
        extra.color.trim().toUpperCase() === normC
      );

      if (existingIndex !== -1) {
        extraScannedItems[existingIndex].actualQty += 1;
      } else {
        extraScannedItems.push({
          partNumber: entry.partNumber,
          size: entry.size || "ー",
          color: entry.color || "ー",
          actualQty: 1,
        });
      }
    }
  });

  // RENDER DASHBOARD (Authenticated state)
  return (
    <div className="min-h-screen bg-[#F3F4F6] text-[#111827] flex flex-col font-sans overflow-x-hidden">
      {/* Professional Polish Header: System Status Bar */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse"></div>
          <span className="font-bold tracking-tight text-lg text-slate-900">
            TAG EXTRACTOR <span className="text-blue-600">PRO RT-1</span>
          </span>
        </div>

        <div className="flex items-center gap-4 md:gap-6">
          <div className="hidden md:flex items-center gap-2 text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            <span className="opacity-60 font-bold uppercase tracking-wider text-[9px]">
              SYNC STATE:
            </span>
            <span
              className={`${
                tokenExpired
                  ? "text-red-700 font-semibold"
                  : selectedSheet
                    ? "text-green-700 font-semibold"
                    : "text-amber-700 font-semibold"
              }`}
            >
              {tokenExpired
                ? "Session Expired"
                : selectedSheet
                  ? "Sheets Connected"
                  : "Awaiting Sheet Selection"}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-full">
            <span className="opacity-60 font-bold uppercase tracking-wider text-[9px]">
              ENGINE LATENCY:
            </span>
            <span className="text-blue-700 font-mono font-bold">14ms</span>
          </div>

          <div className="flex items-center gap-2 bg-slate-100 rounded-full px-3 py-1.5 border border-slate-200/50">
            {user?.photoURL ? (
              <img
                src={user.photoURL}
                alt="Avatar"
                className="w-4 h-4 rounded-full border border-slate-300"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-4 h-4 rounded-full bg-slate-300" />
            )}
            <span className="text-xs font-semibold text-slate-700 hidden lg:inline">
              {user?.displayName || "Operator"}
            </span>
          </div>

          <button
            onClick={handleLogout}
            className="px-3 py-1.5 flex items-center gap-1.5 text-xs text-gray-600 hover:text-red-600 border border-gray-200 hover:border-red-200 rounded-lg hover:bg-red-50/50 bg-white transition-all cursor-pointer font-bold shadow-xs active:scale-[0.98]"
            title="Disconnect Google Account"
          >
            <LogOut className="w-3.5 h-3.5 text-gray-500" />
            <span className="hidden sm:inline">SIGN OUT</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-6 py-8 flex flex-col gap-6">
        {/* Quick Tips Collapsible Panel (A Helpful Companion for Mobile Operators) */}
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <button
            onClick={() => setIsHelpOpen(!isHelpOpen)}
            className="w-full px-5 py-4 flex items-center justify-between text-left font-sans hover:bg-slate-50 transition-colors focus:outline-none"
          >
            <div className="flex items-center gap-2.5">
              <HelpCircle className="w-5 h-5 text-blue-500 animate-pulse" />
              <div>
                <span className="font-bold text-slate-800 text-sm block">
                  服タグをスムーズに読み取るコツ / Scanner Guide
                </span>
                <span className="text-xs text-slate-400 block font-medium">
                  スマホ撮影での認識率をグッと上げるポイント
                </span>
              </div>
            </div>
            <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
              {isHelpOpen ? "閉じる / Close" : "見る / View Tips"}
            </span>
          </button>

          {isHelpOpen && (
            <div className="px-6 pb-5 pt-1 border-t border-slate-50 text-xs text-slate-600 grid grid-cols-1 md:grid-cols-3 gap-4 font-sans leading-relaxed">
              <div className="p-3 bg-slate-50/70 border border-slate-100 rounded-xl">
                <span className="font-black text-blue-600 text-base block mb-0.5">
                  ① 平らに置く (Keep Flat)
                </span>
                Tags that are crumpled, curled, or hanging lose letters. Smooth
                the apparel tag surface flat on a table before capturing.
                <p className="mt-1.5 text-[11px] text-slate-500 font-medium">
                  タグがシワくちゃにならないよう、指でまっすぐ伸ばして平らに置いて撮影してください。
                </p>
              </div>
              <div className="p-3 bg-slate-50/70 border border-slate-100 rounded-xl">
                <span className="font-black text-blue-600 text-base block mb-0.5">
                  ② 十分な明るさ (Good Light)
                </span>
                OCR engines require high text-contrast. Scan in bright
                outdoor/indoor spaces, avoiding shadows of your camera phone or
                body.
                <p className="mt-1.5 text-[11px] text-slate-500 font-medium">
                  蛍光灯の真下ではスマホや手の影が入りやすいため、少しずらすなどして影を避けてください。
                </p>
              </div>
              <div className="p-3 bg-slate-50/70 border border-slate-100 rounded-xl">
                <span className="font-black text-blue-600 text-base block mb-0.5">
                  ③ 枠の中に収める (Align Center)
                </span>
                Center variables like part number code and size inside the dash
                boundaries. Hold steady for 2-3s for automatic reads.
                <p className="mt-1.5 text-[11px] text-slate-500 font-medium">
                  品番（NO）・サイズ（SIZE）などのテキストが、ガイド枠の直線付近に並ぶようにカメラを近づけてください。
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Signed-out preview. Say so permanently: every count on screen is real
            work, but none of it is reaching the spreadsheet. */}
        {isPreviewEnvironment() && previewMode && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="uppercase tracking-wider text-[11px] font-bold text-amber-800">
                  開発プレビュー（サインインなし）
                </p>
                <p className="text-xs text-amber-700 font-normal leading-relaxed">
                  CSV読み込み・タグ読取・数量の突合は通常どおり動作しますが、
                  <strong>スプレッドシートへの保存は行われません。</strong>
                  保存まで確認するにはPublish版でサインインしてください。
                </p>
              </div>
            </div>
            <button
              onClick={() => {
                setPreviewMode(false);
                setNeedsAuth(true);
              }}
              className="shrink-0 px-4 py-2.5 border border-amber-300 hover:bg-amber-100 text-amber-800 font-bold text-xs rounded-lg transition-colors cursor-pointer"
            >
              サインイン画面へ戻る
            </button>
          </div>
        )}

        {/* Expired Google session: saving is broken until the token is renewed, and
            failed rows are excluded from the counts, so say so instead of letting
            the ledger quietly stop advancing. */}
        {tokenExpired && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="uppercase tracking-wider text-[11px] font-bold text-amber-800">
                  Google接続の有効期限切れ
                </p>
                <p className="text-xs text-amber-700 font-normal leading-relaxed">
                  スプレッドシートへの保存ができない状態です。検品済の数は保持されていますので、接続を更新してから履歴の「再試行」で保存してください。
                </p>
              </div>
            </div>
            <button
              onClick={handleReauth}
              disabled={isLoggingIn}
              className="shrink-0 px-4 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white font-extrabold text-xs rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isLoggingIn ? "animate-spin" : ""}`} />
              接続を更新
            </button>
          </div>
        )}

        {/* Status Messaging Area */}
        {(generalError || successMessage) && (
          <div className="w-full">
            {generalError && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-xl text-xs sm:text-sm text-red-700 font-semibold flex items-start gap-2.5 shadow-xs">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="uppercase tracking-wider text-[11px] font-bold">
                    Operation Error (エラー)
                  </p>
                  <p className="text-xs text-red-600 font-normal leading-relaxed">
                    {generalError}
                  </p>
                </div>
              </div>
            )}
            {successMessage && (
              <div className="p-4 bg-green-50 border border-green-100 rounded-xl text-xs sm:text-sm text-green-700 font-semibold flex items-start gap-2.5 shadow-xs">
                <CheckCircle className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="uppercase tracking-wider text-[11px] font-bold">
                    Success (成功)
                  </p>
                  <p className="text-xs text-green-600 font-normal leading-relaxed">
                    {successMessage}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* INVENTORY INSPECTION WORKFLOW STEPPER BAR COMPONENTS      */}
        {/* ========================================================= */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs p-5 flex flex-col md:flex-row md:items-center justify-between gap-5 font-sans">
          <div className="flex items-center gap-3.5">
            <div className="p-3 bg-slate-900 text-white rounded-xl shadow-xs border border-slate-800">
              <ListCheck className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-800 text-sm md:text-base tracking-tight leading-snug">
                店舗別 仕入・検品フロー / Logistics Inspection Flow
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 font-medium">
                ①店舗選択 ➔ ②連続スキャン ➔ ③結果確認・差分突合 を順に行い、検品完了後に次の店舗へ進みます。
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1 sm:gap-2 bg-slate-50 border border-slate-100 rounded-xl p-1.5 self-start md:self-center">
            <button
              onClick={() => {
                setWorkflowStep("store_select");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
                workflowStep === "store_select"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <MapPin className="w-4 h-4 shrink-0" />
              1. 店舗選択
            </button>
            
            <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
            
            <button
              onClick={() => {
                setWorkflowStep("scanning");
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
                workflowStep === "scanning"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <Camera className="w-4 h-4 shrink-0" />
              2. 連続スキャン
            </button>
            
            <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
            
            <button
              onClick={handleProceedToResults}
              className={`px-3.5 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center gap-2 ${
                workflowStep === "results"
                  ? "bg-slate-900 text-white shadow-xs"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              3. 結果確認
            </button>
          </div>
        </div>

        {/* ========================================================= */}
        {/* WORKFLOW STEPS ROUTING RENDER PANEL                       */}
        {/* ========================================================= */}

        {/* STEP 1: STORE SELECT VIEW */}
        {workflowStep === "store_select" && (
          <div className="space-y-6 animate-fade-in block">
            {/* Master CSV Importer Section */}
            <CsvImporter
              onImport={(list) => {
                // An empty list is the importer's "clear everything" action.
                if (list.length === 0) {
                  setInspectionList([]);
                  setSuccessMessage("検品マスターリストをクリアしました。");
                  return;
                }

                // Replace only the stores present in the imported files. A full
                // replace meant picking up one store's CSV wiped every other
                // store's master, and their existing scans immediately
                // reclassified as "リスト外" with 予定数 0.
                const importedStores = new Set(list.map((item) => item.store));
                setInspectionList((prev) => [
                  ...prev.filter((item) => !importedStores.has(item.store)),
                  ...list,
                ]);

                const storesList = Array.from(importedStores);
                if (storesList.length > 0 && !selectedStore) {
                  setSelectedStore(storesList[0]);
                }
                setSuccessMessage(
                  `検品マスターリストを更新しました。 (${storesList.length}店舗 / ${list.length}型番)`,
                );
              }}
              onSelectStore={(storeName) => {
                setSelectedStore(storeName);
                setSuccessMessage(`検品対象店舗を「${storeName}」に変更しました。`);
              }}
              currentlyLoadedCount={inspectionList.length}
              currentlyLoadedStoresCount={Array.from(new Set(inspectionList.map(item => item.store))).length}
              selectedStore={selectedStore}
              inspectionList={inspectionList}
            />

            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-6">
              <h3 className="font-bold text-slate-800 text-sm md:text-base leading-snug mb-2">
                対象店舗を選択してください / Select Target Store
              </h3>
              <p className="text-xs text-slate-400 mb-6 font-medium">
                現在検品作業を行う対象の物理店舗を選択してください。マスターに登録されている店舗、もしくは共通倉庫を選べます。
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {distinctStores.map((store) => {
                  const storeItems = inspectionList.filter(item => item.store === store);
                  const totalExpected = storeItems.reduce(
                    (acc, item) => acc + (changedQtyOverrides[item.id] ?? item.expectedQty),
                    0,
                  );
                  const scannedTotal = history.filter(
                    entry => entry.store === store && entry.status !== "failed" && entry.status !== "extracting"
                  ).length;
                  const isSelected = selectedStore === store;

                  return (
                    <button
                      key={store}
                      onClick={() => {
                        setSelectedStore(store);
                        setSuccessMessage(`検品対象店舗を「${store}」に変更しました。`);
                      }}
                      className={`text-left p-5 rounded-2xl border transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between h-36 ${
                        isSelected
                          ? "bg-slate-900 border-slate-900 text-white shadow-md"
                          : "bg-slate-50/50 hover:bg-slate-50 border-slate-200 text-slate-800 hover:border-slate-300 shadow-2xs"
                      }`}
                    >
                      {isSelected && (
                        <span className="absolute top-3.5 right-3.5 bg-blue-500 text-white p-1 rounded-full text-[10px] font-extrabold w-5 h-5 flex items-center justify-center">
                          ✓
                        </span>
                      )}
                      <div>
                        <span className={`text-[9px] font-black tracking-widest uppercase block mb-1 ${isSelected ? "text-blue-400" : "text-slate-400"}`}>
                          {isSelected ? "ACTIVE STORAGE" : "STORAGE SHOP"}
                        </span>
                        <span className="text-base font-extrabold tracking-tight block truncate">
                          {store}
                        </span>
                      </div>

                      <div className="mt-3">
                        <span className={`text-[10px] block font-mono ${isSelected ? "text-slate-300" : "text-slate-400"}`}>
                          マスタ登録: {storeItems.length}型番 (予定仕様総数 {totalExpected}点)
                        </span>
                        <span className={`text-[11px] block font-extrabold mt-1 ${isSelected ? "text-green-400" : "text-green-600"}`}>
                          今回検品済: {scannedTotal}点 / {totalExpected || "—"}点
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="flex justify-end mt-8 pt-6 border-t border-slate-100">
                <button
                  onClick={() => {
                    // Turn on batchMode and scan state quickly for continuous flow
                    setBatchModeEnabled(true);
                    setAutoScanEnabled(true);
                    setWorkflowStep("scanning");
                    setMobileTab("scan");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  className="px-6 py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold rounded-xl shadow-xs text-sm flex items-center gap-2 transition-all cursor-pointer shadow-2xs active:scale-[0.985]"
                >
                  {selectedStore} の検品（連続スキャン）を開始する
                  <ArrowRight className="w-4 h-4 text-white" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 2: CONTINUOUS SCAN ACTIVE VIEW */}
        {workflowStep === "scanning" && (
          <div className="space-y-6 animate-fade-in block">
            {/* Active Store Target HUD */}
            <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 shadow-md p-5 flex flex-col md:flex-row md:items-center justify-between gap-5 font-sans">
              <div className="flex items-center gap-4">
                <div className="w-11 h-11 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center border border-blue-500/20 shrink-0">
                  <MapPin className="w-5 h-5 animate-bounce" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[9px] text-blue-400 font-black tracking-widest uppercase">ACTIVE PHYSICAL LOCATION</span>
                    <span className="text-[9px] bg-red-600 text-white font-bold px-2 py-0.5 rounded-full animate-pulse">連続スキャンモード (自動保存ON)</span>
                  </div>
                  <span className="text-lg md:text-xl font-bold block tracking-tight mt-0.5">{selectedStore}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6 animate-fade-in">
                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block font-mono uppercase font-bold">Master Expected Qty</span>
                  <span className="text-sm font-extrabold block">
                    {inspectionList
                      .filter((item) => item.store === selectedStore)
                      .reduce(
                        (acc, item) => acc + (changedQtyOverrides[item.id] ?? item.expectedQty),
                        0,
                      )}点
                  </span>
                </div>

                <div className="text-right">
                  <span className="text-[10px] text-slate-400 block font-mono uppercase font-bold">Scanned Actual Qty</span>
                  <span className="text-sm font-extrabold text-green-400 block">
                    {history.filter(e => e.store === selectedStore && e.status !== "failed" && e.status !== "extracting").length}点
                  </span>
                </div>

                <button
                  onClick={handleProceedToResults}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-black rounded-lg text-xs flex items-center gap-2 transition-all cursor-pointer shadow-md"
                >
                  <CheckCircle2 className="w-4 h-4 text-white" />
                  スキャン差異突合・結果確認 ➔
                </button>
              </div>
            </div>

            {/* WORKSPACE AREA */}
            {/* DESKTOP VIEWPORT: Static Bento Grid layout (Full View) */}
            {isDesktop && (
            <div className="grid grid-cols-12 gap-8">
              {/* Left Column configuration */}
              <div className="lg:col-span-4 flex flex-col gap-6">
                <SheetSelector
                  accessToken={token || ""}
                  selectedSheet={selectedSheet}
                  onSheetSelected={setSelectedSheet}
                />

                <div
                  className={`bg-white rounded-2xl shadow-sm border border-slate-100 p-5 relative transition-opacity ${!selectedSheet && !previewMode ? "opacity-50 pointer-events-none" : ""}`}
                >
                  {/* Overlay Prompt to require Sheet Selection first */}
                  {!selectedSheet && !previewMode && (
                    <div className="absolute inset-0 z-10 bg-white/75 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center rounded-2xl gap-2">
                      <Settings className="w-8 h-8 text-indigo-500 animate-spin" />
                      <p className="font-bold text-slate-800 text-sm">
                        Spreadsheet Connection Required
                      </p>
                      <p className="text-xs text-slate-500 max-w-xs px-4">
                        Please configure or create a target Google Spreadsheet in
                        Step 1 to unlock high-speed photo scanning.
                      </p>
                    </div>
                  )}

                  {/* Input Switch Toggles */}
                  <div className="flex justify-between items-center mb-4">
                    <div>
                      <h2 className="text-sm font-bold text-slate-800 font-sans">
                        2. Scanner Input Feed
                      </h2>
                    </div>

                    <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5 border border-slate-200/50">
                      <button
                        onClick={() => setInputTab("camera")}
                        className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded transition-all cursor-pointer ${
                          inputTab === "camera"
                            ? "bg-white text-blue-700 shadow-2xs"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        <Camera className="w-3 h-3" /> CAMERA
                      </button>
                      <button
                        onClick={() => setInputTab("upload")}
                        className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold rounded transition-all cursor-pointer ${
                          inputTab === "upload"
                            ? "bg-white text-blue-700 shadow-2xs"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        <FileUp className="w-3 h-3" /> UPLOAD
                      </button>
                    </div>
                  </div>

                  {/* Main Sub Tab Viewports */}
                  {inputTab === "camera" ? (
                    <CameraStream
                      onCapture={handleImageCapture}
                      disabled={isExtracting || isSaving}
                      autoScanEnabled={autoScanEnabled}
                      onToggleAutoScan={setAutoScanEnabled}
                      batchModeEnabled={batchModeEnabled}
                      onToggleBatchMode={setBatchModeEnabled}
                      isExtracting={isExtracting}
                      lastScanSuccessTime={lastScanTime}
                      onCameraError={handleCameraError}
                    />
                  ) : (
                    <ManualUpload
                      onImageSelected={handleImageCapture}
                      selectedPreview={capturedImageBase64}
                      onClear={handleResetScan}
                      disabled={isExtracting || isSaving}
                      isExtracting={isExtracting}
                    />
                  )}
                </div>

                {/* Scan Result Form nested on sidebar */}
                <div className="w-full">
                  <ScanResultForm
                    initialData={scanResult}
                    onSave={handleSaveToSheet}
                    onReset={handleResetScan}
                    selectedSheet={selectedSheet}
                    isSaving={isSaving}
                    isExtracting={isExtracting}
                  />
                </div>
              </div>

              {/* Right Column: Retro terminal styled Inspection Table */}
              <div className="lg:col-span-8 flex flex-col gap-6">
                <InspectionStatusTable
                  selectedStore={selectedStore}
                  comparisonRows={comparisonRows}
                  extraScannedItems={extraScannedItems}
                  changedQtyOverrides={changedQtyOverrides}
                  onQtyOverrideChange={handleQtyOverrideChange}
                  onAdjustQty={handleAdjustQty}
                  onClearHistory={handleClearStoreHistory}
                />
              </div>
            </div>
            )}

            {/* SMARTPHONE / TABLET VIEWPORT: Dynamic tab-render container */}
            {!isDesktop && (
            <div>
              <div className="flex bg-white rounded-xl shadow-xs p-1 gap-1 border border-slate-200 mb-6 font-sans">
                <button
                  onClick={() => setMobileTab("settings")}
                  className={`flex-1 py-2 px-0.5 text-center font-bold text-xs rounded-lg flex flex-col items-center justify-center gap-1 transition-all outline-none cursor-pointer ${
                    mobileTab === "settings"
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-50/50"
                  }`}
                >
                  <Settings className="w-4 h-4" />
                  <span className="text-[10px] sm:text-xs">1. 接続設定</span>
                  {selectedSheet ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse mt-0.5" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-0.5" />
                  )}
                </button>

                <button
                  onClick={() => setMobileTab("scan")}
                  className={`flex-1 py-2 px-0.5 text-center font-bold text-xs rounded-lg flex flex-col items-center justify-center gap-1 transition-all outline-none cursor-pointer ${
                    mobileTab === "scan"
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-50/50"
                  }`}
                >
                  <Camera className="w-4 h-4" />
                  <span className="text-[10px] sm:text-xs">2. 読取スキャン</span>
                  {isExtracting ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping mt-0.5" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-0.5" />
                  )}
                </button>

                <button
                  onClick={() => setMobileTab("edit")}
                  className={`relative flex-1 py-2 px-0.5 text-center font-bold text-xs rounded-lg flex flex-col items-center justify-center gap-1 transition-all outline-none cursor-pointer ${
                    mobileTab === "edit"
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-50/50"
                  }`}
                >
                  <PenTool className="w-4 h-4" />
                  <span className="text-[10px] sm:text-xs">3. 編集・保存</span>
                  {scanResult ? (
                    <span className="absolute top-1.5 right-1.5 flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
                    </span>
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-0.5" />
                  )}
                </button>

                <button
                  onClick={() => setMobileTab("history")}
                  className={`flex-1 py-2 px-0.5 text-center font-bold text-xs rounded-lg flex flex-col items-center justify-center gap-1 transition-all outline-none cursor-pointer ${
                    mobileTab === "history"
                      ? "bg-[#112D55] text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-50/50"
                  }`}
                >
                  <History className="w-4 h-4" />
                  <span className="text-[10px] sm:text-xs">4. セッション履歴</span>
                  {history.length > 0 ? (
                    <span className="bg-blue-600 text-white text-[9px] px-1.5 py-0.5 rounded-full min-w-4 text-center mt-0.5 leading-none animate-bounce">
                      {history.length}
                    </span>
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300 mt-0.5" />
                  )}
                </button>
              </div>

              {mobileTab === "settings" && (
                <div className="animate-fade-in">
                  <SheetSelector
                    accessToken={token || ""}
                    selectedSheet={selectedSheet}
                    onSheetSelected={setSelectedSheet}
                  />
                </div>
              )}

              {mobileTab === "scan" && (
                <div className="flex flex-col gap-6 animate-fade-in">
                  <div
                    className={`bg-white rounded-2xl shadow-sm border border-slate-100 p-6 relative transition-opacity ${!selectedSheet && !previewMode ? "opacity-50 pointer-events-none" : ""}`}
                  >
                    {/* Overlay Prompt to require Sheet Selection first */}
                    {!selectedSheet && !previewMode && (
                      <div className="absolute inset-0 z-10 bg-white/75 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center rounded-2xl gap-2">
                        <Settings className="w-8 h-8 text-blue-600 animate-spin" />
                        <p className="font-bold text-slate-800 text-sm">
                          Spreadsheet Connection Required
                        </p>
                        <p className="text-xs text-slate-500 max-w-xs leading-normal">
                          ステップ1で接続先スプレッドシートを作成または選択すると、高性能なカメラ・ファイル読取機能が利用可能になります。
                        </p>
                      </div>
                    )}

                    {/* Input Switch Toggles */}
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
                      <div>
                        <h2 className="text-base font-bold text-slate-800">
                          2. スキャン入力ソース / Input Feed
                        </h2>
                        <p className="text-xs text-slate-400 font-medium font-sans">
                          タグをカメラにかざすか、ドラッグ＆ドロップ、タップ撮影してください
                        </p>
                      </div>

                      <div className="flex gap-1 bg-slate-100 rounded-lg p-1 border border-slate-200/50 w-full sm:w-auto">
                        <button
                          onClick={() => setInputTab("camera")}
                          className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-bold rounded-md transition-all cursor-pointer ${
                            inputTab === "camera"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          <Camera className="w-3.5 h-3.5" /> LIVE CAMERA
                        </button>
                        <button
                          onClick={() => setInputTab("upload")}
                          className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-bold rounded-md transition-all cursor-pointer ${
                            inputTab === "upload"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          <FileUp className="w-3.5 h-3.5" /> PHOTO UPLOAD
                        </button>
                      </div>
                    </div>

                    {/* Main Sub Tab Viewports */}
                    {inputTab === "camera" ? (
                      <CameraStream
                        onCapture={handleImageCapture}
                        disabled={isExtracting || isSaving}
                        autoScanEnabled={autoScanEnabled}
                        onToggleAutoScan={setAutoScanEnabled}
                        batchModeEnabled={batchModeEnabled}
                        onToggleBatchMode={setBatchModeEnabled}
                        isExtracting={isExtracting}
                        lastScanSuccessTime={lastScanTime}
                        onCameraError={handleCameraError}
                      />
                    ) : (
                      <ManualUpload
                        onImageSelected={handleImageCapture}
                        selectedPreview={capturedImageBase64}
                        onClear={handleResetScan}
                        disabled={isExtracting || isSaving}
                        isExtracting={isExtracting}
                      />
                    )}
                  </div>

                  {/* Mobil Retro Status Inquiry Card */}
                  <div className="w-full">
                    <InspectionStatusTable
                      selectedStore={selectedStore}
                      comparisonRows={comparisonRows}
                      extraScannedItems={extraScannedItems}
                      changedQtyOverrides={changedQtyOverrides}
                      onQtyOverrideChange={handleQtyOverrideChange}
                      onAdjustQty={handleAdjustQty}
                      onClearHistory={handleClearStoreHistory}
                    />
                  </div>
                </div>
              )}

              {mobileTab === "edit" && (
                <div className="animate-fade-in">
                  <ScanResultForm
                    initialData={scanResult}
                    onSave={handleSaveToSheet}
                    onReset={handleResetScan}
                    selectedSheet={selectedSheet}
                    isSaving={isSaving}
                    isExtracting={isExtracting}
                  />
                </div>
              )}

              {mobileTab === "history" && (
                <div className="animate-fade-in">
                  <HistoryList
                    entries={history}
                    selectedSheet={selectedSheet}
                    onClearHistory={handleClearHistory}
                    onSaveEntry={handleSaveHistoryItem}
                  />
                </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* STEP 3: RESULTS RECONCILIATION TABLE VIEW */}
        {workflowStep === "results" && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 animate-fade-in">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 border-b border-slate-50 pb-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-100 text-slate-800 rounded-xl border border-slate-100 shrink-0">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-800 text-sm md:text-base">
                    【{selectedStore}】結果確認・差異突合シミュレーター
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5 font-medium">
                    仕入マスター予定数量(CSV)と、AIカメラで実物から自動検出した実績数量の差異突合レポート
                  </p>
                </div>
              </div>

              {/* Export reconciliation as CSV */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    // 予定数 must be the operator's 変更数 when they set one. Exporting
                    // the raw CSV quantity instead made the report contradict the
                    // ledger they inspected against, and this file is the artifact
                    // that leaves the building.
                    const headers = "店舗,品番,サイズ,カラー,予定数,実績数,状態,差分\n";
                    const rows = [
                      ...comparisonRows.map(r => {
                        const expected = changedQtyOverrides[r.id] ?? r.expectedQty;
                        const diff = r.actualQty - expected;
                        const status = diff === 0 ? "一致" : diff < 0 ? "不足" : "過剰";
                        return `${selectedStore},"${r.partNumber}","${r.size}","${r.color}",${expected},${r.actualQty},"${status}",${diff}`;
                      }),
                      ...extraScannedItems.map(r => {
                        return `${selectedStore},"${r.partNumber}","${r.size}","${r.color}",0,${r.actualQty},"リスト外",${r.actualQty}`;
                      })
                    ].join("\n");
                    
                    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]); // UTF-8 BOM
                    const blob = new Blob([bom, headers + rows], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.setAttribute("download", `kenpin_report_${selectedStore}.csv`);
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    setSuccessMessage("突合レポートCSVのエクスポートが完了しました。");
                  }}
                  className="text-xs text-blue-600 hover:text-blue-700 bg-blue-50/55 hover:bg-blue-100 border border-blue-200 rounded-lg px-3.5 py-2 cursor-pointer transition-colors font-bold flex items-center gap-1.5"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" />
                  突合表CSVエクスポート
                </button>
              </div>
            </div>

            <div className="overflow-x-auto -mx-6">
              <table className="w-full text-left border-collapse min-w-[650px] text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-[10px] font-black uppercase text-slate-400 tracking-widest bg-slate-50/55 h-11">
                    <th className="px-6 py-2.5 font-mono">状態 / STATUS</th>
                    <th className="px-4 py-2.5 font-mono">品番・型番 / PART CODE</th>
                    <th className="px-4 py-2.5 font-mono">サイズ / SIZE</th>
                    <th className="px-4 py-2.5 font-mono">カラー / COLOR</th>
                    <th className="px-4 py-2.5 text-center font-mono w-24">予定数量 / REQ</th>
                    <th className="px-4 py-2.5 text-center font-mono w-24">今回検出 / ACT</th>
                    <th className="px-6 py-2.5 text-right font-mono">差異 / DIFF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-600 font-sans">
                  {comparisonRows.length === 0 && extraScannedItems.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-12 text-center text-slate-400 font-medium">
                        この店舗の検品レコードはありません。Step 2 でスキャンを開始してください。
                      </td>
                    </tr>
                  ) : (
                    <>
                      {comparisonRows.map((row) => {
                        // Same override the scanning ledger works against; using the
                        // raw CSV quantity here reported 不足 for rows the operator
                        // had already corrected to 0.
                        const expected = changedQtyOverrides[row.id] ?? row.expectedQty;
                        const diff = row.actualQty - expected;
                        const matches = diff === 0;
                        const isZero = row.actualQty === 0;
                        const isShort = diff < 0 && !isZero;
                        const isSurplus = diff > 0;

                        return (
                          <tr key={row.id} className="hover:bg-slate-50/30 transition-all duration-150 bg-white">
                            <td className="px-6 py-4">
                              {matches && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-green-50 text-green-700 font-bold border border-green-200">
                                  ✓ 一致 (MATCH)
                                </span>
                              )}
                              {isZero && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-50 text-slate-400 font-bold border border-slate-100">
                                  未スキャン (PENDING)
                                </span>
                              )}
                              {isShort && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-bold border border-amber-200 animate-pulse">
                                  ▲ 不足 (SHORT)
                                </span>
                              )}
                              {isSurplus && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-bold border border-indigo-200 animate-pulse">
                                  ◆ 過剰 (SURPLUS)
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-4 font-bold text-slate-800 font-mono uppercase">
                              {row.partNumber}
                            </td>
                            <td className="px-4 py-4">
                              <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-bold font-mono text-[10px] border border-blue-100">
                                {row.size}
                              </span>
                            </td>
                            <td className="px-4 py-4 font-bold text-slate-700 uppercase">
                              {row.color}
                            </td>
                            <td className="px-4 py-4 text-center font-mono font-bold text-slate-500 bg-slate-50/40">
                              {expected}
                              {expected !== row.expectedQty && (
                                <span className="block text-[9px] font-sans font-normal text-slate-400 leading-none mt-0.5">
                                  変更 (元 {row.expectedQty})
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-4 text-center font-mono font-bold text-slate-800">
                              {row.actualQty}
                            </td>
                            <td className="px-6 py-4 text-right font-mono font-bold">
                              {diff === 0 ? (
                                <span className="text-green-600">±0</span>
                              ) : diff < 0 ? (
                                <span className="text-amber-600">{diff}</span>
                              ) : (
                                <span className="text-indigo-600">+{diff}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {/* Extra scanned items */}
                      {extraScannedItems.map((row, idx) => (
                        <tr key={`extra_${idx}`} className="hover:bg-yellow-50/40 transition-all duration-150 bg-yellow-50/15">
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-800 font-bold border border-yellow-200 animate-pulse">
                              ⚠ リスト外 (EXTRA)
                            </span>
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-800 font-mono uppercase">
                            {row.partNumber}
                          </td>
                          <td className="px-4 py-4">
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-orange-50 text-orange-700 font-bold font-mono text-[10px] border border-orange-100">
                              {row.size}
                            </span>
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-700 uppercase">
                            {row.color}
                          </td>
                          <td className="px-4 py-4 text-center font-mono font-bold text-slate-400 bg-slate-50/40">
                            0
                          </td>
                          <td className="px-4 py-4 text-center font-mono font-bold text-slate-800">
                            {row.actualQty}
                          </td>
                          <td className="px-6 py-4 text-right font-mono font-bold text-yellow-700">
                            +{row.actualQty}
                          </td>
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {/* Next Store Flow Step Control Block */}
            <div className="mt-8 pt-6 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-50/80 rounded-2xl p-4 border border-slate-100">
              <div className="text-slate-500 text-xs text-center sm:text-left font-medium leading-relaxed">
                現在の店舗【 <strong>{selectedStore}</strong> 】の検査が終わりましたら、次の店舗の検品へ進んでください。
              </div>

              <button
                onClick={() => {
                  // Advance step index loop safely
                  const currentIndex = distinctStores.indexOf(selectedStore);
                  let nextStore = "";
                  if (currentIndex !== -1 && currentIndex < distinctStores.length - 1) {
                    nextStore = distinctStores[currentIndex + 1];
                  } else {
                    nextStore = distinctStores[0]; // loops back to the index 0
                  }

                  setSelectedStore(nextStore);
                  setWorkflowStep("store_select"); // loop back to shop select view to start fresh
                  setSuccessMessage(`次の店舗【 ${nextStore} 】の検品に切り替えました。連続スキャンを開始可能です。`);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                className="w-full sm:w-auto px-6 py-3.5 bg-green-600 hover:bg-green-700 text-white shadow-xs font-extrabold rounded-xl text-sm flex items-center justify-center gap-2.5 transition-all cursor-pointer transform hover:-translate-y-0.5 duration-100 shadow-2xs active:scale-[0.985]"
              >
                ※次の店舗へ進む (Proceed to Next Store)
                <ChevronRight className="w-4 h-4 text-white" />
              </button>
            </div>
          </div>
        )}

        {/* Global Recent Scans List - Displayed as Live Session Log across steps 1 and 2, hidden only on Results check to maintain focus */}
        {workflowStep !== "results" && (
          <div className="w-full">
            <HistoryList
              entries={history}
              selectedSheet={selectedSheet}
              onClearHistory={handleClearHistory}
              onSaveEntry={handleSaveHistoryItem}
            />
          </div>
        )}
      </main>

      {/* Global Industrial Interface Footer */}
      <footer className="h-10 bg-[#1E293B] text-white/80 flex items-center px-6 shrink-0 font-mono text-[10px]">
        <div className="flex-1 flex gap-8">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></div>
            <span className="text-[10px] text-white/50 font-medium tracking-widest uppercase">
              AIS Neural Engine Active
            </span>
          </div>
          <div className="flex items-center gap-2 hidden md:flex">
            <span className="text-[10px] text-white/40 font-medium uppercase">
              Model: Gemini 3.5 Flash
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 font-medium uppercase">
              API Sync Status: Online
            </span>
          </div>
        </div>
        <div className="text-[10px] text-white/30 truncate">
          SYSTEM_HEARTBEAT_STABLE // {currentTimestamp}
        </div>
      </footer>

      {/* CUSTOM OVERLAY DIALOGS (REPLACES NATIVE DIALOG BLOCKERS) */}
      {confirmModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-2xl max-w-md w-full overflow-hidden transform scale-100 transition-all">
            <div className="p-6">
              <h3 className="text-base font-extrabold text-slate-900 mb-2">{confirmModal.title}</h3>
              <p className="text-sm text-slate-500 leading-relaxed">{confirmModal.message}</p>
            </div>
            <div className="bg-slate-50 px-6 py-4 flex justify-end gap-3 border-t border-slate-100">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
              >
                キャンセル
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="px-4 py-2 text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-700 rounded-lg transition-colors cursor-pointer"
              >
                確定
              </button>
            </div>
          </div>
        </div>
      )}

      {overscanAlert && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-amber-50 rounded-2xl border-2 border-amber-300 shadow-2xl max-w-md w-full overflow-hidden transform scale-100 transition-all">
            <div className="p-6 flex gap-4">
              <div className="w-12 h-12 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0 border border-amber-200">
                <AlertCircle className="w-6 h-6 animate-pulse" />
              </div>
              <div className="space-y-2 flex-1">
                <h3 className="text-base font-extrabold text-amber-900 leading-snug">
                  【超過警告】検品数量の上限を超えています
                </h3>
                <p className="text-xs text-amber-800 font-medium">
                  マスター指示数に対してスキャン数が超過しています。
                </p>
                <div className="bg-white/80 border border-amber-200/50 rounded-xl p-3.5 space-y-1 font-mono text-xs text-slate-800 mt-2">
                  <div><strong>品番:</strong> {overscanAlert.partNumber}</div>
                  <div><strong>仕様:</strong> {overscanAlert.size} / {overscanAlert.color}</div>
                  <div className="pt-1.5 border-t border-dashed border-amber-200 flex justify-between mt-1">
                    <span>指示予定数:</span>
                    <span className="font-bold text-slate-900">{overscanAlert.expectedQty} 点</span>
                  </div>
                  <div className="flex justify-between text-amber-800 font-bold">
                    <span>今回スキャン数:</span>
                    <span className="font-extrabold text-amber-600">{overscanAlert.scannedQty + 1} 点目</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="bg-amber-100/50 px-6 py-4 flex justify-end gap-3 border-t border-amber-200">
              <button
                onClick={overscanAlert.onCancel}
                className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-amber-100 rounded-lg transition-colors cursor-pointer"
              >
                キャンセル（記録しない）
              </button>
              <button
                onClick={overscanAlert.onAccept}
                className="px-5 py-2.5 text-xs font-extrabold text-white bg-amber-600 hover:bg-amber-700 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                了解して検品数に加える
              </button>
            </div>
          </div>
        </div>
      )}

      {nonMasterAlert && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-rose-50 rounded-2xl border-2 border-rose-300 shadow-2xl max-w-md w-full overflow-hidden transform scale-100 transition-all">
            <div className="p-6 flex gap-4">
              <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0 border border-rose-200">
                <AlertCircle className="w-6 h-6 animate-pulse" />
              </div>
              <div className="space-y-2 flex-1">
                <h3 className="text-base font-extrabold text-rose-900 leading-snug">
                  【マスタ外警告】対象外の商品です
                </h3>
                <p className="text-xs text-rose-800 font-medium">
                  この店舗の検品対象マスタ（予定リスト）に登録がありません。
                </p>
                <div className="bg-white/80 border border-rose-200/50 rounded-xl p-3.5 space-y-1 font-mono text-xs text-slate-800 mt-2">
                  <div><strong>品番:</strong> {nonMasterAlert.partNumber || "品番不明"}</div>
                  <div><strong>仕様:</strong> {nonMasterAlert.size || "ー"} / {nonMasterAlert.color || "ー"}</div>
                </div>
              </div>
            </div>
            <div className="bg-rose-100/50 px-6 py-4 flex justify-end gap-3 border-t border-rose-200">
              <button
                onClick={nonMasterAlert.onCancel}
                className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-rose-100 rounded-lg transition-colors cursor-pointer"
              >
                キャンセル（記録しない）
              </button>
              <button
                onClick={nonMasterAlert.onAccept}
                className="px-5 py-2.5 text-xs font-extrabold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm transition-colors cursor-pointer"
              >
                了解して記録に加える
              </button>
            </div>
          </div>
        </div>
      )}

      {uninspectedAlert && (
        <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-slate-900 text-white rounded-2xl border border-slate-800 shadow-2xl max-w-md w-full overflow-hidden transform scale-100 transition-all">
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-500/10 text-red-400 flex items-center justify-center border border-red-500/20">
                  <AlertCircle className="w-5 h-5 animate-bounce" />
                </div>
                <h3 className="text-base font-extrabold tracking-tight">【未検品警告】不足商品があります</h3>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">
                まだ検品（スキャン）されていない商品が残っています。
                <br />
                現在、<strong>合計 {uninspectedAlert.uninspectedCount} 点</strong> が未検品（不足）状態です。
              </p>
              <p className="text-xs text-slate-400">
                ※このまま「結果確認」画面に進んで差異を確認することも可能です。
              </p>
            </div>
            <div className="bg-slate-950/50 px-6 py-4 flex justify-end gap-3 border-t border-slate-800/80">
              <button
                onClick={() => setUninspectedAlert(null)}
                className="px-4 py-2.5 text-xs font-bold text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                戻って検品を続ける
              </button>
              <button
                onClick={uninspectedAlert.onConfirm}
                className="px-5 py-2.5 text-xs font-extrabold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer"
              >
                不足を承知で結果確認へ進む
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

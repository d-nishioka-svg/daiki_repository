# CLAUDE.md

Project context for Claude Code when working in this repository.

## What this app is

"Tag Extractor" — a garment-tag inspection app used by store staff to scan
product tags with a camera, match them against a delivery/order master list,
and log inspection results to a Google Sheet. Originally generated in Google
AI Studio and still actively developed there.

## ⚠️ Most important thing to know: this repo lags behind AI Studio

The user develops this app primarily **inside Google AI Studio's own
editor/preview**, not in this checked-out repo. AI Studio's "Sync to GitHub"
is **push-only** — it does not pull, and commits made here do **not**
propagate back into AI Studio automatically. So:

- The AI Studio app is very often **ahead** of what's in this repo.
- Do not assume `git log` / the current file contents reflect the latest
  behavior the user is actually running.
- When the user reports a bug or asks for a change to "the app," always ask
  (or infer from an uploaded ZIP/screenshot) whether they mean the AI Studio
  build or this repo before editing files here.
- When the user wants a change made in AI Studio, the deliverable is a
  **Japanese-language, copy-pasteable instruction script** for them to paste
  into AI Studio's Gemini-driven code editor — not a direct edit in this
  repo. Be precise about exact file/function names and current behavior so
  Gemini's edit lands correctly on the first try.
- When verifying whether an AI-Studio-applied fix actually worked, don't
  trust Gemini's own "修正しました" narration or a screenshot alone if the
  logic is non-trivial — ask for a ZIP export, extract it, and actually run
  the relevant function (e.g. via a small Node/esbuild harness) against real
  sample data.
- As of the last sync, this repo does **not** yet contain several features
  that exist in the AI Studio build (see "AI-Studio-only features" below).
  If the user asks to bring the repo up to date with AI Studio, that means
  re-implementing those from the description below (or from a fresh ZIP
  export), not `git pull`.

## Tech stack

- React 19 + Vite 6 + Tailwind CSS v4
- Express server (`server.ts`), TypeScript (no `strict`), bundled with esbuild
  for production (`dist/server.cjs`)
- Firebase Auth (`signInWithPopup`) for sign-in
- Google Sheets REST API (`values:append`, `values:PUT`) for logging results
- Gemini via `@google/genai`, server-side only, behind `/api/extract`
- `jose`'s `createRemoteJWKSet` (module-scope singleton) to verify Firebase
  ID tokens on the server
- In-memory per-user rate limiter (`Map<string,{count,resetAt}>`) in
  `server.ts` bounding `/api/extract` calls

## Key files (as currently in this repo)

- `server.ts` — Express app. Verifies the caller's Firebase ID token, rate
  limits, then calls Gemini with a two-model cascade
  (`gemini-3.5-flash` primary, `gemini-3.1-flash-lite` fallback) and a JSON
  `responseSchema`, `temperature: 0.0`, `thinkingConfig.thinkingLevel =
  ThinkingLevel.MINIMAL`.
- `src/App.tsx` — top-level state machine: inspection list, selected store,
  scan handling (`handleImageCapture`), history, results screen.
- `src/components/CameraStream.tsx` — camera capture + auto-scan loop. Gating
  condition for the next auto-capture is `if (!activeStream ||
  !autoScanEnabled || disabled || isExtracting) return;` — anything that
  keeps `isExtracting` true (e.g. an awaited network call) directly delays
  the next scan.
- `src/components/CsvImporter.tsx` — loads the store's delivery/order CSV
  (currently: local folder picker only in this repo; see below for the
  Drive-based version that exists only in AI Studio).
- `src/lib/folderAccess.ts` — wraps `showDirectoryPicker` (File System
  Access API). `isEmbeddedFrame()` detects cross-origin-iframe contexts
  (blocked in the AI Studio preview, works standalone/published).
  `pickFolder()` throws Japanese-language errors instead of silently
  returning null (except on `AbortError`) — fixed in commit `6f9d54b`.
- `src/lib/sheets.ts` — `appendRow(accessToken, spreadsheetId, rowValues)`:
  single `values/{range}:append` POST with a 400/404-only fallback to an
  unqualified range. Deliberately does **not** retry on 401/403/429.
- `src/lib/auth.ts` — Firebase sign-in / token handling.

## CSV column-layout convention (important, easy to get wrong)

The real-world export ("◯◯◯店別納品一覧表.CSV") has **header labels that do
not match their data columns** — parsing must be positional, not
header-name-based. This is handled by `isOrderSheetLayout` in
`CsvImporter.tsx`:

| Column | Index (0-based) | Meaning |
|---|---|---|
| H | 7 | 自社品番 (product code) |
| I | 8 | カラー名 (color name) |
| J | 9 | サイズ名 (size name) |
| U | 20 | 店舗名 (store name) |
| V | 21 | 明細数 (line-item quantity) |

Notes:
- Column L (index 11) is an internal color code, **not** a quantity — an
  earlier bug used it for 予定数/変更数/未検品数; the fix is to read column V
  (index 21) instead.
- If a human opens and re-saves the export in Excel, codes like `3763-1` can
  get silently reinterpreted as dates (e.g. `Jan-63`). This is **unfixable
  downstream in code** — must be prevented upstream (format the column as
  Text in Excel, or never let Excel touch the file before it's read by the
  app).
- The app's built-in sample/demo CSV must match this real 22-column layout
  (store name + quantity in columns U/V) or testing against it will give
  false negatives about whether a fix actually works.

## AI-Studio-only features (not yet in this repo)

These exist in the live AI Studio build as of the last ZIP review, and were
delivered as AI Studio instruction scripts rather than commits here:

1. **Google Drive integration** — replaces the local folder picker as the
   CSV source, while preserving the "type a folder + 3-digit store code" UX.
   Uses the existing Firebase/OAuth session with the `drive.readonly` scope
   (a broader scope than the original `drive.file`, so it requires users to
   re-consent/re-login once). New files: `src/lib/driveAccess.ts`
   (`resolveDriveFolderId`, `listFolderFiles`, `downloadDriveFile`,
   `readStoreCsvFromDrive`, `listDriveStoreCodes`, `DriveAccessError`,
   `isDriveAuthError`) and Drive-related state/handlers added to
   `CsvImporter.tsx` (`driveFolderInput`, `driveFolderId`, `driveCodes`,
   `isDriveBusy`, `handleConnectDrive`, `handleForgetDrive`).
2. **Excel (.xlsx/.xls) support** alongside CSV — new file
   `src/lib/spreadsheetSource.ts` (`isExcelFile`, `isSpreadsheetFile`,
   `excelBufferToCsvText` via SheetJS `xlsx` package), branched into in
   `CsvImporter.tsx`'s file-loading paths, plus widened
   `candidateNames`/`accept` filters.
3. **Manual CSV/Excel bulk-upload panel removed** — operation is Drive-only
   now; the old upload panel, `handleFiles`, and related file-input JSX were
   deleted from `CsvImporter.tsx`.
4. **Store-selection lists scoped to the current search only** — both the
   "対象店舗を選択してください" section (in `App.tsx`) and (now-removed,
   see next point) "切替可能な店舗一覧" badge previously accumulated store
   names across *every* past search in the session. Fixed by making
   `onImport` do a **full replace** of `inspectionList`
   (`setInspectionList(list)`, not a merge) since the workflow is
   single-Drive-search-at-a-time. `App.tsx`'s `distinctStores` derivation is
   unchanged but now correctly reflects only the current search as a result.
5. **"切替可能な店舗一覧" badge removed entirely** — was redundant with
   "対象店舗を選択してください" once both were scoped correctly; kept only
   the latter.
6. **Auto-popup on scan completion** — when every master row for the
   selected store has been scanned (uninspected count reaches 0), a popup
   now prompts the user to proceed to the results screen. Implemented with
   a shared `computeUninspectedCount` helper (reused by the manual
   "結果確認" button) plus a `prevUninspectedCountRef` + `useEffect` that
   fires only on the `>0 → 0` edge transition (so it doesn't refire just
   because the count is already 0).
7. **Scan-speed fix** — `handleImageCapture`'s normal-path branch was
   `await saveScannedItem()`, which (because `isExtracting` is only cleared
   in a `finally` after this resolves) delayed `CameraStream`'s next
   auto-capture by the full Sheets-append round trip. Changed to
   fire-and-forget (`saveScannedItem();`, no `await`), matching the
   `isNonMaster`/`isOverScan` branches which were already fire-and-forget.
   Also split `server.ts`'s Gemini retry logic into `isQuotaExhausted`
   (429/RESOURCE_EXHAUSTED — fail fast, no backoff) vs
   `isTransientOverload` (503/500/UNAVAILABLE — keep retrying), raised
   `RATE_LIMIT_MAX_REQUESTS` from 60 to 120, and added timing
   instrumentation around the Gemini call and around `/api/extract` overall.
   **Not yet confirmed by the user whether this resolved the perceived
   slowdown.**

When asked to bring this repo up to date with AI Studio, re-implement the
above (ideally by diffing against a fresh ZIP export from the user) rather
than assuming any of it is already here.

## Known pending issues (flagged in earlier review, not yet fixed anywhere)

- Orphaned `MediaStream` on rapid camera restart in `CameraStream.tsx`.
- Back-camera auto-selection is unreliable on some devices.
- Duplicate master rows can be double-counted via a `find()`-based match.
- `createSpreadsheet`-equivalent code ignores the result of the header-row
  write, so a failed header write goes unnoticed.
- iPhone HEIC photos get labelled as JPEG.
- List rendering uses array-index keys on "extra item" rows.

## Working conventions in this repo

- Default branch work happens on `claude/content-understanding-wm7qx7`;
  fast-forward `main` after pushing there when asked.
- Commit messages and PR bodies: plain description of the change, no model
  name/identifier.
- Prefer verifying behavior by actually running the relevant function
  against real sample data over trusting a diff or narration alone,
  especially for anything CSV-parsing or AI-Studio-sourced.

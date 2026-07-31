/**
 * Access to the shared CSV folder.
 *
 * A browser cannot open a path the user typed — there is no API for it, by
 * design. What it can do is let the operator pick the folder once through the
 * File System Access API and keep a handle to it, after which the app can read
 * "211店別納品一覧表.CSV" out of that folder on demand without another dialog.
 * The handle survives reloads because it is stored in IndexedDB; localStorage
 * cannot hold one (it is structured-cloneable, not a string).
 *
 * Chrome and Edge on desktop support this. Firefox, Safari and mobile browsers
 * do not, so callers must keep the manual file picker as a fallback.
 */

const DB_NAME = "tag_extractor_fs";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const FOLDER_KEY = "csv_folder";

export const isFolderAccessSupported = (): boolean =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const withStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
};

export const saveFolderHandle = async (
  handle: FileSystemDirectoryHandle,
): Promise<void> => {
  await withStore("readwrite", (store) => store.put(handle, FOLDER_KEY) as IDBRequest<any>);
};

export const loadFolderHandle =
  async (): Promise<FileSystemDirectoryHandle | null> => {
    try {
      const handle = await withStore<FileSystemDirectoryHandle | undefined>(
        "readonly",
        (store) => store.get(FOLDER_KEY),
      );
      return handle ?? null;
    } catch (err) {
      console.warn("Could not read the stored folder handle:", err);
      return null;
    }
  };

export const clearFolderHandle = async (): Promise<void> => {
  try {
    await withStore("readwrite", (store) => store.delete(FOLDER_KEY) as IDBRequest<any>);
  } catch (err) {
    console.warn("Could not clear the stored folder handle:", err);
  }
};

/**
 * Chrome drops the permission grant when the tab is closed, so a restored handle
 * needs it re-requested. `requestPermission` must run inside a user gesture.
 */
export const ensureReadPermission = async (
  handle: FileSystemDirectoryHandle,
  { promptIfNeeded = true }: { promptIfNeeded?: boolean } = {},
): Promise<boolean> => {
  const anyHandle = handle as any;
  if (typeof anyHandle.queryPermission !== "function") return true;

  if ((await anyHandle.queryPermission({ mode: "read" })) === "granted") return true;
  if (!promptIfNeeded) return false;
  return (await anyHandle.requestPermission({ mode: "read" })) === "granted";
};

export const pickFolder = async (): Promise<FileSystemDirectoryHandle | null> => {
  if (!isFolderAccessSupported()) return null;
  try {
    const handle = await (window as any).showDirectoryPicker({
      id: "tag-extractor-csv",
      mode: "read",
    });
    await saveFolderHandle(handle);
    return handle;
  } catch (err: any) {
    // AbortError just means the operator closed the dialog.
    if (err?.name !== "AbortError") {
      console.warn("Folder selection failed:", err);
    }
    return null;
  }
};

/** Filenames the delivery export is known to use, in the order we try them. */
const candidateNames = (code: string): string[] => [
  `${code}店別納品一覧表.CSV`,
  `${code}店別納品一覧表.csv`,
  `${code}店別発注一覧表.CSV`,
  `${code}店別発注一覧表.csv`,
];

export interface FolderCsv {
  fileName: string;
  buffer: ArrayBuffer;
}

/**
 * Reads the CSV for a store code out of the chosen folder. Falls back to scanning
 * the directory for any file starting with the code, so a slightly different
 * naming convention still resolves.
 */
export const readStoreCsv = async (
  handle: FileSystemDirectoryHandle,
  code: string,
): Promise<FolderCsv | null> => {
  for (const name of candidateNames(code)) {
    try {
      const fileHandle = await handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      return { fileName: file.name, buffer: await file.arrayBuffer() };
    } catch {
      // Not found under this spelling; try the next.
    }
  }

  try {
    for await (const [name, entry] of (handle as any).entries()) {
      if (
        entry.kind === "file" &&
        name.startsWith(code) &&
        name.toLowerCase().endsWith(".csv")
      ) {
        const file = await entry.getFile();
        return { fileName: file.name, buffer: await file.arrayBuffer() };
      }
    }
  } catch (err) {
    console.warn("Could not scan the selected folder:", err);
  }

  return null;
};

/** Store codes discoverable in the folder, for showing what is available. */
export const listStoreCodes = async (
  handle: FileSystemDirectoryHandle,
): Promise<string[]> => {
  const codes = new Set<string>();
  try {
    for await (const [name, entry] of (handle as any).entries()) {
      if (entry.kind !== "file" || !name.toLowerCase().endsWith(".csv")) continue;
      const match = name.match(/^(\d{3})/);
      if (match) codes.add(match[1]);
    }
  } catch (err) {
    console.warn("Could not list the selected folder:", err);
  }
  return Array.from(codes).sort();
};

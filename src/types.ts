export interface TagData {
  partNumber: string;
  size: string;
  color: string;
}

export interface ScanHistoryEntry {
  id: string;
  time: string;
  partNumber: string;
  size: string;
  color: string;
  status: "extracting" | "pending" | "saving" | "saved" | "failed";
  error?: string;
  previewImage?: string;
  store: string; // The store where the scan was recorded
}

export interface SpreadsheetInfo {
  id: string;
  name: string;
  url: string;
}

export interface InspectionListItem {
  id: string;
  store: string;
  partNumber: string;
  size: string;
  color: string;
  expectedQty: number;
  actualQty: number; // Scanned count
}

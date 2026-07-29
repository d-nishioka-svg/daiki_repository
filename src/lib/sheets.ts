import { SpreadsheetInfo } from "../types";

/**
 * Creates a brand new Google Spreadsheet for Tag Extractor and initializes it with headers
 */
export const createSpreadsheet = async (accessToken: string, title: string): Promise<SpreadsheetInfo> => {
  const response = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        title: title,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to create spreadsheet: ${errText}`);
  }

  const data = await response.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // Initialize spreadsheet with header row
  const headers = ["Scan Time / スキャン日時", "Store / 店舗", "Part Number / 品番 (NO)", "Size / サイズ (SIZE)", "Color / カラー (COL)"];
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1:E1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range: "A1:E1",
        majorDimension: "ROWS",
        values: [headers],
      }),
    }
  );

  return {
    id: spreadsheetId,
    name: title,
    url: spreadsheetUrl,
  };
};

/**
 * Fetches basic metadata of an existing Google Spreadsheet to verify it exists and is accessible
 */
export const fetchSpreadsheetInfo = async (accessToken: string, spreadsheetId: string): Promise<SpreadsheetInfo> => {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to access the spreadsheet. Ensure the ID is correct and you have permission: ${errText}`);
  }

  const data = await response.json();
  return {
    id: spreadsheetId,
    name: data.properties.title || "Unnamed Spreadsheet",
    url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
};

/**
 * Appends a row of clothing tag data to an active spreadsheet
 */
export const appendRow = async (
  accessToken: string,
  spreadsheetId: string,
  rowValues: string[]
): Promise<void> => {
  const colLetter = rowValues.length > 4 ? "E" : "D";
  const rangeStr = `Sheet1!A:${colLetter}`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${rangeStr}:append?valueInputOption=USER_ENTERED`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        range: rangeStr,
        majorDimension: "ROWS",
        values: [rowValues],
      }),
    }
  );

  if (!response.ok) {
    const rawRangeStr = `A:${colLetter}`;
    // Falls back to scanning without explicit sheet name if default Sheet1 isn't present
    const fallbackResponse = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${rawRangeStr}:append?valueInputOption=USER_ENTERED`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          range: rawRangeStr,
          majorDimension: "ROWS",
          values: [rowValues],
        }),
      }
    );

    if (!fallbackResponse.ok) {
      const errText = await fallbackResponse.text();
      throw new Error(`Failed to append data to spreadsheet: ${errText}`);
    }
  }
};

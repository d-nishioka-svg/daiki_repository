// 環境変数の読み込みと検証。
// 値そのもの（トークン等）はログに出力しないこと。

export interface AppConfig {
  google: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    calendarId: string;
  };
  poodle: {
    baseUrl: string;
    storageStatePath: string;
  };
  trainerName: string;
  dryRun: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。.env.example を参考に .env を作成してください。`,
    );
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    google: {
      clientId: requireEnv("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: requireEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      refreshToken: requireEnv("GOOGLE_OAUTH_REFRESH_TOKEN"),
      calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    },
    poodle: {
      baseUrl: process.env.POODLE_BASE_URL || "https://poodle.race.co.jp",
      storageStatePath:
        process.env.POODLE_STORAGE_STATE_PATH ||
        "./secrets/poodle-storage-state.json",
    },
    trainerName: requireEnv("TRAINER_NAME"),
    // 未設定時は安全側（ドライラン）に倒す
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  };
}

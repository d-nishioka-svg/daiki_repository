import { mkdir, appendFile } from "node:fs/promises";

/**
 * ログには「いつ・どの企業の・どの予定を登録したか」のみを記録し、
 * 受講者の個人情報や契約金額等の機密情報は書き込まない。
 */

const LOG_DIR = "./logs";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function logEvent(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);

  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(`${LOG_DIR}/${today()}.log`, line + "\n", "utf-8");
}

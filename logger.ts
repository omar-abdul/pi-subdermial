/**
 * Minimal logger for subdermial debugging.
 * Writes to ~/.pi/agent/subdermial/subdermial.log
 */

import * as fs from "node:fs";
import * as path from "node:path";

let logStream: fs.WriteStream | null = null;
let logPath = "";

export function initLogger(dir: string): void {
  logPath = path.join(dir, "subdermial.log");
  try {
    fs.mkdirSync(dir, { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  } catch {
    logStream = null;
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function log(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, data?: unknown): void {
  const line = `[${timestamp()}] [${level}] ${message}${data ? " " + JSON.stringify(data) : ""}`;
  if (logStream) {
    logStream.write(line + "\n");
  }
  // Also write to stderr for visibility during development
  if (level === "ERROR" || level === "WARN") {
    process.stderr.write(`[subdermial:${level.toLowerCase()}] ${message}\n`);
  }
}

export function info(message: string, data?: unknown): void {
  log("INFO", message, data);
}

export function warn(message: string, data?: unknown): void {
  log("WARN", message, data);
}

export function error(message: string, data?: unknown): void {
  log("ERROR", message, data);
}

export function debug(message: string, data?: unknown): void {
  log("DEBUG", message, data);
}

export function getLogPath(): string {
  return logPath;
}

export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

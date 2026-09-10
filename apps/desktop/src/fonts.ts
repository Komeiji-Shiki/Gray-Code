import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
let cached: Promise<string[]> | undefined;

/** OS font families include system fonts and fonts installed for the current user. */
export function systemFonts(refresh = false): Promise<string[]> {
  if (refresh) cached = undefined;
  return cached ??= enumerate().catch(error => { cached = undefined; throw error; });
}
async function enumerate(): Promise<string[]> {
  let families: string[];
  if (process.platform === "win32") {
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Drawing; $graycodeFonts = [System.Drawing.Text.InstalledFontCollection]::new(); try { ConvertTo-Json -Compress -InputObject @($graycodeFonts.Families | ForEach-Object { $_.Name }) } finally { $graycodeFonts.Dispose() }";
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    families = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
  } else if (process.platform === "linux") {
    const result = await execute("fc-list", ["--format", "%{family}\n"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    families = result.stdout.split(/[\n,]/);
  } else if (process.platform === "darwin") {
    const result = await execute("system_profiler", ["SPFontsDataType", "-json"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    families = [];
    for (const font of JSON.parse(result.stdout).SPFontsDataType ?? [])
      for (const typeface of font.typefaces ?? []) if (typeface.family) families.push(typeface.family);
  } else families = [];
  return [...new Set(families.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const powershell = process.platform === 'win32' ? 'powershell.exe' : undefined;
const timeoutMs = 120_000;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
// 输出与错误都按 UTF-8 读取；不设置时中文系统的错误信息按 GBK 写出，读回来是乱码。
const preamble = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech`;
const listScript = `${preamble}
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
$voice.Dispose()`;

function run(script: string): Promise<string> {
  if (!powershell) return Promise.reject(new Error('本机语音合成只支持 Windows。'));
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = []; const errors: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error('本机语音合成超时。')); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 1024 * 1024) output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { if (errors.reduce((total, item) => total + item.length, 0) < 16 * 1024) errors.push(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) { resolve(Buffer.concat(output).toString('utf8')); return; }
      const message = Buffer.concat(errors).toString('utf8').trim();
      reject(new Error(message || `本机语音合成失败（退出码 ${code}）。`));
    });
  });
}

export async function listSystemVoices(): Promise<string[]> {
  const output = await run(listScript);
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** 一次 PowerShell 调用合成全部片段，避免长回复每段都重启系统语音。 */
export async function synthesizeSystem(texts: string[], voice: string | undefined, speed: number): Promise<{ text: string; bytes: Buffer }[]> {
  if (!powershell) throw new Error('本机语音合成只支持 Windows。');
  const directory = await mkdtemp(path.join(tmpdir(), 'graycode-speech-'));
  try {
    const files = texts.map((text, index) => ({ text, path: path.join(directory, `${index}.wav`) }));
    const input = path.join(directory, 'input.json');
    await writeFile(input, JSON.stringify(files), 'utf8');
    const rate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 10)));
    const script = `${preamble}
$items = Get-Content -Raw -Encoding UTF8 ${quote(input)} | ConvertFrom-Json
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
${voice ? `$voice.SelectVoice(${quote(voice)})` : ''}
$voice.Rate = ${rate}
foreach ($item in $items) {
  $voice.SetOutputToWaveFile($item.path)
  $voice.Speak($item.text)
}
$voice.Dispose()`;
    await run(script);
    return await Promise.all(files.map(async item => ({ text: item.text, bytes: await readFile(item.path) })));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

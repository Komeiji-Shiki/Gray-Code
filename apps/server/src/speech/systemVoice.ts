import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

const requestTimeoutMs = 120_000;
/** 空闲这么久后结束进程；下次朗读重新启动，只多一次加载系统语音的时间。 */
const idleMs = 120_000;

/**
 * 常驻循环：System.Speech 只加载一次，之后每行读入一个 JSON 请求、写出一行 JSON 结果。
 * 音频写入内存流并以 base64 返回，不落临时文件；base64 不含需要转义的字符，直接拼成 JSON。
 * 输入输出都按 UTF-8，中文文本和中文系统的错误信息都不会乱码。
 */
const workerScript = String.raw`$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$defaultVoice = $synth.Voice.Name
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $request = $line | ConvertFrom-Json
    if ($request.command -eq 'voices') {
      $names = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
      [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $true; voices = $names }))
      continue
    }
    if ($request.voice) { $synth.SelectVoice($request.voice) } else { $synth.SelectVoice($defaultVoice) }
    $synth.Rate = [int]$request.rate
    $clips = @(foreach ($text in $request.texts) {
      $stream = New-Object System.IO.MemoryStream
      $synth.SetOutputToWaveStream($stream)
      $synth.Speak([string]$text)
      $synth.SetOutputToNull()
      [Convert]::ToBase64String($stream.ToArray())
      $stream.Dispose()
    })
    $body = if ($clips.Count) { '"' + ($clips -join '","') + '"' } else { '' }
    [Console]::Out.WriteLine('{"ok":true,"clips":[' + $body + ']}')
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ ok = $false; error = $_.Exception.Message }))
  }
}`;

interface Pending { resolve(value: Record<string, any>): void; reject(error: Error): void }

/** 语音服务独占的 Windows 本机语音进程；请求串行执行，只结束自己启动的这一个进程。 */
export class SystemVoice {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: Pending;
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: NodeJS.Timeout;
  private closed = false;

  async voices(): Promise<string[]> {
    return (await this.request({ command: 'voices' })).voices ?? [];
  }

  /** 中止只影响这一次请求：排队中直接跳过；正在合成时结束进程，后面排队的请求换新进程继续。 */
  async synthesize(texts: string[], voice: string | undefined, speed: number, signal?: AbortSignal): Promise<Buffer[]> {
    if (!texts.length) return [];
    const rate = Math.max(-10, Math.min(10, Math.round((speed - 1) * 10)));
    const result = await this.request({ command: 'speak', texts, voice: voice ?? '', rate }, signal);
    return (result.clips as string[]).map(clip => Buffer.from(clip, 'base64'));
  }

  close(): void {
    this.closed = true;
    this.pending?.reject(new Error('本机语音已关闭。'));
    this.stop();
  }

  private request(command: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    const run = this.queue.catch(() => {}).then(() => {
      signal?.throwIfAborted();
      return this.send(command, signal);
    });
    this.queue = run;
    return run;
  }

  private send(command: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
    if (this.closed) return Promise.reject(new Error('本机语音已关闭。'));
    if (process.platform !== 'win32') return Promise.reject(new Error('本机语音合成只支持 Windows。'));
    clearTimeout(this.idle);
    const child = this.child ?? this.start();
    return new Promise<Record<string, any>>((resolve, reject) => {
      // System.Speech 的同步合成无法从外部打断，超时与中止都只能结束进程。
      const abort = () => { this.pending?.reject(signal!.reason); this.stop(); };
      const timer = setTimeout(() => { this.pending?.reject(new Error('本机语音合成超时。')); this.stop(); }, requestTimeoutMs);
      const settle = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending = {
        resolve: value => { settle(); resolve(value); },
        reject: error => { settle(); reject(error); },
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }).finally(() => {
      this.pending = undefined;
      this.idle = setTimeout(() => this.stop(), idleMs);
      this.idle.unref();
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', workerScript],
      { windowsHide: true, stdio: 'pipe' });
    this.child = child;
    let diagnostic = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4_000); });
    child.stdin.on('error', () => {});
    // 被结束的旧进程稍后才发出 close；此时 pending 可能已属于新进程的请求，只处理当前进程的事件。
    createInterface({ input: child.stdout }).on('line', line => {
      if (this.child !== child) return;
      let message: Record<string, any>;
      try { message = JSON.parse(line); }
      catch {
        if (line.trim()) diagnostic = `${diagnostic}${line}\n`.slice(-4_000);
        return;
      }
      if (message.ok) this.pending?.resolve(message);
      else this.pending?.reject(new Error(String(message.error || '本机语音合成失败。')));
    });
    child.once('error', error => { if (this.child === child) this.pending?.reject(error); });
    child.once('close', code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.pending?.reject(new Error(diagnostic.trim() || `本机语音进程已退出（退出码 ${code}）。`));
    });
    return child;
  }

  private stop(): void {
    clearTimeout(this.idle);
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    child.kill();
  }
}

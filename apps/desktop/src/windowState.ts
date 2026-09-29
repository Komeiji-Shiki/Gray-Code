import type { BrowserWindow, Rectangle } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface DesktopWindowSnapshot { format: 1; bounds: Rectangle; maximized: boolean }
const finiteBounds = (value: any): value is Rectangle => !!value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;

/** 使用显示器的逻辑工作区，拔除副屏或改变缩放后仍能完整看见标题栏和窗口。 */
export function restoreWindowBounds(snapshot: unknown, workAreas: readonly Rectangle[]) {
  const areas = workAreas.filter(finiteBounds);
  if (!areas.length) areas.push({ x: 0, y: 0, width: 1920, height: 1080 });
  const saved = snapshot as Partial<DesktopWindowSnapshot> | undefined;
  const bounds = saved?.format === 1 && finiteBounds(saved.bounds) ? saved.bounds : undefined;
  const overlap = (area: Rectangle) => bounds ? Math.max(0, Math.min(area.x + area.width, bounds.x + bounds.width) - Math.max(area.x, bounds.x))
    * Math.max(0, Math.min(area.y + area.height, bounds.y + bounds.height) - Math.max(area.y, bounds.y)) : 0;
  const area = areas.reduce((best, candidate) => overlap(candidate) > overlap(best) ? candidate : best);
  const minWidth = Math.min(1080, area.width), minHeight = Math.min(650, area.height);
  const width = Math.round(Math.max(minWidth, Math.min(area.width, bounds?.width ?? 1560)));
  const height = Math.round(Math.max(minHeight, Math.min(area.height, bounds?.height ?? 980)));
  const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, bounds?.x ?? area.x + (area.width - width) / 2)));
  const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bounds?.y ?? area.y + (area.height - height) / 2)));
  return { bounds: { x, y, width, height }, minWidth, minHeight, maximized: !!bounds && saved?.maximized === true };
}

/** 轻量窗口偏好独立于业务配置；连续拖动合并写入，写入失败不阻止关闭应用。 */
export class DesktopWindowState {
  private snapshot?: DesktopWindowSnapshot;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private readonly filename: string, private readonly report: (error: unknown) => void = console.warn) {}
  get value(): DesktopWindowSnapshot | undefined { return this.snapshot; }
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.filename, 'utf8'));
      if (saved?.format === 1 && finiteBounds(saved.bounds)) this.snapshot = { format: 1, bounds: { ...saved.bounds }, maximized: saved.maximized === true };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error); }
  }
  remember(bounds: Rectangle, maximized: boolean): void {
    if (!finiteBounds(bounds)) return;
    this.snapshot = { format: 1, bounds: { ...bounds }, maximized }; this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 500); this.timer.unref();
  }
  bind(window: BrowserWindow): void {
    const remember = () => { if (!window.isDestroyed() && !window.isMinimized()) this.remember(window.getNormalBounds(), window.isMaximized()); };
    window.on('resize', remember); window.on('move', remember);
    window.on('maximize', remember); window.on('unmaximize', remember); window.on('close', remember);
  }
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.dirty || !this.snapshot) return this.writing;
    const contents = JSON.stringify(this.snapshot); this.dirty = false;
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await writeFile(`${this.filename}.tmp`, contents, { mode: 0o600 });
      await rename(`${this.filename}.tmp`, this.filename);
    }).catch(this.report);
    return this.writing;
  }
}

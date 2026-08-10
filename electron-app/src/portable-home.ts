/**
 * portable-home.ts - 便携版「外层目录找回」工具
 *
 * 背景：便携版（electron-builder portable target）经 NSIS 启动器解压到
 * %TEMP%\GrayCode-Portable 后运行内层 exe。启动器在启动前会注入
 * PORTABLE_EXECUTABLE_DIR（外层便携 exe 所在目录），应用据此把数据目录解析为
 * `<外层目录>\data`，实现「exe + data 文件夹随身携带」。
 *
 * 问题：从任务栏固定图标启动时，Windows 固定的是内层 exe（运行中进程的 exe 路径），
 * explorer 直接启动内层 exe，NSIS 启动器不参与，PORTABLE_EXECUTABLE_DIR 不存在，
 * 数据目录回退到 `%TEMP%\GrayCode-Portable\data`——表现为「持久化丢失」。
 *
 * 方案：每次经启动器正常启动时，应用把外层目录写入解压缓存目录内的指针文件
 * gc-portable-home；内层 exe 被直接启动（固定图标等）时读取该指针找回外层目录，
 * 回填 PORTABLE_EXECUTABLE_DIR，使 userData 解析、安装形态判定等下游逻辑与正常启动一致。
 *
 * 设计约束：
 * - 不写 %LOCALAPPDATA% 等固定位置，不改变多实例语义——多实例能力来自
 *   各副本经启动器启动时注入的各自 PORTABLE_EXECUTABLE_DIR，指针只服务
 *   「内层 exe 被直接启动」这一兜底场景（多份副本共用同一解压缓存目录时，
 *   指针指向最近一次经启动器启动的副本目录，该场景下任务栏图标本就指向同一内层 exe）。
 */

import fs from 'fs';
import path from 'path';

export const PORTABLE_HOME_MARKER = 'gc-portable-home';
export const PORTABLE_CACHE_MARKER = 'gc-cache-key';

/** exe 目录是否位于便携解压缓存（存在 gc-cache-key 构建标记） */
export function isPortableCacheDir(exeDir: string): boolean {
  return fs.existsSync(path.join(exeDir, PORTABLE_CACHE_MARKER));
}

/**
 * 从解压缓存读取外层便携 exe 所在目录（gc-portable-home 指针文件）。
 * 目录不存在/损坏时返回 undefined（调用方维持原回退行为）。
 */
export function readPortableHomeFromCache(exeDir: string): string | undefined {
  if (!isPortableCacheDir(exeDir)) return undefined;
  try {
    const home = fs.readFileSync(path.join(exeDir, PORTABLE_HOME_MARKER), 'utf8').trim();
    if (!home) return undefined;
    const resolved = path.resolve(home);
    if (!fs.existsSync(resolved)) return undefined;
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 每次经启动器正常启动时刷新指针文件（内容 = 外层便携 exe 所在目录）。
 * 失败（只读/占用等极端情况）静默忽略——指针是尽力而为的兜底，不阻塞启动。
 */
export function persistPortableHomePointer(exeDir: string, home: string | undefined): void {
  if (!home) return;
  if (!isPortableCacheDir(exeDir)) return;
  try {
    fs.writeFileSync(path.join(exeDir, PORTABLE_HOME_MARKER), path.resolve(home), 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 回填 PORTABLE_EXECUTABLE_DIR：
 * - 已有环境变量（正常经启动器启动）→ 不做任何事；
 * - 缺失（任务栏固定等直接启动内层 exe）→ 从指针文件找回外层目录。
 * 返回是否完成了回填。
 */
export function backfillPortableExecutableDir(
  exeDir: string,
  env: Record<string, string | undefined>
): boolean {
  if (env.PORTABLE_EXECUTABLE_DIR) return false;
  const home = readPortableHomeFromCache(exeDir);
  if (!home) return false;
  env.PORTABLE_EXECUTABLE_DIR = home;
  return true;
}

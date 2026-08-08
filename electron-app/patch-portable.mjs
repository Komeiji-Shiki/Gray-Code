/**
 * patch-portable.mjs - 给 electron-builder 的 portable NSIS 模板打「解压缓存」补丁
 *
 * 背景：便携版 exe（NSIS 自解压）每次启动都把 ~95MB 应用解压到 %TEMP% 再运行、
 * 退出后整目录删除——解压占启动耗时大头（本机实测 2.27s / 总 3.0s）。
 * 本补丁把模板改成「缓存优先」：
 *   1. 首次启动：解压到 %TEMP%\GrayCode-Portable（unpackDirName 固定），
 *      解压成功后写入 gc-cache-key 标记文件（内容 = 本次构建的随机 build ID）。
 *   2. 再次启动：检测到应用文件存在且 gc-cache-key 与本构建 ID 一致 → 跳过解压，
 *      直接运行（启动从 ~3s 降到 ~1s 以内）。退出不再删除缓存目录。
 *   3. exe 被替换/重新下载（build ID 变化）→ 缓存失效，自动重新解压。
 *
 * 体积不受影响（仍是 LZMA 压缩的 7z 载荷，只是把「每次解压」变成「首次解压 + 复用」）。
 *
 * 幂等性：首次执行前备份原始模板为 portable.nsi.orig，之后每次先还原再打补丁。
 * 若模板内容与预期不符（electron-builder 升级导致模板变动）会抛错终止构建，
 * 避免静默产出未优化的启动器。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const templateDir = path.resolve(
  __dirname,
  'node_modules',
  'app-builder-lib',
  'templates',
  'nsis'
);
const templatePath = path.join(templateDir, 'portable.nsi');
const backupPath = templatePath + '.orig';

/** 本构建随机 build ID（写入缓存标记，exe 替换/重下后自动失效重解压） */
const BUILD_ID = crypto.randomBytes(8).toString('hex');

// 原始模板关键锚点（electron-builder 26.x）。全部缺失则视为模板已不是预期版本，拒绝继续。
// 注意：JS 模板字符串里 `${...}` 会被插值，NSIS 编译期宏（${APP_EXECUTABLE_FILENAME} 等）
// 必须写成 \${...} 转义；本脚本生成的脚本内容里只直接插入 BUILD_ID 字面量。
const ANCHORS = [
  `  RMDir /r $INSTDIR
  SetOutPath $INSTDIR
`,
  `  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'`,
  `  SetOutPath $EXEDIR
	RMDir /r $INSTDIR
SectionEnd`
];

const CACHE_PROLOG = `  ; GC-PORTABLE-CACHE (patched by patch-portable.mjs)
  ; 命中缓存（应用已解压且 gc-cache-key 与本构建 ID 一致）→ 跳过解压直接启动；
  ; 否则清空重解压，解压成功后写入缓存标记（中断/部分解压不落标记，下次自动重解压）。
  StrCpy $R5 "miss"
  IfFileExists "$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" gcCacheCheck gcExtract
  gcCacheCheck:
    ClearErrors
    FileOpen $R2 "$INSTDIR\\gc-cache-key" r
    IfErrors gcExtract 0
    FileRead $R2 $R3
    FileClose $R2
    StrCmp $R3 "${BUILD_ID}$\\r$\\n" gcLaunch gcExtract
  gcExtract:
  RMDir /r $INSTDIR
  SetOutPath $INSTDIR
`;

const CACHE_EPILOG = `  ; GC-PORTABLE-CACHE: 解压成功才写缓存标记（部分解压/中断不会留下可命中的缓存）
  FileOpen $R2 "$INSTDIR\\gc-cache-key" w
  FileWrite $R2 "${BUILD_ID}$\\r$\\n"
  FileClose $R2
  gcLaunch:
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'`;

function fail(message) {
  console.error(`[patch-portable] ${message}`);
  process.exit(1);
}

function main() {
  // 还原原始模板（首次运行先备份）
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, templatePath);
  } else {
    fs.copyFileSync(templatePath, backupPath);
  }

  let script = fs.readFileSync(templatePath, 'utf8');

  for (const anchor of ANCHORS) {
    if (!script.includes(anchor)) {
      fail(
        `portable.nsi 模板与预期不符（缺锚点：${JSON.stringify(anchor.slice(0, 60))}...）。` +
          `electron-builder 可能升级导致模板变更，请更新 patch-portable.mjs 后重试。`
      );
    }
  }

  // 1) 解压前置逻辑：缓存命中检查（插在 RMDir/SetOutPath 之前）
  script = script.replace(ANCHORS[0], CACHE_PROLOG);
  // 2) 解压后：写缓存标记 + gcLaunch 标签（插在环境变量注入之前）
  script = script.replace(ANCHORS[1], CACHE_EPILOG);
  // 3) 退出时保留缓存目录（不再 RMDir，移除原清理行）
  script = script.replace(ANCHORS[2], `  SetOutPath $EXEDIR
SectionEnd`);

  fs.writeFileSync(templatePath, script, 'utf8');
  console.log(`[patch-portable] portable.nsi patched (build id ${BUILD_ID})`);
}

main();

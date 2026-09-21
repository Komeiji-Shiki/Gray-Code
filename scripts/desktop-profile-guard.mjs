import { existsSync } from 'node:fs';
import path from 'node:path';

/** 运行过的便携目录含用户配置，不能被重新打包覆盖，也不能进入公开安装器。 */
export function assertCleanDesktopPackage(directory) {
  if (existsSync(path.join(directory, 'portable-data'))) {
    throw new Error('目标程序目录含 portable-data 用户配置，请使用新的 GRAYCODE_DESKTOP_OUT 生成干净发行包。');
  }
}

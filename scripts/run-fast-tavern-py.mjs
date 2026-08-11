/**
 * py-fast-tavern 测试运行器（跨平台）。
 *
 * 修改原因（09 批 M3）：原脚本 `python -m pip install pytest` 无 venv——Ubuntu 24.04
 * 等 PEP 668（externally-managed-environment）runner 上直接拒绝全局安装，nightly/release
 * CI 会红。修改方式：项目内创建 venv（仅首次），venv 内安装 pytest 并运行测试，
 * 不污染全局环境；Windows 与 POSIX 分别定位 venv 解释器。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const venvDir = path.join(root, 'fast-tavern-main', 'py-fast-tavern', '.venv');
const venvPython = process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');

function run(args, label) {
    const result = spawnSync(venvPython, args, { stdio: 'inherit', cwd: root });
    if (result.error) {
        console.error(`[fast-tavern-py] failed to spawn python: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`[fast-tavern-py] ${label} exited with code ${result.status}`);
        process.exit(result.status ?? 1);
    }
}

if (!fs.existsSync(venvPython)) {
    const created = spawnSync('python', ['-m', 'venv', venvDir], { stdio: 'inherit', cwd: root });
    if (created.status !== 0) {
        console.error('[fast-tavern-py] failed to create venv (python -m venv required)');
        process.exit(created.status ?? 1);
    }
}

run(['-m', 'pip', 'install', '--quiet', 'pytest'], 'pip install pytest');
run(['-m', 'pytest', 'fast-tavern-main/py-fast-tavern/tests', '-q'], 'pytest');

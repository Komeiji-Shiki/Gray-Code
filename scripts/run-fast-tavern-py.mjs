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

/** 单次 spawnSync 超时（pip install / pytest 冷启动 5 分钟上限） */
const SPAWN_TIMEOUT_MS = 300_000;
/** 探测超时：spawnSync --version 探测 10s 上限，防 PATH 中失效 shim 等导致挂起 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 探测某条 Python 命令是否可用：`<command> --version` 成功（未 spawn 失败、未超时被杀、退出码 0）。
 * 探测统一带 PROBE_TIMEOUT_MS 超时。
 * @param {string} command 命令名或完整路径
 * @returns {boolean} 可用与否
 */
function probePython(command) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS });
    return !probe.error && !probe.signal && probe.status === 0;
}

/**
 * 解析系统 Python 命令：优先 PYTHON 环境变量（CI 显式指定，同样探测一次确认可用），
 * 否则按 python3 → python 探测回退。Ubuntu 24.04 等现代发行版只有 python3（无 python 别名）；
 * Windows 通常只有 python（无 python3）。
 * @returns {string | null} 可用命令名/路径；探测全部失败时返回 null
 */
function resolveSystemPython() {
    if (process.env.PYTHON) {
        if (probePython(process.env.PYTHON)) {
            return process.env.PYTHON;
        }
        console.warn(`[fast-tavern-py] PYTHON=${process.env.PYTHON} 探测失败（--version 非零退出/超时/无法 spawn），回退 python3 → python 探测`);
    }
    for (const name of ['python3', 'python']) {
        if (probePython(name)) {
            return name;
        }
    }
    return null;
}

/** spawnSync 结果统一检查：spawn 失败 / 超时被杀 / 非零退出均显式报错 */
function assertSpawnOk(result, label) {
    if (result.error) {
        console.error(`[fast-tavern-py] failed to spawn: ${result.error.message}`);
        process.exit(1);
    }
    if (result.signal) {
        console.error(`[fast-tavern-py] ${label} killed by signal ${result.signal}（可能超过 ${SPAWN_TIMEOUT_MS}ms 超时）`);
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(`[fast-tavern-py] ${label} exited with code ${result.status}`);
        process.exit(result.status ?? 1);
    }
}

function run(args, label) {
    const result = spawnSync(venvPython, args, { stdio: 'inherit', cwd: root, timeout: SPAWN_TIMEOUT_MS });
    assertSpawnOk(result, label);
}

if (!fs.existsSync(venvPython)) {
    const systemPython = resolveSystemPython();
    if (!systemPython) {
        console.error('[fast-tavern-py] 未找到系统 Python：请安装 python3（或设置 PYTHON 环境变量指定解释器路径）');
        process.exit(1);
    }
    const created = spawnSync(systemPython, ['-m', 'venv', venvDir], {
        stdio: 'inherit',
        cwd: root,
        timeout: SPAWN_TIMEOUT_MS,
    });
    assertSpawnOk(created, `create venv (${systemPython} -m venv)`);
}

run(['-m', 'pip', 'install', '--quiet', 'pytest'], 'pip install pytest');
run(['-m', 'pytest', 'fast-tavern-main/py-fast-tavern/tests', '-q'], 'pytest');

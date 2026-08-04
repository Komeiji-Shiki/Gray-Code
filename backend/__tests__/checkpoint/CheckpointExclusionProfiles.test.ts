import {
    DEFAULT_EXCLUSION_PROFILES,
    DEFAULT_ENABLED_PROFILES,
    DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
    resolveEnabledProfiles,
    collectEnabledProfilePatterns,
    buildIgnoreSnapshot,
    validateCustomExclusionPatterns,
    getExclusionProfile
} from '../../modules/checkpoint/CheckpointExclusionProfiles';

/**
 * CheckpointExclusionProfiles 测试（EX-03~EX-06 / EX-12）
 *
 * 覆盖：
 * - 8 个默认排除类别的代表性模式（严格按计划文档 L531~L682）
 * - 不建议默认排除的扩展名（*.bin / *.dat / *.model、env/、png/jpg/svg）
 * - enabledProfiles 解析语义（缺省全开 / 空对象全开 / 部分覆盖）
 * - 规则快照构建（CheckpointIgnoreSnapshot）
 * - 自定义模式校验（EX-12：空、绝对路径、纯 !、.. 越界、换行）
 */

function patternsOf(id: string): string[] {
    const profile = getExclusionProfile(id);
    if (!profile) {
        throw new Error(`profile ${id} not found`);
    }
    return [...profile.patterns];
}

describe('CheckpointExclusionProfiles', () => {
    test('defines exactly the 8 default exclusion profiles in plan order', () => {
        expect(DEFAULT_EXCLUSION_PROFILES.map(p => p.id)).toEqual([
            'logs',
            'aiModels',
            'datasets',
            'caches',
            'pythonVenvs',
            'buildArtifacts',
            'largeMedia',
            'archives'
        ]);
        for (const profile of DEFAULT_EXCLUSION_PROFILES) {
            expect(profile.displayName.length).toBeGreaterThan(0);
            expect(profile.description.length).toBeGreaterThan(0);
            expect(profile.patterns.length).toBeGreaterThan(0);
            expect(profile.defaultEnabled).toBe(true);
        }
    });

    test('logs profile contains log patterns', () => {
        const patterns = patternsOf('logs');
        for (const representative of ['*.log', '*.log.*', 'logs/', 'log/', 'npm-debug.log*', 'yarn-error.log*', 'pnpm-debug.log*', 'lerna-debug.log*']) {
            expect(patterns).toContain(representative);
        }
    });

    test('aiModels profile contains model weight patterns but not generic binary extensions', () => {
        const patterns = patternsOf('aiModels');
        for (const representative of ['*.safetensors', '*.pt', '*.pth', '*.onnx', '*.h5', '*.hdf5', '*.pb', '*.ckpt', '*.gguf', '*.ggml', '*.tflite', '*.torchscript', '*.mlmodel', '*.joblib', '*.engine', '*.trt', '*.mar']) {
            expect(patterns).toContain(representative);
        }
        // 不建议默认排除：*.bin / *.dat / *.model（过于通用）
        expect(patterns).not.toContain('*.bin');
        expect(patterns).not.toContain('*.dat');
        expect(patterns).not.toContain('*.model');
    });

    test('datasets profile contains dataset patterns', () => {
        const patterns = patternsOf('datasets');
        for (const representative of ['data/', 'datasets/', 'dataset/', '*.parquet', '*.arrow', '*.feather', '*.tfrecord']) {
            expect(patterns).toContain(representative);
        }
    });

    test('caches profile contains cache and bytecode patterns', () => {
        const patterns = patternsOf('caches');
        for (const representative of ['.cache/', '.mypy_cache/', '.pytest_cache/', '.ruff_cache/', '.tox/', '__pycache__/', '*.pyc', '*.pyo']) {
            expect(patterns).toContain(representative);
        }
    });

    test('pythonVenvs profile excludes venv dirs but not generic env/', () => {
        const patterns = patternsOf('pythonVenvs');
        for (const representative of ['.venv/', 'venv/', 'virtualenv/']) {
            expect(patterns).toContain(representative);
        }
        // 不建议默认排除所有名为 env/ 的目录（避免误伤配置目录）
        expect(patterns).not.toContain('env/');
    });

    test('buildArtifacts profile contains build output patterns', () => {
        const patterns = patternsOf('buildArtifacts');
        for (const representative of ['dist/', 'build/', '.next/', '.nuxt/', '.gradle/', 'target/', 'coverage/', '.nyc_output/', '*.tsbuildinfo']) {
            expect(patterns).toContain(representative);
        }
    });

    test('largeMedia profile contains large media patterns but not small images', () => {
        const patterns = patternsOf('largeMedia');
        for (const representative of ['*.mp4', '*.mkv', '*.mov', '*.avi', '*.flac', '*.psd', '*.tiff', '*.raw']) {
            expect(patterns).toContain(representative);
        }
        // 不建议默认排除常见小型图片（前端项目重要源码资源）
        expect(patterns).not.toContain('*.png');
        expect(patterns).not.toContain('*.jpg');
        expect(patterns).not.toContain('*.svg');
    });

    test('archives profile contains archive and binary patterns', () => {
        const patterns = patternsOf('archives');
        for (const representative of ['*.zip', '*.tar', '*.tar.gz', '*.tgz', '*.7z', '*.rar', '*.iso', '*.dmg', '*.exe', '*.dll']) {
            expect(patterns).toContain(representative);
        }
    });

    test('all profiles are enabled by default', () => {
        for (const profile of DEFAULT_EXCLUSION_PROFILES) {
            expect(DEFAULT_ENABLED_PROFILES[profile.id]).toBe(true);
        }
        expect(DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    });

    test('resolveEnabledProfiles: undefined = all enabled, explicit false disables', () => {
        const all = resolveEnabledProfiles(undefined);
        expect(all).toEqual(DEFAULT_EXCLUSION_PROFILES.map(p => p.id));

        // 空对象没有显式 false → 全部按默认启用
        expect(resolveEnabledProfiles({})).toEqual(DEFAULT_EXCLUSION_PROFILES.map(p => p.id));

        const partial = resolveEnabledProfiles({ logs: false, caches: false });
        expect(partial).not.toContain('logs');
        expect(partial).not.toContain('caches');
        expect(partial).toContain('aiModels');
        expect(partial).toContain('archives');

        // 显式全部关闭
        const allOff: Record<string, boolean> = {};
        for (const profile of DEFAULT_EXCLUSION_PROFILES) {
            allOff[profile.id] = false;
        }
        expect(resolveEnabledProfiles(allOff)).toEqual([]);
    });

    test('collectEnabledProfilePatterns flattens only enabled profiles', () => {
        const patterns = collectEnabledProfilePatterns({ logs: true, aiModels: false });
        expect(patterns).toContain('*.log');
        expect(patterns).not.toContain('*.safetensors');
        expect(patterns).toContain('dist/'); // buildArtifacts 默认启用
    });

    test('buildIgnoreSnapshot produces the manifest snapshot shape', () => {
        const snapshot = buildIgnoreSnapshot({
            enabledProfiles: { logs: false },
            maxFileSizeBytes: 123456,
            customPatterns: ['*.tmp']
        });
        expect(snapshot.version).toBeGreaterThanOrEqual(1);
        expect(snapshot.forcedRulesVersion).toBeGreaterThanOrEqual(1);
        expect(snapshot.defaultProfileVersion).toBeGreaterThanOrEqual(1);
        expect(snapshot.enabledProfiles.logs).toBe(false);
        expect(snapshot.enabledProfiles.aiModels).toBe(true);
        expect(snapshot.maxFileSizeBytes).toBe(123456);
        expect(snapshot.customPatterns).toEqual(['*.tmp']);

        // 0 / 负数 = 不限制
        expect(buildIgnoreSnapshot({ maxFileSizeBytes: 0 }).maxFileSizeBytes).toBe(0);
        expect(buildIgnoreSnapshot({ maxFileSizeBytes: -5 }).maxFileSizeBytes).toBe(0);
    });

    test('validateCustomExclusionPatterns accepts valid gitignore-style patterns', () => {
        const valid = ['*.log', 'generated/', '**/cache/**', '!important/model.gguf', '/anchored/', 'src/generated/'];
        expect(validateCustomExclusionPatterns(valid)).toEqual([]);
    });

    test('validateCustomExclusionPatterns rejects empty patterns', () => {
        const issues = validateCustomExclusionPatterns(['', '   ', '*.log']);
        expect(issues).toHaveLength(2);
        expect(issues.every(i => i.reason === 'empty')).toBe(true);
    });

    test('validateCustomExclusionPatterns rejects absolute path patterns', () => {
        const issues = validateCustomExclusionPatterns(['C:\\Users\\me\\project\\foo', 'C:/Users/me/foo', '//server/share/foo']);
        expect(issues).toHaveLength(3);
        expect(issues.every(i => i.reason === 'absolute')).toBe(true);
    });

    test('validateCustomExclusionPatterns rejects bare negation', () => {
        const issues = validateCustomExclusionPatterns(['!', '! ', '!*.log']);
        expect(issues).toHaveLength(2);
        expect(issues.filter(i => i.reason === 'negation_only')).toHaveLength(2);
    });

    test('validateCustomExclusionPatterns rejects .. traversal patterns', () => {
        const issues = validateCustomExclusionPatterns(['../foo', 'a/../../b', 'ok/../evil', 'fine.txt']);
        expect(issues).toHaveLength(3);
        expect(issues.filter(i => i.reason === 'traversal')).toHaveLength(3);
    });

    test('validateCustomExclusionPatterns rejects patterns containing newlines', () => {
        const issues = validateCustomExclusionPatterns(['*.log\n*.secret']);
        expect(issues).toHaveLength(1);
        expect(issues[0].reason).toBe('newline');
    });
});

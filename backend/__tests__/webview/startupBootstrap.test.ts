import {
    buildDeferredFrontendLoader,
    buildStartupBootstrapMarkup,
    buildStartupBootstrapStyles,
    buildStartupPreferenceAssignment,
    resolveStartupSplashEnabled
} from '../../../webview/startupBootstrap';

describe('Webview 首帧启动引导', () => {
    test('旧配置或缺失配置默认开启，只有明确 false 才关闭', () => {
        expect(resolveStartupSplashEnabled(undefined)).toBe(true);
        expect(resolveStartupSplashEnabled({})).toBe(true);
        expect(resolveStartupSplashEnabled({ appearance: {} })).toBe(true);
        expect(resolveStartupSplashEnabled({ appearance: { splashEnabled: true } })).toBe(true);
        expect(resolveStartupSplashEnabled({ appearance: { splashEnabled: false } })).toBe(false);
    });

    test('开启与关闭首帧 DOM 严格互斥', () => {
        const enabledMarkup = buildStartupBootstrapMarkup(true);
        const disabledMarkup = buildStartupBootstrapMarkup(false);

        expect(enabledMarkup).toContain('startup-splash-bootstrap');
        expect(enabledMarkup).not.toContain('startup-backdrop');
        expect(disabledMarkup).toContain('startup-backdrop');
        expect(disabledMarkup).not.toContain('startup-splash-bootstrap');
        expect(enabledMarkup).toContain('data-graycode-bootstrap-screen');
        expect(disabledMarkup).toContain('data-graycode-bootstrap-screen');
    });

    test('将不可变启动偏好安全写入前端模块之前', () => {
        expect(buildStartupPreferenceAssignment(true)).toBe(
            'window.__GRAYCODE_STARTUP_SPLASH_ENABLED = true;'
        );
        expect(buildStartupPreferenceAssignment(false)).toBe(
            'window.__GRAYCODE_STARTUP_SPLASH_ENABLED = false;'
        );
    });

    test('内联样式使用真实 Gray icon，并同时覆盖两种首帧画面', () => {
        const css = buildStartupBootstrapStyles('vscode-resource:/resources/icon.svg');

        expect(css).toContain('url("vscode-resource:/resources/icon.svg")');
        expect(css).toContain('.startup-splash-bootstrap[data-graycode-bootstrap-screen]');
        expect(css).toContain('.startup-backdrop[data-graycode-bootstrap-screen]');
        expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    });

    test('首帧后才加载完整样式，并在样式完成后按顺序加载模块', () => {
        const loader = buildDeferredFrontendLoader(
            ['codicon.css', 'index.css'],
            ['vite-client.js', 'index.js']
        );

        expect(loader).toContain('requestAnimationFrame(() => requestAnimationFrame(loadApplication))');
        expect(loader).toContain('window.__GRAYCODE_FRONTEND_STYLES_READY = Promise.all(pendingStyles)');
        expect(loader).toContain('loadModule(0)');
        expect(loader).toContain('["codicon.css","index.css"]');
        expect(loader).toContain('["vite-client.js","index.js"]');
        expect(loader).not.toContain('<script');
    });
});

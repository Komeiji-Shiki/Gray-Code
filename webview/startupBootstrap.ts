/**
 * Webview 首帧启动画面。
 *
 * 这里生成的 DOM 与极小样式会直接写入扩展侧 HTML，在完整前端样式和 JavaScript
 * 下载、解析之前就参与首次绘制。Vue 挂载后会清空这些节点，并按同一个启动偏好
 * 接管画面。
 */

export const STARTUP_SPLASH_ENABLED_GLOBAL = '__GRAYCODE_STARTUP_SPLASH_ENABLED' as const;

/** 只有持久化配置明确为 false 时才关闭；缺失或旧配置继续沿用默认开启。 */
export function resolveStartupSplashEnabled(uiConfig: unknown): boolean {
    if (!uiConfig || typeof uiConfig !== 'object') {
        return true;
    }

    const appearance = (uiConfig as Record<string, unknown>).appearance;
    if (!appearance || typeof appearance !== 'object') {
        return true;
    }

    return (appearance as Record<string, unknown>).splashEnabled !== false;
}

/** 在前端模块执行前发布本次启动的不可变偏好快照。 */
export function buildStartupPreferenceAssignment(splashEnabled: boolean): string {
    return `window.${STARTUP_SPLASH_ENABLED_GLOBAL} = ${splashEnabled ? 'true' : 'false'};`;
}

/**
 * 两种首帧画面严格互斥：
 * - 开启：正式 Splash 同源的蓝图描线预备动效；
 * - 关闭：StartupBackdrop 使用的石墨光场 DOM。
 */
export function buildStartupBootstrapMarkup(splashEnabled: boolean): string {
    if (!splashEnabled) {
        return `<div class="startup-backdrop" data-graycode-bootstrap-screen aria-hidden="true">
        <div class="graphite-orbit"></div>
        <div class="graphite-horizon"></div>
    </div>`;
    }

    return `<div class="startup-splash-bootstrap" data-graycode-bootstrap-screen role="status" aria-label="Gray Code 正在启动">
        <div class="startup-splash-bootstrap__signal" aria-hidden="true">
            <span class="startup-splash-bootstrap__trace startup-splash-bootstrap__trace--cap"></span>
            <span class="startup-splash-bootstrap__trace startup-splash-bootstrap__trace--body"></span>
            <span class="startup-splash-bootstrap__pen"></span>
        </div>
    </div>`;
}

/**
 * 仅供 HTML 首次绘制使用的极小样式。选择器限定到 data 属性，不会覆盖 Vue 接管后的组件。
 */
export function buildStartupBootstrapStyles(iconUrl: string): string {
    const serializedIconUrl = JSON.stringify(iconUrl);
    return `
html, body, #app {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: var(--vscode-editor-background, #1e1e1e);
}

.startup-splash-bootstrap[data-graycode-bootstrap-screen] {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    color: var(--vscode-foreground, #cccccc);
    background: var(--vscode-editor-background, #1e1e1e);
}

.startup-splash-bootstrap[data-graycode-bootstrap-screen]::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image: radial-gradient(currentColor 1px, transparent 1px);
    background-size: 22px 22px;
    -webkit-mask-image: radial-gradient(ellipse at center, black 22%, transparent 70%);
    mask-image: radial-gradient(ellipse at center, black 22%, transparent 70%);
    opacity: 0;
    animation: graycode-bootstrap-grid-in 0.55s ease-out both;
}

.startup-splash-bootstrap__signal {
    position: relative;
    width: 156px;
    height: 184px;
    filter: drop-shadow(0 0 16px color-mix(in srgb, currentColor 10%, transparent));
    animation: graycode-bootstrap-signal-breathe 1.8s ease-in-out infinite;
}

.startup-splash-bootstrap__signal::before {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    -webkit-mask: url(${serializedIconUrl}) center / contain no-repeat;
    mask: url(${serializedIconUrl}) center / contain no-repeat;
    clip-path: inset(0 100% 0 0);
    opacity: 0.82;
    animation: graycode-bootstrap-trace-in 1.15s cubic-bezier(0.2, 0.75, 0.25, 1) forwards;
}

.startup-splash-bootstrap__trace {
    display: none;
}

.startup-splash-bootstrap__signal::after {
    content: '';
    position: absolute;
    left: 38px;
    bottom: 8px;
    width: 80px;
    height: 2px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, currentColor 28%, currentColor 72%, transparent);
    opacity: 0.24;
    animation: graycode-bootstrap-line-pulse 1.15s ease-in-out 0.25s infinite alternate;
}

.startup-splash-bootstrap__pen {
    position: absolute;
    top: 25px;
    left: 25px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vscode-textLink-foreground, #3794ff);
    box-shadow: 0 0 7px var(--vscode-textLink-foreground, #3794ff), 0 0 16px color-mix(in srgb, var(--vscode-textLink-foreground, #3794ff) 62%, transparent);
    opacity: 0;
    animation: graycode-bootstrap-pen 1.35s ease-in-out 0.03s infinite;
}

.startup-backdrop[data-graycode-bootstrap-screen] {
    --graphite-base: var(--vscode-editor-background, #1e1e1e);
    --graphite-panel: var(--vscode-sideBar-background, var(--graphite-base));
    --graphite-ink: var(--vscode-foreground, #cccccc);
    position: fixed;
    inset: 0;
    z-index: 9998;
    overflow: hidden;
    filter: grayscale(1);
    background:
        radial-gradient(ellipse 82% 66% at 49% 44%, color-mix(in srgb, var(--graphite-ink) 5%, transparent), transparent 72%),
        linear-gradient(132deg, color-mix(in srgb, var(--graphite-panel) 68%, var(--graphite-base)), var(--graphite-base) 46%, color-mix(in srgb, var(--graphite-panel) 55%, var(--graphite-base)));
}

.startup-backdrop[data-graycode-bootstrap-screen] .graphite-orbit {
    position: absolute;
    left: 50%;
    top: 46%;
    width: min(86vw, 980px);
    aspect-ratio: 2.24 / 1;
    border: 1px solid color-mix(in srgb, var(--graphite-ink) 13%, transparent);
    border-radius: 50%;
    box-shadow: inset 0 0 92px color-mix(in srgb, var(--graphite-ink) 4%, transparent), 0 0 150px color-mix(in srgb, var(--graphite-ink) 4%, transparent);
    transform: translate(-50%, -50%) rotate(-5deg);
    animation: graycode-bootstrap-orbit 2.4s ease-in-out infinite;
}

.startup-backdrop[data-graycode-bootstrap-screen] .graphite-horizon {
    position: absolute;
    left: 7%;
    right: 7%;
    top: 53%;
    height: 1px;
    overflow: visible;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--graphite-ink) 15%, transparent), transparent);
    transform: rotate(-3.5deg);
}

.startup-backdrop[data-graycode-bootstrap-screen] .graphite-horizon::after {
    content: '';
    position: absolute;
    top: -1px;
    left: 0;
    width: clamp(72px, 18%, 180px);
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--graphite-ink) 40%, transparent), transparent);
    box-shadow: 0 0 18px color-mix(in srgb, var(--graphite-ink) 16%, transparent);
    opacity: 0;
    animation: graycode-bootstrap-scan 2.1s ease-in-out infinite;
}

@keyframes graycode-bootstrap-grid-in {
    to { opacity: 0.05; }
}

@keyframes graycode-bootstrap-trace-in {
    to { clip-path: inset(0 0 0 0); opacity: 0.82; }
}

@keyframes graycode-bootstrap-signal-breathe {
    0%, 100% { transform: translateY(1px); opacity: 0.78; }
    50% { transform: translateY(-2px); opacity: 1; }
}

@keyframes graycode-bootstrap-line-pulse {
    from { transform: scaleX(0.72); opacity: 0.14; }
    to { transform: scaleX(1); opacity: 0.42; }
}

@keyframes graycode-bootstrap-pen {
    0% { transform: translate(0, 0); opacity: 0; }
    12% { opacity: 1; }
    43% { transform: translate(101px, 42px); opacity: 0.9; }
    54% { transform: translate(18px, 55px); opacity: 1; }
    88% { transform: translate(77px, 124px); opacity: 0.75; }
    100% { transform: translate(77px, 124px); opacity: 0; }
}

@keyframes graycode-bootstrap-orbit {
    0%, 100% { transform: translate(-50%, -50%) rotate(-5deg) scale(0.985); opacity: 0.62; }
    50% { transform: translate(-50%, -50%) rotate(-3.8deg) scale(1.018); opacity: 0.94; }
}

@keyframes graycode-bootstrap-scan {
    0%, 12% { transform: translateX(-125%) scaleX(0.72); opacity: 0; }
    38% { opacity: 0.9; }
    88%, 100% { transform: translateX(590%) scaleX(1.08); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
    .startup-splash-bootstrap[data-graycode-bootstrap-screen]::before,
    .startup-splash-bootstrap[data-graycode-bootstrap-screen] *,
    .startup-backdrop[data-graycode-bootstrap-screen] * {
        animation: none !important;
    }

    .startup-splash-bootstrap__signal::before {
        clip-path: none;
    }

    .startup-splash-bootstrap__pen,
    .startup-backdrop[data-graycode-bootstrap-screen] .graphite-horizon::after {
        display: none;
    }
}
`;
}


/**
 * 首帧绘制完成后并行加载完整样式与前端模块。
 * 模块可提前下载和解析，但 main.ts 会等待公开的样式 Promise 后再挂载 Vue，
 * 因而启动壳持续可见且不会出现无样式组件。样式失败也会 resolve，让应用继续启动。
 */
export function buildDeferredFrontendLoader(stylesheetUrls: string[], moduleUrls: string[]): string {
    const styles = JSON.stringify(stylesheetUrls);
    const modules = JSON.stringify(moduleUrls);

    return `(() => {
    const stylesheetUrls = ${styles};
    const moduleUrls = ${modules};

    const loadModule = (index) => {
        if (index >= moduleUrls.length) return;
        const script = document.createElement('script');
        script.type = 'module';
        script.src = moduleUrls[index];
        script.addEventListener('load', () => loadModule(index + 1), { once: true });
        script.addEventListener('error', () => loadModule(index + 1), { once: true });
        document.body.appendChild(script);
    };

    const loadApplication = () => {
        const pendingStyles = stylesheetUrls.map((href) => new Promise((resolve) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.addEventListener('load', resolve, { once: true });
            link.addEventListener('error', resolve, { once: true });
            document.head.appendChild(link);
        }));

        window.__GRAYCODE_FRONTEND_STYLES_READY = Promise.all(pendingStyles).then(() => undefined);
        loadModule(0);
    };

    requestAnimationFrame(() => requestAnimationFrame(loadApplication));
})();`;
}
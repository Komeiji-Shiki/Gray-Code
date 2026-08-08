<template>
  <!-- 纯装饰启动底图：无文字；灰银光痕的缓慢流动表示仍在加载 -->
  <div class="startup-backdrop" aria-hidden="true">
    <div class="graphite-orbit"></div>
    <div class="graphite-horizon"></div>
  </div>
</template>

<style scoped>
/*
 * 石墨蚀刻光场
 *
 * 全部色阶取自宿主主题，不假定深色或浅色；前景色在深色主题中生成银灰高光，
 * 在浅色主题中自然翻转为烟灰阴影。低频呼吸与掠光用于表达加载状态，
 * 不复刻正式 Splash 的 Logo 描绘叙事。
 */
.startup-backdrop {
  --graphite-base: var(--vscode-editor-background, #1e1e1e);
  --graphite-panel: var(--vscode-sideBar-background, var(--graphite-base));
  --graphite-raised: var(--vscode-editorWidget-background, var(--graphite-panel));
  --graphite-ink: var(--vscode-foreground, #cccccc);
  --graphite-whisper: color-mix(in srgb, var(--graphite-ink) 4%, transparent);
  --graphite-sheen: color-mix(in srgb, var(--graphite-ink) 9%, transparent);
  --graphite-edge: color-mix(in srgb, var(--graphite-ink) 15%, transparent);

  position: fixed;
  inset: 0;
  z-index: 9998;
  overflow: hidden;
  pointer-events: none;
  isolation: isolate;
  /* 某些高彩主题会给全局 foreground 加色相；占位始终保持纯灰阶。 */
  filter: grayscale(1);
  background:
    radial-gradient(
      ellipse 82% 66% at 49% 44%,
      var(--graphite-whisper) 0%,
      color-mix(in srgb, var(--graphite-ink) 1.5%, transparent) 42%,
      transparent 72%
    ),
    radial-gradient(
      ellipse 54% 92% at -8% 108%,
      color-mix(in srgb, var(--graphite-ink) 5%, transparent),
      transparent 70%
    ),
    radial-gradient(
      ellipse 48% 80% at 108% -12%,
      color-mix(in srgb, var(--graphite-ink) 3.5%, transparent),
      transparent 72%
    ),
    linear-gradient(
      132deg,
      color-mix(in srgb, var(--graphite-panel) 68%, var(--graphite-base)) 0%,
      var(--graphite-base) 44%,
      color-mix(in srgb, var(--graphite-raised) 56%, var(--graphite-base)) 100%
    );
}

/* 宽幅棱面：看得见层次，但没有明确物体轮廓。 */
.startup-backdrop::before {
  content: '';
  position: absolute;
  inset: -34%;
  z-index: -1;
  background:
    conic-gradient(
      from 214deg at 53% 46%,
      transparent 0deg 38deg,
      var(--graphite-whisper) 64deg,
      transparent 104deg 178deg,
      color-mix(in srgb, var(--graphite-ink) 3%, transparent) 208deg,
      transparent 248deg 360deg
    );
  filter: blur(54px) grayscale(1);
  transform: rotate(-7deg) scale(1.08);
  opacity: 0.9;
  animation: graphite-facet-drift 9s ease-in-out infinite alternate;
}

@keyframes graphite-facet-drift {
  0% {
    transform: rotate(-7deg) scale(1.08) translate3d(-0.8%, -0.4%, 0);
    opacity: 0.72;
  }
  100% {
    transform: rotate(-4.5deg) scale(1.12) translate3d(0.9%, 0.55%, 0);
    opacity: 0.96;
  }
}

/* 极淡拉丝纹理只在中心区域出现，边缘仍保持干净。 */
.startup-backdrop::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(
      102deg,
      transparent 0 5px,
      color-mix(in srgb, var(--graphite-ink) 1.4%, transparent) 5px 6px,
      transparent 6px 12px
    );
  -webkit-mask-image: radial-gradient(ellipse 78% 68% at center, black, transparent 76%);
  mask-image: radial-gradient(ellipse 78% 68% at center, black, transparent 76%);
  opacity: 0.72;
}

/* 不闭合的椭圆光层，让视觉介于石墨切面、镜面折射与烟雾之间。 */
.graphite-orbit {
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(86vw, 980px);
  aspect-ratio: 2.24 / 1;
  border-radius: 50%;
  transform: translate(-50%, -50%) rotate(-5deg);
  background:
    radial-gradient(
      ellipse at center,
      transparent 0 27%,
      color-mix(in srgb, var(--graphite-ink) 2%, transparent) 34%,
      var(--graphite-edge) 39.5%,
      color-mix(in srgb, var(--graphite-ink) 4%, transparent) 43%,
      transparent 54% 100%
    );
  box-shadow:
    inset 0 0 92px color-mix(in srgb, var(--graphite-ink) 3.5%, transparent),
    0 0 150px var(--graphite-whisper);
  filter: grayscale(1);
  opacity: 0.82;
  animation: graphite-orbit-breathe 4.8s ease-in-out -1.2s infinite;
}

@keyframes graphite-orbit-breathe {
  0%, 100% {
    transform: translate(-50%, -50%) rotate(-5deg) scale(0.985);
    opacity: 0.68;
  }
  50% {
    transform: translate(-50%, -50%) rotate(-3.7deg) scale(1.018);
    opacity: 0.94;
  }
}

.graphite-orbit::before {
  content: '';
  position: absolute;
  inset: 17% 8%;
  border: 1px solid color-mix(in srgb, var(--graphite-ink) 8%, transparent);
  border-radius: 50%;
  box-shadow:
    inset 0 0 52px color-mix(in srgb, var(--graphite-ink) 3%, transparent),
    0 0 68px color-mix(in srgb, var(--graphite-ink) 3%, transparent);
  opacity: 0.74;
  animation: graphite-inner-precession 7.2s ease-in-out -2.1s infinite alternate;
}

@keyframes graphite-inner-precession {
  from {
    transform: rotate(0.6deg) scale(0.985);
    opacity: 0.54;
  }
  to {
    transform: rotate(-1deg) scale(1.025);
    opacity: 0.82;
  }
}

.graphite-orbit::after {
  content: '';
  position: absolute;
  left: -6%;
  right: -6%;
  top: 43%;
  height: 14%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--graphite-ink) 3%, transparent) 20%,
    var(--graphite-edge) 50%,
    color-mix(in srgb, var(--graphite-ink) 3%, transparent) 80%,
    transparent
  );
  filter: blur(18px);
  animation: graphite-core-pulse 3.6s ease-in-out -0.9s infinite;
}

@keyframes graphite-core-pulse {
  0%, 100% {
    opacity: 0.34;
    transform: scaleX(0.9);
  }
  50% {
    opacity: 0.86;
    transform: scaleX(1.04);
  }
}

/* 一条几乎不可辨认的斜向明暗交界，把光场与窗口比例联系起来。 */
.graphite-horizon {
  position: absolute;
  left: 7%;
  right: 7%;
  top: 53%;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--graphite-whisper) 18%,
    var(--graphite-edge) 50%,
    var(--graphite-whisper) 82%,
    transparent
  );
  box-shadow: 0 0 44px var(--graphite-sheen);
  transform: rotate(-3.5deg);
  opacity: 0.66;
  animation: graphite-horizon-breathe 4.8s ease-in-out -1.2s infinite;
}

@keyframes graphite-horizon-breathe {
  0%, 100% {
    opacity: 0.38;
  }
  50% {
    opacity: 0.78;
  }
}

.graphite-horizon::before {
  content: '';
  position: absolute;
  left: 12%;
  right: 12%;
  top: -70px;
  height: 140px;
  background: radial-gradient(ellipse at center, var(--graphite-sheen), transparent 68%);
  filter: blur(24px) grayscale(1);
  opacity: 0.52;
}

/*
 * 最明确的加载信号：一束低亮度反光沿石墨交界掠过。
 * 中间保留停顿，避免持续扫动造成正式开屏动画仍在播放的错觉。
 */
.graphite-horizon::after {
  content: '';
  position: absolute;
  left: 0;
  top: -1px;
  width: clamp(72px, 18%, 180px);
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--graphite-ink) 18%, transparent) 44%,
    color-mix(in srgb, var(--graphite-ink) 38%, transparent) 50%,
    color-mix(in srgb, var(--graphite-ink) 18%, transparent) 56%,
    transparent
  );
  box-shadow: 0 0 18px color-mix(in srgb, var(--graphite-ink) 14%, transparent);
  filter: blur(0.5px) grayscale(1);
  opacity: 0;
  animation: graphite-scan 3.4s cubic-bezier(0.42, 0, 0.2, 1) -0.85s infinite;
}

@keyframes graphite-scan {
  0%, 12% {
    transform: translateX(-125%) scaleX(0.72);
    opacity: 0;
  }
  24% {
    opacity: 0.28;
  }
  52% {
    opacity: 0.92;
  }
  76% {
    opacity: 0.24;
  }
  88%, 100% {
    transform: translateX(590%) scaleX(1.08);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .startup-backdrop::before,
  .startup-backdrop::after,
  .graphite-orbit,
  .graphite-orbit::before,
  .graphite-orbit::after,
  .graphite-horizon,
  .graphite-horizon::after {
    animation: none;
  }

  .graphite-horizon::after {
    display: none;
  }
}
</style>

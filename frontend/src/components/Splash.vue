<script setup lang="ts">
/**
 * Splash.vue - 开始动画组件
 * - 一笔画出灰码少女（线稿取自 resources/icon.svg）：帽子先落笔 → 身体/发丝
 * - 标题字距收拢浮现 → 横线脉冲等待 ready
 * - 最短展示 minDisplayMs，ready 后淡出（FADE_MS）并 emit('done')
 * - 支持 prefers-reduced-motion（动画即时完成/静止，淡出无过渡）
 *
 * 注：TPS 实时可视化条不在此处——它位于聊天面板底部（components/input/TpsBar.vue），
 * 应用启动（无真实流）阶段由该组件自行随机模拟波动。
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 外部 ready 信号：App.vue 传入 languageLoaded（语言/设置加载完成） */
  ready?: boolean
  /** 最短展示时长（ms） */
  minDisplayMs?: number
}>(), {
  ready: false,
  minDisplayMs: 1100
})

const emit = defineEmits<{
  (e: 'done'): void
}>()

/** 淡出时长（与 CSS transition 一致） */
const FADE_MS = 450
/** 全部绘制动画完成（帽子 0.05~0.65s + 身体 0.45~1.35s + 标题 0.75~1.35s） */
const DRAW_TOTAL_MS = 1400

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
const reducedMotion = prefersReducedMotion()

const fading = ref(false)
const done = ref(false)
const drawDone = ref(false)

const startedAt = Date.now()

let fadeTimer: number | null = null
let drawTimer: number | null = null
let disposeTimer: number | null = null

// ---------- 状态机：绘制完成 + ready + 最短时长 → 淡出 → done ----------

function tryFadeOut(): void {
  if (fading.value || done.value) return
  if (!props.ready || !drawDone.value) return
  const elapsed = Date.now() - startedAt
  if (elapsed < props.minDisplayMs) {
    if (fadeTimer !== null) window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(tryFadeOut, props.minDisplayMs - elapsed)
    return
  }
  beginFadeOut()
}

function beginFadeOut(): void {
  fading.value = true
  if (reducedMotion) {
    finish()
    return
  }
  disposeTimer = window.setTimeout(finish, FADE_MS)
}

function finish(): void {
  if (done.value) return
  done.value = true
  emit('done')
}

function markDrawDone(): void {
  if (drawDone.value) return
  drawDone.value = true
  tryFadeOut()
}

function clearTimers(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer)
  if (drawTimer !== null) window.clearTimeout(drawTimer)
  if (disposeTimer !== null) window.clearTimeout(disposeTimer)
}

watch(
  () => props.ready,
  (val) => {
    if (val) tryFadeOut()
  }
)

onMounted(() => {
  if (reducedMotion) {
    // reduced-motion：动画即时完成（CSS 静态最终态），去掉无意义的 50ms 等待
    markDrawDone()
  } else {
    drawTimer = window.setTimeout(markDrawDone, DRAW_TOTAL_MS)
  }
  // 极端情况：挂载时 ready 已为 true
  if (props.ready) tryFadeOut()
})

onBeforeUnmount(() => {
  clearTimers()
})
</script>

<template>
  <div class="splash" :class="{ leaving: fading }">
    <div class="splash-inner">
      <!-- 灰码少女线稿：帽子先落笔，身体/发丝随后 -->
      <svg
        class="girl"
        viewBox="220 170 580 630"
        width="150"
        aria-hidden="true"
      >
        <!-- 帽子（先画） -->
        <path
          class="draw-cap"
          pathLength="1"
          d="M 230.0 366.0 L 232.0 369.0 L 258.0 355.0 L 292.0 344.0 L 350.0 340.0 L 381.0 344.0 L 424.0 356.0 L 498.0 391.0 L 529.0 401.0 L 567.0 400.0 L 624.0 385.0 L 589.0 364.0 L 527.0 336.0 L 480.0 322.0 L 428.0 314.0 L 365.0 315.0 L 325.0 321.0 L 280.0 334.0 L 240.0 355.0 Z M 358.0 246.0 L 339.0 313.0 L 380.0 305.0 L 432.0 304.0 L 508.0 318.0 L 565.0 340.0 L 738.0 428.0 L 735.0 349.0 L 723.0 276.0 L 690.0 241.0 L 634.0 207.0 L 562.0 184.0 L 531.0 180.0 L 488.0 181.0 L 456.0 187.0 L 418.0 200.0 L 393.0 213.0 L 364.0 235.0 Z"
        />
        <!-- 身体 / 发丝 / 面部（后画） -->
        <path
          class="draw-body"
          pathLength="1"
          d="M 744.0 758.0 L 724.0 723.0 L 704.0 706.0 L 687.0 698.0 L 630.0 684.0 L 625.0 684.0 L 583.0 725.0 L 582.0 719.0 L 517.0 750.0 L 497.0 754.0 L 476.0 753.0 L 455.0 743.0 L 438.0 724.0 L 432.0 697.0 L 436.0 688.0 L 396.0 700.0 L 393.0 720.0 L 382.0 708.0 L 373.0 706.0 L 377.0 742.0 L 345.0 715.0 L 319.0 745.0 L 302.0 784.0 L 751.0 784.0 Z M 588.0 600.0 L 544.0 631.0 L 485.0 655.0 L 485.0 679.0 L 447.0 696.0 L 443.0 701.0 L 446.0 716.0 L 454.0 728.0 L 471.0 740.0 L 482.0 743.0 L 512.0 740.0 L 572.0 714.0 L 585.0 706.0 L 590.0 688.0 L 592.0 653.0 L 588.0 616.0 Z M 334.0 534.0 L 329.0 587.0 L 332.0 645.0 L 339.0 677.0 L 354.0 710.0 L 364.0 722.0 L 357.0 683.0 L 358.0 657.0 L 369.0 679.0 L 387.0 700.0 L 374.0 641.0 L 372.0 572.0 L 341.0 544.0 Z M 587.0 408.0 L 601.0 509.0 L 606.0 582.0 L 604.0 651.0 L 596.0 700.0 L 615.0 673.0 L 631.0 639.0 L 647.0 588.0 L 653.0 550.0 L 680.0 532.0 L 690.0 512.0 L 692.0 495.0 L 685.0 475.0 L 678.0 471.0 L 662.0 472.0 L 666.0 443.0 L 673.0 455.0 L 694.0 471.0 L 701.0 487.0 L 701.0 509.0 L 696.0 526.0 L 687.0 541.0 L 672.0 553.0 L 707.0 696.0 L 722.0 706.0 L 742.0 728.0 L 755.0 762.0 L 753.0 694.0 L 737.0 594.0 L 765.0 660.0 L 785.0 760.0 L 790.0 743.0 L 786.0 701.0 L 745.0 532.0 L 728.0 436.0 L 639.0 393.0 L 606.0 404.0 Z M 326.0 374.0 L 306.0 418.0 L 299.0 457.0 L 301.0 493.0 L 310.0 522.0 L 312.0 484.0 L 323.0 450.0 L 329.0 491.0 L 338.0 518.0 L 353.0 542.0 L 369.0 556.0 L 370.0 513.0 L 377.0 480.0 L 411.0 401.0 L 414.0 481.0 L 409.0 477.0 L 402.0 445.0 L 386.0 482.0 L 381.0 506.0 L 393.0 571.0 L 417.0 601.0 L 446.0 622.0 L 481.0 640.0 L 548.0 612.0 L 594.0 577.0 L 588.0 483.0 L 577.0 410.0 L 534.0 413.0 L 483.0 398.0 L 462.0 434.0 L 439.0 460.0 L 466.0 389.0 L 402.0 362.0 L 343.0 352.0 Z"
        />
      </svg>

      <!-- 标题：字距收拢浮现 -->
      <h1 class="title">Gray Code</h1>

      <!-- 横线脉冲：等待 ready -->
      <div class="pulse-line" aria-hidden="true"></div>
    </div>
  </div>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  transition: opacity 0.45s ease;
}

.splash.leaving {
  opacity: 0;
  pointer-events: none;
}

.splash-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 24px;
}

.girl {
  display: block;
  color: var(--vscode-foreground);
  opacity: 0.95;
}

/* 描线动画：pathLength=1 归一化后，dashoffset 从 1 动画到 0 */
.draw-cap,
.draw-body {
  fill: none;
  stroke: currentColor;
  stroke-width: 26;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.draw-cap {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw-stroke 0.6s ease-out 0.05s both;
}

.draw-body {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw-stroke 0.9s ease-out 0.45s both;
}

@keyframes draw-stroke {
  to {
    stroke-dashoffset: 0;
  }
}

.title {
  margin: 0;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.5em;
  opacity: 0;
  animation: title-in 0.6s ease-out 0.75s both;
}

@keyframes title-in {
  to {
    letter-spacing: 0.08em;
    opacity: 1;
  }
}

.pulse-line {
  width: 64px;
  height: 2px;
  border-radius: 2px;
  background: var(--vscode-charts-blue, #0050b3);
  transform-origin: center;
  animation: line-pulse 1.1s ease-in-out 1.25s infinite;
}

@keyframes line-pulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scaleX(0.55);
  }
  50% {
    opacity: 0.95;
    transform: scaleX(1);
  }
}

/* prefers-reduced-motion：关闭全部装饰动画，直接呈现最终状态 */
@media (prefers-reduced-motion: reduce) {
  .draw-cap,
  .draw-body,
  .title,
  .pulse-line {
    animation: none;
  }
  .draw-cap,
  .draw-body {
    stroke-dashoffset: 0;
  }
  .title {
    letter-spacing: 0.08em;
    opacity: 1;
  }
  .pulse-line {
    opacity: 0.6;
    transform: scaleX(1);
  }
  .splash {
    transition: none;
  }
}
</style>

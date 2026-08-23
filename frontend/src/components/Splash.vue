<script setup lang="ts">
/**
 * Splash.vue - 开始动画组件
 * - 蓝图点阵浮现 → 笔尖光点执笔画出 Gray logo（线稿取自 resources/icon.svg）：
 *   帽子先落笔 → 身体/发丝 → 完稿定影提亮 → 呼吸待机
 * - 标题分层浮现（Gray 粗 / Code 细 + 蓝色终端光标）→ 副标题
 * - 格雷码等待线（3-bit 循环 000→001→011→010→110→111→101→100，每步恰好只变一位）
 *   等待 ready；ready 后三位归一为蓝色实线（保证至少完整播完一轮 8 步才归一）
 * - 最短展示 minDisplayMs，ready 后淡出（FADE_MS，blur+scale 消散）并 emit('done')
 * - 支持 prefers-reduced-motion（动画即时完成/静止，淡出无过渡）
 *
 * 时间轴（相对挂载，与 CSS 动画严格对齐）：
 *   0.00s  点阵背景淡入          0.05~0.75s  帽子描线 + 笔尖光点
 *   0.50~1.60s 身体描线 + 光点   0.75s       标题浮现
 *   1.15s  副标题 + 格雷码线起跳（周期 2s，相位 001 起始）
 *   1.35s  光标闪烁              1.60s       色块渗入 + 线稿退位细描边（0.5s）
 *   1.75s  帽子色块渗入          2.00s       完稿定影（0.5s）
 *   2.30s  DRAW_TOTAL_MS → drawDone → 呼吸待机
 *
 * 退场（ready 后两拍）：先归一（MERGE_MS，蓝线合并 + 光标定格）再淡出（FADE_MS）
 * ready 早到时（加载快）也强制等格雷码线完整播完一轮（挂载后 1.15s+2s=3.15s）再归一，
 * 保证每次启动都能看到完整 8 步循环
 *
 * 注：TPS 实时可视化条不在此处——它位于聊天面板底部（components/input/TpsBar.vue）。
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '../i18n'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  /** 外部 ready 信号：App.vue 传入 languageLoaded（语言/设置加载完成） */
  ready?: boolean
  /** 最短展示时长（ms）：默认与 DRAW_TOTAL_MS 一致，保证完整叙事（描线+上色+定影+格雷码起跳） */
  minDisplayMs?: number
}>(), {
  ready: false,
  minDisplayMs: 2300
})

const emit = defineEmits<{
  (e: 'done'): void
}>()

/** 淡出时长（与 CSS transition 一致） */
const FADE_MS = 450
/** 归一演出时长：ready 后先蓝线归一 + 光标定格，再淡出 */
const MERGE_MS = 420
/** 全部绘制动画完成（描线 0.05~1.6s + 上色 1.6~2.25s + 定影 2.0s 起） */
const DRAW_TOTAL_MS = 2300
/** 格雷码等待线：bit 循环动画延迟（与 CSS animation-delay 1.15s 对齐） */
const GRAY_LINE_DELAY = 1150
/** 格雷码等待线：单周期 2s（8 步 × 250ms，与 CSS 2s linear 对齐） */
const GRAY_LINE_PERIOD = 2000

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}
const reducedMotion = prefersReducedMotion()

const fading = ref(false)
const merging = ref(false)
const done = ref(false)
const drawDone = ref(false)

const startedAt = Date.now()

let fadeTimer: number | null = null
let drawTimer: number | null = null
let mergeTimer: number | null = null
let disposeTimer: number | null = null

// ---------- 状态机：绘制完成 + ready + 最短时长 → 淡出 → done ----------

function tryFadeOut(): void {
  if (merging.value || done.value) return
  if (!props.ready || !drawDone.value) return
  const now = Date.now()
  const elapsed = now - startedAt
  if (elapsed < props.minDisplayMs) {
    if (fadeTimer !== null) window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(tryFadeOut, props.minDisplayMs - elapsed)
    return
  }
  // 加载再快也要让格雷码线完整播完一轮（8 步），否则看不到完整循环就淡出了
  if (!reducedMotion) {
    const remain = startedAt + GRAY_LINE_DELAY + GRAY_LINE_PERIOD - now
    if (remain > 0) {
      if (fadeTimer !== null) window.clearTimeout(fadeTimer)
      fadeTimer = window.setTimeout(tryFadeOut, remain)
      return
    }
  }
  beginFadeOut()
}

function beginFadeOut(): void {
  // 第一拍：蓝线归一 + 光标定格（merging 类触发 .gray-line.is-ready）
  merging.value = true
  if (reducedMotion) {
    finish()
    return
  }
  // 第二拍：blur + scale 消散
  mergeTimer = window.setTimeout(() => {
    fading.value = true
    disposeTimer = window.setTimeout(finish, FADE_MS)
  }, MERGE_MS)
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
  if (mergeTimer !== null) window.clearTimeout(mergeTimer)
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
    // reduced-motion：动画即时完成（CSS 静态最终态），去掉无意义的等待
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
  <div class="splash" :class="{ leaving: fading, merged: merging }" role="status" aria-live="polite">
    <span class="gc-visually-hidden">{{ t('common.loading') }}</span>
    <div class="splash-inner" :class="{ settled: drawDone }">
      <!-- Gray logo：色块层（下）先渗入上色，线稿层（上）描完后退位为细描边 -->
      <svg
        class="girl"
        viewBox="220 170 580 630"
        width="150"
        aria-hidden="true"
      >
        <!-- 色块层：body 按 M…Z 拆块（身体→头发→脸镂空→帽檐→帽身，后画的覆盖重叠区），1.6s 起错峰渗入 -->
        <g class="fills">
          <path class="fill-body" d="M 744.0 758.0 L 724.0 723.0 L 704.0 706.0 L 687.0 698.0 L 630.0 684.0 L 625.0 684.0 L 583.0 725.0 L 582.0 719.0 L 517.0 750.0 L 497.0 754.0 L 476.0 753.0 L 455.0 743.0 L 438.0 724.0 L 432.0 697.0 L 436.0 688.0 L 396.0 700.0 L 393.0 720.0 L 382.0 708.0 L 373.0 706.0 L 377.0 742.0 L 345.0 715.0 L 319.0 745.0 L 302.0 784.0 L 751.0 784.0 Z" />
          <path class="fill-body" d="M 588.0 600.0 L 544.0 631.0 L 485.0 655.0 L 485.0 679.0 L 447.0 696.0 L 443.0 701.0 L 446.0 716.0 L 454.0 728.0 L 471.0 740.0 L 482.0 743.0 L 512.0 740.0 L 572.0 714.0 L 585.0 706.0 L 590.0 688.0 L 592.0 653.0 L 588.0 616.0 Z" />
          <path class="fill-hair" d="M 334.0 534.0 L 329.0 587.0 L 332.0 645.0 L 339.0 677.0 L 354.0 710.0 L 364.0 722.0 L 357.0 683.0 L 358.0 657.0 L 369.0 679.0 L 387.0 700.0 L 374.0 641.0 L 372.0 572.0 L 341.0 544.0 Z" />
          <path class="fill-hair" d="M 587.0 408.0 L 601.0 509.0 L 606.0 582.0 L 604.0 651.0 L 596.0 700.0 L 615.0 673.0 L 631.0 639.0 L 647.0 588.0 L 653.0 550.0 L 680.0 532.0 L 690.0 512.0 L 692.0 495.0 L 685.0 475.0 L 678.0 471.0 L 662.0 472.0 L 666.0 443.0 L 673.0 455.0 L 694.0 471.0 L 701.0 487.0 L 701.0 509.0 L 696.0 526.0 L 687.0 541.0 L 672.0 553.0 L 707.0 696.0 L 722.0 706.0 L 742.0 728.0 L 755.0 762.0 L 753.0 694.0 L 737.0 594.0 L 765.0 660.0 L 785.0 760.0 L 790.0 743.0 L 786.0 701.0 L 745.0 532.0 L 728.0 436.0 L 639.0 393.0 L 606.0 404.0 Z" />
          <path class="fill-face" d="M 326.0 374.0 L 306.0 418.0 L 299.0 457.0 L 301.0 493.0 L 310.0 522.0 L 312.0 484.0 L 323.0 450.0 L 329.0 491.0 L 338.0 518.0 L 353.0 542.0 L 369.0 556.0 L 370.0 513.0 L 377.0 480.0 L 411.0 401.0 L 414.0 481.0 L 409.0 477.0 L 402.0 445.0 L 386.0 482.0 L 381.0 506.0 L 393.0 571.0 L 417.0 601.0 L 446.0 622.0 L 481.0 640.0 L 548.0 612.0 L 594.0 577.0 L 588.0 483.0 L 577.0 410.0 L 534.0 413.0 L 483.0 398.0 L 462.0 434.0 L 439.0 460.0 L 466.0 389.0 L 402.0 362.0 L 343.0 352.0 Z" />
          <path class="fill-cap" d="M 230.0 366.0 L 232.0 369.0 L 258.0 355.0 L 292.0 344.0 L 350.0 340.0 L 381.0 344.0 L 424.0 356.0 L 498.0 391.0 L 529.0 401.0 L 567.0 400.0 L 624.0 385.0 L 589.0 364.0 L 527.0 336.0 L 480.0 322.0 L 428.0 314.0 L 365.0 315.0 L 325.0 321.0 L 280.0 334.0 L 240.0 355.0 Z" />
          <path class="fill-cap" d="M 358.0 246.0 L 339.0 313.0 L 380.0 305.0 L 432.0 304.0 L 508.0 318.0 L 565.0 340.0 L 738.0 428.0 L 735.0 349.0 L 723.0 276.0 L 690.0 241.0 L 634.0 207.0 L 562.0 184.0 L 531.0 180.0 L 488.0 181.0 L 456.0 187.0 L 418.0 200.0 L 393.0 213.0 L 364.0 235.0 Z" />
        </g>

        <!-- 帽子（先画） -->
        <path
          id="cap-path"
          class="draw-cap"
          pathLength="1"
          d="M 230.0 366.0 L 232.0 369.0 L 258.0 355.0 L 292.0 344.0 L 350.0 340.0 L 381.0 344.0 L 424.0 356.0 L 498.0 391.0 L 529.0 401.0 L 567.0 400.0 L 624.0 385.0 L 589.0 364.0 L 527.0 336.0 L 480.0 322.0 L 428.0 314.0 L 365.0 315.0 L 325.0 321.0 L 280.0 334.0 L 240.0 355.0 Z M 358.0 246.0 L 339.0 313.0 L 380.0 305.0 L 432.0 304.0 L 508.0 318.0 L 565.0 340.0 L 738.0 428.0 L 735.0 349.0 L 723.0 276.0 L 690.0 241.0 L 634.0 207.0 L 562.0 184.0 L 531.0 180.0 L 488.0 181.0 L 456.0 187.0 L 418.0 200.0 L 393.0 213.0 L 364.0 235.0 Z"
        />
        <!-- 身体 / 发丝 / 面部（后画） -->
        <path
          id="body-path"
          class="draw-body"
          pathLength="1"
          d="M 744.0 758.0 L 724.0 723.0 L 704.0 706.0 L 687.0 698.0 L 630.0 684.0 L 625.0 684.0 L 583.0 725.0 L 582.0 719.0 L 517.0 750.0 L 497.0 754.0 L 476.0 753.0 L 455.0 743.0 L 438.0 724.0 L 432.0 697.0 L 436.0 688.0 L 396.0 700.0 L 393.0 720.0 L 382.0 708.0 L 373.0 706.0 L 377.0 742.0 L 345.0 715.0 L 319.0 745.0 L 302.0 784.0 L 751.0 784.0 Z M 588.0 600.0 L 544.0 631.0 L 485.0 655.0 L 485.0 679.0 L 447.0 696.0 L 443.0 701.0 L 446.0 716.0 L 454.0 728.0 L 471.0 740.0 L 482.0 743.0 L 512.0 740.0 L 572.0 714.0 L 585.0 706.0 L 590.0 688.0 L 592.0 653.0 L 588.0 616.0 Z M 334.0 534.0 L 329.0 587.0 L 332.0 645.0 L 339.0 677.0 L 354.0 710.0 L 364.0 722.0 L 357.0 683.0 L 358.0 657.0 L 369.0 679.0 L 387.0 700.0 L 374.0 641.0 L 372.0 572.0 L 341.0 544.0 Z M 587.0 408.0 L 601.0 509.0 L 606.0 582.0 L 604.0 651.0 L 596.0 700.0 L 615.0 673.0 L 631.0 639.0 L 647.0 588.0 L 653.0 550.0 L 680.0 532.0 L 690.0 512.0 L 692.0 495.0 L 685.0 475.0 L 678.0 471.0 L 662.0 472.0 L 666.0 443.0 L 673.0 455.0 L 694.0 471.0 L 701.0 487.0 L 701.0 509.0 L 696.0 526.0 L 687.0 541.0 L 672.0 553.0 L 707.0 696.0 L 722.0 706.0 L 742.0 728.0 L 755.0 762.0 L 753.0 694.0 L 737.0 594.0 L 765.0 660.0 L 785.0 760.0 L 790.0 743.0 L 786.0 701.0 L 745.0 532.0 L 728.0 436.0 L 639.0 393.0 L 606.0 404.0 Z M 326.0 374.0 L 306.0 418.0 L 299.0 457.0 L 301.0 493.0 L 310.0 522.0 L 312.0 484.0 L 323.0 450.0 L 329.0 491.0 L 338.0 518.0 L 353.0 542.0 L 369.0 556.0 L 370.0 513.0 L 377.0 480.0 L 411.0 401.0 L 414.0 481.0 L 409.0 477.0 L 402.0 445.0 L 386.0 482.0 L 381.0 506.0 L 393.0 571.0 L 417.0 601.0 L 446.0 622.0 L 481.0 640.0 L 548.0 612.0 L 594.0 577.0 L 588.0 483.0 L 577.0 410.0 L 534.0 413.0 L 483.0 398.0 L 462.0 434.0 L 439.0 460.0 L 466.0 389.0 L 402.0 362.0 L 343.0 352.0 Z"
        />

        <!-- 笔尖光点：沿描线路径移动，先帽后身（SMIL animateMotion + mpath，与描线同曲线同节奏） -->
        <circle class="pen pen-cap" r="13" fill="currentColor">
          <animateMotion
            dur="0.7s"
            begin="0.05s"
            fill="freeze"
            calcMode="spline"
            keySplines="0 0 .58 1"
            keyPoints="0;1"
            keyTimes="0;1"
          >
            <mpath href="#cap-path" />
          </animateMotion>
        </circle>
        <circle class="pen pen-body" r="13" fill="currentColor">
          <animateMotion
            dur="1.1s"
            begin="0.5s"
            fill="freeze"
            calcMode="spline"
            keySplines="0 0 .58 1"
            keyPoints="0;1"
            keyTimes="0;1"
          >
            <mpath href="#body-path" />
          </animateMotion>
        </circle>
      </svg>

      <!-- 标题：Gray 粗 / Code 细 + 蓝色终端光标（呼应流式输出） -->
      <h1 class="title">
        <span class="t-gray">Gray</span>&nbsp;<span class="t-code">Code</span><span class="caret">▍</span>
      </h1>
      <p class="subtitle">AI&thinsp;CODING&thinsp;ASSISTANT</p>

      <!-- 格雷码等待线：3-bit 序列每步恰好只变一位，ready 后归一为蓝色实线 -->
      <div class="gray-line" :class="{ 'is-ready': merging }" aria-hidden="true">
        <span class="bit b2"></span><span class="bit b1"></span><span class="bit b0"></span>
      </div>
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
  overflow: hidden;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground);
  transition: opacity 0.45s ease;
}

/* 蓝图点阵背景 + 晕影：极淡网格点，径向遮罩聚焦中心 */
.splash::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(currentColor 1px, transparent 1px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(ellipse at center, black 25%, transparent 72%);
  mask-image: radial-gradient(ellipse at center, black 25%, transparent 72%);
  opacity: 0;
  animation: bg-in 1s ease 0.2s both;
}

@keyframes bg-in {
  to {
    opacity: 0.05;
  }
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
  transition: transform 0.45s ease, filter 0.45s ease;
}

.girl {
  display: block;
  color: var(--vscode-foreground);
  opacity: 0.95;
  /* 主题自适应灰阶：从 currentColor 派生，亮/暗主题自动成立 */
  --ink-hair: color-mix(in srgb, var(--vscode-foreground) 92%, var(--vscode-editor-background));
  --ink-cap: color-mix(in srgb, var(--vscode-foreground) 45%, var(--vscode-editor-background));
  --ink-body: color-mix(in srgb, var(--vscode-foreground) 30%, var(--vscode-editor-background));
  --paper: var(--vscode-editor-background);
  /* 完稿定影：2.0s 起轻微提亮再回落（0% 帧在 delay 期间压低透明度） */
  animation: girl-settle 0.5s ease-out 2s both;
}

@keyframes girl-settle {
  0% {
    opacity: 0.82;
  }
  40% {
    opacity: 1;
    filter: drop-shadow(0 0 10px currentColor);
  }
  100% {
    opacity: 0.95;
    filter: none;
  }
}

/* 色块层（草稿→上色）：body 1.6s 渗入（下层），cap 1.75s 渗入（错峰分层上色） */
.fills path {
  opacity: 0;
  animation: ink-in 0.5s ease-out both;
}

.fill-body {
  fill: var(--ink-body);
  animation-delay: 1.6s;
}

.fill-hair {
  fill: var(--ink-hair);
  animation-delay: 1.6s;
}

.fill-face {
  fill: var(--paper);
  animation-delay: 1.6s;
}

.fill-cap {
  fill: var(--ink-cap);
  animation-delay: 1.75s;
}

@keyframes ink-in {
  to {
    opacity: 1;
  }
}

/* 描线动画：pathLength=1 归一化后，dashoffset 从 1 动画到 0（时长与光点严格对齐） */
.draw-cap,
.draw-body {
  fill: none;
  stroke: currentColor;
  stroke-width: 26;
  stroke-linejoin: round;
  stroke-linecap: round;
}

/* 双动画：先描线（dashoffset），1.6s 起同步退位为细描边（line-retire 的 delay 自元素插入起算，与色块渗入同刻） */
.draw-cap {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation:
    draw-stroke 0.7s ease-out 0.05s both,
    line-retire 0.5s ease-out 1.6s both;
}

.draw-body {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation:
    draw-stroke 1.1s ease-out 0.5s both,
    line-retire 0.5s ease-out 1.6s both;
}

@keyframes draw-stroke {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes line-retire {
  to {
    opacity: 0.3;
    stroke-width: 10;
  }
}

/* 笔尖光点：与描线同步快起慢收，画完即隐（both 保证 delay 期间不可见） */
.pen {
  opacity: 0;
  filter: drop-shadow(0 0 8px currentColor);
}

.pen-cap {
  animation: pen-life 0.7s linear 0.05s both;
}

.pen-body {
  animation: pen-life 1.1s linear 0.5s both;
}

@keyframes pen-life {
  0% {
    opacity: 0;
  }
  8% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* 呼吸待机：等待期整体缓慢浮动 */
.splash-inner.settled {
  animation: idle-float 4s ease-in-out 0.3s infinite;
}

@keyframes idle-float {
  50% {
    transform: translateY(-2.5px);
  }
}

/* 标题层次：Gray 粗 / Code 细 + 蓝色终端光标 */
.title {
  margin: 0;
  font-size: 26px;
  letter-spacing: 0.08em;
  opacity: 0;
  animation: title-in 0.6s ease-out 0.75s both;
}

.t-gray {
  font-weight: 600;
}

.t-code {
  font-weight: 300;
  color: var(--vscode-descriptionForeground);
}

.caret {
  color: var(--vscode-charts-blue, #0050b3);
  font-weight: 300;
  animation: caret-blink 1.1s steps(1, end) 1.35s infinite;
}

@keyframes caret-blink {
  0%, 49% {
    opacity: 1;
  }
  50%, 100% {
    opacity: 0;
  }
}

/* 输出完成：光标定格实心蓝 */
.splash.merged .caret {
  animation: none;
  opacity: 1;
}

@keyframes title-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.subtitle {
  margin: -6px 0 0;
  font-size: 10px;
  letter-spacing: 0.42em;
  text-indent: 0.42em;
  color: var(--vscode-descriptionForeground);
  opacity: 0;
  animation: fade-up 0.6s ease-out 1.15s both;
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 0.8;
    transform: none;
  }
}

/* 格雷码等待线：3-bit 序列周期 2s（8 步 × 250ms），每步恰好只变一位；1.15s 与副标题同刻入场 */
.gray-line {
  display: flex;
  gap: 5px;
  margin-top: 4px;
  opacity: 0;
  animation: fade-up 0.6s ease-out 1.15s both;
}

.bit {
  width: 22px;
  height: 2px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.12;
  transition: opacity 0.3s ease, background 0.3s ease, width 0.3s ease;
}

/* 001→011→010→110→111→101→100→000 循环（相位旋转：第一帧即有一条亮着，杜绝开场全灭） */
.b0 {
  animation: g0 2s linear 1.15s infinite;
}

.b1 {
  animation: g1 2s linear 1.15s infinite;
}

.b2 {
  animation: g2 2s linear 1.15s infinite;
}

@keyframes g0 {
  0%, 24.9% { opacity: 1; }
  25%, 49.9% { opacity: 0.12; }
  50%, 74.9% { opacity: 1; }
  75%, 100% { opacity: 0.12; }
}

@keyframes g1 {
  0%, 12.4% { opacity: 0.12; }
  12.5%, 62.4% { opacity: 1; }
  62.5%, 100% { opacity: 0.12; }
}

@keyframes g2 {
  0%, 37.4% { opacity: 0.12; }
  37.5%, 87.4% { opacity: 1; }
  87.5%, 100% { opacity: 0.12; }
}

/* ready：三位归一，合并为蓝色实线（一次性闪光，覆盖 fade-up 入场动画） */
.gray-line.is-ready {
  gap: 0;
  animation: line-flash 0.45s ease;
}

.gray-line.is-ready .bit {
  animation: none;
  opacity: 1;
  background: var(--vscode-charts-blue, #0050b3);
}

@keyframes line-flash {
  30% {
    filter: drop-shadow(0 0 6px var(--vscode-charts-blue, #0050b3));
  }
  100% {
    filter: none;
  }
}

/* 淡出升级：不只变透明，还轻微放大 + 失焦（idle-float 让位给 transition） */
.splash.leaving .splash-inner {
  animation: none;
  transform: scale(1.02);
  filter: blur(3px);
}

/* prefers-reduced-motion：关闭全部装饰动画，直接呈现最终状态 */
@media (prefers-reduced-motion: reduce) {
  .pen {
    display: none; /* SMIL 不受 CSS 控制，直接藏掉 */
  }
  .splash::before {
    animation: none;
    opacity: 0.05;
  }
  .draw-cap,
  .draw-body,
  .title,
  .subtitle,
  .caret,
  .bit,
  .girl,
  .fills path,
  .gray-line,
  .splash-inner.settled {
    animation: none;
  }
  .draw-cap,
  .draw-body {
    stroke-dashoffset: 0;
    opacity: 0.3;
    stroke-width: 10;
  }
  .fills path {
    opacity: 1;
  }
  .gray-line {
    opacity: 1;
  }
  .title {
    opacity: 1;
  }
  .subtitle {
    opacity: 0.8;
  }
  .bit {
    opacity: 0.9;
  }
  .splash,
  .splash-inner {
    transition: none;
  }
}
</style>

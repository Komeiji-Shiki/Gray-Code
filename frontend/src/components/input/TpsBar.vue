<script setup lang="ts">
/**
 * TpsBar.vue - 聊天面板底部 TPS（tokens per second）实时可视化条。
 *
 * 位置：聊天 Webview 面板最底部一行（InputArea.bottom-toolbar），总结上下文按钮左侧。
 * 布局（flex 一行）：左侧 "TPS" 标签 + 中间 240×24 canvas 柱状图 + 右侧实时数值。
 *
 * 数据（三段状态机）：
 * - 真实流：订阅 utils/tpsMeter 单例（streamChunkHandlers 在流式 chunk 到达时 record token 数），
 *   sample.live 为 true 时绘制真实曲线；
 * - 流活跃但无真实 token（agent 思考/工具执行停顿 >2s）：冻结最近真实曲线，
 *   不清空 bars（避免曲线闪烁）；
 * - 流结束/空闲：不模拟任何假数据——直接绘制 tpsMeter 自然衰减中的曲线
 *   （EMA 指数衰减到 0），柱子逐渐变矮滚出屏幕后保持 0.0 与空画布，直到下一轮真实流。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tpsMeter, type TpsSample } from '../../utils/tpsMeter'
import { useChatStore } from '../../stores'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const chatStore = useChatStore()

const CANVAS_W = 240
const CANVAS_H = 24
/** tok/s 单位（三语通用，不需要 i18n） */
const TOK_UNIT = 'tok/s'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const live = ref(false)
const valueText = ref(`0.0 ${TOK_UNIT}`)

/** 流是否活跃：正在接收流式响应或等待响应（agent 思考/工具执行也视为活跃） */
const streamActive = computed(() => chatStore.isStreaming || chatStore.isWaitingForResponse)

let unsubscribe: (() => void) | null = null
/** 最近一次真实曲线的 ring（流活跃但无实时数据时冻结展示） */
let lastRealRing: number[] = []

function resolveChartColor(): string {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--vscode-charts-blue')
      .trim()
    if (v) return v
  } catch {
    // 解析失败走默认色
  }
  return '#0050b3'
}

function drawChart(bars: number[]): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = CANVAS_W
  const h = CANVAS_H
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (bars.length === 0) return

  // 每次绘制实时解析主题色：主题切换后颜色跟随更新（200ms 一次 getComputedStyle 开销可忽略）
  const color = resolveChartColor()

  let peak = 1
  for (const b of bars) {
    if (b > peak) peak = b
  }

  const slot = w / bars.length
  const barW = Math.max(2, slot * 0.7)
  for (let i = 0; i < bars.length; i++) {
    const bh = Math.max(1, (bars[i] / peak) * (h - 2))
    // 越新的柱子越实，强调"实时"
    ctx.globalAlpha = 0.35 + 0.65 * (bars.length > 1 ? i / (bars.length - 1) : 1)
    ctx.fillStyle = color
    ctx.fillRect(i * slot + (slot - barW) / 2, h - bh, barW, bh)
  }
  ctx.globalAlpha = 1
}

// ---------- 真实流 ----------

/** 流活跃但无实时数据：冻结最近真实曲线（不清空 bars，避免曲线闪烁） */
function showFrozenReal(): void {
  live.value = lastRealRing.length > 0
  if (lastRealRing.length === 0) {
    // 从未有过真实曲线：显示 0 与空画布，不给假数据
    valueText.value = `0.0 ${TOK_UNIT}`
    drawChart([])
  }
}

function onSample(sample: TpsSample): void {
  if (sample.live) {
    live.value = true
    lastRealRing = sample.ring
    valueText.value = `${sample.ema.toFixed(1)} ${TOK_UNIT}`
    drawChart(sample.ring)
    return
  }
  if (streamActive.value) {
    // 流活跃但停顿 >2s（agent 思考/工具执行）：冻结最近真实曲线
    showFrozenReal()
    return
  }
  // 流结束/空闲：不模拟假数据——绘制自然衰减中的曲线，归零后保持 0
  live.value = false
  if (sample.ema > 0) {
    valueText.value = `${sample.ema.toFixed(1)} ${TOK_UNIT}`
    drawChart(sample.ring)
  } else {
    valueText.value = `0.0 ${TOK_UNIT}`
    drawChart([])
  }
}

// 流一旦开始（即使尚无 token）立即切到冻结态，无需等下一次采样（≤200ms）
watch(streamActive, (active) => {
  if (active) showFrozenReal()
})

// ---------- 可见性 ----------

function onVisibilityChange(): void {
  if (!document.hidden) {
    // 视图恢复可见：用最新快照刷新画布（隐藏期间采样仍在继续，曲线可能已衰减/归零）
    onSample(tpsMeter.snapshot)
  }
}

onMounted(() => {
  unsubscribe = tpsMeter.subscribe(onSample)
  // 挂载即按快照进入对应状态（真实/冻结/归零），避免首帧空白
  if (!document.hidden) onSample(tpsMeter.snapshot)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div
    class="tps-bar"
    :class="{ 'is-live': live }"
    :title="t('components.input.tpsTooltip')"
  >
    <span class="tps-label">TPS</span>
    <canvas ref="canvasRef" aria-hidden="true"></canvas>
    <span class="tps-value">{{ valueText }}</span>
  </div>
</template>

<style scoped>
.tps-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1;
}

.tps-label {
  flex: none;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  opacity: 0.75;
}

.tps-bar canvas {
  display: block;
  width: 100%;
  max-width: 240px;
  height: 24px;
  flex: 1 1 auto;
  min-width: 60px;
  opacity: 0.9;
}

.tps-value {
  flex: none;
  min-width: 4.2em;
  text-align: right;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

.tps-bar.is-live .tps-label {
  opacity: 1;
}

/* 窄面板：隐藏 canvas 只留数值，避免把右侧按钮挤出 */
@media (max-width: 520px) {
  .tps-bar canvas {
    display: none;
  }

  .tps-value {
    min-width: 0;
  }
}
</style>

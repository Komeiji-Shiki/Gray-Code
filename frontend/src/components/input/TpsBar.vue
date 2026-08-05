<script setup lang="ts">
/**
 * TpsBar.vue - 聊天面板底部 TPS（tokens per second）实时可视化条。
 *
 * 位置：聊天 Webview 面板最底部一行（InputArea.bottom-toolbar），总结上下文按钮左侧。
 * 布局（flex 一行）：左侧 "TPS" 标签 + 中间 240×24 canvas 柱状图 + 右侧实时数值。
 *
 * 数据：
 * - 真实流：订阅 utils/tpsMeter 单例（streamChunkHandlers 在流式 chunk 到达时 record token 数）；
 * - 无真实流（开始动画/空闲等待）：本地随机模拟波动（常态低流量 + 偶发突发 + 均值回归），
 *   让启动与空闲阶段的图表保持活性；一旦收到真实流数据立即切换为真实曲线。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { tpsMeter, type TpsSample } from '../../utils/tpsMeter'

const CANVAS_W = 240
const CANVAS_H = 24
const SIM_SAMPLE_MS = 200
const SIM_BARS = 30

const canvasRef = ref<HTMLCanvasElement | null>(null)
const live = ref(false)
const valueText = ref('0.0 tok/s')

let chartColor = '#0050b3'
let unsubscribe: (() => void) | null = null
let simTimer: number | null = null
const simBars: number[] = []
let simEma = 0

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
    ctx.fillStyle = chartColor
    ctx.fillRect(i * slot + (slot - barW) / 2, h - bh, barW, bh)
  }
  ctx.globalAlpha = 1
}

// ---------- 随机模拟（无真实流时） ----------

function simTick(): void {
  // 基线 12 tok/s 附近随机游走 + 偶发突发（burst）→ 自然"打字机"波动
  const last = simBars.length > 0 ? simBars[simBars.length - 1] : 12
  const burst = Math.random() < 0.1 ? 30 + Math.random() * 50 : 0
  const drift = (Math.random() - 0.45) * 6
  const next = Math.max(2, last * 0.9 + burst + drift + 2)
  simEma = simEma === 0 ? next : simEma * (1 - 0.3) + next * 0.3
  simBars.push(simEma)
  if (simBars.length > SIM_BARS) simBars.shift()
  valueText.value = `${simEma.toFixed(1)} tok/s`
  drawChart(simBars)
}

function startSim(): void {
  if (simTimer !== null) return
  live.value = false
  simTimer = window.setInterval(simTick, SIM_SAMPLE_MS)
}

function stopSim(): void {
  if (simTimer !== null) {
    window.clearInterval(simTimer)
    simTimer = null
  }
}

// ---------- 真实流 ----------

function onSample(sample: TpsSample): void {
  if (sample.live) {
    stopSim()
    live.value = true
    valueText.value = `${sample.ema.toFixed(1)} tok/s`
    drawChart(sample.ring)
  } else {
    startSim()
  }
}

onMounted(() => {
  chartColor = resolveChartColor()
  unsubscribe = tpsMeter.subscribe(onSample)
  const snap = tpsMeter.snapshot
  if (snap.live) {
    onSample(snap)
  } else {
    startSim()
  }
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  stopSim()
})
</script>

<template>
  <div class="tps-bar" :class="{ 'is-live': live }" title="TPS（tokens per second）">
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
</style>

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
 *   不启动模拟、不清空 bars（避免用随机数据误导）；
 * - 流不活跃（开始动画/空闲等待）：本地随机模拟波动（常态低流量 + 偶发突发 + 均值回归），
 *   让启动与空闲阶段的图表保持活性；一旦收到真实流数据立即切换为真实曲线。
 *
 * 视觉区分：sim 阶段给根节点加 .is-sim 类并降低 canvas 透明度，避免与真实曲线混淆。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { tpsMeter, type TpsSample } from '../../utils/tpsMeter'
import { useChatStore } from '../../stores'
import { useI18n } from '../../i18n'

const { t } = useI18n()
const chatStore = useChatStore()

const CANVAS_W = 240
const CANVAS_H = 24
const SIM_SAMPLE_MS = 200
const SIM_BARS = 30
/** tok/s 单位（三语通用，不需要 i18n） */
const TOK_UNIT = 'tok/s'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const live = ref(false)
const isSim = ref(false)
const valueText = ref(`0.0 ${TOK_UNIT}`)

/** 流是否活跃：正在接收流式响应或等待响应（agent 思考/工具执行也视为活跃） */
const streamActive = computed(() => chatStore.isStreaming || chatStore.isWaitingForResponse)

let unsubscribe: (() => void) | null = null
let simTimer: number | null = null
const simBars: number[] = []
let simEma = 0
/** 最近一次真实曲线的 EMA（sim 起步值，避免 sim/live 切换曲线跳变） */
let lastRealEma = 0
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

// ---------- 随机模拟（流不活跃时） ----------

function simTick(): void {
  // 基线 12 tok/s 附近随机游走 + 偶发小突发（短暂尖峰）→ 自然"打字机"波动。
  // 稳态均值 ≈ 12：drift 零均值（±3），常数项 1.0 ≈ 12 × (1 - 0.9) − E[burst]≈0.2。
  const burst = Math.random() < 0.04 ? 2 + Math.random() * 6 : 0
  const drift = (Math.random() - 0.5) * 6
  const next = Math.max(2, simEma * 0.9 + burst + drift + 1.0)
  simEma = simEma === 0 ? next : simEma * (1 - 0.3) + next * 0.3
  simBars.push(simEma)
  if (simBars.length > SIM_BARS) simBars.shift()
  valueText.value = `${simEma.toFixed(1)} ${TOK_UNIT}`
  drawChart(simBars)
}

function startSim(): void {
  if (simTimer !== null) return
  live.value = false
  isSim.value = true
  // 用最后一次真实 ema（或 0）重置 sim 状态，并先清空画布再开始，
  // 保证 sim/live 切换时曲线连续、不残留旧图
  simBars.length = 0
  simEma = lastRealEma
  drawChart([])
  simTimer = window.setInterval(simTick, SIM_SAMPLE_MS)
}

function stopSim(): void {
  if (simTimer !== null) {
    window.clearInterval(simTimer)
    simTimer = null
  }
  isSim.value = false
}

// ---------- 真实流 ----------

/** 流活跃但无实时数据：冻结最近真实曲线（退出模拟、不清空 bars、不启动 sim） */
function showFrozenReal(): void {
  stopSim()
  live.value = lastRealRing.length > 0
  if (lastRealRing.length === 0) {
    // 从未有过真实曲线：显示 0 与空画布，不给假数据
    valueText.value = `0.0 ${TOK_UNIT}`
    drawChart([])
  }
}

function onSample(sample: TpsSample): void {
  if (sample.live) {
    stopSim()
    live.value = true
    lastRealEma = sample.ema
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
  // 流不活跃：才允许启动模拟
  startSim()
}

// 流一旦开始（即使尚无 token）立即退出模拟，无需等下一次采样（≤200ms）
watch(streamActive, (active) => {
  if (active) showFrozenReal()
})

// ---------- 可见性 ----------

function onVisibilityChange(): void {
  if (document.hidden) {
    // 视图隐藏：停止模拟定时器，避免后台空转
    stopSim()
  } else {
    // 视图可见：按需恢复模拟（流活跃或有真实曲线时不模拟）
    if (streamActive.value || live.value) return
    startSim()
  }
}

onMounted(() => {
  unsubscribe = tpsMeter.subscribe(onSample)
  // 挂载即按快照进入对应状态（真实/冻结/模拟），避免首帧空白；隐藏时不启动模拟
  if (!document.hidden) onSample(tpsMeter.snapshot)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  stopSim()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div
    class="tps-bar"
    :class="{ 'is-live': live, 'is-sim': isSim }"
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

/* sim（模拟）曲线弱化，与真实曲线视觉区分 */
.tps-bar.is-sim canvas {
  opacity: 0.4;
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

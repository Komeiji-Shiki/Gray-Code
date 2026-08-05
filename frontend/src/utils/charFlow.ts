/**
 * CharFlow - 流式字符流水线（批内错峰淡入）
 *
 * 原理：DOM 每帧最多生效一次更新，逐字提交的上限就是屏幕刷新率（60Hz≈60 字/秒）。
 * 高 tps 下（100+ tps ≈ 300+ 字符/秒）物理上追不上逐字提交，因此把
 * 「提交频率」与「观感」解耦：
 *
 *   - 提交侧：每帧最多 append 一批字素（SmoothStreamer 按速率 drain 出来）
 *   - 观感侧：批内每个字符是独立 span，用 animation-delay 做亚帧级错峰淡入。
 *     CSS 动画由合成器按 vsync 采样，同一帧插入的多个字符在下一帧各自处于
 *     不同动画进度，人眼积分后感知为「字符连续浮现」——180Hz 屏上错峰
 *     分辨率是 60Hz 的 3 倍，接近真·逐字流水。
 *
 * DOM 全部手动操作（不经 Vue 响应式/vnode diff）：每秒几百个 span 走 Vue
 * 是纯浪费。Vue 只负责 host 元素本身（MessageItem 里的 <div ref="tailHost">）。
 *
 * 有界性：collapse() 每帧把播完动画的 chip 回收进单个 settled Text 节点，
 * 同时存活的 chip ≈ cps × fadeMs（300 chars/s × 110ms ≈ 33 个），不膨胀。
 *
 * 注意：手动创建的 DOM 不受 Vue scoped 样式约束，相关 CSS 在全局 style.css
 * （.char-flow / .cf-chip / @keyframes cf-in）。
 */

const CF_CHIP_CLASS = 'cf-chip'

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export class CharFlow {
  /** 已定型文本：单个 Text 节点，位于 host 首位 */
  private settled: Text
  /** 各 chip 动画结束时间（performance.now 时间轴），与 host 中 chip 顺序一一对应 */
  private births: number[] = []
  private disposed = false

  constructor(
    private readonly host: HTMLElement,
    private readonly fadeMs = 110,
    private readonly reducedMotion = prefersReducedMotion(),
    private readonly followEnd = false
  ) {
    host.classList.add('char-flow')
    this.settled = document.createTextNode('')
    host.appendChild(this.settled)
  }

  /**
   * 本帧要浮现的字素 + 帧时长（ms，用于批内错峰间隔）。
   * instant=true 时跳过淡入直接定型（panic 快进 / flush 用）。
   */
  append(graphemes: string[], frameDurMs: number, instant = false): void {
    if (this.disposed || graphemes.length === 0) return
    // 先回收已播完的 chip，保持 host 结构 = settled + 存活的 chips
    this.collapse()

    if (this.reducedMotion || instant) {
      // 减少动效 / 直通：直接并入已定型文本，不建 span
      this.settled.appendData(graphemes.join(''))
      this.scrollToEnd()
      return
    }

    const now = performance.now()
    // 批内错峰间隔：帧时长均摊到每个字素；钳到 fadeMs 防止单帧大 dt 拖长动画
    const step = Math.min(frameDurMs / graphemes.length, this.fadeMs)
    const frag = document.createDocumentFragment()
    for (let i = 0; i < graphemes.length; i++) {
      const chip = document.createElement('span')
      chip.className = CF_CHIP_CLASS
      chip.textContent = graphemes[i]
      chip.style.animationDelay = `${(i * step).toFixed(2)}ms`
      chip.style.animationDuration = `${this.fadeMs}ms`
      this.births.push(now + i * step + this.fadeMs)
      frag.appendChild(chip)
    }
    this.host.appendChild(frag)
    this.scrollToEnd()
  }

  /** 把播完动画的 chip 回收进 settled 文本节点（防 span 累积） */
  private collapse(): void {
    const now = performance.now()
    let n = 0
    while (n < this.births.length && this.births[n] <= now) n++
    if (n === 0) return
    this.births.splice(0, n)
    let text = ''
    for (let i = 0; i < n; i++) {
      const el = this.settled.nextSibling as HTMLElement | null
      if (!el) break
      text += el.textContent ?? ''
      el.remove()
    }
    this.settled.appendData(text)
  }

  /** 是否还有未播完动画的字符（供「升级为稳定块」判断） */
  idle(): boolean {
    return this.births.length === 0
  }

  /** 已定型文本（settled 内容）：渐进 markdown 层据此检测可提升的完整段落 */
  get settledText(): string {
    return this.settled.data
  }

  /**
   * 从已定型文本开头剥离 n 个字符（交给渐进 markdown 渲染层），返回剥离的文本。
   * 剥离的是 settled 前缀——最早显示、已稳定成型的字符；未播完动画的 chips 不受影响。
   */
  promote(n: number): string {
    if (this.disposed || n <= 0) return ''
    const text = this.settled.data.slice(0, n)
    this.settled.replaceData(0, n, '')
    return text
  }

  /** 立即定型全部字符（flush / 中止 / 终结前调用，不清空内容） */
  finish(): void {
    if (this.disposed) return
    this.collapse()
    let el = this.settled.nextSibling
    while (el) {
      const next = el.nextSibling
      this.settled.appendData(el.textContent ?? '')
      el.remove()
      el = next
    }
    this.births.length = 0
    this.scrollToEnd()
  }

  /**
   * 重建恢复：清空当前显示，从累计文本直接定型（不经过动画）。
   * 用于组件重建 / 切标签页回来 / 段落切换后新段落的基线显示。
   */
  restore(text: string): void {
    if (this.disposed) return
    this.finish()
    this.settled.replaceData(0, this.settled.length, text)
    this.scrollToEnd()
  }

  /** 折叠的单行思维预览始终展示最新字符；正文与展开态不启用。 */
  private scrollToEnd(): void {
    if (this.followEnd) {
      this.host.scrollLeft = this.host.scrollWidth
    }
  }

  /** 销毁并清空 host（组件卸载 / 段落切换时由 manager 调用） */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    while (this.host.firstChild) {
      this.host.removeChild(this.host.firstChild)
    }
    this.births.length = 0
  }
}

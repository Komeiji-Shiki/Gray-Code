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
 * 有界性：collapse() 每帧把播完动画的 chip 回收进单个 settled 文本节点，
 * 同时存活的 chip ≈ cps × fadeMs（300 chars/s × 110ms ≈ 33 个），不膨胀。
 *
 * 折叠预览模式（noFade + squashLineBreaks + tailWindow）：
 * 单行滚动容器里「逐字淡入」的透明占位、nowrap 下换行渲染成的占位空格，
 * 都会把 followEnd 的滚动目标挤成空白；tailWindow 保证长思考内容有界。
 * 这三个选项共同保证折叠预览始终显示真实可见的最新字符。
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

export interface CharFlowOptions {
  /** 批内错峰淡入时长（ms），默认 110 */
  fadeMs?: number
  /** 减少动效：直接文本追加，不建 span（默认自动探测 prefers-reduced-motion） */
  reducedMotion?: boolean
  /** 单行预览宿主是否应始终滚动到最新字符（折叠思考预览） */
  followEnd?: boolean
  /** 禁用错峰淡入（直接文本追加）。折叠预览等不适合逐字动画的场景用——
   * 动画 delay 期间字符透明但占位，会把 followEnd 滚动目标挤成空白 */
  noFade?: boolean
  /** 把换行符折叠为零宽空格（\u200B）：nowrap 单行容器中换行会渲染成占位空格，
   * 长思考内容会整片「被空格挤出去」；零宽后预览持续显示最新真实字符 */
  squashLineBreaks?: boolean
  /** 尾部窗口：只保留最近 N 个字符（丢弃开头）。折叠预览内容有界，
   * 避免超长思考撑爆单行容器 */
  tailWindow?: number
  /** 垂直滚动容器（默认 host 自身）：多行预览时滚动发生在父容器上，
   * host 自身不滚动，贴底需写在容器上 */
  scrollContainer?: HTMLElement
  /** 内容更新时是否应贴底：返回 false 表示用户正在向上查看，不打扰 */
  stickBottom?: () => boolean
  /** 尾部窗口首次发生裁剪时回调（中展开裁剪提示用） */
  onTrimmed?: () => void
}

export class CharFlow {
  /** 已定型文本：单个 Text 节点，位于 host 首位 */
  private settled: Text
  /** 各 chip 动画结束时间（performance.now 时间轴），与 host 中 chip 顺序一一对应 */
  private births: number[] = []
  private disposed = false
  private readonly fadeMs: number
  private readonly reducedMotion: boolean
  private readonly followEnd: boolean
  private readonly noFade: boolean
  private readonly squashLineBreaks: boolean
  private readonly tailWindow?: number
  private readonly scrollContainer?: HTMLElement
  private readonly stickBottom?: () => boolean
  private readonly onTrimmed?: () => void
  private trimmed = false

  constructor(
    private readonly host: HTMLElement,
    options: CharFlowOptions = {}
  ) {
    this.fadeMs = options.fadeMs ?? 110
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion()
    this.followEnd = options.followEnd === true
    this.noFade = options.noFade === true
    this.squashLineBreaks = options.squashLineBreaks === true
    this.tailWindow = options.tailWindow !== undefined && options.tailWindow > 0 ? options.tailWindow : undefined
    this.scrollContainer = options.scrollContainer
    this.stickBottom = options.stickBottom
    this.onTrimmed = options.onTrimmed
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

    const chars = this.squashLineBreaks
      ? graphemes.map(g => (g === '\n' || g === '\r') ? '\u200B' : g)
      : graphemes

    if (this.reducedMotion || instant || this.noFade) {
      // 减少动效 / 直通：直接并入已定型文本，不建 span
      this.settled.appendData(chars.join(''))
      this.trimToWindow()
      this.scrollToEnd()
      return
    }

    const now = performance.now()
    // 批内错峰间隔：帧时长均摊到每个字素；钳到 fadeMs 防止单帧大 dt 拖长动画
    const step = Math.min(frameDurMs / chars.length, this.fadeMs)
    const frag = document.createDocumentFragment()
    for (let i = 0; i < chars.length; i++) {
      const chip = document.createElement('span')
      chip.className = CF_CHIP_CLASS
      chip.textContent = chars[i]
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

  /** 尾部窗口裁剪：内容超出窗口时丢弃开头（保留最新字符；折叠预览用）。
   * 首次发生裁剪时回调 onTrimmed（组件据此显示「内容过长」提示） */
  private trimToWindow(): void {
    if (this.tailWindow === undefined) return
    const excess = this.settled.data.length - this.tailWindow
    if (excess > 0) {
      this.settled.replaceData(0, excess, '')
      if (!this.trimmed) {
        this.trimmed = true
        this.onTrimmed?.()
      }
    }
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
    this.trimToWindow()
    this.scrollToEnd()
  }

  /**
   * 重建恢复：清空当前显示，从累计文本直接定型（不经过动画）。
   * 用于组件重建 / 切标签页回来 / 段落切换后新段落的基线显示。
   */
  restore(text: string): void {
    if (this.disposed) return
    this.finish()
    // 折叠预览恢复历史文本同样要折叠换行（nowrap 下换行渲染成占位空格）
    this.settled.replaceData(0, this.settled.length, this.squashLineBreaks ? text.replace(/[\r\n]/g, '\u200B') : text)
    this.trimToWindow()
    this.scrollToEnd()
  }

  /**
   * 内容更新后的滚动跟随：
   * - followEnd：单行水平预览始终滚动到最新字符；
   * - stickBottom：多行滚动容器按用户意图贴底（用户滚上去查看时返回 false 停止打扰）。
   * 正文与展开态不启用。
   */
  private scrollToEnd(): void {
    const scroller = this.scrollContainer ?? this.host
    if (this.followEnd) {
      scroller.scrollLeft = scroller.scrollWidth
    }
    if (this.stickBottom?.()) {
      scroller.scrollTop = scroller.scrollHeight
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

import { computed, type Ref } from 'vue'

/** 样式仅消费测量结果，不建立观察器或修改滚动位置。 */
export function useScrollbarStyles(props: { width: number; offset: number; trackColor: string; thumbColor: string; maxHeight: string | number },
  scrollTrack: Ref<HTMLElement | null>, virtualDragRatio: Ref<number | null>, thumbHeight: Ref<number>, thumbTop: Ref<number>, thumbWidth: Ref<number>, thumbLeft: Ref<number>) {
  const trackStyle = computed(() => {
    const style: Record<string, string> = {
      width: `${props.width}px`,
    }
    if (props.trackColor) {
      style.background = props.trackColor
    }
    return style
  })

  const thumbStyle = computed(() => {
    const dragThumbTop = virtualDragRatio.value !== null
      ? virtualDragRatio.value * Math.max(0, (scrollTrack.value?.clientHeight || 0) - thumbHeight.value)
      : thumbTop.value
    const style: Record<string, string> = {
      height: `${thumbHeight.value}px`,
      transform: `translateY(${dragThumbTop}px)`,
    }
    if (props.thumbColor) {
      style.background = props.thumbColor
    }
    return style
  })

  const hTrackStyle = computed(() => {
    const style: Record<string, string> = {
      height: `${props.width}px`,
      bottom: `${props.offset}px`,
    }
    if (props.trackColor) {
      style.background = props.trackColor
    }
    return style
  })

  const hThumbStyle = computed(() => {
    const style: Record<string, string> = {
      width: `${thumbWidth.value}px`,
      transform: `translateX(${thumbLeft.value}px)`,
    }
    if (props.thumbColor) {
      style.background = props.thumbColor
    }
    return style
  })

  // 容器样式（支持 maxHeight 模式）
  const wrapperStyle = computed(() => {
    if (!props.maxHeight) return {}

    const maxH = typeof props.maxHeight === 'number'
      ? `${props.maxHeight}px`
      : props.maxHeight

    return {
      maxHeight: maxH,
      height: 'auto'
    }
  })


  return { trackStyle, thumbStyle, hTrackStyle, hThumbStyle, wrapperStyle }
}

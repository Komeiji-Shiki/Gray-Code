/** 保留既有均匀采样与真实索引映射，投影只读取最终显示的标记。 */
export function projectVirtualScrollbarMarkers(markers: readonly { index: number; preview?: string }[], total: number, trackHeight: number) {
  if (total <= 0 || trackHeight <= 0) return []
  const stride = Math.max(1, Math.ceil(markers.length / 2000))
  const positions: Array<{ top: number; targetIndex: number; index: number; contentPreview: string; color: string; tooltipPrefix: string }> = []
  for (let index = 0; index < markers.length; index += stride) {
    const marker = markers[index]
    const targetIndex = Math.max(0, Math.min(total - 1, Math.floor(marker.index)))
    positions.push({
      top: ((targetIndex + 0.5) / total) * trackHeight,
      targetIndex,
      index: positions.length + 1,
      contentPreview: marker.preview || '',
      color: '',
      tooltipPrefix: ''
    })
  }
  return positions
}

let lockCount = 0
let previousOverflow = ''

export function lockBodyScroll(): void {
  if (typeof document === 'undefined') return
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1
}

export function unlockBodyScroll(): void {
  if (typeof document === 'undefined' || lockCount === 0) return
  lockCount -= 1
  if (lockCount === 0) {
    document.body.style.overflow = previousOverflow
    previousOverflow = ''
  }
}

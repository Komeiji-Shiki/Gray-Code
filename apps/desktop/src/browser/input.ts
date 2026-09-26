import type { MouseInputEvent } from 'electron';

/** Electron before-mouse-event uses MouseInputEvent, not DOM or CDP event names. */
export function isActiveMouseInput(mouse: MouseInputEvent): boolean {
  if (mouse.type === 'mouseMove' || mouse.type === 'mouseEnter' || mouse.type === 'mouseLeave') {
    // Moving over a shown tab is passive, but dragging in from outside the page is not.
    return mouse.modifiers?.some(modifier => modifier === 'leftbuttondown'
      || modifier === 'middlebuttondown' || modifier === 'rightbuttondown') ?? false;
  }
  // mouseDown, mouseUp, contextMenu, mouseWheel (and future non-passive types) take over.
  return true;
}

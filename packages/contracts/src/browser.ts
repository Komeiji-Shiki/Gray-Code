import type { ScreenshotMetadata, VisualObservation } from './visual';

export interface BrowserProfile {
  id: string;
  name: string;
  actorId: string;
}
export interface BrowserTab {
  id: string;
  profileId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  controlledBy?: { runId: string; conversationId?: string };
  userControlled: boolean;
}
export interface BrowserState {
  profiles: BrowserProfile[];
  tabs: BrowserTab[];
  activeTabId?: string;
}
export interface BrowserLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export interface BrowserObservation extends VisualObservation {
  tabId: string;
  url: string;
  coordinateSpace: 'image';
  screenshot: ScreenshotMetadata;
  /** 图片像素乘以对应比例，得到浏览器接收的 CSS 视口坐标。 */
  imageToViewportScale?: { x: number; y: number };
  /** 宽高和滚动位置使用 CSS 像素；zoomFactor 是页面缩放，不包含显示器像素缩放。 */
  viewport: { width: number; height: number; scrollX: number; scrollY: number; zoomFactor: number };
}

export interface BrowserHitTarget {
  tagName: string;
  role?: string;
  name?: string;
  relation?: string;
  disabled?: boolean;
  inert?: boolean;
}

export interface BrowserActionFeedback {
  pointer?: {
    source: 'image' | 'element';
    method: 'pointer' | 'dom-click';
    observationId?: string;
    image?: { x: number; y: number };
    viewport?: { x: number; y: number };
    hit?: BrowserHitTarget;
    overlapped?: boolean;
  };
}

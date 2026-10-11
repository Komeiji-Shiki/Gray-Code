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
/** 交给模型的截图元数据：坐标动作用 id 指定截图，宽高就是坐标范围，换算由工具完成。 */
export interface BrowserScreenshot {
  id: string;
  width: number;
  height: number;
  /** 截图时页面的 CSS 滚动位置，用来判断画面与当前页面是否仍对应。 */
  scrollX: number;
  scrollY: number;
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
    hit?: BrowserHitTarget;
    overlapped?: boolean;
    /** 元素没有几何位置时改用 DOM click，模型据此判断悬停或坐标类效果没有发生。 */
    domClick?: boolean;
  };
}

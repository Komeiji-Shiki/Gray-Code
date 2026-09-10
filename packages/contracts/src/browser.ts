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

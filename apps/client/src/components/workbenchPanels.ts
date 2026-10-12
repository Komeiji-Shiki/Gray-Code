import { shellText as t } from '../i18n';
export type WorkbenchIcon = 'file' | 'folder' | 'browser' | 'terminal' | 'git' | 'review' | 'warning' | 'chat' | 'search' | 'computer';
export interface WorkbenchTab {
  id: string;
  label: string;
  title?: string;
  icon: WorkbenchIcon;
  dirty?: boolean;
}
export const workbenchPanels: Array<{ id: string; label: string; icon: WorkbenchIcon; description: string }> = [
  {
    id: 'diff',
    get label() {
      return t('reviewTitle');
    },
    icon: 'review',
    get description() {
      return t('uiworkbenchPanelsReviewAiChanges');
    },
  },
  {
    id: 'terminal',
    get label() {
      return t('uiworkbenchPanelsTerminal');
    },
    icon: 'terminal',
    get description() {
      return t('uiworkbenchPanelsRunCommandsViewOutput');
    },
  },
  {
    id: 'debug',
    get label() {
      return t('uiworkbenchPanelsDebug');
    },
    icon: 'terminal',
    get description() {
      return t('uiworkbenchPanelsDebugPanelDescription');
    },
  },
  {
    id: 'browser',
    get label() {
      return t('uiworkbenchPanelsBrowser');
    },
    icon: 'browser',
    get description() {
      return t('uiworkbenchPanelsBrowserPanelDescription');
    },
  },
  {
    id: 'computer',
    get label() {
      return t('uiworkbenchPanelsComputer');
    },
    icon: 'computer',
    get description() {
      return t('uiworkbenchPanelsComputerPanelDescription');
    },
  },
  {
    id: 'nodes',
    get label() {
      return t('uiworkbenchPanelsDevices');
    },
    icon: 'computer',
    get description() {
      return t('uiworkbenchPanelsDevicePanelDescription');
    },
  },
  {
    id: 'editor',
    get label() {
      return t('uiFileTreeFile');
    },
    icon: 'folder',
    get description() {
      return t('uiworkbenchPanelsFilesPanelDescription');
    },
  },
  {
    id: 'search',
    get label() {
      return t('uiMemoryLibrarySearch');
    },
    icon: 'search',
    get description() {
      return t('uiworkbenchPanelsSearchPanelDescription');
    },
  },
  {
    id: 'outline',
    get label() {
      return t('uiCodeEditorOutline');
    },
    icon: 'file',
    get description() {
      return t('uiworkbenchPanelsOutlinePanelDescription');
    },
  },
  {
    id: 'git',
    label: 'Git',
    icon: 'git',
    get description() {
      return t('uiworkbenchPanelsGitPanelDescription');
    },
  },
  {
    id: 'problems',
    get label() {
      return t('uiworkbenchPanelsFindings');
    },
    icon: 'warning',
    get description() {
      return t('uiworkbenchPanelsProblemsPanelDescription');
    },
  },
];

/**
 * menu-i18n.ts - 主进程界面文案多语言字典
 *
 * 主进程壳（main.js）为了启动提速不允许打包 backend/webview 的完整 i18n 语言包，
 * 这里维护一份极小的独立字典，覆盖 Electron 原生菜单、系统文件夹选择对话框、
 * About 对话框与宿主提示 toast 的文案（en / zh-CN / ja，与前端语言一致）。
 *
 * 语言来源：设置项 graycode.ui.language（'auto' 时回退系统 locale）；
 * 语言切换时主进程通过 app.setMenuLanguage 消息重建菜单（见 main.ts / BackendHost.ts）。
 */

export type MenuLang = 'zh-CN' | 'en' | 'ja';

const MENU_MESSAGES: Record<string, Record<MenuLang, string>> = {
  // 顶层菜单
  menuFile: { 'zh-CN': '文件', en: 'File', ja: 'ファイル' },
  menuEdit: { 'zh-CN': '编辑', en: 'Edit', ja: '編集' },
  menuView: { 'zh-CN': '视图', en: 'View', ja: '表示' },
  menuHelp: { 'zh-CN': '帮助', en: 'Help', ja: 'ヘルプ' },
  // File 子菜单
  openWorkspaceFolder: { 'zh-CN': '打开工作区文件夹…', en: 'Open Workspace Folder...', ja: 'ワークスペースフォルダを開く…' },
  reload: { 'zh-CN': '重新加载', en: 'Reload', ja: '再読み込み' },
  forceReload: { 'zh-CN': '强制重新加载', en: 'Force Reload', ja: '強制再読み込み' },
  exit: { 'zh-CN': '退出', en: 'Exit', ja: '終了' },
  // Edit 子菜单
  undo: { 'zh-CN': '撤销', en: 'Undo', ja: '元に戻す' },
  redo: { 'zh-CN': '重做', en: 'Redo', ja: 'やり直す' },
  cut: { 'zh-CN': '剪切', en: 'Cut', ja: '切り取り' },
  copy: { 'zh-CN': '复制', en: 'Copy', ja: 'コピー' },
  paste: { 'zh-CN': '粘贴', en: 'Paste', ja: '貼り付け' },
  selectAll: { 'zh-CN': '全选', en: 'Select All', ja: 'すべて選択' },
  // View 子菜单
  toggleFullScreen: { 'zh-CN': '切换全屏', en: 'Toggle Full Screen', ja: '全画面表示の切り替え' },
  developerTools: { 'zh-CN': '开发者工具', en: 'Developer Tools', ja: '開発者ツール' },
  // Help 子菜单 + About 对话框
  about: { 'zh-CN': '关于 GrayCode Desktop', en: 'About GrayCode Desktop', ja: 'GrayCode Desktop について' },
  aboutTitle: { 'zh-CN': '关于', en: 'About', ja: 'バージョン情報' },
  aboutMessage: { 'zh-CN': 'GrayCode Desktop', en: 'GrayCode Desktop', ja: 'GrayCode Desktop' },
  aboutDetail: {
    'zh-CN': 'GrayCode AI 编程助手（独立桌面版）\n基于 GrayCode v{version}\nElectron {electron} / Chromium {chromium}',
    en: 'GrayCode AI coding assistant (standalone desktop edition)\nBased on GrayCode v{version}\nElectron {electron} / Chromium {chromium}',
    ja: 'GrayCode AI コーディングアシスタント（スタンドアロン デスクトップ版）\nGrayCode v{version} ベース\nElectron {electron} / Chromium {chromium}'
  },
  // File 菜单打开的文件夹选择对话框
  pickFolderTitle: { 'zh-CN': '打开工作区文件夹', en: 'Open Workspace Folder', ja: 'ワークスペースフォルダを開く' },
  pickFolderButton: { 'zh-CN': '选择文件夹', en: 'Choose Folder', ja: 'フォルダを選択' },
  // 未打开工作区提示 toast
  noWorkspaceTitle: { 'zh-CN': '工作区', en: 'Workspace', ja: 'ワークスペース' },
  noWorkspaceMessage: {
    'zh-CN': '未打开工作区文件夹。请使用「文件 > 打开工作区文件夹…」开始。',
    en: 'No workspace folder is open. Use File > Open Workspace Folder... to get started.',
    ja: 'ワークスペースフォルダが開かれていません。「ファイル > ワークスペースフォルダを開く…」で開始してください。'
  },
  openFolderBtn: { 'zh-CN': '打开文件夹…', en: 'Open Folder...', ja: 'フォルダを開く…' },
  // 首次启动欢迎 toast
  firstRunTitle: { 'zh-CN': '欢迎使用 GrayCode Desktop', en: 'Welcome to GrayCode Desktop', ja: 'GrayCode Desktop へようこそ' },
  firstRunMessage: {
    'zh-CN': '欢迎使用 GrayCode Desktop！请配置 API 渠道以开始与 AI 对话。',
    en: 'Welcome to GrayCode Desktop! Configure an API channel to start chatting with AI.',
    ja: 'GrayCode Desktop へようこそ！AI とチャットするには API チャンネルを設定してください。'
  },
  openSettingsBtn: { 'zh-CN': '打开设置', en: 'Open Settings', ja: '設定を開く' }
};

/** 把任意语言标识归一为支持的三种（zh 系 → zh-CN、ja 系 → ja、其余 → en） */
export function resolveMenuLang(lang?: string): MenuLang {
  if (lang === 'zh-CN' || lang === 'en' || lang === 'ja') return lang;
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('zh')) return 'zh-CN';
  if (l.startsWith('ja')) return 'ja';
  return 'en';
}

/** 取某条菜单/对话框文案（key 缺失时原样返回 key，与前后端 t() 的缺失行为一致） */
export function menuLabel(key: string, lang?: string): string {
  const entry = MENU_MESSAGES[key];
  if (!entry) return key;
  return entry[resolveMenuLang(lang)] ?? entry.en;
}

/** 字典完整性自检：全部 key 在三种语言下都有值（供单测与启动防御使用） */
export function menuI18nCompleteness(): { missing: Array<{ key: string; lang: MenuLang }> } {
  const missing: Array<{ key: string; lang: MenuLang }> = [];
  for (const [key, entry] of Object.entries(MENU_MESSAGES)) {
    for (const lang of ['zh-CN', 'en', 'ja'] as MenuLang[]) {
      if (typeof entry[lang] !== 'string' || entry[lang].length === 0) {
        missing.push({ key, lang });
      }
    }
  }
  return { missing };
}

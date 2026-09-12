export type WorkbenchIcon = 'file' | 'folder' | 'browser' | 'terminal' | 'git' | 'review' | 'warning' | 'chat' | 'search';
export interface WorkbenchTab { id: string; label: string; title?: string; icon: WorkbenchIcon; dirty?: boolean }
export const workbenchPanels: Array<{ id: string; label: string; icon: WorkbenchIcon; description: string }> = [
  { id: 'diff', label: '审查', icon: 'review', description: '查看与接受 AI 修改' },
  { id: 'terminal', label: '终端', icon: 'terminal', description: '运行命令与查看输出' },
  { id: 'browser', label: '浏览器', icon: 'browser', description: '打开网页与预览内容' },
  { id: 'editor', label: '文件', icon: 'folder', description: '浏览工作区与编辑代码' },
  { id: 'search', label: '搜索', icon: 'search', description: '在项目中搜索与替换文本' },
  { id: 'outline', label: '大纲', icon: 'file', description: '查看当前文件的函数与符号' },
  { id: 'git', label: 'Git', icon: 'git', description: '查看仓库状态与差异' },
  { id: 'problems', label: '问题', icon: 'warning', description: '查看代码诊断' },
];

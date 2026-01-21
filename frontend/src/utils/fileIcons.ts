/**
 * 文件图标工具
 * 使用 file-icons-js 库获取文件类型图标
 */

import { getClassWithColor } from 'file-icons-js'

/**
 * 根据文件路径获取对应的图标类名
 * @param filePath 文件路径或文件名
 * @returns 图标 CSS 类名（包含颜色），如果找不到返回默认图标
 */
export function getFileIcon(filePath: string): string {
  if (!filePath) return 'icon text-icon'
  
  // 获取文件名（去掉路径）
  const fileName = filePath.split(/[\\/]/).pop() || ''
  
  // 使用 file-icons-js 获取图标类
  const iconClass = getClassWithColor(fileName)
  
  if (iconClass) {
    // file-icons-js 返回格式如 "js-icon medium-yellow"
    // 需要添加 "icon" 前缀类
    return `icon ${iconClass}`
  }
  
  // 默认文件图标
  return 'icon text-icon'
}

/**
 * 根据文件路径判断是否是文件夹
 * @param filePath 文件路径
 * @returns 是否是文件夹
 */
export function isDirectory(filePath: string): boolean {
  return filePath.endsWith('/') || filePath.endsWith('\\')
}

/**
 * 获取文件夹图标
 * @param expanded 是否展开
 * @returns codicon 类名
 */
export function getFolderIcon(expanded = false): string {
  return expanded ? 'codicon-folder-opened' : 'codicon-folder'
}

/** 文件工具只拆解展示名称；保留原始路径用于宿主打开文件。 */
export function getFileName(filePath: string): string {
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

export function getFileExtension(filePath: string): string {
  const name = getFileName(filePath)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.substring(index + 1) : ''
}

export function getFileNameWithoutExt(filePath: string): string {
  const name = getFileName(filePath)
  const index = name.lastIndexOf('.')
  return index > 0 ? name.substring(0, index) : name
}

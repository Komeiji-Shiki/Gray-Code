export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/** 桌面打开入口与服务端内容工具共用格式范围，避免把其他文件交给 Office 操作。 */
export function officeFormatFor(file: string): OfficeFormat | undefined {
  return /\.(docx|xlsx|pptx)$/i.exec(file)?.[1].toLowerCase() as OfficeFormat | undefined;
}

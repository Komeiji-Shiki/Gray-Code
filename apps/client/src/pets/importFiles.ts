import type { PetImport } from '@graycode/contracts';
import { live2dReferences, petAssetPath } from '../../../../shared/petFormat';
export const selectedPath = (file: File) => file.webkitRelativePath || file.name;
export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
  for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}
/** 只上传所选清单实际引用的文件，目录里的其他项目内容留在用户电脑上。 */
export async function collectPetImport(files: File[], entry: string): Promise<PetImport> {
  const map = new Map(files.map(file => [petAssetPath(selectedPath(file)), file]));
  const manifest = map.get(entry); if (!manifest) throw new Error('请选择目录中的桌宠清单。');
  const raw = JSON.parse(await manifest.text());
  const paths = [entry, ...(raw.spritesheetPath ? [raw.spritesheetPath] : live2dReferences(raw)).map((reference: string) => petAssetPath(entry, reference))];
  const wanted = [...new Set(paths)].map(path => { const file = map.get(path); if (!file) throw new Error(`缺少引用文件：${path}`); return { path, file }; });
  if (wanted.reduce((total, item) => total + item.file.size, 0) > 128 * 1024 * 1024) throw new Error('一次导入的资源总量不能超过 128 MiB。');
  return { entry, files: await Promise.all(wanted.map(async ({ path, file }) => ({ path, data: await fileBase64(file) }))) };
}

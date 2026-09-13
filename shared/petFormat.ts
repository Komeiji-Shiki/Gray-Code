import type { PetAnimation } from '../packages/contracts/src/pets';

export const petAnimations: { id: PetAnimation; name: string; frames: number }[] = [
  { id: 'idle', name: '休息', frames: 6 }, { id: 'running-right', name: '向右跑', frames: 8 },
  { id: 'running-left', name: '向左跑', frames: 8 }, { id: 'waving', name: '挥手', frames: 4 },
  { id: 'jumping', name: '跳跃', frames: 5 }, { id: 'failed', name: '任务失败', frames: 8 },
  { id: 'waiting', name: '等待', frames: 6 }, { id: 'running', name: '任务进行中', frames: 6 },
  { id: 'review', name: '等待审批', frames: 6 },
];
/** 资源路径仅在导入包内部解析，不能转为宿主文件路径或网络地址。 */
export function petAssetPath(entry: string, reference = ''): string {
  const source = reference || entry;
  if (typeof source !== 'string' || !source || /[\x00-\x1f:]/.test(source) || /^[\\/]/.test(source)) throw new Error('桌宠资源必须使用包内相对路径。');
  const joined = reference ? [...entry.replace(/\\/g, '/').split('/').slice(0, -1), ...reference.replace(/\\/g, '/').split('/')] : source.replace(/\\/g, '/').split('/');
  const parts: string[] = [];
  for (const part of joined) {
    if (part === '.' || !part) continue;
    if (part === '..') { if (!parts.length) throw new Error('资源引用超出了导入目录。'); parts.pop(); }
    else parts.push(part);
  }
  if (!parts.length) throw new Error('资源路径不能为空。');
  return parts.join('/');
}
export function live2dReferences(raw: Record<string, any>): string[] {
  const files = raw.FileReferences;
  if (raw.Version !== 3 || !files || typeof files.Moc !== 'string' || !Array.isArray(files.Textures) || !files.Textures.length) throw new Error('请选择 Cubism model3.json 模型清单。');
  const refs: unknown[] = [files.Moc, ...files.Textures];
  for (const key of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (files[key]) refs.push(files[key]);
  if (files.Expressions) {
    if (!Array.isArray(files.Expressions)) throw new Error('模型表情清单无效。');
    for (const expression of files.Expressions) refs.push(expression.File);
  }
  if (files.Motions) {
    if (typeof files.Motions !== 'object' || Array.isArray(files.Motions)) throw new Error('模型动作清单无效。');
    for (const motions of Object.values(files.Motions)) {
      if (!Array.isArray(motions)) throw new Error('模型动作组无效。');
      for (const motion of motions) { refs.push(motion.File); if (motion.Sound) refs.push(motion.Sound); }
    }
  }
  if (refs.some(ref => typeof ref !== 'string' || !ref)) throw new Error('模型包含无效的资源引用。');
  return [...new Set(refs)] as string[];
}

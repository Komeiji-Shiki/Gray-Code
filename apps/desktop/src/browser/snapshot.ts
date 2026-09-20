export interface SnapshotNode {
  ref?: string;
  frameId?: string;
  depth: number;
  role?: string;
  name?: string;
  value?: string;
  [property: string]: unknown;
}

/** 页面正文始终作为带引号的资料返回，换行不能伪装成新的元素引用。 */
export function compactSnapshot(nodes: SnapshotNode[]): string[] {
  let previousFrame: string | undefined;
  return nodes.map(node => {
    const frame = node.frameId !== previousFrame ? `frame=${JSON.stringify(node.frameId)}\n` : '';
    previousFrame = node.frameId;
    const states = Object.entries(node).filter(([key, value]) =>
      !['ref', 'frameId', 'depth', 'role', 'name', 'value'].includes(key) && value !== undefined
      && !(value === false && ['disabled', 'required', 'readonly', 'multiline'].includes(key))
    ).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    return `${frame}${' '.repeat(Math.min(node.depth, 24))}${node.ref ? `[${node.ref}] ` : ''}${node.role ?? 'node'}`
      + (node.name ? ` ${JSON.stringify(node.name)}` : '')
      + (node.value !== undefined ? ` value=${JSON.stringify(node.value)}` : '')
      + (states.length ? ` ${states.join(' ')}` : '');
  });
}

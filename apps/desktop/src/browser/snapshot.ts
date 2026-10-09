export interface SnapshotNode {
  ref?: string;
  frameId?: string;
  depth: number;
  role?: string;
  name?: string;
  value?: string;
  [property: string]: unknown;
}

export interface SnapshotOptions {
  compact?: boolean;
  maxNodes?: number;
  ref?: string;
  frameId?: string;
  query?: string;
  role?: string;
  interactiveOnly?: boolean;
  offset?: number;
}

export interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  /** DOM 快照确认的点击监听或独立 pointer 光标线索。 */
  clickable?: boolean;
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}

export interface DomInteractionSnapshot {
  strings?: string[];
  documents?: Array<{
    frameId: number;
    nodes: { nodeType?: number[]; parentIndex?: number[]; backendNodeId?: number[]; isClickable?: { index: number[] } };
    layout: { nodeIndex: number[]; styles: number[][] };
  }>;
}

/** 一个目标的 DOM 快照包含同进程 iframe；按框架和真实节点编号合并到各自的 AX 树。 */
export function snapshotClickables(snapshot: DomInteractionSnapshot): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>(), strings = snapshot.strings ?? [];
  for (const { frameId, nodes, layout } of snapshot.documents ?? []) {
    const clickable = new Set(nodes.isClickable?.index ?? []);
    const pointers = new Set(layout.nodeIndex.filter((_node, index) => strings[layout.styles[index]?.[0]] === 'pointer'));
    // 光标会继承到文本包装层；只追加独立 pointer 边界，避免每层 span 都重复变成操作目标。
    for (const index of pointers) if (!pointers.has(nodes.parentIndex?.[index] ?? -1)) clickable.add(index);
    const rendered = new Set(layout.nodeIndex), ids = new Set<number>();
    for (const index of clickable) {
      const id = nodes.backendNodeId?.[index];
      if (nodes.nodeType?.[index] === 1 && rendered.has(index) && id !== undefined) ids.add(id);
    }
    result.set(strings[frameId], ids);
  }
  return result;
}

const interactiveRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'listbox', 'option', 'treeitem',
  'date', 'datetime', 'inputtime', 'colorwell']);
const snapshotProperties = new Set(['checked', 'selected', 'disabled', 'expanded', 'required', 'readonly', 'level',
  'multiline', 'url', 'clickable', 'focused', 'busy', 'hasPopup', 'autocomplete', 'orientation', 'multiselectable', 'valuemin', 'valuemax', 'valuetext']);
const textContainerRoles = new Set(['paragraph', 'heading', 'caption', 'listitem', 'cell', 'columnheader', 'rowheader']);

/** 内嵌媒体保留类型与编码，正文不参与快照检索或字符预算；元素身份仍使用原始 AX 节点。 */
export function snapshotUrl(url: string): string {
  const header = /^data:([^,]*),/i.exec(url);
  if (!header || !/;base64(?:;|$)/i.test(header[1]) && !/^image\//i.test(header[1])) return url;
  return `${header[0]}[内嵌${/^image\//i.test(header[1]) ? '图片' : '数据'}已省略]`;
}

/** 按树顺序输出，正文、表头和所属控件保持相邻；Chromium 返回的数组可能是广度优先排列。 */
export function* snapshotRows(nodes: AxNode[], options: SnapshotOptions, backendNodeId?: number): Generator<{ node: AxNode; row: SnapshotNode }> {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const children = new Map<string, AxNode[]>();
  for (const node of nodes) if (node.parentId) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node); children.set(node.parentId, siblings);
  }
  const root = backendNodeId === undefined ? undefined : nodes.find(node => node.backendDOMNodeId === backendNodeId);
  if (backendNodeId !== undefined && !root) throw new Error('所选页面区域已经变化，请重新读取整个页面。');
  const roots = root ? [root] : nodes.filter(node => !node.parentId || !byId.has(node.parentId));
  const pending = roots.reverse().map(node => ({ node, depth: 0, textContainer: undefined as string | undefined }));
  const visited = new Set<string>();
  const ordered: Array<{ node: AxNode; depth: number; properties: Record<string, unknown>; interactive: boolean; textContainer?: string }> = [];
  const text = new Map<string, string[]>();
  while (pending.length) {
    const { node, depth, textContainer } = pending.pop()!;
    if (visited.has(node.nodeId)) continue;
    visited.add(node.nodeId);
    const descendants = node.childIds?.length ? node.childIds.map(id => byId.get(id)).filter((child): child is AxNode => !!child) : children.get(node.nodeId) ?? [];
    const role = node.role?.value ?? 'node';
    const properties = Object.fromEntries((node.properties ?? []).map(property => [property.name, property.value.value]));
    if (typeof properties.url === 'string') properties.url = snapshotUrl(properties.url);
    if (node.clickable) properties.clickable = true;
    const interactive = interactiveRoles.has(role.toLowerCase()) || properties.focusable === true && role !== 'RootWebArea'
      || properties.editable === 'richtext' || properties.editable === 'plaintext' || node.clickable === true;
    const omitted = node.ignored && !node.clickable || role === 'InlineTextBox' || !node.name?.value && ['generic', 'none'].includes(role) && !interactive;
    const container = (!node.ignored || node.clickable) && (textContainerRoles.has(role.toLowerCase()) || node.clickable) ? node.nodeId : textContainer;
    for (let index = descendants.length - 1; index >= 0; index--) pending.push({ node: descendants[index], depth: depth + (omitted ? 0 : 1), textContainer: container });
    if (omitted) continue;
    // 段落内的字符 span 可散布在透明包装层中；按页面树顺序拼接，嵌套段落各自保留边界。
    if (textContainer && (role === 'StaticText' || role === 'LineBreak')) {
      const fragments = text.get(textContainer) ?? [];
      fragments.push(role === 'LineBreak' ? '\n' : node.name?.value ?? ''); text.set(textContainer, fragments);
    }
    ordered.push({ node, depth, properties, interactive, textContainer });
  }
  const paragraphs = new Map([...text].filter(([id, fragments]) => fragments.length > 1 || byId.get(id)?.clickable)
    .map(([id, fragments]) => [id, fragments.join('')]));
  const query = options.query?.toLocaleLowerCase();
  for (const { node, depth, properties, interactive, textContainer } of ordered) {
    const role = node.role?.value ?? 'node';
    // 聚合正文的 ref 属于真实段落；链接、控件及其他语义节点仍保持各自的引用与点击目标。
    if (!interactive && textContainer && paragraphs.has(textContainer) && (role === 'StaticText' || role === 'LineBreak')
      && options.role?.toLowerCase() !== role.toLowerCase()) continue;
    if (options.role && role.toLowerCase() !== options.role.toLowerCase()) continue;
    if (options.interactiveOnly && !interactive) continue;
    const paragraph = paragraphs.get(node.nodeId), name = node.name?.value || paragraph || '', description = node.description?.value;
    const body = paragraph && paragraph !== name ? paragraph : undefined;
    const value = node.value?.value === undefined ? undefined : String(node.value.value);
    if (query && ![name, body, description, value, properties.url].some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(query))) continue;
    let textTruncated = false;
    const excerpt = (text: string) => {
      if (text.length <= 3000) return text;
      textTruncated = true;
      const match = query ? text.toLocaleLowerCase().indexOf(query) : 0;
      const start = Math.max(0, match - 200);
      return (start ? '…' : '') + text.slice(start, start + 3000) + (start + 3000 < text.length ? '…' : '');
    };
    const row: SnapshotNode = { depth, role, name: excerpt(name),
      ...(body ? { text: excerpt(body) } : {}),
      ...(description ? { description: excerpt(description) } : {}),
      ...(value !== undefined ? { value: excerpt(value) } : {}),
      ...Object.fromEntries(Object.entries(properties).filter(([key]) => snapshotProperties.has(key))) };
    if (textTruncated) row.textTruncated = true;
    yield { node, row };
  }
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

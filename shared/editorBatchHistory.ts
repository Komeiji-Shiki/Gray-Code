export interface BatchEditTarget {
  version(): number | string;
  disposed(): boolean;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}
export interface BatchEditEntry { target: BatchEditTarget; before: number | string; after: number | string }
export interface EditBatchHandle { undo(): Promise<void>; redo(): Promise<void> }
interface BatchEditGroup { entries: BatchEditEntry[]; undone: boolean; clearedRedo: Set<BatchEditTarget> }

/** 整批预检后才撤销；其他文件仍有较新的输入时，不允许只恢复其中一部分。 */
export class EditorBatchHistory {
  private groups: BatchEditGroup[] = [];
  record(entries: BatchEditEntry[]): EditBatchHandle {
    this.groups = this.groups.filter(group => !group.entries.every(entry => entry.target.disposed()));
    const group: BatchEditGroup = { entries: entries.filter(entry => entry.before !== entry.after), undone: false, clearedRedo: new Set() };
    if (group.entries.length) this.groups.push(group);
    const move = async (undo: boolean) => {
      if (group.undone === undo || !group.entries.length) return;
      await this.moveGroup(group, undo);
    };
    return { undo: () => move(true), redo: () => move(false) };
  }
  invalidateRedo(target: BatchEditTarget) {
    for (const group of this.groups) if (group.undone && group.entries.some(entry => entry.target === target)) group.clearedRedo.add(target);
  }
  private async moveGroup(group: BatchEditGroup, undo: boolean) {
    if (group.clearedRedo.size) throw new Error('撤销后又进行了编辑，原来的整批修改已不能重做。');
    const expected = undo ? 'after' : 'before';
    if (group.entries.some(entry => entry.target.disposed() || entry.target.version() !== entry[expected]))
      throw new Error('这批修改涉及的文件已关闭或有较新的编辑，请先撤销后续编辑再重试。');
    // 本地模型操作同步生效，不在各文件修改之间等待网络响应。
    await Promise.all(group.entries.map(entry => undo ? entry.target.undo() : entry.target.redo()));
    group.undone = undo;
  }
  async move(target: BatchEditTarget, undo: boolean): Promise<void> {
    const expected = undo ? 'after' : 'before';
    const group = [...this.groups].reverse().find(group => group.undone !== undo &&
      group.entries.some(entry => entry.target === target && entry[expected] === target.version()));
    if (!group) { await (undo ? target.undo() : target.redo()); return; }
    // 此文件的新编辑已经清除了旧重做栈，仍允许它重做自己的后续输入。
    if (!undo && group.clearedRedo.has(target)) { await target.redo(); return; }
    await this.moveGroup(group, undo);
  }
}

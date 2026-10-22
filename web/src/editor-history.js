import { opApply, opDiff, opMap, opTransform, opInverse } from './text-operations.js';

// Inverses belong to document versions, not to the browser's textarea value.
// Rebase them through incoming operations so undo retains remote edits.
export class EditorHistory {
  constructor(limit = 200) { this.limit = limit; this.undo = []; this.redo = []; this.group = null; }
  boundary() { this.group = null; }
  record(before, after, selectionBefore, selectionAfter, group = '', now = Date.now()) {
    if (before === after) return;
    const top = this.undo.at(-1);
    const together = group && this.group?.id === group && this.group.entry === top && (group.startsWith('agent:') || (now - this.group.at < 750 && this.group.selection?.every((p, i) => p === selectionBefore[i]))) && this.group.after === before;
    if (together) top.ops = opDiff(after, this.group.before);
    else {
      const entry = { ops: opDiff(after, before), selection: [...selectionBefore] };
      this.undo.push(entry);
      if (this.undo.length > this.limit) this.undo.shift();
      this.group = group ? { id: group, entry, before } : null;
    }
    if (this.group) Object.assign(this.group, { at: now, after, selection: [...selectionAfter] });
    this.redo = [];
  }
  recordOperation(before, ops, selectionBefore, selectionAfter) {
    if (opApply(before, ops) === before) return;
    this.boundary();
    this.undo.push({ ops: opInverse(before, ops), selection: [...selectionBefore] });
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo = [];
  }
  remote(ops) {
    this.boundary();
    for (const stack of [this.undo, this.redo]) {
      let change = ops;
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        [entry.ops, change] = opTransform(entry.ops, change);
        entry.selection = entry.selection.map((p) => opMap(change, p));
      }
    }
  }
  step(text, selection, redo = false) {
    this.boundary();
    const from = redo ? this.redo : this.undo;
    const to = redo ? this.undo : this.redo;
    while (from.length) {
      const entry = from.pop();
      const next = opApply(text, entry.ops);
      if (next === text) continue;
      to.push({ ops: opInverse(text, entry.ops), selection: [...selection] });
      return { text: next, selection: entry.selection.map((p) => Math.max(0, Math.min(next.length, p))) };
    }
    return null;
  }
}

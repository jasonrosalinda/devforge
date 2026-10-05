// Tiptap schema for runbook cells, with no React, so the UI and the headless
// round-trip tests share it. Chip nodes keep the original Confluence XHTML in
// `xml`; the UI adds node views on top with `.extend({ addNodeView })`.

import { Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';

// `key` is the node attribute, written to / read from `data-<name>`. Rendering it
// matters: copy & paste round-trips nodes through this HTML, so a chip that
// rendered nothing would paste back empty (and its Confluence content be lost).
const dataAttr = (key: string, name: string, encode = false) => ({
  default: '',
  parseHTML: (el: HTMLElement) => {
    const v = el.getAttribute(`data-${name}`) ?? '';
    return encode ? decodeURIComponent(v) : v;
  },
  renderHTML: (attrs: Record<string, unknown>) => {
    const v = String(attrs[key] ?? '');
    return { [`data-${name}`]: encode ? encodeURIComponent(v) : v };
  },
});

function chip(name: string, tag: 'span' | 'div', marker: string, attrs: Record<string, ReturnType<typeof dataAttr>>, inline: boolean) {
  return Node.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes: () => attrs,
    parseHTML: () => [{ tag: `${tag}[data-${marker}]` }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes, { [`data-${marker}`]: '' })],
  });
}

export const CfMention = chip('cfMention', 'span', 'cf-mention', { accountId: dataAttr('accountId', 'account-id'), xml: dataAttr('xml', 'xml', true) }, true);
export const CfStatus = chip('cfStatus', 'span', 'cf-status', { title: dataAttr('title', 'title'), colour: dataAttr('colour', 'colour'), xml: dataAttr('xml', 'xml', true) }, true);
export const CfRaw = chip('cfRaw', 'span', 'cf-raw', { label: dataAttr('label', 'label'), xml: dataAttr('xml', 'xml', true) }, true);
export const CfRawBlock = chip('cfRawBlock', 'div', 'cf-raw-block', { label: dataAttr('label', 'label'), xml: dataAttr('xml', 'xml', true) }, false);

export const CfImage = Node.create({
  name: 'cfImage',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({
    filename: dataAttr('filename', 'filename'),
    xml: dataAttr('xml', 'xml', true),
    previewUrl: { default: '', parseHTML: () => '', renderHTML: () => ({}) }, // object URL of a pasted image, never saved
  }),
  parseHTML: () => [{ tag: 'img[data-cf-image]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', mergeAttributes(HTMLAttributes, { 'data-cf-image': '' })],
});

export const ConfluenceTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      // keepOnSplit false: Enter makes a new task, which must get a new id (not a copy).
      taskId: { default: null, keepOnSplit: false, parseHTML: (el: HTMLElement) => el.getAttribute('data-task-id') || null, renderHTML: (a: Record<string, unknown>) => (a.taskId ? { 'data-task-id': String(a.taskId) } : {}) },
      taskUuid: { default: null, keepOnSplit: false, parseHTML: (el: HTMLElement) => el.getAttribute('data-task-uuid') || null, renderHTML: (a: Record<string, unknown>) => (a.taskUuid ? { 'data-task-uuid': String(a.taskUuid) } : {}) },
    };
  },
}).configure({ nested: true });

export function richTextSchema(): AnyExtension[] {
  return [
    // trailingNode off: it appends an empty paragraph on the first transaction (even a click), which would mark untouched cells as edited.
    StarterKit.configure({ codeBlock: false, trailingNode: false, link: { openOnClick: false, autolink: true } }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList,
    ConfluenceTaskItem,
    Details.configure({ persist: true }),
    DetailsSummary,
    DetailsContent,
    CfMention, CfStatus, CfRaw, CfRawBlock, CfImage,
  ];
}

import { createHash, randomBytes } from 'node:crypto';
import { StoredFiles } from './stored-files.mjs';
import { fileType } from './file-codecs.mjs';
import { MemoryFiles } from './memory-files.mjs';
import { action, controls, interaction } from './interaction.mjs';
import { groupLabel } from './group-label.mjs';

const key = name => createHash('sha256').update(name).digest('hex').slice(0, 32);
const label = name => name.replace(/[\r\n*_`<>\[\]#]/g, ' ');
const pageNumber = value => Math.min(1000000, Math.max(1, Number(value) || 1));

// Administrator-only data pages. No model inference, arbitrary paths or other private workspaces.
export class FileManagement {
  constructor(controller) { this.controller = controller; this.confirmations = new Map(); }
  async handle(adminScope, text) {
    const c = this.controller;
    if (!adminScope.startsWith('c2c:') || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REQUIRED');
    const match = /^\/files(?: (current|shared|[a-f0-9]{32})(?: (list|view|export|delete|confirm|open)(?: ([a-f0-9]{16,32}|\d+))?(?: (\d+))?)?)?$/.exec(text);
    if (!match) return interaction('请从文件与笔记页面选择操作。', [[action('文件与笔记', '/files')]]);
    if (!match[1]) return interaction('## 文件与笔记\n对话文件是模型保存的草稿、代码或笔记；共享记忆是各对话共用的公开知识笔记。\n可阅读正文、导出完整 TXT 或删除指定文件。收到的 QQ 附件请进入“附件与图片”。\n选择要查看的范围：', [
      [action('当前私聊文件', '/files current'), action('共享记忆', '/files shared')],
      [controls.groups, action('附件与图片', '/media')], [action('返回数据管理', '/settings data')],
    ]);
    const [, target, operation = 'list', value = '1', rawPage = '1'] = match;
    let scope = adminScope; let name = '当前私聊文件'; let back = action('返回文件与笔记', '/files');
    if (!['current', 'shared'].includes(target)) {
      const group = await c.groupAccess.read(target);
      if (!group?.allowed) return interaction('本群当前未获授权，无法查看文件。', [[controls.groups]]);
      scope = `group:${group.openid}`; name = `${groupLabel(group)} · 文件`;
      back = action('返回群设置', `/group more ${target}`);
    }
    if (target === 'shared') name = '共享记忆';
    const files = target === 'shared' ? new MemoryFiles(c.store, scope) : new StoredFiles(c.store, scope);
    const command = `/files ${target}`;
    const list = () => action('返回文件列表', command);
    try {
      for (const [id, pending] of this.confirmations) if (pending.until < Date.now()) this.confirmations.delete(id);
      if (operation === 'confirm') {
        const pending = this.confirmations.get(value); this.confirmations.delete(value);
        if (!pending || pending.adminScope !== adminScope || pending.target !== target) return interaction('删除确认已失效，请重新选择文件。', [[list()]]);
        if (pending.digest) await files.removeFile(pending.name, pending.digest);
        else await files.remove(pending.name, pending.content);
        return interaction(`已删除：${label(pending.name)}`, [[list()]]);
      }
      const entries = (await files.list()).files;
      if (operation === 'list') {
        const page = Math.min(pageNumber(value), Math.max(1, Math.ceil(entries.length / 8)));
        const selected = entries.slice((page - 1) * 8, page * 8);
        const rows = [];
        for (let i = 0; i < selected.length; i += 2) rows.push(selected.slice(i, i + 2).map(file => action(label(file.name), `${command} view ${key(file.name)}`)));
        const navigation = [];
        if (page > 1) navigation.push(action('上一页', `${command} list ${page - 1}`));
        if (page * 8 < entries.length) navigation.push(action('下一页', `${command} list ${page + 1}`));
        navigation.push(back);
        rows.push(navigation);
        return interaction(`## ${name}\n共 ${entries.length} 个文件，第 ${page} 页。\n${selected.map(file => `${label(file.name)} · ${file.bytes} 字节`).join('\n') || '暂时没有文件。'}\n点击文件可阅读正文。`, rows);
      }
      const file = entries.find(file => key(file.name) === value);
      if (!file) return interaction('文件已不存在，请刷新列表。', [[list()]]);
      const binary = target !== 'shared' && fileType(file.name).kind !== 'text';
      if (binary) {
        const selected = operation === 'open' ? await files.load(file.name) : await files.descriptor(file.name);
        await selected.close?.();
        const assertAccess = async () => {
          if (c.closed || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REVOKED');
          if (target !== 'current' && !(await c.groupAccess.read(target))?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
          await selected.assertAccess();
        };
        await assertAccess();
        if (operation === 'open' && ['image', 'audio', 'video'].includes(selected.kind)) return {
          ...interaction(`已打开：${label(file.name)}`, [[list()]]),
          media: { type: selected.kind, bytes: selected.bytes, mimeType: selected.mimeType, assertAccess },
        };
        if (operation === 'delete') {
          const token = randomBytes(8).toString('hex');
          this.confirmations.set(token, { adminScope, target, name: file.name, digest: selected.sha256, until: Date.now() + 600000 });
          while (this.confirmations.size > 100) this.confirmations.delete(this.confirmations.keys().next().value);
          return interaction(`确认删除 ${label(file.name)}？此操作无法撤销。`, [[action('确认删除', `${command} confirm ${token}`)], [list()]]);
        }
        return interaction(`## ${label(file.name)}\n类型：${selected.mimeType} · ${selected.size} 字节\n${label(selected.label || '')}\n文件内容尚未在此读取。`, [
          ...(['image', 'audio', 'video'].includes(selected.kind) ? [[action('在私聊打开', `${command} open ${value}`)]] : []),
          [action('删除文件', `${command} delete ${value}`)], [list()],
        ]);
      }
      const content = await files.readText(file.name);
      if (operation === 'export') return { ...interaction(`已导出 ${label(file.name)} 的完整文本。`, [[list()]]),
        file: { name: `note-${value}.txt`, text: content, assertAccess: async () => {
          if (c.closed || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REVOKED');
          if (!['current', 'shared'].includes(target) && !(await c.groupAccess.read(target))?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
          await files.readText(file.name);
        } } };
      if (operation === 'delete') {
        if (target === 'shared' && file.name.toLowerCase() === 'agents.md') return interaction('共享记忆使用说明为只读文件。', [[list()]]);
        const token = randomBytes(8).toString('hex');
        this.confirmations.set(token, { adminScope, target, name: file.name, content, until: Date.now() + 600000 });
        while (this.confirmations.size > 100) this.confirmations.delete(this.confirmations.keys().next().value);
        return interaction(`## 删除文件\n${label(file.name)}\n仅删除这一份文件，无法撤销${target === 'shared' ? '；会影响所有对话以后读取这份记忆' : ''}。`, [
          [action('确认删除', `${command} confirm ${token}`)], [action('取消', `${command} view ${value}`)],
        ]);
      }
      const characters = Array.from(content); const total = Math.max(1, Math.ceil(characters.length / 1000));
      const page = Math.min(pageNumber(rawPage), total);
      const excerpt = characters.slice((page - 1) * 1000, page * 1000).join('');
      const navigation = [];
      if (page > 1) navigation.push(action('上一页', `${command} view ${value} ${page - 1}`));
      if (page < total) navigation.push(action('下一页', `${command} view ${value} ${page + 1}`));
      return interaction(`## ${label(file.name)}\n${name} · 正文第 ${page}/${total} 页\n\n${excerpt || '（空文件）'}`, [
        ...(navigation.length ? [navigation] : []),
        [action('导出完整 TXT', `${command} export ${value}`), ...(target === 'shared' && file.name.toLowerCase() === 'agents.md' ? [] : [action('删除文件', `${command} delete ${value}`)])],
        [list()],
      ]);
    } catch (error) {
      const message = error.message === 'WORKSPACE_FILE_CHANGED' ? '文件内容已更新，未删除。请重新查看后操作。'
        : ['ENOENT', 'WORKSPACE_FILE_EXISTS'].includes(error.code) ? '文件已变动，请刷新列表。'
          : '暂时无法访问文件，请检查当前授权和文件状态。';
      return interaction(message, [[list()]]);
    }
  }
}

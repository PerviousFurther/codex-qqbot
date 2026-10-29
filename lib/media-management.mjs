import { randomBytes } from 'node:crypto';
import { action, controls, interaction } from './interaction.mjs';
import { scopeId } from './policy.mjs';
import { groupLabel } from './group-label.mjs';
import { assertMessageAccess } from './message-access.mjs';
import { downloadQQMedia } from './qq-images.mjs';
import { imageType, MAX_IMAGE_BYTES } from './image-policy.mjs';
import { audioType } from './audio-policy.mjs';

const names = { image: '图片', audio: '语音', video: '视频', file: '文件' };
const clean = value => String(value || '').replace(/[\r\n*_`<>\[\]#]/g, ' ').slice(0, 120);

// Explicit private operator access to the selected authorized conversation's media.
// URLs remain backend-only; viewing reuses checked downloads and QQ delivery.
export class MediaManagement {
  constructor(controller) { this.controller = controller; this.confirmations = new Map(); this.download = downloadQQMedia; }
  async handle(adminScope, text) {
    const c = this.controller;
    if (!adminScope.startsWith('c2c:') || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REQUIRED');
    const match = /^\/media(?: (current|[a-f0-9]{32})(?: (received|saved)(?: (list|view|open|export|delete|confirm)(?: ([a-f0-9]{16,32}|\d+))?(?: (\d+))?)?)?)?$/.exec(text);
    if (!match?.[1]) return interaction('## 附件与图片\n收到的附件保留下载索引；链接可能失效。保存的图片已保留实际内容，与原链接分开管理。\n选择当前私聊，或从已授权群的更多设置中进入。', [
      [action('当前私聊媒体', '/media current'), controls.groups], [action('返回数据管理', '/settings data')],
    ]);
    const [, target, category, operation = 'list', value = '1', rawPage = '1'] = match;
    let scope = adminScope; let title = '当前私聊';
    if (target !== 'current') {
      const group = await c.groupAccess.read(target);
      if (!group?.allowed) return interaction('本群当前未获授权，无法查看附件。', [[controls.groups]]);
      scope = `group:${group.openid}`; title = groupLabel(group);
    }
    const command = `/media ${target}`;
    const back = action('返回媒体分类', command);
    if (!category) return interaction(`## ${title} · 附件与图片\n收到的附件：消息携带的图片、语音、视频和文件索引。\n保存的图片：模型另外保存的图片、截图或表情图片。\n打开媒体会将所选内容发送到当前机管私聊。`, [
      [action('收到的附件', `${command} received`), action('保存的图片', `${command} saved`)],
      [target === 'current' ? action('返回数据管理', '/settings data') : action('返回群设置', `/group more ${target}`)],
    ]);
    const base = `${command} ${category}`; const list = action('返回列表', base);
    const access = async row => {
      if (c.closed || !c.admins.includes(adminScope.slice(4))) throw new Error('ADMIN_ACCESS_REVOKED');
      if (scope.startsWith('group:') && !(await c.groupAccess.read(scopeId(scope)))?.allowed) throw new Error('GROUP_NOT_AUTHORIZED');
      await assertMessageAccess(scope, c.store, row);
    };
    try {
      await access();
      for (const [id, pending] of this.confirmations) if (pending.until < Date.now()) this.confirmations.delete(id);
      if (operation === 'confirm') {
        const pending = this.confirmations.get(value); this.confirmations.delete(value);
        if (!pending || pending.adminScope !== adminScope || pending.scope !== scope || pending.category !== category) return interaction('删除确认已失效，请重新选择。', [[list]]);
        if (category === 'saved') await c.savedImages.remove(scope, pending.id);
        else await c.messageRecords.removeAttachment(scope, pending.id);
        return interaction(category === 'saved' ? '已删除这张保存图片。' : '已删除本地附件下载索引；消息文字和另外保存的图片不受影响。', [[list]]);
      }
      if (operation === 'list') {
        const page = Math.min(1000000, Math.max(1, Number(value) || 1));
        let items; let more;
        if (category === 'saved') {
          const all = await c.savedImages.list(scope);
          items = all.slice((page - 1) * 8, page * 8).map(item => ({ id: item.asset_id, text: item.label || '图片', size: item.size })); more = page * 8 < all.length;
        } else {
          const result = await c.messageRecords.listAttachments(scope, (page - 1) * 8);
          items = [];
          for (const row of result.items) {
            try { await access(row); items.push({ id: row.id, text: row.attachment.filename || names[row.kind] || '附件', size: row.attachment.size }); }
            catch (error) { if (error.message !== 'GROUP_MESSAGES_DISABLED') throw error; }
          }
          more = result.more;
        }
        const rows = [];
        for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map(item => action(clean(item.text), `${base} view ${item.id}`)));
        rows.push([...(page > 1 ? [action('上一页', `${base} list ${page - 1}`)] : []), ...(more ? [action('下一页', `${base} list ${page + 1}`)] : []), back]);
        return interaction(`## ${title} · ${category === 'saved' ? '保存的图片' : '收到的附件'}\n第 ${page} 页\n${items.map(item => `${clean(item.text)}${item.size === undefined ? '' : ` · ${item.size} 字节`}`).join('\n') || '本页没有可访问的内容。'}`, rows);
      }
      if (!/^[a-f0-9]{32}$/.test(value)) return interaction('请选择列表中的附件。', [[list]]);
      const saved = category === 'saved' ? await c.savedImages.get(scope, value, { metadataOnly: true }) : null;
      const received = saved ? null : await c.messageRecords.attachmentDetail(scope, value);
      if (!saved && !received) throw new Error('ATTACHMENT_NOT_RETAINED');
      await access(saved?.source ?? received);
      const type = saved ? 'image' : received.attachment.type;
      const name = saved?.label || received?.attachment.filename || names[type] || '附件';
      if (operation === 'delete') {
        const token = randomBytes(8).toString('hex');
        this.confirmations.set(token, { adminScope, scope, category, id: value, until: Date.now() + 600000 });
        while (this.confirmations.size > 100) this.confirmations.delete(this.confirmations.keys().next().value);
        return interaction(`## 删除${category === 'saved' ? '保存图片' : '附件索引'}\n${clean(name)}\n${category === 'saved' ? '删除机器人保存的这张图片。' : '删除本地下载索引；图片的查看索引也会删除。原消息文字和另外保存的图片保留。'}不会撤回 QQ 消息。`, [
          [action('确认删除', `${base} confirm ${token}`)], [action('取消', `${base} view ${value}`)],
        ]);
      }
      if (operation === 'open' || operation === 'export') {
        if (operation === 'export' && type !== 'file') return interaction('请使用打开媒体查看此附件。', [[list]]);
        const recheck = async () => {
          await access();
          if (saved) { const current = await c.savedImages.get(scope, value, { metadataOnly: true }); await access(current.source); }
          else { const row = await c.messageRecords.attachment(scope, value); if (!row) throw new Error('ATTACHMENT_NOT_RETAINED'); await access(row); }
        };
        await recheck();
        const limit = type === 'image' ? MAX_IMAGE_BYTES : type === 'audio' ? 8 * 1024 * 1024 : type === 'video' ? 64 * 1024 * 1024 : 64 * 1024;
        const pointer = saved ? null : await c.messageRecords.attachment(scope, value);
        if (!saved && !pointer) throw new Error('ATTACHMENT_NOT_RETAINED');
        const bytes = saved ? (await c.savedImages.get(scope, value)).bytes : await this.download(pointer.url, limit);
        await recheck();
        if (type === 'file') {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (content.includes('\0')) throw new Error('ATTACHMENT_TEXT_REQUIRED');
          if (operation === 'export') return { ...interaction(`${clean(name)} · 完整文本已导出为 TXT。`, [[list]]), file: { name: `attachment-${value}.txt`, text: content, assertAccess: recheck } };
          const characters = Array.from(content); const total = Math.max(1, Math.ceil(characters.length / 1000));
          const page = Math.min(total, Math.max(1, Number(rawPage) || 1));
          return interaction(`## ${clean(name)}\n正文第 ${page}/${total} 页\n\n${characters.slice((page - 1) * 1000, page * 1000).join('') || '（空文件）'}`, [
            [...(page > 1 ? [action('上一页', `${base} open ${value} ${page - 1}`)] : []), ...(page < total ? [action('下一页', `${base} open ${value} ${page + 1}`)] : []), action('导出完整 TXT', `${base} export ${value}`)], [list],
          ]);
        }
        const mimeType = type === 'image' ? imageType(bytes) : type === 'audio' ? audioType(bytes) : bytes.toString('ascii', 4, 8) === 'ftyp' ? 'video/mp4' : null;
        if (!mimeType) throw new Error('MEDIA_FORMAT_UNSUPPORTED');
        return { ...interaction(`${clean(name)} · ${names[type]}`, [[list]]), media: { type, bytes, mimeType, assertAccess: recheck } };
      }
      return interaction(`## ${clean(name)}\n${title} · ${names[type] || '文件'}\n${saved ? `已保存实际图片内容，有效期至 ${saved.expiresAt}。` : '保留的是下载索引；QQ 链接可能失效。'}\n${received?.attachment.size === undefined ? '' : `文件大小：${received.attachment.size} 字节\n`}打开上限：图片 16 MiB、语音 8 MiB、视频 64 MiB；普通文件仅支持 64 KiB 内的 UTF-8 文本。`, [
        [action(type === 'file' ? '查看文本' : '在私聊打开', `${base} open ${value}`), action('删除', `${base} delete ${value}`)], [list],
      ]);
    } catch (error) {
      const unavailable = ['IMAGE_UNAVAILABLE_OR_EXPIRED', 'ATTACHMENT_NOT_RETAINED', 'SAVED_IMAGE_NOT_RETAINED'].includes(error.message);
      return interaction(unavailable ? '附件已过期、链接不可用或本地索引已删除。未发送媒体，可请原发送者重发。'
        : error.message === 'IMAGE_TOO_LARGE' ? '附件超过当前单文件上限，未打开或保存。请先压缩或缩小文件。'
          : error instanceof TypeError || error.message === 'ATTACHMENT_TEXT_REQUIRED' ? '该文件不是受支持的 UTF-8 文本，无法转换为 TXT。'
            : '当前无法读取附件，请检查授权、文件格式或下载状态。', [[list]]);
    }
  }
}

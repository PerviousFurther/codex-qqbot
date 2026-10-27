import { join } from 'node:path';
import { action, controls, interaction } from './interaction.mjs';

export class ChatAccess {
  constructor(store) { this.store = store; this.path = join(store.root, 'chat-access.json'); this.tail = Promise.resolve(); }
  async read() { return this.store.read(this.path, { publicPrivateChat: true }); }
  async accepts(who) { return !who.private || who.admin || (await this.read()).publicPrivateChat === true; }
  async handle(command) {
    const task = this.tail.then(async () => {
      const settings = await this.read();
      if (command === '/chat-access private on' || command === '/chat-access private off') {
        settings.publicPrivateChat = command.endsWith(' on'); await this.store.write(this.path, settings);
      } else if (command !== '/chat-access') return interaction('请通过聊天权限按钮设置。', [[action('聊天权限', '/chat-access')]]);
      return interaction(`## 私聊开放范围\n其他人的私聊：${settings.publicPrivateChat ? '允许' : '禁止'}\n\n关闭后，机器人只接受机管私聊。这个开关不限制机器人向已知联系人或机管发送消息。群聊仍按各群设置运行。`, [
        [action(`${settings.publicPrivateChat ? '禁止' : '允许'}非机管私聊`, `/chat-access private ${settings.publicPrivateChat ? 'off' : 'on'}`)], [controls.chat],
      ]);
    });
    this.tail = task.catch(() => {}); return task;
  }
}

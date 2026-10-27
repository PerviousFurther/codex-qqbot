import { modelMenu } from './model-menu.mjs';
import { action, controls, interaction } from './interaction.mjs';
import { scopeId } from './policy.mjs';
import { reasoningMenu, effortLabel } from './reasoning-menu.mjs';

// One model catalogue and selection path for every conversation environment.
export class ConversationModels {
  constructor({ adapter, store, event }) { Object.assign(this, { adapter, store, event }); }
  async menu(scope, page, target) {
    const startedAt = Date.now();
    this.event({ scope: scopeId(scope), state: 'models_requested' });
    const [models, checkpoint] = await Promise.all([this.adapter.models(scope), this.store.conversation(scope)]);
    this.event({ scope: scopeId(scope), state: 'models_loaded', count: models.length, elapsedMs: Date.now() - startedAt });
    return modelMenu(models, checkpoint.model, page, target);
  }
  async select(scope, model, { list = '/models', environment = '当前私聊', thinking = '/thinking', back } = {}) {
    const models = await this.adapter.models(scope, { refresh: true });
    const selected = models.find(item => item.id === model);
    if (!selected) {
      return interaction('该模型不在当前可用列表中，请重新选择。', [[action('重新选择', list)]]);
    }
    // Read inside the conversation queue so an earlier turn cannot overwrite this choice.
    const checkpoint = await this.store.conversation(scope);
    checkpoint.model = model;
    const resetEffort = checkpoint.reasoningEffort && !selected.efforts.some(item => item.id === checkpoint.reasoningEffort);
    if (resetEffort) checkpoint.reasoningEffort = null;
    await this.store.saveConversation(scope, checkpoint);
    return interaction(`${environment}已选择模型：${model}，下一轮生效。${resetEffort ? '\n原思考深度不适用于这个模型，已恢复模型默认。' : ''}`, [[action('思考深度', thinking), back ?? controls.chat]]);
  }
  async reasoningState(scope, refresh = false) {
    const [models, checkpoint] = await Promise.all([this.adapter.models(scope, { refresh }), this.store.conversation(scope)]);
    return { model: models.find(item => item.id === checkpoint.model) ?? models.find(item => item.isDefault), checkpoint };
  }
  async thinkingMenu(scope, page, target) {
    const { model, checkpoint } = await this.reasoningState(scope);
    return reasoningMenu(model, checkpoint.reasoningEffort, page, target);
  }
  async selectThinking(scope, value, target = {}) {
    const { model, checkpoint } = await this.reasoningState(scope, true);
    if (value !== 'default' && !model?.efforts.some(item => item.id === value)) {
      return interaction('当前模型不支持这个思考深度，请重新选择。', [[action('思考深度', target.thinking ?? '/thinking')]]);
    }
    checkpoint.reasoningEffort = value === 'default' ? null : value;
    await this.store.saveConversation(scope, checkpoint);
    return interaction(`${target.environment ?? '当前私聊'}的思考深度已设为${value === 'default' ? '模型默认' : effortLabel(value)}，下一轮生效。`, [[action('思考深度', target.thinking ?? '/thinking'), target.back ?? controls.chat]]);
  }
}

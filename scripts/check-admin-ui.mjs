import { CommandSelections } from '../lib/command-selections.mjs';
// Offline operator-interface checks: temporary settings, fake model catalogue,
// fake QQ API and no model inference, browser, login or real message submission.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.mjs';
import { VideoController } from '../lib/controller.mjs';
import { scopeId } from '../lib/policy.mjs';
import { modelMenu } from '../lib/model-menu.mjs';
import { diagnosticReport } from '../lib/diagnostic-report.mjs';
import { validateControls, commandInstructions } from '../lib/interaction.mjs';
import { ChatDelivery } from '../lib/chat-delivery.mjs';
import { DeliveryDiagnostics } from '../lib/delivery-errors.mjs';
import { ChatResponse } from '../lib/chat-response.mjs';
import { RequestUpdates } from '../lib/request-updates.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';
import { personaTokenLimit, personaTokens } from '../lib/persona-tokens.mjs';
import { conversationInstructions } from '../lib/agent-instructions.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-admin-ui-'));
const store = new Store(root); let controller;
try {
  let inference = 0;
  const catalogue = Array.from({ length: 11 }, (_, index) => ({ id: `fixture-${index}`, name: `测试模型 ${index}`,
    isDefault: index === 0, defaultEffort: 'low', efforts: [{ id: 'low' }, { id: 'high' }] }));
  controller = new VideoController({ store, admins: ['operator'], adapter: {
    models: async () => catalogue, reset: async () => {}, compact: async () => false, close: async () => {},
    run: async () => { inference++; throw new Error('INFERENCE_NOT_ALLOWED'); },
  } });
  const scope = 'c2c:operator'; const groupScope = 'group:fixture'; const id = scopeId(groupScope);
  const group = { id, openid: 'fixture', name: '测试群', allowed: true, listen: true, engage: true,
    taskBlocked: 'SEND_FAILED', pushPending: true, pushOwner: 'fixture-owner', ownerScope: scope,
    observedAt: new Date().toISOString(), platform: { state: { error: 'PLATFORM_ERROR_SENTINEL' } } };
  await store.write(controller.groupAccess.path(id), group);
  await store.saveConversation(scope, { seen: ['old-message'], model: 'fixture-0', threadId: 'retained-thread' });
  await controller.adminSettings.update(scope, settings => { settings.autobrowse = true; });
  const beforeGroup = await controller.groupAccess.read(id);
  const beforeAdmin = await controller.adminSettings.read(scope);
  const beforeCheckpoint = await store.conversation(scope);
  const menus = new Map();
  const render = async (text, who = { scope, admin: true, private: true }) => {
    const responses = [];
    assert(await controller.commands.dispatch({ text, who, message: { senderId: 'operator' }, reply: async value => responses.push(value) }));
    assert.equal(responses.length, 1, text);
    return responses[0];
  };
  const pages = ['/settings', '/settings chat', '/settings data', '/settings display', '/settings browsing',
    '/preferences', '/preferences topics', '/preferences avoid', '/preferences duration', '/preferences style',
    '/persona', '/persona custom',
    '/models', '/models 2', '/thinking', '/groups', `/group view ${id}`, `/group more ${id}`,
    `/group schedule ${id}`, ...['chars', 'count', 'wait', 'context', 'idle'].map(field => `/group schedule ${id} ${field}`),
    `/group-models ${id}`, `/group-thinking ${id}`, `/group-memory ${id}`,
    '/memory', '/contents', '/stop', '/help', '/status', '/context-sharing'];
  for (const command of pages) {
    const response = await render(command); menus.set(command, response);
    assert.equal(typeof response.text, 'string', command);
    assert(!/MCP|Codex|Agent RPC|Trace ID|o200k|程序拆分|发送预留|最小模型调用间隔|PLATFORM_ERROR_SENTINEL/.test(response.text), command);
    assert(response.buttons, command); validateControls(response.buttons);
    assert(!/按钮|点击/.test(response.text), command);
    const instructions = commandInstructions(response.buttons);
    for (const item of response.buttons.rows.flat()) {
      assert(instructions.includes(`\n${item.command}`), command);
      if (item.enter === false) assert(instructions.includes(`${item.label}（编辑后发送）`), command);
    }
    for (const button of response.buttons.rows.flat()) {
      if (button.command.startsWith('/')) assert(controller.commands.routes.some(route => route.pattern.test(button.command)), `${command}: ${button.command}`);
      assert(!/^\/debug\s|^\/group (?:platform|refresh)\s|^\/settings more$/.test(button.command), command);
    }
  }
  // Opaque command arguments become stable, scoped numeric selections.
  let clock = 1000;
  const selections = new CommandSelections(store, () => clock);
  for (const menu of menus.values()) {
    const projected = await selections.prepare(scope, menu.buttons);
    for (const [index, item] of projected.rows.flat().entries()) {
      if (!item.command.startsWith('/action ')) continue;
      assert(!/[a-f0-9]{16,64}/i.test(item.command));
      const original = menu.buttons.rows.flat()[index];
      if (original.enter === false) {
        assert(selections.resolve(scope, item.command).error);
        assert.equal(selections.resolve(scope, `${item.command} 42`).text,
          `${original.editCommand ?? original.command.trim()} 42`);
      } else assert.equal(selections.resolve(scope, item.command).text, original.command);
      assert(selections.resolve('c2c:other', item.command).error);
    }
  }
  const pending = await selections.prepare(scope, { rows: [[{ label: '确认', command: '/contents confirm ' + 'a'.repeat(24) }]] });
  const chosen = pending.rows[0][0].command;
  await selections.prepare(scope, { rows: [[{ label: '另一个对象', command: '/group view ' + 'b'.repeat(32) }]] });
  assert.equal(selections.resolve(scope, chosen).text, '/contents confirm ' + 'a'.repeat(24));
  assert(selections.resolve(scope, `${chosen} extra`).error);
  const restarted = new CommandSelections(store, () => clock);
  assert(restarted.resolve(scope, chosen).error);
  assert.notEqual((await restarted.prepare(scope, { rows: [[{ label: '新菜单', command: '/group view ' + 'c'.repeat(32) }]] })).rows[0][0].command, chosen);
  clock += 600001;
  assert(selections.resolve(scope, chosen).error);
  const deniedMenu = await controller.commandSelections.prepare(groupScope, { rows: [[
    { label: '允许回复', command: `/group allow ${id}` },
  ]] });
  assert.equal(await render(deniedMenu.rows[0][0].command, { scope: groupScope, admin: false, private: false }),
    '这个请求无法在当前对话中处理。');
  const invalidSelection = await render('/action 999999');
  assert(invalidSelection.includes('失效'));
  const homeButtons = menus.get('/settings').buttons.rows.flat();
  assert.equal(homeButtons.filter(button => button.command === '/debug').length, 0);
  assert(homeButtons.some(button => button.command === '/settings display'));
  assert.equal(menus.get('/settings display').buttons.rows.flat().filter(button => button.command === '/debug').length, 1);
  assert(homeButtons.some(button => button.command === '/settings chat'));
  assert(homeButtons.some(button => button.command === '/settings data'));
  assert(menus.get('/group more ' + id).buttons.rows.flat().every(button => !button.command.startsWith('/debug')));
  assert(menus.get('/groups').buttons.rows.flat().some(button => button.command === '/settings'));
  assert(!menus.get('/help').text.includes('/group-memory'));
  assert.deepEqual(await controller.groupAccess.read(id), beforeGroup);
  assert.deepEqual(await controller.adminSettings.read(scope), beforeAdmin);
  assert.deepEqual(await store.conversation(scope), beforeCheckpoint);

  // Long administrator persona commands reach token validation without entering inference.
  assert.equal(personaTokenLimit, 5000);
  const description = 'a '.repeat(personaTokenLimit - 1) + 'a';
  assert.equal(personaTokens(description), personaTokenLimit);
  assert(description.length > 6000);
  const personaReplies = [];
  const setPersona = content => controller.messages.handle({ kind: 'c2c', senderId: 'operator',
    messageId: 'persona-fixture', content }, async value => personaReplies.push(value));
  await setPersona('/persona custom ' + description);
  assert(personaReplies.at(-1).text.includes('5000/5000'));
  assert(personaReplies.at(-1).text.includes('前 600 字符预览'));
  const savedPersona = await controller.personaSettings.read();
  assert.equal(savedPersona.description, description);
  assert(conversationInstructions(scope, savedPersona).includes(JSON.stringify(description)));
  await setPersona('/persona custom ' + description + ' a');
  assert(personaReplies.at(-1).text.includes('5001/5000'));
  assert.deepEqual(await controller.personaSettings.read(), savedPersona);
  await render('/persona custom denied', { scope: 'c2c:other', admin: false, private: true });
  assert.deepEqual(await controller.personaSettings.read(), savedPersona);
  assert.equal(inference, 0);
  await render('/persona reset');

  // Monitoring is opt-in, persisted only for this administrator's private chat.
  assert.equal(beforeAdmin.toolMonitor, false);
  assert(!('progress' in beforeAdmin)); assert(!('details' in beforeAdmin));
  assert(!/进度提示|简短说明/.test(menus.get('/settings display').text));
  assert(menus.get('/group more ' + id).buttons.rows.flat().every(button => !button.command.includes('progress-')));
  assert(![...menus.values()].some(page => page.buttons.rows.flat().some(button => /reply/.test(button.command))));
  assert(menus.get('/group more ' + id).buttons.rows.flat().some(button => button.command === `/group tool-monitor-on ${id}`));
  assert(menus.get('/group more ' + id).text.includes('反馈只发给机管'));
  await render(`/group tool-monitor-on ${id}`);
  const monitoredGroup = await controller.groupAccess.read(id);
  assert.equal(monitoredGroup.toolMonitor, true);
  assert.equal(monitoredGroup.taskBlocked, beforeGroup.taskBlocked);
  assert.equal(monitoredGroup.pushOwner, beforeGroup.pushOwner);
  assert.deepEqual(await controller.adminSettings.read(scope), beforeAdmin);
  await render(`/group tool-monitor-off ${id}`);
  assert.equal((await controller.groupAccess.read(id)).toolMonitor, false);
  await controller.groupAccess.update(id, value => { delete value.toolMonitor; });
  await render('/settings toolMonitor on');
  assert.equal((await controller.adminSettings.read(scope)).toolMonitor, true);
  assert.equal((await controller.adminSettings.read('c2c:other')).toolMonitor, false);
  await render('/settings toolMonitor off');
  assert.deepEqual(await controller.adminSettings.read(scope), beforeAdmin);
  const updates = [];
  const monitor = new RequestUpdates({ toolMonitor: true }, async value => updates.push(value));
  for (let index = 0; index < 2; index++) monitor.update({ kind: 'tool', name: 'read_webpage_media', arguments: 'PARAMETER_SENTINEL' });
  monitor.update({ kind: 'tool-result', name: 'read_webpage_media', status: 'completed', elapsedMs: 1250, result: 'BODY_SENTINEL' });
  monitor.update({ kind: 'tool-result', name: 'read_webpage_media', status: 'failed', elapsedMs: 30 });
  monitor.update({ kind: 'tool-result', name: 'read_webpage', status: 'interrupted', elapsedMs: 500 });
  monitor.update({ kind: 'tool', name: 'UNTRUSTED_TOOL_SENTINEL' });
  monitor.update({ kind: 'explanation', text: 'COMMENTARY_SENTINEL' });
  await monitor.finish();
  assert.equal(updates.length, 6);
  assert(updates.every(value => value.event === 'progress'));
  assert.equal(updates.filter(value => value.text.includes('开始')).length, 2);
  assert(updates.some(value => value.text.includes('已完成（用时 1.3 秒）')));
  assert(updates.some(value => value.text.includes('未能完成')));
  assert(updates.some(value => value.text.includes('已中断')));
  assert(!JSON.stringify(updates).includes('SENTINEL'));
  let disabledSends = 0;
  const disabled = new RequestUpdates({}, async () => { disabledSends++; });
  disabled.update({ kind: 'tool', name: 'read_webpage_media' });
  disabled.update({ kind: 'tool-result', name: 'read_webpage_media', status: 'completed', elapsedMs: 10 });
  await disabled.finish(); assert.equal(disabledSends, 0);

  // Every catalogue entry remains selectable, including at pagination boundaries;
  // return/previous/next buttons all count toward QQ's five-button model limit.
  for (let count = 0; count <= 25; count++) {
    const models = Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, name: `模型 ${i}` }));
    const chosen = []; let page = 1;
    do {
      const result = modelMenu(models, 'model-0', page, { back: { label: '返回本群', command: `/group view ${id}` } });
      validateControls(result.buttons);
      assert(result.buttons.rows.every(row => row.length === 1)); assert(result.buttons.rows.length <= 5);
      const buttons = result.buttons.rows.flat();
      assert(buttons.some(button => button.command === `/group view ${id}`));
      chosen.push(...buttons.filter(button => button.command.startsWith('/model ')).map(button => button.command.slice(7)));
      if (!buttons.some(button => button.command === `/models ${page + 1}`)) break;
      page++;
    } while (page <= 30);
    assert.deepEqual(chosen, models.map(model => model.id));
  }

  // Sensitive mutations stay explicit and scoped; these requests only ask for
  // confirmation and never execute clear/reset/model actions.
  for (const command of ['/memory clear', `/group-memory ${id} clear`, '/contents clear']) {
    const confirmation = await render(command);
    assert(confirmation.text.includes('无法撤销')); validateControls(confirmation.buttons);
    assert(confirmation.buttons.rows.flat().some(button => /confirm [a-f0-9]+$/.test(button.command)));
  }
  assert.deepEqual(await store.conversation(scope), beforeCheckpoint);
  for (const who of [{ scope: 'c2c:other', admin: false, private: true }, { scope: groupScope, admin: true, private: false }]) {
    for (const command of ['/settings', '/settings toolMonitor on', `/group tool-monitor-on ${id}`, '/debug', '/groups', `/group view ${id}`]) {
      const rejected = await render(command, who); assert.equal(typeof rejected, 'string'); assert(!rejected.file);
    }
  }
  for (const command of ['/debug details', `/debug group ${id}`, `/group platform ${id}`, '/settings more', '/settings details on', '/settings progress on']) {
    const removed = await render(command); assert(!removed.file); validateControls(removed.buttons);
  }

  // The report uses cached metadata only, merges bounded scope-tagged events,
  // and never exports another private conversation or arbitrary event fields.
  for (let index = 0; index < 220; index++) controller.debug.record(scope, 'task_failed', {
    requestId: `fixture-${index}`, reason: 'FIXTURE_FAILURE', httpStatus: 503, rpcCode: -32000, agentCode: 'httpConnectionFailed',
  });
  const data = controller.debug.read(scope);
  data.events.push({ at: new Date().toISOString(), stage: 'private_metadata', count: 1, body: 'CHAT_BODY_SENTINEL', persona: 'PERSONA_SENTINEL' });
  controller.debug.record('c2c:other', 'task_failed', { reason: 'OTHER_PRIVATE_SENTINEL' });
  controller.debug.record(groupScope, 'qq_failed', { reason: 'QQ_REPLY_FAILED', traceId: 'fixture-trace' });
  controller.store.memories = async () => { throw new Error('VIDEO_BODY_READ_NOT_ALLOWED'); };
  const report = await diagnosticReport(controller, scope);
  assert(!report.file.text.includes('PLATFORM_ERROR_SENTINEL'));
  assert(report.file.text.includes('fixture-trace')); assert(report.file.text.includes('rpcCode'));
  assert(!/CHAT_BODY_SENTINEL|PERSONA_SENTINEL|OTHER_PRIVATE_SENTINEL|retained-thread|old-message/.test(report.file.text));
  const timeline = report.file.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert(timeline.length <= 160); assert(timeline.every(event => /^[a-f0-9]{32}$/.test(event.scope)));
  assert.equal(report.buttons.rows.flat().length, 1);
  assert.equal(report.buttons.rows[0][0].command, '/settings display');

  // Tool and progress hints share the administrator notifier, independent of
  // the normal reply target.
  const hints = []; const publications = [];
  const hintDelivery = new ChatDelivery({ transport: async (_target, { text }, { beforeCommit }) => {
    await beforeCommit(); publications.push(text); return {};
  }, diagnostics: new DeliveryDiagnostics(),
  onState() {}, assertCanContinue: async () => {}, notifyAdmins: async report => hints.push(report) });
  const hintResponse = new ChatResponse({ message: { kind: 'c2c', senderId: 'operator', requestId: 'monitor',
    replyTarget: { scope: 'c2c', targetId: 'operator', msgId: 'monitor-message' } },
    delivery: hintDelivery, debug: { record() {} }, onState() {} });
  const hintUpdates = new RequestUpdates({ toolMonitor: true }, value => hintDelivery.notifyAdmins({
    scope, requestId: 'monitor', reason: 'TASK_FEEDBACK', text: value.text, feedback: true, isActive: value.isActive }));
  hintUpdates.update({ kind: 'tool', name: 'get_webpage_subtitles' });
  hintUpdates.update({ kind: 'tool-result', name: 'get_webpage_subtitles', status: 'completed', elapsedMs: 200 });
  await hintUpdates.finish(); await hintResponse.send({ text: '任务完成' });
  assert.equal(hints.length, 3); assert(hints.every(report => report.reason === 'TASK_FEEDBACK'));
  assert.deepEqual(publications, ['任务完成']);

  // Settings keep their text and command rows at the common delivery boundary.
  const sends = [];
  const delivery = new ChatDelivery({ transport: async (_target, content, { beforeCommit }) => {
    await beforeCommit(); sends.push(content); return {};
  }, diagnostics: new DeliveryDiagnostics(), onState() {}, assertCanContinue: async () => {}, notifyAdmins: async () => {} });
  const response = new ChatResponse({ message: { kind: 'c2c', senderId: 'operator', requestId: 'menu' },
    delivery, debug: { record() {} }, onState() {} });
  await response.send(menus.get('/settings'));
  assert.equal(sends.length, 2); assert.equal(sends[0].text, menus.get('/settings').text);
  assert(!sends[0].buttons); assert.deepEqual(sends[1].buttons, menus.get('/settings').buttons);

  const notices = [];
  const notifier = new AdminNotifications(controller, { send: async (_scope, text, options) => { await options.beforeSend(); await options.beforeCommit(); notices.push(text); } });
  await notifier.send({ scope, requestId: 'failure', reason: 'CODEX_TURN_FAILED' });
  assert.equal(notices.length, 1); assert(!/CODEX|HTTP|Trace|任务编号/.test(notices[0]));
  assert(notices[0].includes('诊断报告'));
  assert.equal(inference, 0);
  console.log('Offline admin UI checks passed: navigation, scopes/permissions, unchanged settings, model pagination, confirmation, report privacy, text and abstract command rows.');
} finally {
  await controller?.close(); await rm(root, { recursive: true, force: true });
}

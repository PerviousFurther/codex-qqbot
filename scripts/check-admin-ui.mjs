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
import { commandKeyboard, QQ_MENU_ITEMS, syncQQMenu } from '../lib/qq-ui.mjs';
import { BilibiliLogin } from '../lib/bilibili-login.mjs';
import { QQDelivery } from '../lib/qq-delivery.mjs';
import { QQDiagnostics } from '../lib/qq-diagnostics.mjs';
import { QQResponse } from '../lib/qq-response.mjs';
import { RequestUpdates } from '../lib/request-updates.mjs';
import { AdminNotifications } from '../lib/admin-notifications.mjs';

const root = await mkdtemp(join(tmpdir(), 'watch-admin-ui-'));
const store = new Store(root); let controller;
try {
  let inference = 0, liveLookups = 0;
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
  controller.groupSettings.platform = { refresh: async value => { liveLookups++; return value; } };
  controller.bilibiliLogin = new BilibiliLogin(controller, {});
  controller.bilibiliLogin.begin = async () => ({ text: '登录二维码', media: { type: 'image', bytes: Buffer.from('fixture') } });
  controller.bilibiliLogin.check = async () => ({ done: true, text: 'B站已登录。' });
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
    '/memory', '/videos', '/stop', '/help', '/status', '/bilibili-login', '/bilibili-login check'];
  for (const command of pages) {
    const response = await render(command); menus.set(command, response);
    assert.equal(typeof response.text, 'string', command);
    assert(!/MCP|Codex|Agent RPC|Trace ID|o200k|程序拆分|发送预留|最小模型调用间隔|PLATFORM_ERROR_SENTINEL/.test(response.text), command);
    assert(response.buttons, command); commandKeyboard(response.buttons);
    for (const button of response.buttons.rows.flat()) {
      if (button.command.startsWith('/')) assert(controller.commands.routes.some(route => route.pattern.test(button.command)), `${command}: ${button.command}`);
      assert(!/^\/debug\s|^\/group (?:platform|refresh)\s|^\/settings more$/.test(button.command), command);
    }
  }
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
  for (let index = 0; index < 2; index++) monitor.update({ kind: 'tool', name: 'get_frames', arguments: 'PARAMETER_SENTINEL' });
  monitor.update({ kind: 'tool-result', name: 'get_frames', status: 'completed', elapsedMs: 1250, result: 'BODY_SENTINEL' });
  monitor.update({ kind: 'tool-result', name: 'get_frames', status: 'failed', elapsedMs: 30 });
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
  disabled.update({ kind: 'tool', name: 'get_frames' });
  disabled.update({ kind: 'tool-result', name: 'get_frames', status: 'completed', elapsedMs: 10 });
  await disabled.finish(); assert.equal(disabledSends, 0);

  // Every catalogue entry remains selectable, including at pagination boundaries;
  // return/previous/next buttons all count toward QQ's five-button model limit.
  for (let count = 0; count <= 25; count++) {
    const models = Array.from({ length: count }, (_, i) => ({ id: `model-${i}`, name: `模型 ${i}` }));
    const chosen = []; let page = 1;
    do {
      const result = modelMenu(models, 'model-0', page, { back: { label: '返回本群', command: `/group view ${id}` } });
      commandKeyboard(result.buttons);
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
  for (const command of ['/memory clear', `/group-memory ${id} clear`, '/videos clear']) {
    const confirmation = await render(command);
    assert(confirmation.text.includes('无法撤销')); commandKeyboard(confirmation.buttons);
    assert(confirmation.buttons.rows.flat().some(button => /confirm [a-f0-9]+$/.test(button.command)));
  }
  assert.deepEqual(await store.conversation(scope), beforeCheckpoint);
  for (const who of [{ scope: 'c2c:other', admin: false, private: true }, { scope: groupScope, admin: true, private: false }]) {
    for (const command of ['/settings', '/settings toolMonitor on', `/group tool-monitor-on ${id}`, '/debug', '/groups', `/group view ${id}`, '/bilibili-login']) {
      const rejected = await render(command, who); assert.equal(typeof rejected, 'string'); assert(!rejected.file);
    }
  }
  for (const command of ['/debug details', `/debug group ${id}`, `/group platform ${id}`, '/settings more', '/settings details on', '/settings progress on']) {
    const removed = await render(command); assert(!removed.file); commandKeyboard(removed.buttons);
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
  const lookupCount = liveLookups;
  controller.store.memories = async () => { throw new Error('VIDEO_BODY_READ_NOT_ALLOWED'); };
  const report = await diagnosticReport(controller, scope);
  assert(report.file.text.includes('PLATFORM_ERROR_SENTINEL'));
  assert(report.file.text.includes('fixture-trace')); assert(report.file.text.includes('rpcCode'));
  assert(!/CHAT_BODY_SENTINEL|PERSONA_SENTINEL|OTHER_PRIVATE_SENTINEL|retained-thread|old-message/.test(report.file.text));
  assert.equal(liveLookups, lookupCount);
  const timeline = report.file.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert(timeline.length <= 160); assert(timeline.every(event => /^[a-f0-9]{32}$/.test(event.scope)));
  assert.equal(report.buttons.rows.flat().length, 1);
  assert.equal(report.buttons.rows[0][0].command, '/settings display');

  // Tool and progress hints share the administrator notifier, independent of
  // the normal reply target and its passive quota.
  const hints = []; const publications = [];
  const hintDelivery = new QQDelivery({ bot: {
    sendText: async (_target, text) => { publications.push(text); return {}; },
  }, diagnostics: new QQDiagnostics('fixture-secret', () => {}), markdown: false,
  onState() {}, assertCanContinue: async () => {}, notifyAdmins: async report => hints.push(report) });
  const hintResponse = new QQResponse({ message: { kind: 'c2c', senderId: 'operator', requestId: 'monitor',
    replyTarget: { scope: 'c2c', targetId: 'operator', msgId: 'monitor-message' } },
    delivery: hintDelivery, debug: { record() {} }, onState() {} });
  const hintUpdates = new RequestUpdates({ toolMonitor: true }, value => hintDelivery.notifyAdmins({
    scope, requestId: 'monitor', reason: 'TASK_FEEDBACK', text: value.text, feedback: true, isActive: value.isActive }));
  hintUpdates.update({ kind: 'tool', name: 'get_subtitles' });
  hintUpdates.update({ kind: 'tool-result', name: 'get_subtitles', status: 'completed', elapsedMs: 200 });
  await hintUpdates.finish(); await hintResponse.send({ text: '任务完成' });
  assert.equal(hints.length, 3); assert(hints.every(report => report.reason === 'TASK_FEEDBACK'));
  assert.deepEqual(publications, ['任务完成']); assert.equal(hintResponse.passiveReplies, 1);

  // Settings are delivered as Markdown first and a separate command keyboard.
  const sends = [];
  const delivery = new QQDelivery({ bot: { sendMarkdown: async (target, text, options) => { sends.push({ text, options }); return {}; } },
    diagnostics: new QQDiagnostics('fixture-secret', () => {}), markdown: true, onState: () => {}, assertCanContinue: async () => {}, notifyAdmins: async () => {} });
  const response = new QQResponse({ message: { kind: 'c2c', senderId: 'operator', requestId: 'menu', replyTarget: { scope: 'c2c', targetId: 'operator', msgId: 'fixture-message' } },
    delivery, debug: { record: () => {} }, onState: () => {} });
  await response.send(menus.get('/settings'));
  assert.equal(sends.length, 2); assert.equal(sends[0].text, menus.get('/settings').text);
  assert(!sends[0].options?.keyboard); assert(sends[1].options.keyboard); assert(sends[1].text.trim());

  // QQ menu synchronization removes known old entries, preserves custom ones,
  // backs up once, and is idempotent when QQ adds default icons.
  let menu = { items: [{ name: '管理', type: 'menu', sub_menu_items: [] }, { name: '暂停', type: 'send_message', send_message: '/pause' },
    { name: '自定义入口', type: 'send_message', send_message: 'custom' }] }; let puts = 0;
  const api = { get: async () => ({ menu }), put: async (path, body) => { puts++; menu = body.menu; return {}; } };
  await syncQQMenu({ api }, store);
  assert.equal(puts, 1); assert(menu.items.some(item => item.name === '自定义入口'));
  assert(!menu.items.some(item => ['管理', '暂停', '状态', '浏览历史'].includes(item.name)));
  const backup = await store.read(join(root, 'qq-menu-backup.json'));
  menu.items = menu.items.map(item => ({ ...item, icon: 'platform-default' }));
  assert.equal(await syncQQMenu({ api }, store), 'menu_unchanged'); assert.equal(puts, 1);
  assert.deepEqual(await store.read(join(root, 'qq-menu-backup.json')), backup);
  assert(QQ_MENU_ITEMS.length <= 10);

  const notices = [];
  const notifier = new AdminNotifications(controller, { send: async (_scope, text, options) => { await options.beforeSend(); await options.beforeCommit(); notices.push(text); } });
  await notifier.send({ scope, requestId: 'failure', reason: 'CODEX_TURN_FAILED' });
  assert.equal(notices.length, 1); assert(!/CODEX|HTTP|Trace|任务编号/.test(notices[0]));
  assert(notices[0].includes('诊断报告'));
  assert.equal(inference, 0);
  console.log('Offline admin UI checks passed: navigation, scopes/permissions, unchanged settings, model pagination, confirmation, report privacy, Markdown/keyboards and QQ menu migration.');
} finally {
  await controller?.close(); await rm(root, { recursive: true, force: true });
}

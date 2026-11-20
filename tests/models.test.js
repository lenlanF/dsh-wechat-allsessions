import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogGroups, displayModel, findModel, modelListText, resolveModelSelection, sourceChannels } from '../lib/models.js';
import { parseRouteCommand, WECHAT_HELP } from '../lib/router.js';

const catalog = {
  groups: [
    { id: 'native-router', name: '聚合路由', models: [
      { id: 'direct:workbuddy:hy4-flash', name: 'WorkBuddy · Hy4 flash · x0.00' },
      { id: 'direct:loomy:model%2Fpro', name: 'Loomy · model/pro · x?' },
    ] },
    { id: 'deepseek-account', name: 'DeepSeek 账号', models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ] },
  ], failures: [{ id: 'expired', name: '已失效渠道', message: 'PRIVATE_ERROR' }],
};
test('models parser covers all required commands and optional page controls', () => {
  assert.deepEqual(parseRouteCommand('/models list'), { kind: 'models-list', page: 1 });
  assert.deepEqual(parseRouteCommand('/models list -c'), { kind: 'models-list', channelsOnly: true, page: 1 });
  assert.deepEqual(parseRouteCommand('/models list native-router'), { kind: 'models-list', channel: 'native-router', page: 1 });
  assert.deepEqual(parseRouteCommand('/models native-router direct:workbuddy:hy4-flash'),
    { kind: 'models-select', channel: 'native-router', model: 'direct:workbuddy:hy4-flash' });
  assert.deepEqual(parseRouteCommand('/models list native-router -p 3'),
    { kind: 'models-list', channel: 'native-router', page: 3 });
  assert.deepEqual(parseRouteCommand('/models list -c -p 2'),
    { kind: 'models-list', channelsOnly: true, page: 2 });
  for (const bad of ['/models', '/models list -c broken', '/models list -p 0', '/models list -p nope', '/models list -p 3 extra', '/models native-router', '/models list -z']) {
    assert.equal(parseRouteCommand(bad)?.kind, 'models-usage', bad);
  }
  assert.ok(WECHAT_HELP.includes('/models list -c'));
});
test('model list draws only current Host catalog, no fake prices or hidden failures', () => {
  const all = modelListText(catalog).text;
  assert.match(all, /聚合路由（native-router）/u);
  assert.match(all, /WorkBuddy · Hy4 flash/u);
  assert.match(all, /direct:workbuddy:hy4-flash/u);
  assert.match(all, /倍率 x0\.00/u);
  assert.doesNotMatch(all, /Loomy.*倍率 x0/u);
  assert.match(all, /deepseek-account/u);
  assert.doesNotMatch(all, /PRIVATE_ERROR/u);
  assert.equal(modelListText(catalog, { channel: 'native-router' }).text.includes('deepseek-v4-flash'), false);
  assert.match(modelListText(catalog, { channelsOnly: true }).text, /expired/u);
  assert.match(modelListText(catalog, { channel: 'expired' }).error, /读取失败/u);
  assert.match(modelListText(catalog, { channel: 'invalid' }).error, /没有可用渠道/u);
  assert.equal(findModel(catalog, 'native-router', 'direct:workbuddy:hy4-flash')?.id,
    'direct:workbuddy:hy4-flash');
  assert.equal(findModel(catalog, 'native-router', 'deepseek-v4-flash'), null);
  assert.ok(displayModel(catalogGroups(catalog)[0], catalogGroups(catalog)[0].models[1]).includes('x?'));
});
test('native-router source channel aliases resolve to the exact Host provider/model pair', () => {
  const sources = sourceChannels(catalogGroups(catalog));
  assert.deepEqual(sources.map(s => s.id), ['workbuddy', 'loomy']);
  const channels = modelListText(catalog, { channelsOnly: true }).text;
  assert.match(channels, /workbuddy/u);
  assert.match(channels, /loomy/u);
  const list = modelListText(catalog, { channel: 'workbuddy' }).text;
  assert.match(list, /Hy4 flash/u);
  assert.match(list, /ID: hy4-flash/u);
  assert.match(list, /倍率 x0\.00/u);
  assert.deepEqual(resolveModelSelection(catalog, 'workbuddy', 'hy4-flash'),
    { provider: 'native-router', model: 'direct:workbuddy:hy4-flash' });
  assert.deepEqual(resolveModelSelection(catalog, 'loomy', 'model/pro'),
    { provider: 'native-router', model: 'direct:loomy:model%2Fpro' });
  assert.equal(resolveModelSelection(catalog, 'workbuddy', 'not-a-model'), null);
  assert.deepEqual(resolveModelSelection(catalog, 'native-router', 'direct:workbuddy:hy4-flash'),
    { provider: 'native-router', model: 'direct:workbuddy:hy4-flash' });
});

test('model listing paginates with explicit next command; no silent truncation', () => {
  const large = { groups: [{ id: 'busy', name: 'Busy', models: Array.from({ length: 64 }, (_, i) => ({ id: 'id-' + i, name: 'Model ' + i })) }] };
  const first = modelListText(large);
  assert.match(first.text, /第 1\/3 页/u);
  assert.match(first.text, /下一页：\/models list -p 2/u);
  assert.doesNotMatch(first.text, /id-63/u);
  const next = modelListText(large, { channel: 'busy', page: 3 });
  assert.match(next.text, /第 3\/3 页/u);
  assert.match(next.text, /id-63/u);
  assert.doesNotMatch(next.text, /下一页：/u);
  assert.match(modelListText(large, { page: 4 }).error, /仅有 3 页/u);
});
test('malformed Host response is not silently treated as an invented catalog', () => {
  assert.throws(() => catalogGroups({}), /models-catalog-unavailable/);
  assert.deepEqual(catalogGroups({ groups: [null, { id: '\n', models: [] }, { id: 'ok', models: [{ id: '' }] }] }),
    [{ id: 'ok', name: 'ok', models: [] }]);
});

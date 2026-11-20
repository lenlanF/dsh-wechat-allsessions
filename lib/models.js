// Read-only projections of the Host's actual model catalog.
// Only DSH sessionController.selectModel() changes a Session's model route.
const PAGE_SIZE = 25;
function validId(value) {
  return typeof value === 'string' && value.trim().length > 0
    && value.length <= 256 && !/[\r\n\u0000-\u001f]/u.test(value);
}
function cleanName(value, fallback) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/[\r\n\u0000-\u001f]/gu, ' ').slice(0, 160)
    : fallback;
}
export function catalogGroups(catalog) {
  if (!Array.isArray(catalog?.groups)) throw new Error('models-catalog-unavailable');
  return catalog.groups.filter(group => validId(group?.id) && Array.isArray(group.models))
    .map(group => ({
      id: group.id, name: cleanName(group.name, group.id),
      models: group.models.filter(model => validId(model?.id))
        .map(model => ({ id: model.id, name: cleanName(model.name, model.id) })),
    }));
}
export function findModel(catalog, providerId, modelId) {
  const group = catalogGroups(catalog).find(row => row.id === providerId);
  return group?.models.find(row => row.id === modelId) ?? null;
}
// Native-router publishes source channels as direct:<sourceId>:<encodedModelId>
// under ONE Host provider. Expose source aliases without inventing new routes.
export function sourceChannels(groups) {
  const native = groups.find(g => g.id === 'native-router');
  if (!native) return [];
  const ids = new Set(groups.map(g => g.id));
  const sources = new Map();
  for (const model of native.models) {
    const m = /^direct:([a-z][a-z0-9_-]{0,63}):(.+)$/iu.exec(model.id);
    if (!m) continue;
    let modelId;
    try { modelId = decodeURIComponent(m[2]); }
    catch { continue; }
    if (!validId(modelId)) continue;
    const alias = ids.has(m[1]) ? 'native-router/' + m[1] : m[1];
    if (!sources.has(alias)) sources.set(alias, {
      id: alias, name: '聚合路由 / ' + m[1], models: [],
    });
    sources.get(alias).models.push({
      id: modelId, name: model.name, routeModelId: model.id,
    });
  }
  return [...sources.values()];
}
export function resolveModelSelection(catalog, channel, model) {
  const groups = catalogGroups(catalog);
  const exact = groups.find(g => g.id === channel);
  if (exact) return exact.models.some(item => item.id === model)
    ? { provider: channel, model } : null;
  const source = sourceChannels(groups).find(g => g.id === channel);
  const match = source?.models.find(item => item.id === model || item.routeModelId === model);
  return match ? { provider: 'native-router', model: match.routeModelId } : null;
}

// The native-router adapter advertises actual upstream x-multipliers in the
// model display label. Do not infer price from the model ID or fake a rate.
export function displayModel(group, model) {
  let name = model.name;
  let rate = '';
  if (group.id === 'native-router' || group.name.startsWith('聚合路由 / ')) {
    const match = /\s*·\s*x(\d+(?:\.\d+)?)\s*$/iu.exec(name);
    if (match) {
      rate = ' · 倍率 x' + match[1];
      name = name.slice(0, match.index).trim() || model.id;
    }
  }
  return name + (name === model.id ? '' : '（ID: ' + model.id + '）') + rate;
}
export function modelListText(catalog, { channel = null, channelsOnly = false, page = 1 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    return { error: '页码无效，请使用正整数。' };
  const groups = catalogGroups(catalog);
  const aliases = sourceChannels(groups);
  const failures = Array.isArray(catalog.failures)
    ? catalog.failures.filter(item => validId(item?.id)) : [];
  if (channelsOnly) {
    const all = [...groups.concat(aliases).map(g => ({ id: g.id, name: g.name, count: g.models.length, ok: true })),
      ...failures.filter(f => !groups.some(g => g.id === f.id))
        .map(f => ({ id: f.id, name: cleanName(f.name, f.id), count: 0, ok: false }))];
    if (!all.length) return { text: '当前没有已注册的模型渠道。' };
    const pages = Math.ceil(all.length / PAGE_SIZE);
    if (page > pages) return { error: '仅有 ' + pages + ' 页渠道。' };
    const lines = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      .map((g, i) => ((page - 1) * PAGE_SIZE + i + 1) + '. ' + g.name + '（' + g.id + '） · ' + (g.ok ? g.count + ' 个模型' : '模型目录不可用'));
    const next = page < pages ? '\n下一页：/models list -c -p ' + (page + 1) : '';
    return { text: 'DSH 模型渠道（' + all.length + ' 个，第 ' + page + '/' + pages + ' 页）：\n' + lines.join('\n') + next };
  }
  const selected = channel === null ? groups : groups.concat(aliases).filter(g => g.id === channel);
  if (channel !== null && !selected.length) {
    const failed = failures.some(f => f.id === channel);
    return { error: failed ? '渠道 ' + channel + ' 当前模型目录读取失败，请稍后重试。'
      : '没有可用渠道 ' + channel + '。发送 /models list -c 查看渠道 ID。' };
  }
  const rows = selected.flatMap(group => group.models.map(model => ({ group, model })));
  if (!rows.length) return { text: '当前没有可选择的模型；请检查 DSH 模型目录及渠道状态。' };
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  if (page > pages) return { error: '仅有 ' + pages + ' 页模型。' };
  const items = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const lines = items.map((item, i) => ((page - 1) * PAGE_SIZE + i + 1) + '. ' +
    item.group.name + '（' + item.group.id + '） / ' + displayModel(item.group, item.model));
  const suffix = channel ? ' ' + channel : '';
  const next = page < pages ? '\n下一页：/models list' + suffix + ' -p ' + (page + 1) : '';
  return { text: 'DSH 可选择模型（' + rows.length + ' 个，第 ' + page + '/' + pages + ' 页）：\n' +
    lines.join('\n') + next + '\n切换：/models <渠道ID> <模型ID>' };
}

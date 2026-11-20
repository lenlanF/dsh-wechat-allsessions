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
        .map(model => ({
          id: model.id, name: cleanName(model.name, model.id),
          // Official Host ModelCatalogModel carries provider-authored badges.
          // Some adapters (e.g. Lingxi) publish an x-rate here rather than
          // appending it to the model display name.
          ...(model.badge === undefined ? {} : { badge: model.badge }),
        })),
    }));
}
export function findModel(catalog, providerId, modelId) {
  const group = catalogGroups(catalog).find(row => row.id === providerId);
  return group?.models.find(row => row.id === modelId) ?? null;
}
// Only the Host's Provider IDs are channels. native-router is itself one
// Provider, and its direct:..., chain:..., autofree IDs stay inside it.
export function resolveModelSelection(catalog, provider, model) {
  return findModel(catalog, provider, model) ? { provider, model } : null;
}

function badgeText(badge) {
  const text = badge?.text;
  if (typeof text === 'string') return cleanName(text, '');
  if (!text || typeof text !== 'object' || Array.isArray(text)) return '';
  // DSH LocalizedText is either a string or a lowercase locale-keyed map.
  const localized = text['zh-cn'] ?? text['zh'] ?? text['en']
    ?? Object.values(text).find(value => typeof value === 'string');
  return cleanName(localized, '');
}
function rateFromText(text) {
  if (typeof text !== 'string') return null;
  // Only explicit stand-alone badge multipliers or labelled suffixes are
  // credit multipliers. Never confuse a model version like Spark-X2.6 with x2.6.
  const patterns = [
    /^\s*(?:倍率\s*[:：]?\s*)?[x×]\s*(\d+(?:\.\d+)?)\s*$/iu,
    /\s*[（(]\s*(?:倍率\s*[:：]?\s*)?[x×]\s*(\d+(?:\.\d+)?)\s*[）)]\s*$/iu,
    /\s*[·｜|]\s*(?:倍率\s*[:：]?\s*)?[x×]\s*(\d+(?:\.\d+)?)\s*$/iu,
    /\s+(?:倍率\s*[:：]?\s*)?[x×]\s*(\d+(?:\.\d+)?)\s*$/iu,
  ];
  for (const re of patterns) {
    const match = re.exec(text);
    if (match) return { value: match[1], start: match.index, end: match.index + match[0].length };
  }
  return null;
}
function withoutUnknownRate(name) {
  return name.replace(/\s*(?:[·｜|]\s*[x×]\s*\?|[（(]\s*[x×]\s*\?\s*[）)]|\s+[x×]\s*\?)\s*$/iu, '').trim();
}
export function displayModel(group, model) {
  const nameRate = rateFromText(model.name);
  const badge = badgeText(model.badge);
  const badgeRate = rateFromText(badge);
  const name = withoutUnknownRate(nameRate
    ? model.name.slice(0, nameRate.start).trim() || model.id
    : model.name) || model.id;
  // A badge is more authoritative than a potentially stale display-name suffix.
  const ratio = badgeRate?.value ?? nameRate?.value;
  if (ratio !== undefined) return name + ' · 倍率 x' + ratio;
  if (group.id === 'native-router' && model.id === 'autofree')
    return name + ' · 动态免费池（无固定倍率）';
  if (group.id === 'native-router' && model.id.startsWith('chain:'))
    return name + ' · 路由链（以实际执行渠道为准）';
  if (/^(?:免费|free)$/iu.test(badge)) return name + ' · 渠道标记：免费';
  return name; // Unknown rate is omitted, not shown as x? or guessed as free.
}
function paginate(rows, page) {
  if (!rows.length) return { rows: [], pages: 0 };
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), pages };
}
export function modelListText(catalog, { channel = null, channelsOnly = false, page = 1 } = {}) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    return { error: '页码无效，请使用正整数。' };
  const groups = catalogGroups(catalog);
  const failures = Array.isArray(catalog.failures)
    ? catalog.failures.filter(item => validId(item?.id)) : [];
  if (channelsOnly) {
    const all = [...groups.map(g => ({ id: g.id, name: g.name, count: g.models.length, ok: true })),
      ...failures.filter(f => !groups.some(g => g.id === f.id))
        .map(f => ({ id: f.id, name: cleanName(f.name, f.id), count: 0, ok: false }))];
    if (!all.length) return { text: '当前没有已注册的模型渠道。' };
    const { rows, pages } = paginate(all, page);
    if (page > pages) return { error: '仅有 ' + pages + ' 页渠道。' };
    const lines = rows.flatMap((g, i) => [
      ((page - 1) * PAGE_SIZE + i + 1) + '. ' + g.name + '（渠道ID：' + g.id + '）'
        + (g.ok ? ' · ' + g.count + ' 个模型' : ' · 模型目录不可用'),
      ...(g.ok ? ['/models list ' + g.id] : []),
    ]);
    const next = page < pages ? '\n下一页：/models list -c -p ' + (page + 1) : '';
    return { text: 'DSH 模型渠道（' + all.length + ' 个，第 ' + page + '/' + pages + ' 页）\n'
      + lines.join('\n') + next };
  }
  const selected = channel === null ? groups : groups.filter(g => g.id === channel);
  if (channel !== null && !selected.length) {
    const failed = failures.some(f => f.id === channel);
    return { error: failed ? '渠道 ' + channel + ' 当前模型目录读取失败，请稍后重试。'
      : '没有可用渠道 ' + channel + '。发送 /models list -c 查看渠道 ID。' };
  }
  const all = selected.flatMap(group => group.models.map(model => ({ group, model })));
  if (!all.length) return { text: '当前没有可选择的模型；请检查 DSH 模型目录及渠道状态。' };
  const { rows, pages } = paginate(all, page);
  if (page > pages) return { error: '仅有 ' + pages + ' 页模型。' };
  const lines = [];
  let lastProvider = '';
  rows.forEach(({ group, model }, i) => {
    if (group.id !== lastProvider) {
      lines.push('【' + group.name + ' · 渠道ID：' + group.id + '】');
      lastProvider = group.id;
    }
    lines.push(((page - 1) * PAGE_SIZE + i + 1) + '. ' + displayModel(group, model));
    // Full executable command is copyable as-is, even if model.name === model.id.
    lines.push('/models ' + group.id + ' ' + model.id);
  });
  const next = page < pages ? '\n下一页：/models list'
    + (channel ? ' ' + channel : '') + ' -p ' + (page + 1) : '';
  return { text: 'DSH 可选模型（共 ' + all.length + ' 个，第 ' + page + '/' + pages + ' 页）\n'
    + '每项下面的 /models 命令可直接复制发送。\n'
    + lines.join('\n') + next
    + '\n注：未显示倍率代表当前渠道未提供可靠倍率，并不等于免费。' };
}

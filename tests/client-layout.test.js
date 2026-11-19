import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const stateValues = () => {
  const rules = {
    enabled: true, broadcastAll: true, activeBotId: '', defaultUserId: '',
    maxChunkBytes: 1500, includeSessionHint: true, includeInternal: true,
    includeSubagents: true, sendLogLimit: 20,
  };
  const accounts = ['bot1','bot2','bot3'].map((botId, index) => ({
    botId, label: '微信账号 ' + (index + 1), maskedId: '…' + botId,
    active: index === 0, polling: index === 0,
  }));
  return [
    rules, rules,
    { connected: true, polling: true, version: '0.4.2', accountRoster: { savedCount: 3, activeCount: 1, accounts } },
    [], '', '', '', null, false, { kind: '', text: '' },
  ];
};

async function renderClient({ allowConfirm = true } = {}) {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const state = stateValues();
  let hookIndex = 0;
  let cardElement;
  const calls = [];
  const confirms = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
    useState(initial) { const index = hookIndex++; return [index < state.length ? state[index] : initial, () => {}]; },
    useEffect() {},
    useCallback(fn) { return fn; },
    useRef(value) { return { current: value }; },
  };
  const modules = [];
  const window = {
    __ModuleLoader__: { load(module) { modules.push(module); } },
    confirm(message) { confirms.push(message); return allowConfirm; },
  };
  const context = { window, console, setInterval() { return 0; }, clearInterval() {} };
  vm.runInNewContext(source, context, { filename: 'client.js' });
  assert.equal(modules.length, 1);
  const client = modules[0].factory(id => id === 'react' ? React : null);
  const slots = {
    inject(_slot, register) { register(); return () => {}; },
    register(_descriptor, render) { cardElement = render(); return () => {}; },
  };
  client.apply({ slots, effect() {} });
  assert.equal(typeof cardElement.type, 'function');
  const tree = cardElement.type({});
  const walk = (node, result = []) => {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) { node.forEach(child => walk(child, result)); return result; }
    result.push(node);
    for (const child of node.children || []) walk(child, result);
    return result;
  };
  const nodes = walk(tree);
  // The UI only fetches after click; no external requests are issued by rendering.
  // Stub fetch via the same client realm to verify a real button calls the endpoint.
  const apiFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/accounts/remove')) {
      return { ok: true, async json() { return { ok: true, removed: true, restartRequired: false }; } };
    }
    if (url.endsWith('/config')) {
      return { ok: true, async json() { return { ok: true, rules: state[0] }; } };
    }
    if (url.endsWith('/status')) {
      return { ok: true, async json() { return { ...state[2], ok: true }; } };
    }
    return { ok: true, async json() { return { ok: true, sessions: [] }; } };
  };
  context.fetch = apiFetch;
  return { nodes, calls, confirms, window };
}

test('WeChat settings statistics use responsive CSS grid with no forced minimum card width', async () => {
  const { nodes } = await renderClient();
  const grids = nodes.filter(n => n.props.style?.gridTemplateColumns?.includes('auto-fit'));
  assert.ok(grids.length, 'stats grid must be responsive');
  assert.ok(grids.some(n => n.props.style.gridTemplateColumns.includes('min(100%, 210px)')));
  assert.ok(grids.some(n => n.children.length === 4));
  assert.ok(nodes.some(n => n.props.style?.minWidth === 0 && n.props.style?.minHeight === 62));
});

test('each saved account has a remove button and compact wrapping account row', async () => {
  const { nodes } = await renderClient();
  const removeButtons = nodes.filter(n => n.type === 'button' && n.children.includes('移除'));
  assert.equal(removeButtons.length, 3);
  assert.ok(removeButtons.every(n => typeof n.props.onClick === 'function'));
  assert.ok(nodes.some(n => n.props.style?.flexWrap === 'wrap'
    && n.props.style?.borderRadius === 9 && n.props.style?.minWidth === 0));
});

test('remove button confirms intent and sends only the selected botId to the local API', async () => {
  const { nodes, calls, confirms } = await renderClient();
  const buttons = nodes.filter(n => n.type === 'button' && n.children.includes('移除'));
  buttons[1].props.onClick();
  await new Promise(resolve => setTimeout(resolve, 30));
  const posts = calls.filter(c => c.url.endsWith('/accounts/remove'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(posts[0].options.body), { botId: 'bot2' });
  assert.equal(confirms.length, 1);
  assert.ok(confirms[0].includes('不撤销其他插件共用的凭据'));
});

test('cancelling removal sends no mutation request', async () => {
  const { nodes, calls, confirms } = await renderClient({ allowConfirm: false });
  const remove = nodes.find(n => n.type === 'button' && n.children.includes('移除'));
  remove.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(confirms.length > 0);
  assert.equal(calls.filter(c => c.url.endsWith('/accounts/remove')).length, 0);
});

window.__ModuleLoader__.load({
  id: 'dsh-wechat-allsessions',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;
    const NS = 'dsh-wechat-allsessions';
    const BASE = '/plugins/' + NS;
    const DEFAULTS = {
      enabled: true, broadcastAll: true, defaultUserId: '', maxChunkBytes: 1500,
      includeSessionHint: true, includeInternal: true, includeSubagents: true,
      format: 'plain', sendLogLimit: 20,
    };
    const C = {
      accent: '#4c8dff', accentSoft: 'rgba(76,141,255,.12)', accentBorder: 'rgba(76,141,255,.38)',
      ok: '#2fa36b', okSoft: 'rgba(47,163,107,.14)', warn: '#d98b2b', warnSoft: 'rgba(217,139,43,.12)',
      danger: '#e05c58', border: 'rgba(128,128,128,.20)', borderStrong: 'rgba(128,128,128,.34)',
      surface: 'rgba(128,128,128,.055)', surface2: 'rgba(128,128,128,.10)', muted: 'rgba(128,128,128,.78)',
    };
    const s = {
      wrap: { padding: '22px 26px 26px', maxWidth: 980, fontSize: 13 },
      head: { display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 },
      badge: { width: 42, height: 42, borderRadius: 13, background: C.accentSoft, border: '1px solid ' + C.accentBorder, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      h1: { fontSize: 18, fontWeight: 700, margin: '0 0 6px', letterSpacing: '.2px' },
      sub: { fontSize: 12, lineHeight: 1.65, color: C.muted, margin: 0 },
      card: { border: '1px solid ' + C.border, borderRadius: 12, background: C.surface, padding: '16px 18px', marginBottom: 14 },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 },
      cardTitle: { fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 },
      step: { width: 20, height: 20, borderRadius: 6, background: C.accentSoft, color: C.accent, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
      hint: { fontSize: 11, lineHeight: 1.6, color: C.muted, margin: '8px 0 0' },
      row: { display: 'flex', alignItems: 'center', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 170 },
      label: { fontSize: 11, color: C.muted },
      input: { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid ' + C.borderStrong, background: 'transparent', color: 'inherit', borderRadius: 8, fontSize: 12, outline: 'none' },
      btn: { cursor: 'pointer', border: '1px solid ' + C.borderStrong, background: 'transparent', color: 'inherit', borderRadius: 8, padding: '6px 12px', fontSize: 11, transition: 'background .15s' },
      primary: { cursor: 'pointer', border: 'none', borderRadius: 9, padding: '9px 20px', fontSize: 13, fontWeight: 700, background: C.accent, color: '#fff', boxShadow: '0 4px 14px rgba(76,141,255,.26)' },
      tag: { fontSize: 10, padding: '2px 8px', borderRadius: 999, background: C.surface2, whiteSpace: 'nowrap' },
      tagOk: { fontSize: 10, padding: '2px 8px', borderRadius: 999, background: C.okSoft, color: C.ok, whiteSpace: 'nowrap' },
      tagWarn: { fontSize: 10, padding: '2px 8px', borderRadius: 999, background: C.warnSoft, color: C.warn, whiteSpace: 'nowrap' },
      mono: { fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 11 },
      notice: { fontSize: 11.5, lineHeight: 1.65, padding: '9px 12px', borderRadius: 8, marginTop: 10 },
      footer: { marginTop: 4, padding: '14px 0 4px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: '1px solid ' + C.border },
      stat: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px', borderRadius: 9, background: C.surface2, minWidth: 120, flex: 1 },
      statLabel: { fontSize: 10.5, color: C.muted },
      statValue: { fontSize: 14, fontWeight: 700 },
    };

    function Switch({ checked, onChange, label, hint, disabled }) {
      return h('label', { style: { ...s.row, cursor: disabled ? 'default' : 'pointer', justifyContent: 'space-between', padding: '7px 0', opacity: disabled ? .55 : 1 } },
        h('span', null,
          h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, label),
          hint ? h('div', { style: { ...s.hint, margin: '3px 0 0' } }, hint) : null),
        h('span', { style: { width: 40, height: 22, borderRadius: 999, background: checked ? C.accent : C.surface2, border: '1px solid ' + (checked ? C.accentBorder : C.borderStrong), position: 'relative', flexShrink: 0, transition: 'background .18s' } },
          h('span', { style: { position: 'absolute', top: 2, left: checked ? 20 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .18s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' } })),
        h('input', { type: 'checkbox', checked, disabled, onChange: (e) => onChange(e.target.checked), style: { display: 'none' } }));
    }

    function Field({ label, value, onChange, placeholder, type, min, mono, disabled }) {
      return h('div', { style: s.field },
        h('span', { style: s.label }, label),
        h('input', {
          style: { ...s.input, ...(mono ? s.mono : {}) }, value: value ?? '', placeholder,
          type: type || 'text', min, disabled,
          onFocus: (e) => { if (type === 'number') e.target.select(); },
          onChange: (e) => onChange(type === 'number' ? Number(e.target.value) : e.target.value),
        }));
    }

    function Card(props) {
      const [rules, setRules] = useState(null);
      const [saved, setSaved] = useState(null);
      const [status, setStatus] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [sessionBusy, setSessionBusy] = useState('');
      const [sessionFilter, setSessionFilter] = useState('');
      const [login, setLogin] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState({ kind: '', text: '' });
      const dirtyRef = useRef(false);
      const cancelledRef = useRef(false);
      useEffect(() => () => { cancelledRef.current = true; }, []);

      const normalize = useCallback((data) => ({ ...DEFAULTS, ...(data || {}) }), []);
      const load = useCallback(async () => {
        try {
          const res = await fetch(BASE + '/config');
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || 'config read failed');
          const next = normalize(data.rules);
          setRules(next); setSaved(next); dirtyRef.current = false;
        } catch (e) { setMessage({ kind: 'error', text: '读取配置失败：' + String(e.message || e) }); }
        try { setStatus(await (await fetch(BASE + '/status')).json()); } catch { setStatus(null); }
        try {
          const res = await fetch(BASE + '/sessions');
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || 'sessions read failed');
          setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        } catch (e) { setMessage({ kind: 'error', text: '获取会话失败：' + String(e.message || e) }); }
      }, [normalize]);

      useEffect(() => { void load(); }, [load]);

      // Refresh session switches without losing unsaved global settings.
      useEffect(() => {
        let active = true;
        const timer = setInterval(() => {
          void (async () => {
            try {
              const [sessionResponse, statusResponse] = await Promise.all([
                fetch(BASE + '/sessions'), fetch(BASE + '/status'),
              ]);
              const data = await sessionResponse.json();
              if (active && sessionResponse.ok && data.ok && Array.isArray(data.sessions)) setSessions(data.sessions);
              const nextStatus = await statusResponse.json();
              if (active && statusResponse.ok) setStatus(nextStatus);
            } catch { /* keep last known status */ }
          })();
        }, 15_000);
        return () => { active = false; clearInterval(timer); };
      }, []);

      const patch = (change) => {
        setRules((old) => ({ ...old, ...change }));
        dirtyRef.current = true;
        setMessage({ kind: '', text: '' });
      };

      const toggleBroadcast = async (sessionId, broadcastEnabled) => {
        if (sessionBusy) return;
        setSessionBusy(sessionId);
        try {
          const res = await fetch(BASE + '/sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, broadcastEnabled }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || '会话配置写入失败');
          setSessions(data.sessions);
          setMessage({ kind: 'ok', text: '会话广播设置已保存，微信端 /broadcast 命令也会实时同步' });
        } catch (error) { setMessage({ kind: 'error', text: String(error.message || error) }); }
        finally { setSessionBusy(''); }
      };

      const save = async () => {
        if (!rules || busy) return;
        setBusy(true);
        try {
          const res = await fetch(BASE + '/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rules),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || data.warning || 'save failed');
          const next = normalize(data.rules);
          setRules(next); setSaved(next); dirtyRef.current = false;
          if (data.restartRequired) setMessage({ kind: 'warn', text: '已保存。启用状态变更需完整重启 Host 才生效。' });
          else if (data.warning) setMessage({ kind: 'warn', text: '已生效，但持久化失败：' + data.warning });
          else setMessage({ kind: 'ok', text: '已保存并生效' });
          await load();
        } catch (e) { setMessage({ kind: 'error', text: '保存失败：' + String(e.message || e) }); }
        finally { setBusy(false); }
      };

      // Poll one QR attempt until it reaches a terminal status. The backend only
      // writes the account on 'confirmed', so without this loop a successful
      // scan would never be persisted.
      const pollAttempt = useCallback(async (qrcode) => {
        for (let i = 0; i < 100; i += 1) {
          if (cancelledRef.current) return;
          try {
            const res = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ qrcode }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'login poll failed');
            const status = data.status?.status;
            if (data.bound) {
              setMessage({ kind: 'ok', text: '✓ 已绑定微信账号 ' + data.bound.botId + (data.bound.connected ? '，桥接已连接' : '，但桥接未连上') });
              setLogin(null);
              await load();
              return;
            }
            if (status === 'confirmed') { setMessage({ kind: 'ok', text: '微信已确认，正在保存账号…' }); continue; }
            if (status === 'scaned' || status === 'scaned_but_redirect') { setMessage({ kind: 'warn', text: '已扫码，请在微信里确认登录。' }); continue; }
            if (status === 'expired') { setMessage({ kind: 'error', text: '二维码已过期，请重新获取。' }); setLogin(null); return; }
            if (status === 'need_verifycode' || status === 'verify_code_blocked') { setMessage({ kind: 'error', text: '需要短信验证码，请在微信端完成验证。' }); continue; }
            if (status === 'binded_redirect') { setMessage({ kind: 'warn', text: '该账号已绑定过，请用原账号或先在微信解绑。' }); setLogin(null); return; }
          } catch (e) {
            setMessage({ kind: 'error', text: '扫码状态读取失败：' + String(e.message || e) });
            return;
          }
        }
        setMessage({ kind: 'warn', text: '扫码等待超时，请重新获取二维码。' });
      }, [load]);

      const beginLogin = async () => {
        setBusy(true);
        try {
          const res = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'login failed');
          setLogin(data);
          setMessage({ kind: 'ok', text: '已获取扫码地址，请用微信扫码。' });
          cancelledRef.current = false;
          void pollAttempt(data.qrcode);
        } catch (e) { setMessage({ kind: 'error', text: '获取二维码失败：' + String(e.message || e) }); }
        finally { setBusy(false); }
      };

      if (!rules) return h('div', { style: s.wrap }, h('p', { style: s.hint }, '正在读取配置…'));
      const dirty = dirtyRef.current;
      const connected = status?.connected === true;
      const polling = status?.polling === true;

      return h('div', { style: s.wrap },
        h('div', { style: s.head },
          h('div', { style: s.badge }, h('span', { style: { fontSize: 19 } }, '💬')),
          h('div', { style: { flex: 1 } },
            h('h1', { style: s.h1 }, '微信助手'),
            h('p', { style: s.sub }, '自动绑定所有未归档 DSH 对话并广播最终消息，支持微信端选择回复会话和独立关闭广播。'),
            h('div', { style: { ...s.row, marginTop: 8, gap: 6 } },
              h('span', { style: rules.enabled ? s.tagOk : s.tagWarn }, rules.enabled ? '已启用' : '未启用'),
              h('span', { style: connected ? s.tagOk : s.tag }, connected ? '账号已加载' : '账号未连接'),
              h('span', { style: polling ? s.tagOk : s.tag }, polling ? '长轮询运行中' : '未轮询'),
              h('span', { style: s.tag }, '已绑定对话 ' + sessions.length + ' 条')))),

        h('div', { style: s.card },
          h('div', { style: s.cardHead }, h('div', { style: s.cardTitle }, h('span', { style: s.step }, '1'), '运行开关与微信收件人')),
          h(Switch, { checked: rules.enabled, onChange: (v) => patch({ enabled: v }), label: '启用微信助手', hint: '新安装默认启用；如改变运行状态，需重启 DSH Host。' }),
          h(Switch, { checked: rules.broadcastAll, onChange: (v) => patch({ broadcastAll: v }), label: '全局自动广播', hint: '默认开启，向绑定的微信账号广播所有未归档对话；下方还可逐个关闭。' }),
          h('div', { style: { ...s.row, marginTop: 10, alignItems: 'flex-end' } },
            h(Field, { label: '默认微信用户 ID（to_user_id）', value: rules.defaultUserId, mono: true, placeholder: '例如 xxxx@im.wechat', onChange: (v) => patch({ defaultUserId: v }) })),
          h('div', { style: { ...s.notice, background: C.warnSoft, color: C.warn } },
            '互斥提醒：同一微信账号只能有一个 getUpdates 消费者。启用前请确认 dsh-im 的微信通道已停用，否则消息会重复或丢失。')),
          connected && status?.broadcastReady === false
            ? h('div', { style: { ...s.notice, background: C.warnSoft, color: C.warn } },
              '微信令牌尚未就绪。请向微信助手发送 /help 以建立当前用户的微信会话。') : null,


        h('div', { style: s.card },
          h('div', { style: s.cardHead },
            h('div', { style: s.cardTitle }, h('span', { style: s.step }, '2'), '自动绑定的对话与广播开关'),
            h('span', { style: s.tagOk }, '默认全部开启 · 已排除归档')),
          h('p', { style: s.hint }, '在此调整单个对话。也可在微信发送 /broadcast on <会话ID> 或 /broadcast off <会话ID>。'),
          h(Field, { label: '搜索对话标题或 ID', value: sessionFilter, onChange: setSessionFilter, placeholder: '筛选已绑定对话…' }),
          h('div', { style: { maxHeight: 365, overflowY: 'auto', marginTop: 10 } },
            ...sessions.filter(item => !sessionFilter || (item.title + ' ' + item.sessionId).toLowerCase().includes(sessionFilter.toLowerCase()))
              .map(item => h('div', { key: item.sessionId, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '1px solid ' + C.border } },
                h('div', { style: { minWidth: 0, flex: 1 } },
                  h('div', { style: { fontWeight: 600, overflowWrap: 'anywhere' } }, item.title || '未命名对话'),
                  h('div', { style: { ...s.mono, color: C.muted, overflowWrap: 'anywhere' } }, item.sessionId)),
                h(Switch, { checked: item.broadcastEnabled !== false, onChange: value => void toggleBroadcast(item.sessionId, value),
                  disabled: Boolean(sessionBusy), label: item.broadcastEnabled !== false ? '广播中' : '已静音' })))),
          sessions.length === 0 ? h('p', { style: s.hint }, '暂未读取到对话，点击下方“刷新状态”重试。') : null),

        h('div', { style: s.card },
          h('div', { style: s.cardHead }, h('div', { style: s.cardTitle }, h('span', { style: s.step }, '2'), '分段与过滤')),
          h('div', { style: s.row },
            h(Field, { label: '每段最大字节（UTF-8 安全，不切码点）', value: rules.maxChunkBytes, type: 'number', min: 100, onChange: (v) => patch({ maxChunkBytes: v }) })),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 8, marginTop: 10 } },
            h(Switch, { checked: rules.includeSessionHint, onChange: (v) => patch({ includeSessionHint: v }), label: '附带续接命令', hint: '消息开头始终包含对话ID和标题；此开关控制末尾的 /session 提示。' }),
            h(Switch, { checked: rules.includeInternal, onChange: (v) => patch({ includeInternal: v }), label: '包含定时/内部回合', hint: '默认开启；微信自己发起的会话不会回环。' }),
            h(Switch, { checked: rules.includeSubagents, onChange: (v) => patch({ includeSubagents: v }), label: '包含子代理会话', hint: '默认开启，也可按具体会话单独关闭。' })),
          h('p', { style: s.hint }, '只广播新完成的回答，不回填旧消息；微信端发送 /help 查看完整命令。')),

        h('div', { style: s.card },
          h('div', { style: s.cardHead }, h('div', { style: s.cardTitle }, h('span', { style: s.step }, '3'), '连接状态与扫码')),
          h('div', { style: s.row },
            h('div', { style: s.stat }, h('span', { style: s.statLabel }, 'Bot ID'), h('span', { style: { ...s.statValue, ...s.mono } }, status?.botId || '—')),
            h('div', { style: s.stat }, h('span', { style: s.statLabel }, '已绑定对话'), h('span', { style: s.statValue }, String(sessions.length))),
            h('div', { style: s.stat }, h('span', { style: s.statLabel }, '轮询'), h('span', { style: { ...s.statValue, color: polling ? C.ok : C.muted } }, polling ? '运行中' : '停止'))),
          h('div', { style: { ...s.row, marginTop: 12 } },
            h('button', { style: { ...s.btn, opacity: busy ? .5 : 1, cursor: busy ? 'default' : 'pointer' }, disabled: busy, onClick: beginLogin }, '获取新扫码二维码'),
            h('button', { style: s.btn, disabled: busy, onClick: load }, '刷新状态')),
          login?.qrImage ? h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 } },
            h('img', { src: login.qrImage, alt: '微信扫码登录二维码', width: 240, height: 240,
              style: { borderRadius: 10, border: '1px solid ' + C.borderStrong, background: '#fff', padding: 6 } }),
            h('p', { style: { ...s.hint, margin: 0 } }, '用微信扫一扫上面的二维码完成绑定')) : null,
          login?.qrcodeUrl ? h('p', { style: { ...s.hint, wordBreak: 'break-all', opacity: .7 } }, '或复制链接：' + login.qrcodeUrl) : null,
          !rules.enabled ? h('p', { style: s.hint }, '可以先扫码绑定账号；绑定成功后再启用桥接开始推送。') : null),

        h('div', { style: s.footer },
          h('button', { style: { ...s.primary, opacity: !dirty || busy ? .5 : 1, cursor: !dirty || busy ? 'default' : 'pointer' }, disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : dirty ? '保存更改' : '已保存'),
          h('button', { style: s.btn, disabled: !dirty || busy, onClick: () => { setRules(saved); dirtyRef.current = false; setMessage({ kind: '', text: '' }); } }, '放弃更改'),
          message.text ? h('span', { style: { fontSize: 12, color: message.kind === 'error' ? C.danger : message.kind === 'warn' ? C.warn : C.ok } }, message.text) : null,
          dirty ? h('span', { style: { fontSize: 11, color: C.warn, marginLeft: 'auto' } }, '有未保存的更改') : null));
    }

    function apply(ctx) {
      const slots = ctx?.slots ?? ctx?.get?.('slots');
      if (!slots?.inject || !slots?.register) {
        console.warn('[' + NS + '] slots service unavailable; settings card skipped');
        return;
      }
      const dispose = slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: NS, order: 67, label: () => '微信助手', locale: NS }, () => h(Card)));
      ctx.effect?.(() => () => { try { dispose?.(); } catch {} }, NS + ' settings section');
    }
    const inject = ['slots', 'remote', 'remote.session'];
    apply.inject = inject;
    return { apply, name: NS, inject };
  },
});

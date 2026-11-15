// Standalone WeChat iLink transport.
// Protocol constants, endpoints and headers adapted from @xmanrui/dsh-im
// src/channels/weixin/weixin-api.mjs (MIT, Copyright (c) 2026 xmanrui).
import { randomBytes, randomUUID } from 'node:crypto';

export const QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const DEFAULT_API_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const PROTOCOL_VERSION = '2.4.6';
export const BOT_TYPE = '3';
const APP_ID = 'bot';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const LONG_POLL_TIMEOUT_MS = 35_000;
const LOGIN_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode', 'verify_code_blocked', 'binded_redirect']);

export class WeixinTransportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'WeixinTransportError';
    this.code = code;
    this.status = options.status;
  }
}

const nonEmpty = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const isWeixinHost = (host) => host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
  || host === 'wechat.com' || host.endsWith('.wechat.com');

export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value || DEFAULT_API_BASE_URL); }
  catch { throw new WeixinTransportError('invalid-base-url', 'invalid WeChat base URL'); }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port && url.port !== '443')) {
    throw new WeixinTransportError('untrusted-base-url', 'untrusted WeChat base URL');
  }
  url.username = ''; url.password = ''; url.search = ''; url.hash = ''; url.pathname = '/';
  return url.toString();
}

function headers(token, authenticated = true) {
  const base = { 'iLink-App-Id': APP_ID, 'iLink-App-ClientVersion': String(CLIENT_VERSION) };
  if (!authenticated) return base;
  return {
    ...base,
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    ...(nonEmpty(token) ? { Authorization: 'Bearer ' + token.trim() } : {}),
  };
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' };
}

export function rejectedProviderResponse(response, keys = ['ret', 'errcode']) {
  if (!response || typeof response !== 'object') return undefined;
  for (const key of keys) {
    const raw = response[key];
    if (raw === undefined || raw === null || raw === 0 || raw === '0') continue;
    const text = String(raw).trim();
    if (/^-?[A-Za-z0-9_.:-]{1,160}$/u.test(text)) return text;
  }
  return undefined;
}

function qrUrl(value) {
  const text = nonEmpty(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && isWeixinHost(url.hostname)) return url.toString();
  } catch { /* invalid */ }
  return undefined;
}

async function requestJson(fetchImpl, { method, baseUrl, endpoint, body, token, timeoutMs = DEFAULT_TIMEOUT_MS, signal, authenticated = true }) {
  const url = new URL(endpoint, normalizeBaseUrl(baseUrl));
  if (!isWeixinHost(url.hostname)) throw new WeixinTransportError('untrusted-endpoint', 'untrusted endpoint');
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: headers(token, authenticated),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new WeixinTransportError('http-error', 'WeChat HTTP ' + response.status, { status: response.status });
    return await response.json();
  } catch (error) {
    if (error instanceof WeixinTransportError) throw error;
    if (signal?.aborted) throw signal.reason;
    if (timedOut) throw new WeixinTransportError('timeout', 'WeChat request timed out', { cause: error });
    throw new WeixinTransportError('network-error', error?.message ?? 'WeChat request failed', { cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function extractWeixinText(message) {
  for (const item of message?.item_list ?? []) {
    if (item?.type === 1 && typeof item.text_item?.text === 'string' && item.text_item.text.trim()) return item.text_item.text.trim();
    if (item?.type === 3 && typeof item.voice_item?.text === 'string' && item.voice_item.text.trim()) return item.voice_item.text.trim();
  }
  return null;
}

export function createWeixinTransport({ fetchImpl = fetch, baseUrl = DEFAULT_API_BASE_URL } = {}) {
  const request = (options) => requestJson(fetchImpl, { baseUrl, ...options });
  const rejection = (response, code) => {
    const providerCode = rejectedProviderResponse(response);
    if (providerCode) throw new WeixinTransportError(String(providerCode) === '-14' ? 'stale-token' : code, 'WeChat rejected request', { status: providerCode });
  };
  return Object.freeze({
    async beginLogin({ signal, baseUrl: callBaseUrl } = {}) {
      const response = await request({ baseUrl: callBaseUrl, method: 'POST', endpoint: 'ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(BOT_TYPE), body: { local_token_list: [] }, timeoutMs: 10_000, signal });
      rejection(response, 'qr-request-rejected');
      const qrcode = nonEmpty(response?.qrcode);
      if (!qrcode) throw new WeixinTransportError('invalid-qr', 'WeChat returned no QR code');
      return { qrcode, qrcodeUrl: qrUrl(response.qrcode_img_content) };
    },
    async pollLogin({ qrcode, verifyCode, signal, baseUrl: callBaseUrl } = {}) {
      const qr = nonEmpty(qrcode);
      if (!qr) throw new TypeError('qrcode is required');
      let endpoint = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qr);
      if (nonEmpty(verifyCode)) endpoint += '&verify_code=' + encodeURIComponent(verifyCode.trim());
      const value = await request({ baseUrl: callBaseUrl, method: 'GET', endpoint, timeoutMs: LONG_POLL_TIMEOUT_MS, signal, authenticated: false });
      if (!value || typeof value !== 'object' || !LOGIN_STATUSES.has(value.status)) throw new WeixinTransportError('invalid-login-status', 'unknown login status');
      return value;
    },
    async getUpdates({ token, getUpdatesBuf = '', signal, baseUrl: callBaseUrl } = {}) {
      try {
        const response = await request({ baseUrl: callBaseUrl, method: 'POST', endpoint: 'ilink/bot/getupdates', body: { get_updates_buf: getUpdatesBuf, base_info: baseInfo() }, token, timeoutMs: LONG_POLL_TIMEOUT_MS, signal });
        rejection(response, 'updates-rejected');
        return response;
      } catch (error) {
        if (error.code === 'timeout') return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
        throw error;
      }
    },
    async notifyStart({ token, signal, baseUrl: callBaseUrl } = {}) {
      const response = await request({ baseUrl: callBaseUrl, method: 'POST', endpoint: 'ilink/bot/msg/notifystart', token, signal, timeoutMs: 10_000, body: { base_info: baseInfo() } });
      rejection(response, 'start-rejected');
      return response;
    },
    async notifyStop({ token, signal, baseUrl: callBaseUrl } = {}) {
      const response = await request({ baseUrl: callBaseUrl, method: 'POST', endpoint: 'ilink/bot/msg/notifystop', token, signal, timeoutMs: 10_000, body: { base_info: baseInfo() } });
      rejection(response, 'stop-rejected');
      return response;
    },
    async sendText({ token, toUserId, text, contextToken, signal, baseUrl: callBaseUrl } = {}) {
      const recipient = nonEmpty(toUserId);
      const content = nonEmpty(text);
      if (!recipient || !content) throw new TypeError('toUserId and text are required');
      const clientId = 'dsh-weixin-' + randomUUID();
      const call = () => request({
        baseUrl: callBaseUrl, method: 'POST', endpoint: 'ilink/bot/sendmessage', token, signal,
        body: { msg: {
          from_user_id: '', to_user_id: recipient, client_id: clientId,
          message_type: 2, message_state: 2,
          item_list: [{ type: 1, text_item: { text: content } }],
          ...(nonEmpty(contextToken) ? { context_token: contextToken.trim() } : {}),
        }, base_info: baseInfo() },
      });
      let response;
      for (let attempt = 0; ; attempt += 1) {
        try { response = await call(); break; }
        catch (error) {
          const delay = [400, 1200][attempt];
          if (delay === undefined || error.code !== 'network-error' || signal?.aborted) throw error;
          await new Promise(r => setTimeout(r, delay));
        }
      }
      rejection(response, 'send-rejected');
      return { sent: true, clientId };
    },
  });
}

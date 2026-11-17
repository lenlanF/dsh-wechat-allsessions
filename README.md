# dsh-wechat-allsessions

## v0.2.0 — 微信会话边界与可靠性修复（2026-11-17）

- 只有绑定账号的 `ownerUserId` 或管理员显式指定的 `defaultUserId` 可发送桥接命令；陌生用户无法列出或绑定任意 DSH 会话；非所有者只能查看和使用自己的路由。
- 老账号若缺失 `ownerUserId` 且 `defaultUserId` 留空，会安全拒绝入站命令。可在本插件重新扫码写入所有者，或明确配置受信任用户。
- `enabled` 状态先持久化再更新运行内存；禁用扫码不启动消费轮询；重新绑定会创建新 AbortSignal；停止先取消长轮询。
- 确认扫码接口不回传 `bot_token` 或本地配置路径；新增登录跨站来源拦截。
- 失败消息不再提前推进 `getUpdatesBuf` 或写入去重标记；重试保留稳定 requestId，但是否达到端到端恰好一次投递仍取决于 DSH 宿主的去重行为。
- 文件损坏时安全报错而非清空游标；未设置默认收件人时可回退到绑定的微信账号所有者。
- 仍须避免 dsh-im 与此插件同时消费同一个微信账号。离线 47/47 通过；尚未做真实微信 iLink 端到端复测。


独立的微信 iLink 桥接插件：把 DSH Host 中**任意工作区、任意 Session 的最终回答**推送到微信，并把微信里的回复续接回**最后一次广播的那个 Session**。

- 安装与排障：[docs/INSTALL.md](docs/INSTALL.md)
- 中文为主；命令、字段名、路径与返回码保持源码原样。

> **必须先读：本插件与 `@xmanrui/dsh-im` 的微信通道互斥。** 启用本插件之前，必须停用 dsh-im 的微信通道（或停用整个 dsh-im bundle），否则同一个微信账号上会有两个 `getUpdates` 消费者争抢 `getUpdatesBuf` 游标，消息可能重复、丢失或串序。详见「与 dsh-im 的关系」。

## 它是什么、不是什么

| 项 | 说明 | 源码 |
| --- | --- | --- |
| 运行时不依赖 dsh-im | 插件只 `import` 自己的 `lib/transport.js`、`router.js`、`text.js`、`events.js`；`inject` 为 `['settings','webServer','sessions','sessionController','credentials']`，其中 `credentials`、`sessionController` 等是 Host 服务。`package.json` 没有 `dependencies`，`peerDependencies` 只有 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，没有 `@xmanrui/dsh-im`。 | `lib/index.js:3,12-15,31`；`package.json:43-46` |
| 复用现有账号 | 插件可读取原有微信 iLink 账号与 Host 凭据；也支持在插件内重新扫码创建账号。旧账号若缺少 `ownerUserId` 且未配置 `defaultUserId`，出于安全原因不会接受微信入站命令。 | `lib/index.js` |
| 复用状态目录，但不改 dsh-im 的状态文件 | 本插件把游标、去重与上下文令牌写在同账号目录下**自己的** `allsessions-state.json`（`<statePath>/<botId>/allsessions-state.json`），不写 `state.json`。 | `lib/index.js:107-114,143-149,310-311` |
| 上下文令牌按用户隔离 | `contextTokenFor(userId)` 只读**该用户**的 `contextTokens.users[userId].token`，或扁平/旧版 `contextTokens[userId].token` / `.contextToken`；**没有全局 `lastContextToken` 回退**，令牌绝不在用户之间共享。入站 `context_token` 按 `from_user_id` 存进 `contextTokens.users`。 | `lib/index.js:214-219,238-245` |
| 新账号扫码入口 | 即使 `enabled: false`，本机 `/login` 也允许获取和轮询二维码；确认成功时将 token 写入 Host 凭据服务、账号写入配置文件，但禁用状态不会启动长轮询。 | `lib/index.js` |

它**不是** dsh-im 的转发层，也不调用 `dshIm.send`；发送和接收都由插件自己的 `lib/transport.js` 直接请求 iLink 接口（`lib/index.js:173,194-198,278`）。

## 与 dsh-im 的关系：零停机复用 + 严格互斥

**复用的是数据，不是进程。** `~/.dsh/integrations/dsh-weixin/config.json`、其中的 `tokenRef` 指向的凭据、以及 `~/.dsh/integrations/dsh-weixin/accounts/<botId>/` 目录由 dsh-im 先前写入；本插件只读账号配置与凭据，另写自己的状态文件。因此停用 dsh-im 的微信通道时**不要删除这些文件**，即可保持账号不中断。

**为什么必须互斥：** 两个消费者都用同一个账号 token 调用 `ilink/bot/getupdates`：

- 本插件 `pollLoop()` 用 `bridgeState.getUpdatesBuf` 请求，并把服务端返回的 `get_updates_buf` 存进 `allsessions-state.json`（`lib/index.js:278,285-288`；`lib/transport.js:137-146`）。
- dsh-im 的 `weixin-runtime.mjs` 也用 `this.#state.getUpdatesBuf()` 请求，并把返回游标写进自己的 `state.json`（`state-store.mjs:13,107,201-207`；`weixin-runtime.mjs:257-262,288-289`）。

两份游标彼此独立，但对应同一个账号；两条长轮询会同时取走同一批 `msgs`，各自回复、各自去重，结果就是重复回答、重复消费或某一侧收不到消息。设置界面也明确写出这条要求（`lib/client.js:55`）。正确做法见 [docs/INSTALL.md](docs/INSTALL.md#1-停用-dsh-im-的微信通道必须步骤)：先停用 dsh-im 的微信通道，再启用本插件，中间完整重启 Host。

## 配置字段（全部 13 项及默认值）

配置来自 `Config`（`lib/index.js:33-46`）、`DEFAULT_RULES`（`lib/index.js:48-53`）与 `normalizeRules()`（`lib/index.js:60-77`）；示例见 `config.example.yml:4-16`。所有字段都是 `volatile()`，Host 传入的包装值先由 `unwrapVolatile()` 解包（`lib/index.js:55-58,162`）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关。`enabled !== true` 时事件引擎忽略事件（`lib/events.js:107,129`）；`apply()` 仅在它为 `true` 时调用 `start()`（`lib/index.js:417`）。**运行期改它不会启动/停止桥接**，见「本机回环接口」。 |
| `broadcastAll` | `false` | 广播门闩：`shouldSkip = !broadcastAll && !defaultUserId`（`lib/index.js:205`）。**只要填了 `defaultUserId`，即使 `broadcastAll` 仍为 `false` 也放行广播**；两者都关闭/为空才全部跳过。`enabled` 仍须为 `true`。 |
| `defaultUserId` | `''` | 广播收件人的 `to_user_id`。发送时优先用它，其次 `context.userId` / `context.senderId`；为空则 `no-user-id`（`lib/index.js:188-189`）。最长 256 字符（`lib/index.js:67`）。 |
| `maxChunkBytes` | `1500` | 每段文本的 UTF-8 字节上限；`Config` 要求 `>= 100`，归一化上限 `8000`，非法值回落 `1500`（`lib/index.js:37,68`）。 |
| `routeStorePath` | `''` | 覆盖路由文件路径；留空用默认路径（下表）。最长 4096 字符（`lib/index.js:62,69`）。 |
| `accountConfigPath` | `''` | 覆盖账号 `config.json` 路径；留空用默认路径（`lib/index.js:110`）。 |
| `statePath` | `''` | 覆盖**账号状态根目录**（不是单个文件）；最终状态文件为 `<statePath>/<botId>/allsessions-state.json`（`lib/index.js:111,310`）。 |
| `includeSessionHint` | `true` | 广播正文前附加标题 / 工作区 / Session，末尾附加 `继续对话: /session <Session ID>`；`false` 时只发正文（`lib/text.js:39-47`；`lib/index.js:177-180`）。 |
| `includeInternal` | `false` | 是否放行 `internal` 来源（notice、schedule、user-question-reply 等，`lib/events.js:8-13,108-109`）。注意：`im` 来源的回答文本根本不累积，打开此项也不会让微信自己发起的回合回环广播（`lib/events.js:78`）。 |
| `includeSubagents` | `false` | 是否放行子代理 Session（`lib/index.js:158`；`lib/events.js:112`）。 |
| `format` | `plain` | 取值 `plain` / `markdown`，其他值归一化为 `plain`（`lib/index.js:44,75`）。当前 `sendText` 恒发 `type: 1` 纯文本项，**字段本身不改变发送格式**（`lib/transport.js:164-169`）。 |
| `sendLogLimit` | `20` | 内存中保留的最近发送记录条数；`>= 1`，归一化上限 `200`，非法值回落 `20`（`lib/index.js:45,76,203`）。 |

`routeStorePath` / `accountConfigPath` / `statePath` 只影响本机文件位置，不影响微信协议行为。`GET /config` 返回归一化后的 `rules` 与 `sendLog`；`POST /config` 只接受 `DEFAULT_RULES` 中存在的字段（`lib/index.js:353-354`）。

## 默认路径（`~/.dsh/integrations`）

`homePaths()` 以 `DSH_HOME` 为根，未设置时为 `~/.dsh`（`lib/index.js:107-114`）：

| 用途 | 默认路径 |
| --- | --- |
| 账号配置（读 dsh-im 留下的文件） | `~/.dsh/integrations/dsh-weixin/config.json` |
| 状态根目录 | `~/.dsh/integrations/dsh-weixin/accounts`，状态文件为 `~/.dsh/integrations/dsh-weixin/accounts/<botId>/allsessions-state.json` |
| 会话路由 | `~/.dsh/integrations/dsh-wechat-allsessions/sessions.json` |

`DSH_HOME` 默认是当前用户的 `~/.dsh`；账号配置至少含 `botId`、`tokenRef`，新版扫码还写入 `ownerUserId`。插件自己的 `allsessions-state.json` 与 dsh-im 的状态文件互相独立。

## 找到 `defaultUserId`（`to_user_id`）

`defaultUserId` 就是出站消息里的 `to_user_id`（`lib/transport.js:165`），也是入站消息的 `from_user_id`（`lib/index.js:230`），常见形态类似 `xxxx@im.wechat`。取值途径：

1. **dsh-im 账号配置**：`~/.dsh/integrations/dsh-weixin/config.json` 的 `accounts[0].ownerUserId` 是绑定者 ID（`config-store.mjs:43-48,62-64`）。
2. **dsh-im 状态文件**：`~/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json` 里 `contextTokens.users` 的键、`recentOutboundMessages[].toUserId`（`state-store.mjs:37-49,64-77`）；`sessions` 的键形如 `p2p:<userId>`，去掉前缀即为 userId（`weixin-bridge.mjs:123-125`）。
3. **本插件的入站消息**：启用后先给机器人发一条文字，`handleInbound()` 会把 `context_token` 按 `from_user_id` 记到 `allsessions-state.json` 的 `contextTokens.users` 键上（`lib/index.js:230,238-245`）；读该键即可。本插件读的是**自己的** `allsessions-state.json`，不是 dsh-im 的 `state.json`（`lib/index.js:131-142,310-311`）。把 dsh-im 的嵌套 `contextTokens` 结构放进本插件状态文件也能被 `contextTokenFor()` 识别（`lib/index.js:214-219`）。`/status` 的 `routes` 也带 `userId`，但只有发生过广播才会写入路由（`lib/index.js:190,367`）。
4. **会话列表**：`GET /plugins/dsh-wechat-allsessions/sessions` 给出 `sessionId / title / cwd / isSubagent`，用于 `/session <ID>` 绑定，不是 `defaultUserId`。

填错时不会报错停机，只会把消息发给错误的人或返回 `no-user-id`（`lib/index.js:188-189`），请先用 `GET /config` 核对。

## 会话路由与微信命令

- **自动路由（最后一次广播生效）**：每次广播发送前，`send()` 把 `defaultUserId -> context.sessionId` 连同 `title`、`cwd`、`updatedAt` 持久化到 `sessions.json`（`lib/index.js:190`；`lib/router.js:51-62`）。之后该用户在微信里发的普通文字会回到这个 Session（`lib/index.js:263-268`）。**每次新广播都会覆盖该用户的路由**，因此「最后一次广播的会话」就是回复目标。
- **提交给 Host 的签名**：使用 `sessionController.prompt(request, abort.signal)`，绝不把配置或 source 对象误当作信号。若微信消息含 `message_id`，`requestId` 根据账号、用户和消息 ID 稳定生成；否则随机生成。可靠投递按至少一次设计，宿主能否严格去重仍需真实验收。
- 命令由 `parseRouteCommand()` 解析，大小写不敏感、要求整条消息匹配（`lib/router.js:77-84`）：

| 命令 | 行为 | 源码 |
| --- | --- | --- |
| `/session <ID>` | 只有绑定账号所有者可以把自己指向任意指定 Session；其它明确授权的微信用户仅能继续绑定自己的现有路由。 | `lib/index.js` |
| `/list`（别名 `/sessions`） | 账号所有者可列出已保存的所有路由；其它受信任用户只能查询自己的路由；陌生发送者不会收到会话资料。 | `lib/index.js` |
| `/new`（别名 `/clear`） | **清除该用户的路由**（不是新建 DSH Session），回复 `已清除当前会话路由`。之后再发普通消息会收到「还没有绑定会话」提示，直到下一次广播或手动绑定。 | `lib/router.js:82`；`lib/index.js:253-256,264-266` |

Session ID 可以从广播消息末尾的 `继续对话: /session <Session ID>` 或 `GET /sessions` 取得。未绑定时普通消息只收到提示文本，不会创建或提交任何任务（`lib/index.js:263-266`）。

## 广播内容、分段与截断

- **先发一条微信消息**：广播 `send()` 在缺少该用户的 `context_token` 时直接返回 `{ sent: false, reason: 'no-context-token' }`，不调用 `sendText`（`lib/index.js:187-192`）。原因是令牌只按用户保存、绝不共享（`lib/index.js:214-219`）。所以启用后请**先用目标微信账号给机器人发一条文字**，让 `handleInbound()` 写入该用户的 `context_token`（`lib/index.js:238-245`），随后才有广播。命令回复 `reply()` 会带上 `contextTokenFor(userId)`（`lib/index.js:221-227`），transport 仅在非空时附加 `msg.context_token`（`lib/transport.js:168`）。
- 消息体来自 `buildBroadcastMessage()`：正文超过 `4000` 字符时先裁到 4000 并追加 `\n…（已截断）`，随后（`includeSessionHint: true` 时）加上标题、`工作区: <cwd>`、`Session: <id>` 与续接提示（`lib/text.js:39-47`；`lib/index.js:177-180`）。
- `chunkUtf8Text()` 按 **Unicode code point** 逐字累加 `Buffer.byteLength`，不会把一个字符的 UTF-8 字节拆到两段；若单个 code point 本身就超过 `maxChunkBytes`，宁可整段超限也要保留完整字符（`lib/text.js:3-25`；`tests/text.test.js:5-13`）。
- `planDelivery(text, { maxBytes: maxChunkBytes, maxChunks: 20 })` 最多发送 **20 段**，超出部分直接丢弃，`truncated: true` 记入发送结果/日志（`lib/index.js:192,201,223`；`lib/text.js:27-36`；`tests/text.test.js:15-19`）。`continuation = '（续）'` 只是返回值字段，**不会自动拼进消息文本**；20 段截断本身也没有另行在微信里追加提示（`lib/text.js:27,35`）。正文 4000 字符截断的 `…（已截断）` 是唯一的文本内截断标记（`lib/text.js:41`）。
- 任一段 `sendText` 返回 `{ sent: false }` 就停止后续段；异常由 `events.js` 捕获并写 `sendLog`，不会变成未处理的 Promise 拒绝（`lib/index.js:193-200`；`lib/events.js:115-122,139-140`）。`sendText` 自身只对 `network-error` 重试最多两次（400ms / 1200ms），且**复用同一个 `clientId`**（`lib/transport.js:161,171-179`）。

## 本机回环接口

`webServer.register` 存在时注册四条回环接口，前缀为 `/plugins/dsh-wechat-allsessions`。只接受本机连接，`POST /config` 和 `POST /login` 均拒绝不可信的跨站 Origin；请求体限制为 1 MiB。新版 `/login` 确认响应不会返回 `bot_token`。

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/plugins/dsh-wechat-allsessions/config` | GET | `{ ok: true, rules, sendLog }`；非回环 `403 loopback only`（`lib/index.js:344-346`）。 |
| `/plugins/dsh-wechat-allsessions/config` | POST | 只接受 `DEFAULT_RULES` 中的字段，立即更新运行规则并尝试持久化到 settings；持久化失败仍返回 `ok: true` 但带 `warning`。无效体/无已知字段 `400`，非本机 `Origin` `403`，其他方法 `405`（`lib/index.js:347-363`）。**POST 永不改变桥接生命周期**：若本次改动了 `enabled`，直接返回 `{ ok: true, rules, restartRequired: true, warning: 'enabled changed; restart Host to start or stop the WeChat bridge' }`，既不调用 `start()` / `stop()`，也不写 settings（`lib/index.js:355-359`）。 |
| `/plugins/dsh-wechat-allsessions/status` | GET | `{ ok, connected, botId, polling, routes, sendLog }`；非回环或非 GET `405`（`lib/index.js:365-368`）。 |
| `/plugins/dsh-wechat-allsessions/sessions` | GET | `{ ok, sessions: [{ sessionId, title, cwd, isSubagent }] }`；非回环或非 GET `405`（`lib/index.js:369-374`）。 |
| `/plugins/dsh-wechat-allsessions/login` | POST | **`enabled: false` 时返回 `403` `{error:'enable the plugin before requesting a QR login'}`**，不会请求 iLink（`lib/index.js:377`）。启用后：空体 `{}` → `{ ok, qrcode, qrcodeUrl, qrBaseUrl }`；带 `{"qrcode":"...","verifyCode":"..."}` → `{ ok, status }`。非回环或非 POST `405`，请求异常 `500`（`lib/index.js:375-387`）。 |

`settings/document-updated` 事件会用最新的 volatile 配置刷新运行规则，但检测到 `enabled` 变化时只写警告 `enabled changed in Host settings; restart Host to apply bridge lifecycle`，不启动/停止桥接（`lib/index.js:322-332`）；`refresh()` 同理只更新规则（`lib/index.js:409`）。**因此把 `enabled: true` 写进 `cordis.patch.yml` 并完整重启 Host**，再用 `GET /status` 确认 `connected: true` 与 `polling: true`（`lib/index.js:417,306-317`）。

## 上游 iLink 协议

6 个上游接口全部在 `lib/transport.js`：`POST ilink/bot/get_bot_qrcode?bot_type=3`（`:122`）、`GET ilink/bot/get_qrcode_status?qrcode=...`（可选 `&verify_code=...`，`:131-133`）、`POST ilink/bot/getupdates`（`:139`）、`POST ilink/bot/msg/notifystart`（`:148`）、`POST ilink/bot/msg/notifystop`（`:153`）、`POST ilink/bot/sendmessage`（`:163`）。默认 API/QR 根地址均为 `https://ilinkai.weixin.qq.com/`（`:6-7`）。

- **地址与请求头**：`normalizeBaseUrl()` 只接受 `weixin.qq.com` / `*.weixin.qq.com` / `wechat.com` / `*.wechat.com` 的 HTTPS（端口 443），并强制把路径改为 `/`（`lib/transport.js:26-38`）。每次调用可用 `baseUrl` 覆盖构造时的默认值：`request = options => requestJson(fetchImpl, { baseUrl, ...options })`（`:114-115`）；`start()` 把账号的 `account.baseUrl` 逐次传给 `notifyStart` / `getUpdates` / `sendText` / `notifyStop`（`lib/index.js:195,278,314,393`）。`baseInfo()` 中 `bot_agent = 'DeepSeekHarness/1.1.0'`（`lib/transport.js:52-54`）。`beginLogin` 使用默认鉴权头集合（无 token 时不发送 `Authorization`，`:40-49,121-122`）；`pollLogin` 显式 `authenticated: false`（`:133`）。二维码地址 `qrcode_img_content` 经 `qrUrl()` 校验为上述可信 HTTPS 域名，否则 `qrcodeUrl` 为 `undefined`（`:67-75,126`）。
- **返回码**：导出 `rejectedProviderResponse(response, ['ret','errcode'])`，同时检查 `ret` 与 `errcode`，接受数值 `0` 与字符串 `'0'` 为成功，其余非零值作为 providerCode（`lib/transport.js:56-65`）。`beginLogin` / `getUpdates` / `notifyStart` / `notifyStop` / `sendText` 统一用它判定，`-14` 一律映射为 `stale-token`，其它按各接口的错误码（`qr-request-rejected` / `updates-rejected` / `start-rejected` / `stop-rejected` / `send-rejected`，`:116-119,123,140,149,154,180`）。
- **超时**：`requestJson()` 自带定时器，超时抛真实 `code = 'timeout'`（`lib/transport.js:84-85,98`）。`getUpdates` **仅**在 `code === 'timeout'` 时返回空批次并保留原游标（`:142-145`）；`network-error` 不再被当作空轮询，会向上抛错（`tests/transport.test.js:42-47` 覆盖 `ret: -14`、`errcode: -14`、`ret: '0'`）。

### 连接生命周期（notifyStart / notifyStop）

`start()` 依次读账号、状态与路由，然后**等待** `transport.notifyStart({ token, baseUrl, signal })` 成功，再以 `void pollLoop().catch(...)` 启动轮询（`lib/index.js:306-317`；`lib/transport.js:147-151`）。`notifyStart` 被拒时 `start()` 失败、`apply()` 记录 `startup failed` 警告，**不会开始轮询**（`lib/index.js:417`）。停机时 `stop()` 是 `async`：`await notifyStop`（带 `AbortSignal.timeout(10_000)`），失败只写 `notifyStop failed` 警告，随后 `abort()` 中止在途请求（`lib/index.js:390-397,399-404`；`lib/transport.js:152-156`）。

`internals.autoStart === false` 时 `start()` 不启动 `pollLoop()`、`apply()` 末尾也不自动调用 `start()`；这是**仅供测试的注入开关，不是用户配置字段**（`lib/index.js:316,417`）。

### getUpdates 返回码与轮询顺序

`pollLoop()` 每一轮捕获 `getUpdates` 异常并写 `getUpdates failed [<code>]` 警告；**遇到 `stale-token` 会 `await stop()` 并退出循环**，其它错误等 3 秒重试（`lib/index.js:275-284`）。消息按 `seq`（或 `message_id`）再按 `create_time_ms` 排序后逐条交给 `handleInbound()`，每条单独 try/catch 写 `inbound failed` 警告；空批次等待 1 秒（`lib/index.js:285-301`）。

### 扫码状态

`pollLogin()` 只接受以下 `status`，其他值报 `unknown login status`（`lib/transport.js:14,128-136`）：`wait`、`scaned`、`confirmed`、`expired`、`scaned_but_redirect`、`need_verifycode`、`verify_code_blocked`、`binded_redirect`。设置分区的「获取新扫码二维码」按钮只发起一次 `beginLogin`，不会自动轮询状态（`lib/client.js:39-44,69`）；如需 `status` 请自行用 `/login` 携带 `qrcode` 再 POST。**未启用时 `/login` 返回 403**，不会请求 iLink（`lib/index.js:377`）。

## 限制（与代码一一对应）

1. **只发最后一次工具调用之后的最终回答**：`tool/call` 或含 `tool-call` 的 `assistant/message` 会清空累积器，只有 `turn/end` 且 `reason === 'completed'`、最终文本非空时才投递（`lib/events.js:47-56,3-6,106-107,131-138`；`tests/events.test.js:7-13`）。工具过程、思考增量、中途取消/中断的回合都不发。
2. **不补发历史**：插件只监听 `apply()` 之后注册的全局 `session/event`（`lib/index.js:321`），事件引擎只处理 `turn/start → … → turn/end` 的实时序列（`lib/events.js:128-138`）；没有历史事件回填，也没有开启前的消息补发。事件队列按 **sessionId** 串行化（`lib/events.js:125-127,140-142`）。
3. **没有图片、文件、审批或富媒体通道**：入站只提取 `item_list` 的 `type: 1 text_item.text` 与 `type: 3 voice_item.text`（语音转写文本），其余项忽略；`message_type === 2`（机器人自己发出的消息）直接忽略（`lib/transport.js:106-112`；`lib/index.js:229-232`）。出站只构造一个 `type: 1` 文本项（`lib/transport.js:164-169`）。`lib/` 中没有图片/文件下载或上传、没有审批请求/回复的 RPC 或端点。
4. **没有审批与权限交互**：微信侧返回的是普通文本提示与广播文本，任何需要 Host 侧确认的操作仍需在 Web GUI 中处理（`lib/index.js:247-268`）。
5. **微信发起的回合不会回环广播**：`submitPrompt()` 的 `requestId` 前缀为 `wechat-allsessions-`（`lib/index.js:210-211`），`isImOwned` 据此判为 `im` 来源，`createTurnTracker.content()` 对 `im` 来源不累积回答（`lib/index.js:185`；`lib/events.js:69-78`）；`includeInternal: true` 也不会改变这一点。
6. **扫码结果不落盘为账号**：`/login` 只返回二维码与状态；`start()` 依然要求 `config.json` 中已有 `accounts[0].botId + tokenRef`（`lib/index.js:116-129,375-387`）。
7. **一个账号只支持一个 `getUpdates` 消费者**：见上文互斥说明。
8. **去重是本插件自己的、重启后仍有限**：`seenMessageIds` 只保留最近 1000 条并写在 `allsessions-state.json`（`lib/index.js:233-236`），与 dsh-im 的 `state.json` 不共享；因此更不能两边同时消费。
9. **广播需要该用户自己的 `context_token`**：缺失时 `no-context-token`，令牌不跨用户共享（`lib/index.js:191,214-219`）。
10. `format` 字段目前不参与发送格式（见配置表）。

## 失败关闭（fail-closed）默认值

- `enabled: false`、`broadcastAll: false`、`defaultUserId: ''`：默认既不连接也不发送（`lib/index.js:33-36,48-53,205,417`）。
- 只有 `enabled === true` 且 `turn.completed === true` 且最终文本非空、来源/子代理过滤通过时才会 `send()`（`lib/events.js:106-113`）。
- 账号、收件人或该用户上下文令牌缺失时返回 `no-account` / `no-user-id` / `no-context-token`，而不是猜测目标（`lib/index.js:187-191`）。
- `start()` 缺少 `credentials.resolve`、账号配置、token 时抛错，由 `apply()` 记录警告，不向外发送（`lib/index.js:116-122,307,417`）。
- **未启用时 `/login` 返回 403**，不会发出任何出站 iLink 请求（`lib/index.js:377`；`tests/index.test.js:47-54`）。
- 所有 HTTP 路由仅回环可达；`POST /config` 拒绝跨站 `Origin`，请求体上限 1 MiB；iLink 地址被限定为可信 HTTPS 域名（`lib/index.js:85-97,342,345,349,366,370,376`；`lib/transport.js:26-38,79`）。
- 发送/入站异常被吸收为 `sendLog` 记录与警告，不会让事件队列或轮询循环崩溃（`lib/events.js:115-122,139-140`；`lib/index.js:295-298,316`；`tests/events.test.js:31-45`）。

## 验证清单（摘要）

完整清单见 [docs/INSTALL.md](docs/INSTALL.md#8-验证清单)。最小闭环：

- [ ] dsh-im 的微信通道已停用、Host 已完整重启，且 `~/.dsh/integrations/dsh-weixin/config.json` 仍在。
- [ ] `GET /plugins/dsh-wechat-allsessions/config` 返回 `rules.enabled === false`（安装后的默认值）；按要求启用并重启后 `GET /status` 返回 `connected: true`、`polling: true`。
- [ ] **未启用时** `POST /plugins/dsh-wechat-allsessions/login` 返回 403 `enable the plugin before requesting a QR login`；启用后可取到二维码。
- [ ] 先用目标微信账号给机器人发一条文字，确认 `allsessions-state.json` 的 `contextTokens.users.<userId>.token` 已写入；`defaultUserId` 已填正确 `to_user_id`。
- [ ] 在 Web GUI 完成一次对话后微信收到含 `继续对话: /session <Session ID>` 的最终回答；`~/.dsh/integrations/dsh-wechat-allsessions/sessions.json` 出现该用户的 `sessionId`。
- [ ] 微信发送 `/list` 能列出路由，发送一条普通文字能续接回同一 Session；`GET /config` 的 `sendLog` 出现 `ok: true` 记录。
- [ ] 单元测试 `node --test tests/*.test.js` 通过（当前 23 pass / 0 fail，含真实 `prompt(request, signal)` 签名、返回码与 `baseUrl` 覆盖用例）。

## 排障（摘要）

| 现象 | 先看什么 |
| --- | --- |
| 设置分区「全会话微信桥接」不出现 | 客户端通过 `slots.inject('settings.section', ...)` 注册（`lib/client.js:76-84`）；确认 bundle 客户端已加载、Host 完整重启、`slots` 服务可用。可绕过界面直接用 4 条回环路由。 |
| `connected: false` / 未连接 | `enabled` 是否写进 patch 并重启（`POST /config` 只返回 `restartRequired`，`lib/index.js:355-359,417`）；`config.json` 是否有 `accounts[0]`、`credentials.resolve(tokenRef)` 是否返回非空 token、Host 日志中的 `startup failed`（也可能是 `notifyStart` 被拒，`lib/transport.js:147-151`）。 |
| `POST /config` 改 `enabled` 后状态没变 | 这是**设计行为**：响应带 `restartRequired: true` 与 `warning`，POST 从不调用 `start()` / `stop()`，且不写 settings（`lib/index.js:355-359`）；`settings/document-updated` 也只刷新规则并写重启警告（`lib/index.js:322-332`）。把 `enabled: true` 写进 `cordis.patch.yml` 并**完整重启 Host**。 |
| 微信发消息没有反应 | `/status` 的 `polling`、是否被 dsh-im 同时消费、消息是否为 `message_type: 2` 或无文本项、是否已有路由；入站异常写 `inbound failed` 警告（`lib/index.js:229-232,295-298`）。 |
| 广播日志出现 `no-context-token` | 该用户还没有 `context_token`：令牌按用户保存、不共享，也没有全局回退（`lib/index.js:191,214-219`）。让**该微信用户**先给机器人发一条文字，确认 `allsessions-state.json` 的 `contextTokens.users.<userId>.token` 已写入（`lib/index.js:238-245`），再在 Web GUI 触发一次对话。 |
| 报错 `signal.throwIfAborted is not a function` | 旧版本把 source 对象当作 `controller.prompt` 的第二个参数，Host 在 `signal` 上调用 `throwIfAborted()` 因而报错；当前版本传的是 `abort.signal`（`lib/index.js:208-212`；新用例 `submitPrompt uses the real SessionController.prompt(request, signal) signature`）。用 bundled node/pnpm 重新执行 `pnpm install --no-frozen-lockfile` 安装最新 bundle 并**完整重启 Host**；确认运行的不是旧 `node_modules` 副本。 |
| `/login` 返回 403 `enable the plugin before requesting a QR login` | `enabled: false` 时该路由直接拒绝，以避免未启用状态发出 iLink 请求（`lib/index.js:377`；`tests/index.test.js:47-54`）。先按上文启用并完整重启 Host，再取二维码。 |
| 与 dsh-im 同时收到重复消息 | 两个 `getUpdates` 消费者争抢 `getUpdatesBuf`；立刻停用其中一个并完整重启 Host。 |
| 凭据缺失 | `no reusable WeChat account in <path>` / `WeChat token is empty for <botId>` / `credentials service unavailable`（`lib/index.js:116-122,307`）。 |
| `startup failed` / 轮询没有启动 | `start()` 会先 `await notifyStart`；响应 `ret/errcode` 非零抛 `start-rejected`（`lib/transport.js:116-119,147-151`），`pollLoop()` 不会被调用（`lib/index.js:313-316,417`）。 |
| `getUpdates failed [stale-token]` | `ret` 或 `errcode` 为 `-14` 时 `pollLoop()` 会 `await stop()` 并停止轮询，不再无限重试（`lib/index.js:280-284`；`lib/transport.js:56-65,116-119`）。重新绑定账号更新 `config.json` 与凭据后完整重启 Host。 |
| Host 日志出现 `notifyStop failed` | `stop()` 会 `await notifyStop`（`AbortSignal.timeout(10_000)`），失败只写警告（`lib/index.js:390-397`）；通常不影响停机与下次启动。 |
| 扫码状态异常 | 只接受上节列出的 8 种 `status`；`invalid-qr`、`unknown login status`、`expired` 分别对应无二维码、未知状态、二维码过期；`qrcode_img_content` 不是可信 HTTPS 地址时 `qrcodeUrl` 为 `undefined`（`lib/transport.js:67-75`）。扫码成功也不会自动写账号配置。 |

详细步骤与命令见 [docs/INSTALL.md](docs/INSTALL.md#9-排障)。

## 许可与致谢

本插件自身为 MIT（`package.json:5`）。协议级实现改编自两个 MIT 项目，完整声明见 `third_party/NOTICE.txt`：

- **`@xmanrui/dsh-im`** — MIT License, Copyright (c) 2026 xmanrui。参考 `src/channels/weixin/weixin-api.mjs` 的常量、请求头与 `get_bot_qrcode` / `get_qrcode_status` / `getupdates` / `sendmessage` 报文（`:11-29,256-313,656-690,758-795,858-870`）、`weixin-bridge.mjs:123-125` 的 `p2p:<userId>` 会话键、`state-store.mjs:1-30` 与 `config-store.mjs:1-30` 的状态/账号结构；`lib/transport.js:1-3`、`lib/events.js:1-2` 亦注明来源。`lib/events.js` 的最终回答引擎参考其 `session-sync-coordinator.mjs` 的分类思路。
- **`sgaofen/cli-in-wechat`** — MIT License（按其 `package.json`）。`lib/text.js:1-2` 改编自 `src/ilink/text-chunk.ts` 的 UTF-8 按 code point 分段；`lib/router.js:1` 改编自 `src/bridge/session.ts` 中 `SessionManager` 的 `sessions.json` 持久化会话路由思路；项目 README 说明了 iLink Bot API 与会话续接的使用模式。

以上两个项目仅作为协议与模式参考；本插件运行时不加载它们的任何代码。

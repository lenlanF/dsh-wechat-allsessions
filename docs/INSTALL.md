# 安装 dsh-wechat-allsessions（desktop profile）

本文件给出**本机 desktop profile 的具体安装步骤**。插件源码在 `D:/Agent/DSH-WeChat-AllSessions`，以 `file:` bundle 装入 `C:/Users/lan/.dsh/profiles/desktop`。行为、字段与限制见 [../README.md](../README.md)。

> **安装顺序不可颠倒：先停用 dsh-im 的微信通道，再启用本插件。** 两者在同一个微信账号上同时运行会各自调用 `getUpdates` 并争抢 `getUpdatesBuf`，导致消息重复或丢失（`lib/index.js:278,285-288`；```xmanrui/dsh-im/src/channels/weixin/weixin-runtime.mjs:257-262,288-289`）。本插件**运行时不需要** ```xmanrui/dsh-im`（`lib/index.js:3,12-15,31`；`package.json:43-46`），只复用它留下的 `config.json`、凭据与状态目录，所以停用通道时**不要删除** `~/.dsh/integrations/dsh-weixin/` 下的文件。

## 0. 前置条件

- DSH Host 的 desktop profile：`C:/Users/lan/.dsh/profiles/desktop`，且 ```deepseek-ai/schemastery` 存在（本机路径 `C:/Users/lan/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs`）。`lib/index.js:17-28` 先按包名导入，失败时按 `DSH_PROFILE_DIR`、`%USERPROFILE%/.dsh/profiles/desktop`、`~/.dsh/profiles/desktop` 顺序查找该 ESM 文件，找不到会报 `schemastery is not resolvable`。
- `package.json:43-46` 声明 peer 依赖 ```deepseek-ai/cordis ~4.1.0`、```deepseek-ai/schemastery ~3.19.0`，由 Host profile 提供；本插件自身没有 `dependencies`。
- 已有一个可用的微信 iLink 账号文件 `C:/Users/lan/.dsh/integrations/dsh-weixin/config.json`（含 `accounts[0].botId` 与 `tokenRef`），且 `tokenRef` 能被 Host 的 `credentials.resolve()` 解析为非空 token（`lib/index.js:116-129`）。本机实际目录：
  - `C:/Users/lan/.dsh/integrations/dsh-weixin/config.json`
  - `C:/Users/lan/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json`（dsh-im 自己的状态，本插件不写）
  - `C:/Users/lan/.dsh/integrations/dsh-weixin/workspaces.json`
- 插件默认 `enabled: false`（`lib/index.js:34,49`、`config.example.yml:5`），安装后不会自动连接或发送任何消息。
- **Host 的 `SessionController.prompt` 必须接受 `(request, signal)` 两个参数**：本插件传 `abort.signal` 作为第二参数（`lib/index.js:208-212`）。旧版把 source 对象当第二参数会报 `signal.throwIfAborted is not a function`，见第 9 节。

## 1. 停用 dsh-im 的微信通道（必须步骤）

dsh-im 的「设置 → IM机器人」页面**不使用渠道级启用/停用开关**（其 `README.md:397`）。`C:/Users/lan/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/cordis.patch.yml:1-3` 只注册一个 bundle 插件 `xmanrui-dsh-im`；各渠道由 `plugin-src/host/index.mjs:80-95,249-256` 内部启动，微信实现是 `plugin-src/host/channels/weixin/index.mjs:7-10,18-27`（其 `name = 'dsh-weixin-host'` 是模块导出名，**不是 cordis.yaml 插件 id**，不能据此写 `- id:` 覆盖）。本机 `C:/Users/lan/.dsh/profiles/desktop/cordis.patch.yml` 里也没有 `weixin` 相关的 id 条目。

因此请用下面两种**已核实**的做法之一（不要凭猜测编造渠道 id）：

| 方式 | 操作 | 影响 |
| --- | --- | --- |
| **A（本机推荐：停用整个 dsh-im bundle）** | 在 `C:/Users/lan/.dsh/profiles/desktop/cordis.patch.yml` 顶层数组追加一条 id 定向的 `disabled: true`，目标为实际注册的 bundle 插件 id `xmanrui-dsh-im`（YAML 见下方代码块），然后**完整重启 Host**。该文件现有条目已使用 `- id: ...` + `disabled: false` 的形式（`:1279-1317`），文件头说明这是「applied after every bundle layer」的 patch 层（`:1-3`）。重启后以 `/status` 的 `polling: true` 与 Host 日志确认本插件是唯一消费者。 | 停用 dsh-im 的全部 IM 渠道；微信账号配置文件与凭据保持不动。同时 `dsh-im-broadcast`（本机 bundle 第 11 行、依赖第 28 行）依赖 `dshIm` 服务，也会失效，请一并评估。 |
| **B（从依赖中移除，等价但更彻底）** | 从 `C:/Users/lan/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 中移除 `"@xmanrui/dsh-im"`（本机第 10 行），从 `dependencies` 移除 `"@xmanrui/dsh-im": "^5.10.0"`（本机第 22 行），再执行第 3 步的 `pnpm install --no-frozen-lockfile`，最后完整重启 Host。 | 同 A；同时让 `dsh-im-broadcast` 失去 `dshIm` 服务。 |

方式 A 使用的 YAML（三条均为顶层条目，与现有 `- id:` 同级）：

```yaml
- id: xmanrui-dsh-im
  name: xmanrui-dsh-im
  disabled: true
```

若你只希望停用微信而保留其它渠道，请在 dsh-im 的配置中确认是否存在官方支持的渠道级开关后再操作（本机 5.10.0 未提供该开关）；在确认之前，不要同时启用本插件。

**无论哪种方式都不要删除** `C:/Users/lan/.dsh/integrations/dsh-weixin/config.json` 或 `accounts/` 目录：本插件 `start()` 要从这里读 `botId`/`tokenRef`，并把状态写到同目录的 `allsessions-state.json`（`lib/index.js:107-114,306-317`）。`start()` 还会在轮询前先等待 `notifyStart` 成功（`lib/index.js:313-316`；`lib/transport.js:147-151`）。这就是「零停机复用」：账号不变、无需重新扫码。

如果还没有账号，先用 dsh-im 的扫码绑定流程生成 `config.json`（其 `README.md:111` 说明微信使用扫码绑定、iLink 长轮询），**再**执行本步骤停用；本插件的 `/login` 只返回二维码与状态，不会把扫码结果写成账号配置（见 [README「它是什么、不是什么」](../README.md#它是什么不是什么) 的「新账号的扫码入口」一行）。**`enabled: false` 时 `/login` 直接返回 403**（`lib/index.js:377`）。

## 2. 注册 bundle 与依赖

编辑 `C:/Users/lan/.dsh/profiles/desktop/package.json`：

- 在 `dsh.profile.bundles`（当前第 6-18 行）追加 `"dsh-wechat-allsessions"`。
- 在 `dependencies`（当前第 20-29 行）追加 `"dsh-wechat-allsessions": "file:D:/Agent/DSH-WeChat-AllSessions"`。写法与已有的 `"dsh-model-failover": "file:D:/Agent/DSH"`（第 25 行）、`"dsh-im-broadcast": "file:D:/Agent/DSH-IM-Broadcast"`（第 28 行）一致。

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-connect-workbuddy",
        "@xmanrui/dsh-im",
        "dsh-im-broadcast",
        "@linxin666/dsh-web-all",
        "dshmarket",
        "dsh-context",
        "dsh-sidebar-shortcut",
        "dsh-model-failover",
        "dsh-wechat-allsessions"
      ]
    }
  },
  "dependencies": {
    "dsh-model-failover": "file:D:/Agent/DSH",
    "dsh-wechat-allsessions": "file:D:/Agent/DSH-WeChat-AllSessions"
  }
}
```

上面只列出要改动的两个字段，其余保持原样（若按第 1 步方式 B 移除了 ```xmanrui/dsh-im`，示例中相应两行也一并删除）。插件的 `dsh.bundle.patch: "./cordis.patch.yml"`（`package.json:28-31`）让 bundle 自带 insert 记录；`main` 为 `lib/index.js`（`:7`），`dsh.client.inject` 见 `:32-41`，设置分区客户端自身声明 `inject = ['slots', 'remote', 'remote.session']`（`lib/client.js:82-84`）。

## 3. 用 DSH 自带的 Node/pnpm 安装

在 `C:/Users/lan/.dsh/profiles/desktop` 下执行（本机 Node 为 `v24.21.0`；路径来自 `load_workspace_dependencies` 返回的 bundled runtime）：

```bash
cd /c/Users/lan/.dsh/profiles/desktop
"C:/Users/lan/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" "C:/Users/lan/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install --no-frozen-lockfile
```

必须用 `--no-frozen-lockfile`：新增 `file:` 依赖需要更新 `C:/Users/lan/.dsh/profiles/desktop/pnpm-lock.yaml`。安装后应能在 `C:/Users/lan/.dsh/profiles/desktop/node_modules/dsh-wechat-allsessions` 下看到 `lib/index.js`、`lib/client.js`、`lib/transport.js`、`lib/router.js`、`lib/text.js`、`lib/events.js`（`package.json:8-14` 的 `files` 列表）。

## 4. 追加 insert 记录

把 `D:/Agent/DSH-WeChat-AllSessions/cordis.patch.yml` 的内容**作为顶层数组的一个新条目**追加到 `C:/Users/lan/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
# dsh-wechat-allsessions: standalone global session observer + WeChat iLink bridge.
- insert:
    - id: dsh-wechat-allsessions
      name: dsh-wechat-allsessions
```

来源 `cordis.patch.yml:1-4`（第 1 行是注释，可省略）。`- insert:` 必须顶格，与该文件现有的 `- id: ...` 条目同级；不要塞进别的 `- insert:` 列表或 `config:` 块。该文件末尾已有一个同类条目 `- insert: - id: dsh-im-broadcast`（`:1349-1351`），照其格式追加即可。

## 5. 追加配置覆盖

再把 `D:/Agent/DSH-WeChat-AllSessions/config.example.yml` 中的 `- id: dsh-wechat-allsessions` 配置覆盖（源文件 `:2-16`）追加到**同一个** `C:/Users/lan/.dsh/profiles/desktop/cordis.patch.yml` 末尾，放在第 4 步之后：

```yaml
- id: dsh-wechat-allsessions
  name: dsh-wechat-allsessions
  config:
    enabled: false
    broadcastAll: false
    defaultUserId: ''
    maxChunkBytes: 1500
    routeStorePath: ''
    accountConfigPath: ''
    statePath: ''
    includeSessionHint: true
    includeInternal: false
    includeSubagents: false
    format: plain
    sendLogLimit: 20
```

`config.example.yml:1` 明确说明这是一条 **id 定向的 config 覆盖**，不要放进 `- insert:` 列表。全部 13 个字段与默认值和 `lib/index.js:33-53` / `config.example.yml:5-16` 一致，字段含义见 [../README.md](../README.md#配置字段全部-13-项及默认值)。`routeStorePath` / `accountConfigPath` / `statePath` 留空即使用 `~/.dsh/integrations` 下的默认路径；本机 `DSH_HOME` 对应 `C:/Users/lan/.dsh`。Host 传入的 volatile 配置由 `unwrapVolatile()` 解包后归一化（`lib/index.js:55-77,162`）。

**保持 `enabled: false` 直到验证完成。** `start()` 还会在 `pollLoop()` 前等待 `notifyStart`；被拒绝时 `start()` 失败、只写 `startup failed` 警告（`lib/index.js:313-316,417`；`lib/transport.js:147-151`）。注意 **`POST /config` 永不改变桥接生命周期**：改 `enabled` 只返回 `{ ok: true, rules, restartRequired: true, warning: 'enabled changed; restart Host to start or stop the WeChat bridge' }`，不调用 `start()` / `stop()`，也不写 settings（`lib/index.js:355-359`）；`settings/document-updated` 同样只刷新规则并写重启警告（`:322-332`）。因此必须把 `enabled: true` 写进 patch 并**完整重启 Host**。

## 6. 完整重启 Host

**完全退出并重新启动 DSH Host**（不是刷新 Web 页面）。bundle 列表、loader patch、`settings`/`webServer`/`sessions`/`sessionController`/`credentials` 注入、4 条回环路由与 `start()` 都在 Host 启动时装配（`lib/index.js:31,306-317,321-332,339-388,417`）；第 1 步停用 dsh-im 微信通道的 patch 也只在重启后生效。停机/重启顺序建议：确认 dsh-im 微信通道已不再轮询 → 启动本插件 → 检查 `/status`。停机时 `async stop()` 会 `await notifyStop`（`AbortSignal.timeout(10_000)`）再 `abort()`（`lib/index.js:390-404`；`lib/transport.js:152-156`）。

## 7. 启用并填写 defaultUserId

1. 找到 `to_user_id`（`defaultUserId`）：见 [README「找到 defaultUserId」](../README.md#找到-defaultuserto_user_id)。最快是读 `C:/Users/lan/.dsh/integrations/dsh-weixin/config.json` 的 `accounts[0].ownerUserId`，或 `C:/Users/lan/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json` 的 `contextTokens.users` 键 / `recentOutboundMessages[].toUserId`（`p2p:<userId>` 形式的会话键去掉前缀即为 userId，见 `weixin-bridge.mjs:123-125`）。
2. 在 `C:/Users/lan/.dsh/profiles/desktop/cordis.patch.yml` 的本插件 `config:` 中把 `enabled` 改为 `true`、填入 `defaultUserId`，并**完整重启 Host**。**广播门闩**：`shouldSkip = !broadcastAll && !defaultUserId`（`lib/index.js:205`）——只填 `defaultUserId` 就足以放行广播，`broadcastAll` 不必打开；`enabled` 仍须为 `true`。重启后若只想改收件人，可用回环接口即时更新规则（持久化失败会返回 `warning`；改 `enabled` 则只返回 `restartRequired`）：

```bash
curl http://127.0.0.1:<Host 实际端口>/plugins/dsh-wechat-allsessions/config
curl --request POST http://127.0.0.1:<Host 实际端口>/plugins/dsh-wechat-allsessions/config --header 'Content-Type: application/json' --data '{"defaultUserId":"xxx@im.wechat"}'
```

端口以 Host 启动时显示的地址为准；4 条路由都只接受回环来源 `127.0.0.1` / `::1` / `::ffff:127.0.0.1`（`lib/index.js:342`），`POST /config` 还拒绝非本机 `Origin`（`:349`）。只接受 `DEFAULT_RULES` 里存在的字段（`:353-354`），请求体上限 1 MiB（`lib/index.js:85-97`），`curl` 默认不带 `Origin`。
3. **先给机器人发一条微信文字**：广播要求该用户自己的 `context_token`，缺失时返回 `no-context-token`，令牌不跨用户共享（`lib/index.js:191,214-219`）。用目标账号发一条文字后，确认 `C:/Users/lan/.dsh/integrations/dsh-weixin/accounts/<botId>/allsessions-state.json` 的 `contextTokens.users.<userId>.token` 已写入（`lib/index.js:238-245`）。
4. 确认连接：`GET /plugins/dsh-wechat-allsessions/status` 应返回 `connected: true`、`botId` 为 `config.json` 中的账号、`polling: true`（`lib/index.js:365-368`）。`connected` 只表示 `account` 已加载；若 `polling` 为 `false`，检查 Host 日志的 `getUpdates failed [<code>]` 警告（`:280-284`）。若日志含 `stale-token`（`ret/errcode === -14`），凭据已失效且轮询会主动停止（`lib/transport.js:56-65,116-119`；`lib/index.js:281`）。

## 8. 验证清单

- [ ] 第 1 步已完成：dsh-im 的微信长轮询不再运行；`C:/Users/lan/.dsh/integrations/dsh-weixin/config.json` 与 `accounts/` 仍存在且未被清空。
- [ ] `package.json` 的 `bundles` / `dependencies` 各含 `dsh-wechat-allsessions`；`pnpm install --no-frozen-lockfile` 退出码为 0；`C:/Users/lan/.dsh/profiles/desktop/node_modules/dsh-wechat-allsessions/lib/index.js` 存在且为最新版本（含 `controller.prompt(request, abort.signal)`）。
- [ ] profile `cordis.patch.yml` 末尾依次有 `- insert:`（`id: dsh-wechat-allsessions`）与 `- id: dsh-wechat-allsessions` 的 `config:` 覆盖，二者都是顶层条目；13 个字段齐全。
- [ ] Host 已完整重启；首次验证时 `GET /plugins/dsh-wechat-allsessions/config` 返回 `ok: true` 且 `rules.enabled === false`（失败关闭默认值）。
- [ ] **未启用时** `POST /plugins/dsh-wechat-allsessions/login` 返回 403 `enable the plugin before requesting a QR login`，且没有出站 iLink 请求（`lib/index.js:377`；`tests/index.test.js:47-54`）。
- [ ] `POST /config` 改 `enabled` 返回 `restartRequired: true` 且桥接状态不变；把 `enabled: true` 写进 patch 并完整重启后，`GET /plugins/dsh-wechat-allsessions/status` 返回 `connected: true`、`polling: true`、`botId` 非空（也意味着 `notifyStart` 成功，`lib/index.js:313-316`）。
- [ ] `GET /plugins/dsh-wechat-allsessions/sessions` 返回当前 Session 列表（含 `sessionId`、`cwd`、`isSubagent`）。
- [ ] 已用目标微信账号先发一条文字，`C:/Users/lan/.dsh/integrations/dsh-weixin/accounts/<botId>/allsessions-state.json` 出现该用户的 `contextTokens.users.<userId>.token`；`defaultUserId` 已填正确 `to_user_id`。
- [ ] 在 Web GUI 完成一次对话后，微信收到**仅最后一次工具调用之后的最终回答**，且含 `继续对话: /session <Session ID>`（`includeSessionHint: true` 默认）；`sendLog` 出现 `ok: true` 而非 `no-context-token`。
- [ ] `C:/Users/lan/.dsh/integrations/dsh-wechat-allsessions/sessions.json` 出现 `version: 1` 与该用户的 `sessionId`；dsh-im 自己的 `state.json` 未被本插件改动。
- [ ] 微信发送 `/list` 收到路由列表；发送普通文字续接回同一 Session（Host 日志无 `signal.throwIfAborted is not a function`）；发送 `/new` 后再发普通文字收到「还没有绑定会话」提示。
- [ ] 长回答按 `maxChunkBytes` 分段且不超过 20 段，中文/emoji 不出现乱码；`sendText` 的 `network-error` 重试使用稳定 `clientId`（`lib/transport.js:161,171-179`）。
- [ ] 单元测试通过：在 `D:/Agent/DSH-WeChat-AllSessions` 执行 `node --test tests/*.test.js`（`package.json:26`），当前 **23 pass / 0 fail**，含真实 `prompt(request, signal)` 签名、provider 返回码、`baseUrl` 覆盖与 login-403 用例。

## 9. 排障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 设置分区「全会话微信桥接」不出现 | 客户端通过 `slots.inject('settings.section', ...)` 注册，依赖 `slots` 服务（`lib/client.js:76-84`）；客户端由 `dsh.client.inject` 装配（`package.json:32-41`）；bundle/客户端未在 Host 启动时加载。 | 完整重启 Host；确认 `package.json` 两项登记与第 3 步安装成功；确认 `slots` 可用。可直接用 4 条回环路由完成配置。分区内实际标签见 `lib/client.js:47,79`（「全会话微信桥接」）、开关/按钮文案见 `:50-73`，不要凭记忆输入其它名称。 |
| `/plugins/dsh-wechat-allsessions/config`、`/status`、`/sessions`、`/login` 四条路由都 404 | `webServer.register` 未注入、`- insert:` 缺失或缩进错误、bundle 未安装、未完整重启（`lib/index.js:339-388`）。 | 逐项复核第 2–6 步；检查 `node_modules/dsh-wechat-allsessions/lib/index.js` 是否存在。 |
| `403 loopback only` / `cross-origin POST refused` / `405` | `/config` 对非回环来源 `403`（`lib/index.js:345`），带非本机 `Origin` 的 POST 另被拒绝（`:349`）；`/status`、`/sessions`、`/login` 对非回环或方法不符都返回 `405`（`:366,370,376`）。 | 从 Host 本机用 `127.0.0.1` / `::1` 访问，核对 GET/POST；POST 不带 `Origin` 或只用 `http(s)://127.0.0.1`、`localhost`、`[::1]`（可带端口）的本机 `Origin`；经局域网 IP 或反向代理时 `remoteAddress` 不是回环地址。 |
| `/login` 返回 403 `enable the plugin before requesting a QR login` | `enabled: false` 时该路由直接拒绝，避免未启用状态发出 iLink 请求（`lib/index.js:377`；`tests/index.test.js:47-54`）。 | 按第 5/6 步把 `enabled: true` 写进 patch 并完整重启 Host，再取二维码。 |
| `POST /config` 改 `enabled` 后状态没变 | 设计行为：响应带 `restartRequired: true` 与 `warning`，POST 从不调用 `start()`/`stop()`，且不写 settings（`lib/index.js:355-359`）；`settings/document-updated` 也只刷新规则并写重启警告（`:322-332`）。 | 把 `enabled: true` 写进 `cordis.patch.yml`，完整重启 Host。 |
| `connected: false` / 没有连接 | `enabled` 未写进 patch 或未重启；`notifyStart` 被拒令 `start()` 失败（`lib/transport.js:147-151`）；`credentials` 服务缺失；`config.json` 路径不对或 `accounts[0]` 缺 `botId`/`tokenRef`；`credentials.resolve()` 返回空 token（`lib/index.js:116-129,306-317,417`）。 | 查 Host 日志中 `startup failed:` 后面的错误文本；核对 `C:/Users/lan/.dsh/integrations/dsh-weixin/config.json`，或用 `accountConfigPath` / `statePath` 显式指向真实路径；确认 `DSH_HOME` 指向 `C:/Users/lan/.dsh`。`connected` 只表示账号已加载。 |
| `polling: false` 或反复 `getUpdates failed` | `pollLoop()` 在请求异常时写 `getUpdates failed [<code>]` 警告、等 3 秒后重试（`lib/index.js:279-284`）；可能 `network-error`、`updates-rejected`（其它非零 `ret/errcode`，`lib/transport.js:56-65,116-119`）、网络不可达或另一个消费者抢游标。仅 `code === 'timeout'` 会返回空批次（`:84-85,98,142-145`）。 | 检查凭据有效性、`https://ilinkai.weixin.qq.com/` 可达性与 Host 日志；确认第 1 步互斥已落实；插件不会自动刷新 token，需完整重启 Host。 |
| `getUpdates failed [stale-token]` | `ret` 或 `errcode` 为 `-14`；`pollLoop()` 会 `await stop()` 并退出循环，不再无限重试（`lib/index.js:280-284`；`lib/transport.js:56-65,116-119`）。 | 重新绑定账号，更新 `config.json` 与凭据后完整重启 Host。 |
| 微信发了消息但没有反应 / 没有入站 | 消息为 `message_type: 2` 或 `item_list` 无 `type: 1`/`type: 3` 文本（`lib/index.js:229-232`；`lib/transport.js:106-112`）；`message_id` 已在 `seenMessageIds` 中（`lib/index.js:233-236`）；没有绑定路由时只回复「还没有绑定会话」（`:263-266`）。消息按 `seq`/`create_time_ms` 排序，每条入站异常写 `inbound failed` 警告（`:285-298`）。 | 用 `/status` 看 `polling` 与 `routes`；用 `/list` 看路由；在 Web GUI 先完成一次对话自动写入路由，或发 `/session <Session ID>`。 |
| 报错 `signal.throwIfAborted is not a function` | 旧版本把 source 对象当作 `controller.prompt` 第二参数，Host 在 `signal` 上调用 `throwIfAborted()` 因而报错；当前版本传的是 `abort.signal`（`lib/index.js:208-212`；新用例 `submitPrompt uses the real SessionController.prompt(request, signal) signature`）。 | 用 bundled node/pnpm 重新执行第 3 步的 `pnpm install --no-frozen-lockfile` 安装最新 bundle，并**完整重启 Host**；确认运行的不是旧 `node_modules` 副本。 |
| 没有收到广播 / `no-context-token` | `enabled: false`；`broadcastAll: false` 且 `defaultUserId: ''` 触发 `shouldSkip`（`lib/index.js:205`）；回合不是 `completed`、被 `im`/`internal`/`subagent` 过滤（`lib/events.js:106-113`）；`no-account` / `no-user-id` / **`no-context-token`**（该用户没有自己的 `context_token`，`lib/index.js:187-192,214-219`）；`defaultUserId` 填错。 | 查 `GET /config` 的 `rules` 与 `sendLog`（`ok`、`reason`）以及 Host 日志的 `send refused` / `send failed`（`lib/events.js:118,121`）；**用目标微信账号先发一条文字**，确认 `allsessions-state.json` 的 `contextTokens.users.<userId>.token` 已写入（`lib/index.js:238-245`）。 |
| 与 dsh-im 同时收到重复消息 / 回答重复 | 两个 `getUpdates` 消费者在同一账号上争抢 `getUpdatesBuf`：本插件写 `allsessions-state.json`（`lib/index.js:285-288`），dsh-im 写 `state.json`（`weixin-runtime.mjs:288-289`）。 | 立即执行第 1 步并完整重启 Host，只保留一个消费者；本插件的 `seenMessageIds` 只保留最近 1000 条且不与 dsh-im 共享（`lib/index.js:235`），不能用作跨插件去重。 |
| `startup failed` / `polling: false` | `start()` 会先 `await notifyStart`（`POST ilink/bot/msg/notifystart`），响应非零 `ret/errcode` 抛 `start-rejected`（`lib/index.js:313-316,417`；`lib/transport.js:116-119,147-151`）。 | 查 Host 日志的 `WeChat rejected request`；核对账号/token 后完整重启 Host。 |
| Host 日志出现 `notifyStop failed` | `stop()` 会 `await notifyStop`（`AbortSignal.timeout(10_000)`），失败只写警告（`lib/index.js:390-397`）；通常不影响停机和下次启动。 | 持续出现时检查网络与账号状态。 |
| 凭据缺失 / token 为空 | `no reusable WeChat account in <path>`、`WeChat token is empty for <botId>`、`credentials service unavailable`（`lib/index.js:116-122,307`）。 | 确认 `config.json` 未被第 1 步删除、`tokenRef` 仍能在 Host 凭据存储中解析；必要时用 dsh-im 重新扫码绑定生成账号文件，再停用通道并重启。 |
| 二维码 / QR status 异常 | `POST /plugins/dsh-wechat-allsessions/login`（需 `enabled: true`）空体返回 `{ qrcode, qrcodeUrl, qrBaseUrl }`（`lib/index.js:377,383-385`；`lib/transport.js:121-127,128-136`）；带 `qrcode` 才轮询状态。可能的错误：`invalid-qr`、`qr-request-rejected`（非零 `ret/errcode`）、`unknown login status`、`expired` / `need_verifycode` 等状态值；`qrcode_img_content` 不是可信 HTTPS 地址时 `qrcodeUrl` 为 `undefined`（`lib/transport.js:67-75`）。设置分区的按钮只发起一次 `beginLogin`，不会自动轮询（`lib/client.js:39-44,69`）。 | 重新 POST `/login`（空体）取新二维码；带 `qrcode`（必要时加 `verifyCode`）再次 POST 读 `status`；`expired` 就重新取码，`need_verifycode` 补 `verifyCode`。仅接受 `wait`、`scaned`、`confirmed`、`expired`、`scaned_but_redirect`、`need_verifycode`、`verify_code_blocked`、`binded_redirect`（`lib/transport.js:14,134`）。**确认成功也不会自动写 `config.json`**，账号仍需按第 0/1 步落到账号文件。 |

## 卸载提示

按相反顺序移除：先在 patch 中把 `enabled` 设回 `false`（或 Host 停机），确认是否要恢复 dsh-im 的微信通道（撤销第 1 步的改动，注意两者仍不可同时消费），再从 profile `cordis.patch.yml` 删除 insert 与 config 两条记录、从 `package.json` 删除 bundle 名与 `file:` 依赖、重新执行 `pnpm install --no-frozen-lockfile`，最后完整重启 Host。本插件只注册自己的 `/plugins/dsh-wechat-allsessions/*` 路由，并只写 `~/.dsh/integrations/dsh-weixin/accounts/<botId>/allsessions-state.json` 与 `~/.dsh/integrations/dsh-wechat-allsessions/sessions.json`；不修改 dsh-im 的文件或 profile 之外的配置。

## 许可

MIT；协议级实现参考两个 MIT 项目：```xmanrui/dsh-im`（Copyright (c) 2026 xmanrui）与 `sgaofen/cli-in-wechat`。完整声明见 `third_party/NOTICE.txt` 与 [../README.md](../README.md#许可与致谢)。

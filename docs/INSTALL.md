# 安装与升级 dsh-wechat-allsessions（v0.2.0）

本插件是独立的 DSH 微信 iLink 桥接。新安装支持**插件内扫码绑定**，不依赖 dsh-im 创建账号。更新不会自动修改正在使用的 DSH Profile。

## 1. 目录和约束

- `<DSH_HOME>`：当前用户的 DSH 数据目录，通常是 `%USERPROFILE%/.dsh`。
- `<PROFILE>`：`<DSH_HOME>/profiles/desktop`。
- `<REPOSITORY_DIR>`：本插件源码或解压后的发布目录。必须换成电脑上的真实绝对路径。
- **同一微信账号只能有一个 iLink getUpdates 消费者。** 使用本插件前，应确认原有 dsh-im 微信通道已经关闭；不能同时开启两个消费者。
- 不要删除旧的 `<DSH_HOME>/integrations/dsh-weixin/config.json`、凭据或状态文件，也不要清理其它工作区的会话。

## 2. 加入 DSH Profile

可以使用 DSH 插件管理器安装，也可使用 DSH 的 bundle 配置。对于本地 `file:` 方式，在 `<PROFILE>/package.json`：

```json
{
  "dependencies": {
    "dsh-wechat-allsessions": "file:<REPOSITORY_DIR>"
  },
  "dsh": {
    "profile": { "bundles": ["dsh-wechat-allsessions"] }
  }
}
```

上面是新增字段示例，**不要用它覆盖整个 package.json**；在现有 `dependencies` 与 `dsh.profile.bundles` 内合并即可。运行 DSH 提供的 Node/pnpm 或 `pnpm install --no-frozen-lockfile`，随后检查 `<PROFILE>/node_modules/dsh-wechat-allsessions/package.json` 中的版本。

把以下 insert 条目追加到 `<PROFILE>/cordis.patch.yml` 的**顶层 YAML 数组**（不要删除已有条目）：

```yaml
- insert:
    - id: dsh-wechat-allsessions
      name: dsh-wechat-allsessions
```

如需配置覆盖条目，则单独添加：

```yaml
- id: dsh-wechat-allsessions
  name: dsh-wechat-allsessions
  config:
    enabled: false
    broadcastAll: false
    defaultUserId: ''
    includeInternal: false
    includeSubagents: false
```

初次安装建议 `enabled: false`，先完成账号绑定。`config.example.yml` 列出了其余选项。修改 bundle 插入记录、插件版本或 `enabled` 后应**完整重启 DSH Host**。

## 3. 扫码绑定账号

1. 在 DSH 设置页面找到「全会话微信桥接」，点击「获取新扫码二维码」。**即使 `enabled: false`，扫码入口仍能使用。**
2. 微信扫码并确认。插件从微信 iLink 确认响应取得凭据，把 token 写入 DSH 的凭据服务，把账号资料保存到 `<DSH_HOME>/integrations/dsh-weixin/config.json`。
3. 账号文件至少需要 `botId`、`tokenRef`；新版扫码会同时写 `ownerUserId`，用于验证哪个微信用户可以访问 DSH 会话。复用旧账号时，如果缺少该字段，需要重新扫码或显式配置受信任的 `defaultUserId`。
4. 登录接口返回的 `status` 不包含私密 `bot_token`；不要通过日志、截图或公开 issue 分享凭据、上下文令牌和扫码结果原文。
5. 禁用状态下扫码仅绑定账号，不会自动开启微信长轮询。启用桥接需在设置页保存 `enabled: true` 并重启 Host。

## 4. 会话广播与回复

- 需要从所有普通 DSH 会话推送最终回复时，设置 `broadcastAll: true`；`defaultUserId` 未填写时，新版会优先使用绑定账号的 `ownerUserId`。
- 为了获取微信回复所必需的 `context_token`，**启用桥接后先从授权微信用户向机器人发一条消息**；插件只保存该用户对应的令牌，不把其他用户令牌拿来作为后备。
- 授权策略：仅绑定账号的 `ownerUserId` 和明确填入 `defaultUserId` 的用户可以使用微信指令。账号所有者可通过 `/session <Session ID>` 指向自己的 DSH 会话并使用 `/list` 查看保存路由；其他受信任用户只能查看和继续自己已经获分配的会话路由。
- `/new` 与 `/clear` 清除当前发送者的路由，并不创建新的 DSH 会话。
- 不要打开 `includeInternal` / `includeSubagents`，除非明确需要将定时任务或子代理的最终文本推送到微信。

## 5. 可靠性与运行限制

- 每个 iLink 批次在所有消息成功处理后才保存新的 `getUpdatesBuf`；调用 DSH 失败时会保留游标重试，避免无声丢消息。
- 去重标记只在成功提交或回复后写入；对于具备 `message_id` 的入站消息，重试使用稳定的 DSH `requestId`，但**端到端恰好一次执行仍取决于宿主幂等保障**。某些异常重启窗口可能出现重复投递。
- 状态与路由文件格式不合法时会停止启动并报错，而不是覆盖原记录。应备份后检查文件，不能盲目删除。
- 多段长消息仍受 `maxChunkBytes` 与最多 20 段限制；工具调用过程、文件和人工审批不会同步到微信。

## 6. 实际验收

请在**隔离测试会话**中核对以下项目：

1. `GET /plugins/dsh-wechat-allsessions/status` 显示账号已加载、`polling: true`，Host 日志不存在持续 `stale-token`。
2. 真实授权微信账号发送一条文本，状态文件记录属于此用户的上下文令牌。陌生微信账号不能查看任何会话路由或指定 Session。
3. DSH 会话产生最终回复后，授权微信账号收到广播；回复该消息继续写入预期 Session。
4. 在模拟提交失败时，下一轮 `getUpdates` 不应跳过失败的消息；重启后不丢失路由与已处理消息标记。
5. 反复扫码并重启后不会复用已 abort 的网络请求信号；启用/禁用配置能够在 Host 重启后保持。

开发者离线回归：在本仓库执行 `node --test tests/*.test.js`。v0.2.0 源码共 47 项测试。**离线测试不能代替真实微信账号验收。**

## 7. 升级、回退和隐私

- 升级前记录当前插件版本，备份 `cordis.patch.yml`、账号配置文件、`allsessions-state.json` 与路由文件；备份应妥善保管。
- 替换插件包/`file:` 目录后更新依赖并完整重启 Host。升级后如果微信命令没有响应，优先检查 `ownerUserId` 或 `defaultUserId` 与实际消息发送者是否一致，以及是否还有其它消费者抢占 iLink。
- 如需要回退，只替换**插件代码版本**并重启；不要自动清空已有会话、凭据、消息状态或修改其它插件。
- `/login`、`/config` 的 POST 会检查回环请求的 Origin；公开文档使用 `<DSH_HOME>` 与 `<REPOSITORY_DIR>` 占位符，不包含真实账号或本机用户名称。

进一步说明见 [README](../README.md)。

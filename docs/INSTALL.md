# 微信助手安装和升级（dsh-wechat-allsessions v0.4.1）

## 保持原配置及数据

**微信助手是界面显示名称，不更改包名与内部标识。** npm 包、bundle 插入 ID、设置命名空间、API 前缀仍为 **dsh-wechat-allsessions**。

更新前建议备份 DSH 用户目录中的 integrations/dsh-wechat-allsessions/sessions.json 与现有插件配置；不要删除旧微信账号、令牌或 dsh-im 状态。不要让 dsh-im 微信通道和本插件**同时消费同一微信账号的 getUpdates**，应先关闭其中一个。

## 安装

可用 DSH 插件管理器更新；若原先按本地源码 file: 方式安装，请将现有依赖更新到 0.4.1，并在当前 Profile 的配置中保留原依赖、旧 bundle 和已有个性化设置。新装时在 Cordis 补丁顶层 YAML 中增加以下 insert 项（**不要覆盖已有数组**）：

~~~yaml
- insert:
    - id: dsh-wechat-allsessions
      name: dsh-wechat-allsessions
~~~

仅新安装/未配置时，默认 enabled:true 与 broadcastAll:true。若旧配置明确保存为 false，升级时不会替你改为 true，需要在设置里手动开启。可选的配置覆盖示例：

~~~yaml
- id: dsh-wechat-allsessions
  name: dsh-wechat-allsessions
  config:
    enabled: true
    broadcastAll: true
    includeInternal: true
    includeSubagents: true
    defaultUserId: ''
~~~

不要覆盖现有 Profile package.json；若使用本地路径，务必核验实际绝对路径。更新安装版本、变更开关后应**完整重启 DSH Host**。

## 登录微信

在 **设置 → 微信助手** 检查已连接账号。若已复用有效的旧账号，不必再次扫码；如果尚无账号，点击“获取新扫码二维码”扫码并确认。即使配置为禁用，也能先扫码绑定。插件把 token 写入 DSH 凭据服务，不会把 token 返回设置界面。旧账号缺失 ownerUserId 时应重新扫码或配置明确受信任的 defaultUserId。

如果 status.broadcastReady 为 false，请由绑定微信账号向机器人发送 **/help** 以建立该用户自己的 context_token；不能跨用户复用别人的令牌。插件也可以只读复用旧 dsh-im 同一用户的令牌，不改原状态文件。

## 自动绑定、广播和续聊

启动时自动登记全部非归档 DSH 对话。新对话出现时通过事件或每 15 秒轮询会话清单自动加入，包括暂未发言的新对话。每个会话初次登记默认开启自动广播，归档后不广播；已手动关闭过的会话不会因重启而恢复。

在设置页面为任何对话操作广播开关，或者微信发送 **/broadcast off 会话ID** 和 **/broadcast on 会话ID**；微信端通过 **/help** 获取完整命令列表。发送 **/list** 查看自动绑定对话。

微信 **/session 会话ID** 指定后续微信提问进入哪个 DSH 对话；其他会话广播不会覆盖这一选择。**/clear** 清除该选择，但不删除会话或关闭广播。

广播消息开头固定显示 **对话ID** 和 **对话标题**。只有完成的回复被广播，不补发历史、文件或审批。
微信消息按完整句子、行与段落安全分段，不截断 /session 会话命令。正文或单句超限时会明确告知省略，绝不发送无法使用的残缺会话 ID。

## 真实环境验收

检查安装版本不能只查看 GitHub 或源码仓库：必须核验当前 DSH Profile 下 node_modules/dsh-wechat-allsessions/package.json 版本、Host 实际加载的插件代码，并查看 /plugins/dsh-wechat-allsessions/status 的 version。若 /help 仍然进入了“最新 DSH 对话”而不是由微信助手直接回复，则当前微信消息由旧插件/其他桥接接收，排查该消费者之前不要叠加启动新的 getUpdates。状态接口新增的 sendLog.kind=wechat-command 可追踪微信命令回复发送是否成功（没有用户 ID 或敏感 token）。


1. 检查已安装插件 package.json 版本为 0.4.1；设置页显示“微信助手”。
2. 启用后查看 GET /plugins/dsh-wechat-allsessions/status，确认 connected:true、polling:true、broadcastReady:true。
3. 微信发送 /help、/list 并核实对话清单与参数说明。
4. 创建一条全新 DSH 对话，不发消息，等待周期同步后核查列表；完成回答后确认微信首行 ID、第二行标题。
5. 设置页关闭某个会话广播，验证该会话不再推送、其他会话照常；微信发送 /broadcast on 会话ID，设置页应更新。
6. 使用 /session 切换微信回复目标；其他会话广播不应改掉该目标。
7. 重启 Host 后检查广播开关仍生效、旧 v1 会话路由仍然存在。
8. 若出现 no-context-token、no-account、stale-token 或其他发送失败，查发送日志和账号状态；不要直接删除历史状态文件。

本地开发目录执行 **npm test** 可验证离线回归；真实微信 iLink 收发仍须按上面流程完成端到端验收。回滚到旧插件前，建议恢复旧 sessions.json 备份（v2 中新广播字段不是旧版识别范围）。

切勿向公开 GitHub、Issue 或日志贴入真实 bot_token、context_token、二维码、用户 ID、会话内容或本机私有文件。

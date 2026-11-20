# 微信助手安装和升级（dsh-wechat-allsessions v0.4.9）

## 保持原配置及数据

**微信助手是界面显示名称，不更改包名与内部标识。** npm 包、bundle 插入 ID、设置命名空间、API 前缀仍为 **dsh-wechat-allsessions**。

更新前建议备份 DSH 用户目录中的 integrations/dsh-wechat-allsessions/sessions.json 与现有插件配置；不要删除旧微信账号、令牌或 dsh-im 状态。不要让 dsh-im 微信通道和本插件**同时消费同一微信账号的 getUpdates**，应先关闭其中一个。

## 安装

可用 DSH 插件管理器更新；若原先按本地源码 file: 方式安装，请将现有依赖更新到 0.4.9，并在当前 Profile 的配置中保留原依赖、旧 bundle 和已有个性化设置。新装时在 Cordis 补丁顶层 YAML 中增加以下 insert 项（**不要覆盖已有数组**）：

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

## v0.4.9 实机权限兼容

重启工作任务只使用与当前 DSH Desktop 根进程相同的 Windows 令牌权限级别（通过 TokenElevation 查询，不推测）。当现有 Desktop 以管理员权限运行时，工作任务和新 Desktop 启动任务也采用当前用户的最高可用权限；普通权限 Desktop 则保持普通权限。任一安全检查无法通过时拒绝结束进程。仍然只创建临时一次性任务、以 GUI 子系统辅助程序执行，不出现 CMD/PowerShell 窗口、不产生额外常驻进程。

## v0.4.8 微信启动恢复

当 Desktop 完成重启但微信 \`notifyStart\` 请求偶发失败时，桥接仍必须继续进入既有的单实例 \`getUpdates\` 长轮询，而不能留下“已连接、未轮询”的半启动状态。完成回执仍须通过新 Host 的消息轮询成功、旧进程清理和临时任务清理三重检查。此修复不修改任何微信凭据和用户路由配置。

## 重启临时资源与无窗口执行

v0.4.7 的 /restart 运行链不启动 CMD 或 PowerShell。进程检查、调度与清理使用随包发行的 Windows GUI 子系统辅助程序（PE subsystem 2）。计划任务只以当前用户交互令牌运行，不提权。

执行器停止旧 Desktop 的同安装路径进程树后，Windows 任务计划程序直接启动原安装目录的 DeepSeek Harness.exe，而不是由执行器派生一个子进程，避免执行器退出时连带结束新 Desktop。Desktop 启动任务没有运行时限。新 Host 恢复微信连接后，会删除工作任务、Desktop 启动任务和备用清理任务；若新 Host 未能启动，备用清理任务只在三分钟后触发一次并清理临时任务，没有周期计划。

“重启完成”回执前，必须确认旧进程树已退出、工作执行器已退出、临时任务全部清除，并且新 Desktop 主进程仍持续运行。清理不完整或进程不稳定时不会报告成功。此流程不增加常驻进程、不增加模型调用或微信轮询。开发者可在 Windows 上通过 \`npm run build:restart-helper\` 从 C# 源码重新构建无窗口辅助程序。

## 微信远程重启 Desktop

已绑定且受信任的微信用户发送 /restart。微信助手先发送受理消息，再通过原生辅助程序安排一次性执行。Windows 任务计划程序直接启动同一安装路径的 DSH Desktop；新 Host 载入插件、恢复微信收发，并通过进程与任务清理校验后，才向微信发送“重启完成”。同一有效期内的待执行请求不会重复重启，失败不会伪装成成功。插件运行期间不会弹出 CMD、PowerShell 或黑色控制台窗口。

正式打包版 Electron 的“重启应用与 Host”开发菜单并不向 Host 插件开放；本方案集成于微信助手，通过其专用 Windows 驱动工作，不会篡改 DSH 官方应用代码。当前插件驱动会强制终止旧 Desktop 主进程后重新启动相同 exe，而非调用正式版未公开的 app.relaunch()。此过程可能中断尚未保存的界面或运行任务。

## 移除微信账号

在设置页「连接状态与扫码」每条已保存的微信账号右侧点击「移除」，确认后通过仅限本机的 POST /plugins/dsh-wechat-allsessions/accounts/remove 解除这条账号绑定。接口要求 JSON 对象，例如 {"botId":"已保存账号的Bot ID"}，会返回剩余数量及是否需要重启 Host；普通未启用账号直接移除，当前轮询账号会先停收发、再移除，剩余账号的第一个成为下次 Host 启动的候选。如移除最后一个账号，后续可重新扫码绑定。

为兼容其他插件复用登录态，**移除操作不撤销 DSH 凭据、不删除账户目录中的私有历史会话**，只调整本插件账号配置。接口拒绝非本机来源以及跨域写入，请不要将真实 Bot ID、令牌或用户 ID 提交到公开问题单中。

## 真实环境验收

检查安装版本不能只查看 GitHub 或源码仓库：必须核验当前 DSH Profile 下 node_modules/dsh-wechat-allsessions/package.json 版本、Host 实际加载的插件代码，并查看 /plugins/dsh-wechat-allsessions/status 的 version。若 /help 仍然进入了“最新 DSH 对话”而不是由微信助手直接回复，则当前微信消息由旧插件/其他桥接接收，排查该消费者之前不要叠加启动新的 getUpdates。状态接口新增的 sendLog.kind=wechat-command 可追踪微信命令回复发送是否成功（没有用户 ID 或敏感 token）。


1. 检查已安装插件 package.json 版本为 0.4.9；设置页显示“微信助手”。
2. 启用后查看 GET /plugins/dsh-wechat-allsessions/status，确认 connected:true、polling:true、broadcastReady:true。
3. 微信发送 /help、/list 并核实对话清单与参数说明。
4. 创建一条全新 DSH 对话，不发消息，等待周期同步后核查列表；完成回答后确认微信首行 ID、第二行标题。
5. 设置页关闭某个会话广播，验证该会话不再推送、其他会话照常；微信发送 /broadcast on 会话ID，设置页应更新。
6. 使用 /session 切换微信回复目标；其他会话广播不应改掉该目标。
7. 重启 Host 后检查广播开关仍生效、旧 v1 会话路由仍然存在。
8. 若出现 no-context-token、no-account、stale-token 或其他发送失败，查发送日志和账号状态；不要直接删除历史状态文件。

本地开发目录执行 **npm test** 可验证离线回归；真实微信 iLink 收发仍须按上面流程完成端到端验收。回滚到旧插件前，建议恢复旧 sessions.json 备份（v2 中新广播字段不是旧版识别范围）。

切勿向公开 GitHub、Issue 或日志贴入真实 bot_token、context_token、二维码、用户 ID、会话内容或本机私有文件。

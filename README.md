# 微信助手（dsh-wechat-allsessions）

**v0.3.0 · DeepSeek Harness 微信 iLink 插件**

微信助手默认把 DSH **全部已有的未归档对话**与微信自动关联，新建对话也自动加入；每个对话默认开启广播。每条广播**最开头**固定显示会话 ID 和会话标题。插件设置页和微信命令都可独立开关指定对话的广播，重启后保留。

为兼容旧版数据，原 npm 包名、插件标识、配置命名空间、HTTP 接口前缀及 GitHub 仓库名称仍为 **dsh-wechat-allsessions**。**微信助手只是显示名称，不要将 Cordis ID 修改成中文。**

## 核心功能

- **自动绑定**：启动读取 DSH 会话清单；监听 session/event，新会话无消息时仍每 15 秒巡检；归档对话自动排除广播。
- **自动广播**：新安装启用开关、全局广播开关默认均开启；每个会话的广播开关默认开启。历史上明确关闭过的配置保持不变。
- **清晰的消息头**：先显示“对话ID”“对话标题”，再显示本轮最终回复；末尾可选续接提示。
- **独立的回复路由**：微信发送 /session 选择一个对话来接收后续微信消息；其他会话广播不会覆盖此选择。
- **双端同步管理**：设置页按会话切换广播，微信 /broadcast on/off 也能切换；使用同一持久数据。
- **账号安全**：只有绑定所有者或明确授权的默认微信用户能读取会话、发送命令。微信上下文令牌仅按用户复用，旧 dsh-im 状态只读。
- **原有配置迁移**：原 sessions.json 中 v1 的 users 路由自动兼容新增的 v2 sessions 注册信息，旧回复绑定不丢失。

## 微信命令大全

| 微信消息 | 说明 |
|---|---|
| **/help** | 查看所有指令及使用说明 |
| **/list**、**/sessions** | 列出全部已登记、未归档的会话及广播状态 |
| **/session 会话ID** | 选择微信发来的普通文字所进入的 DSH 对话 |
| **/broadcast list** | 列出所有对话的广播开关 |
| **/broadcast off 会话ID** | 关闭该会话广播 |
| **/broadcast on 会话ID** | 开启该会话广播 |
| **/broadcast on**、**/broadcast off** | 操作当前已选择的会话 |
| **/broadcast status [会话ID]** | 查看指定（或当前）会话的广播状态 |
| **/clear**、**/new** | 清除微信回复目标；不删除 DSH 会话和广播设置 |
| **普通文字消息** | 提交到 /session 选择的会话 |

### 广播消息示意

~~~text
对话ID：session-abc
对话标题：墨界 Inkverse

本次开发任务已经完成，回归测试通过……

继续对话：/session session-abc
~~~

默认发送**新完成的最终文字回复**，不回填旧消息，不传输文件、图片、审批或工具执行过程。内部/定时和子代理完成的回复默认纳入，也可通过设置关闭；微信自己发起的对话回合完成时也会得到回复。

## 主要配置

| 字段 | 新安装默认值 | 含义 |
|---|---|---|
| **enabled** | true | 桥接启停，变更后需重启 Host |
| **broadcastAll** | true | 全局广播总开关 |
| **defaultUserId** | 空 | 留空使用绑定微信账号的 ownerUserId |
| **includeInternal** | true | 包含内部/定时及微信发起回合 |
| **includeSubagents** | true | 包含子代理回合 |
| **includeSessionHint** | true | 消息末尾带 /session 续聊命令；开头对话 ID、标题固定不隐藏 |
| **maxChunkBytes** | 1500 | 每段最多字节数，最多发送 20 段 |
| **routeStorePath** | 空 | 会话路由及广播开关文件路径覆盖值 |
| **accountConfigPath** | 空 | 微信账号配置文件路径覆盖值 |
| **statePath** | 空 | 微信状态文件根目录覆盖值 |

原有已持久化 enabled:false 或 broadcastAll:false 会得到尊重，**不会因升级被强行开启**。需要自动广播时，在设置页主动启用即可。未扫码的全新安装也会登记 DSH 对话，但账号连接前不会发送微信消息。

会话数据默认路径：**~/.dsh/integrations/dsh-wechat-allsessions/sessions.json**。请升级前备份。原 DSH 微信账号配置及 iLink 状态沿用原位置，本插件不会写回 dsh-im 的旧 state.json。

## 安装、升级和故障定位

请阅读 [安装与升级指南](docs/INSTALL.md)，并确保同一微信账号**不能有两个 iLink getUpdates 消费者**：运行微信助手时，要停用 dsh-im 内对应的微信接收通道，否则可能丢消息、重复消息。

在设置 → **微信助手** 可查看自动绑定清单与开关。若无法广播，请核对本机 **GET /plugins/dsh-wechat-allsessions/status**：

- **connected**：已加载微信绑定账号。
- **polling**：长轮询正在运行。
- **broadcastReady**：收件人的微信上下文令牌已就绪。若为 false，请用绑定的微信号向机器人发送一次 **/help**，让该用户的令牌建立后重试。
- **sendLog**：记录 no-account、no-context-token 等具体拒发原因。

广播列表与微信普通消息路由独立。微信 /session 选择目标后，其他会话完成广播不会抢走回复目标。

## 本机 HTTP 接口

原路径均保持不变（仅回环访问；POST 校验 Origin、限制请求体大小）：

| 路径后缀 | 方法 | 用途 |
|---|---|---|
| **/config** | GET / POST | 获取/保存全局设置 |
| **/status** | GET | 状态、账号、会话数、广播就绪度与发送日志 |
| **/sessions** | GET | 已绑定的未归档会话、会话 ID、标题、广播状态 |
| **/sessions** | POST | JSON 请求体为 sessionId 和 broadcastEnabled 布尔值，修改指定会话开关 |
| **/login** | POST | 新账号二维码与扫码登录状态 |

公共前缀为 **/plugins/dsh-wechat-allsessions**。

## 开发和验证

~~~bash
npm test
~~~

离线测试使用假的账号和消息传输，覆盖自动发现、广播启停、历史迁移、权限边界、上下文令牌隔离、断连后重试、微信命令。**离线测试不等于真实微信 iLink 端到端验收**；实际安装后仍应在单独测试会话发送消息并检查微信是否真正收到。

MIT License。第三方版权说明见 [NOTICE](third_party/NOTICE.txt)。

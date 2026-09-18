# 测试与验收报告

## 2.1.0 会话生命周期验收（2026-09-15）

本版将产品重命名为 **TmuxDock**，明确定位为“从本地 VS Code 停靠和管理远程 tmux 会话”，Agent CLI 是首要使用场景而不是产品边界。Marketplace 正式版使用 `mingwangsong.remote-agent-sessions`；命令和配置键保持不变，并新增 schema 2 备份导入，以便从开发版安全迁移本地主机与恢复记录。

同时把 New Session、Rename、Delete 提升为完整的一等功能。New Session 只保留在在线服务器行，手动 Refresh 也从顶栏移到对应服务器行。会话树不再在右侧描述重复 tmux 名，该位置只显示 Git 分支和可重建状态等附加信息。New Session 提供可输入、可逐级进入且实时查询子目录的远端目录选择器；名称只输入一次，同时作为显示名与真实 tmux 名。远端已有 tmux 不再显示 `unmanaged`，而是作为普通会话使用；**Enable Recovery** 只是可选的快照能力。Delete 经二次确认后停止远端 tmux 并清除本地元数据。原有 Terminate（保留可重建记录）和 Forget（保留远端进程）继续提供。

自动化结果：29/29 单元、持久化、SSH 参数、主机注册与备份迁移测试通过；此前完成的 12/12 真实 tmux/Git 集成、9/9 源码 VS Code Extension Host 检查、9/9 最终 2.1.0 VSIX 安装检查继续有效。测试包含备份格式验证、无覆盖合并、远端子目录枚举、单一名称、中文/空格名称、已有/可恢复会话的重命名和删除、真实 tmux 名变化、记录同步、所有权保持，以及 New Session/Refresh 只存在于对应服务器行、会话描述不重复名称。

安全边界：生命周期操作使用 tmux ID、创建时间和插件 owner 标记识别实例；如果同名会话在用户操作前被替换，插件拒绝重命名、终止或删除。真实 tmux 测试均运行在随机独立 socket，未接触默认 tmux server。

## 2.0.1 中央编辑区终端验收（2026-09-15）

点击 live session 时，扩展现在显式使用 VS Code 的 TerminalEditorLocationOptions，在当前活动编辑器列打开 terminal editor；不再依赖用户的全局终端默认位置。扩展宿主测试会读取终端 `creationOptions.location`，验证 `viewColumn` 为 Active 且 `preserveFocus` 为 false。用户可将 `remoteAgentSessions.sessionTerminalLocation` 改为 `panel` 恢复集成终端面板行为。

真实 UI 验收在本机新 VS Code 窗口连接隔离测试主机：临时测试会话点击后成为中央 Editor Group 1 的终端标签，右侧栏和底部 Panel 均保持关闭；关闭该标签后远端会话仍存在且 attached=0。随后精确删除临时会话，预先存在的会话保持不变。

## 2.0.0 本地多主机控制器验收（2026-09-14）

2.0 将扩展从远端 workspace host 移到本地 UI host。本机安装一次后，通过系统 OpenSSH 查询并连接配置的服务器；会话记录按主机保存在本地。最终自动化结果为 24 项单元/持久化/SSH 测试、11 项真实 tmux/Git 集成、8 项源码 VS Code 宿主和 8 项最终 VSIX 宿主检查，全部通过。

真实远程主机另完成两层测试：随机独立 tmux socket 的 SSH 创建、窗口/分屏、快照、停止、重建与清理；以及本地 VS Code UI 添加主机、枚举原有会话、点击附着、关闭本地终端后确认 tmux 存活。UI 验收期间只创建并删除隔离的临时会话，预先存在的会话保持不变。

### 2.0 已验证的新增行为

1. `extensionKind` 为 `ui`，最终 VSIX 在本地扩展宿主激活；远端无需安装插件。
2. 主机作为树根节点，多台 SSH 主机的 tmux 会话可在一个侧栏聚合。
3. 状态查询采用 BatchMode 与连接超时；交互 attach 使用 `ssh -tt` 并允许正常认证交互。
4. 主机、路径、socket 和远端 argv 均验证或逐项 POSIX 引用，拒绝选项注入、换行与 NUL。
5. macOS/Linux 使用短 ControlPath 的 OpenSSH 连接复用；真实主机完整集成从首次约 46 秒降到约 7.5 秒。
6. 本地终端实际连接远端 tmux；重复点击复用终端，关闭终端只 detach、不终止会话。
7. 本地记录按主机隔离；在线刷新保存远端窗口、分屏、布局、目录与 Git 信息。
8. 隔离 tmux server 消失后，本地控制器显示可重建，并恢复布局、备注与显式命令。
9. 1.x 远端记录提供只读导入；导入不删除旧文件。
10. 新活动栏 SVG 在本地 VS Code 中实际可见。

### 真实主机现场状态处理

- 检查到旧版 1.0.0 远端 globalStorage 没有会话记录，因此无需迁移。
- 在真实 UI 验收成功后卸载远端 Agent Sessions 1.0.0，保留 Claude Code 官方插件。
- 本地 Agent Sessions 2.0.0 继续通过 SSH 显示该主机原有 5 个 tmux 会话。

### 2.0 验证边界

- 没有重启真实服务器；重建用独立 tmux socket 模拟 server 消失。
- 没有运行真实付费 Agent 请求；CLI 续聊能力仍取决于 Claude/Codex 等工具自己的 resume 命令。
- 未测试密码/MFA 的自动状态刷新；此类认证应先在普通终端建立凭据或使用 Open SSH Terminal 交互处理。
- 未完成 Windows 本机、ProxyJump、多跳、不同发行版和外部用户可用性测试。
- 本地元数据尚未提供跨电脑自动同步。

### 2.0 可复现命令

```bash
npm ci
npm run verify
npm run test:integration
npm run test:vscode
RAS_SSH_HOST=你的测试别名 npm run test:ssh
npm run package
npm run verify:package
RAS_TEST_VSIX=dist/remote-agent-sessions-2.0.0.vsix npm run test:vscode
```

## 1.0.1 品牌更新验收（2026-09-13）

新版本增加产品 PNG 图标、产品文档和打包/测试基础设施，src/ 会话运行代码不变。16 项单元/持久化、11 项真实 tmux/Git、7 项最终 VSIX 的实际 VS Code 宿主检查全部通过。打包校验包含源码、图标逐字节一致性及运行依赖完整性。首轮受限沙箱不能正常创建 tmux pane；取得执行权限后同一代码复跑通过。原始结果摘录见源码 docs/evidence/。

随后补充的 1.0.0 用户实机 Remote SSH 验收也通过：远端 Linux x64 / tmux 3.4 / Node 20.20.2，13 项远程宿主检查及 16 + 11 项服务端测试通过；原有 4 个 tmux 会话未被修改。未真实重启服务器，未调用付费 Agent。

## 1.0.0 原始验收

日期：2026-09-13。目标：VS Code Remote 场景的会话管理、断线保活、重启后工作区重建和任务记录持久化。

## 实际环境与结果

| 环境 | 检查 | 结果 |
| --- | --- | --- |
| macOS 26.3 arm64 / Node 25.6.1 | 语法检查、单元及持久化测试 | 16/16 通过 |
| macOS / tmux 3.6a | 真实 tmux 与 Git 集成 | 11/11 通过 |
| Ubuntu 24.04 arm64 容器 / Node 18.19.1 | 单元及持久化测试 | 16/16 通过 |
| Ubuntu 24.04 / tmux 3.4 | 真实 tmux 与 Git 集成 | 11/11 通过 |
| VS Code 1.137.0 arm64 独立新窗口 | 源码扩展宿主验收 | 7/7 通过 |
| 最终 VSIX 安装目录 | 扩展宿主运行验收 | 7/7 通过，CLI 安装成功 |

## 已验证的关键行为

1. 创建会话并在真实 pane 内执行命令；重新实例化管理器后仍能读取备注、恢复命令和活动会话。
2. 模拟 tmux server 消失后，从磁盘记录重建多个窗口、多个分屏、原目录和布局；包含中文、空格、单引号目录及重名窗口。
3. 两个独立管理器并发创建同名任务，生成唯一 tmux 名称且互不覆盖记录。
4. 多次或并发点击恢复，文件计数器证明恢复命令只执行一次。
5. 手工重命名 tmux 后跟踪原身份；同名但不同身份的会话禁止误连接或误终止。
6. 目录缺失时，在创建任何恢复进程之前失败。
7. 注入第二窗口创建失败，完整清理本次重建的空壳会话并保留恢复记录，随后可成功重试。
8. 纳管已有会话，兼容 base-index=1 与分屏；删除记录后进程继续运行。
9. 选择仅恢复 shell 时，已保存的命令不产生副作用。
10. 旧版 0.1 记录升级为带身份的快照，已有恢复命令保留。
11. 在真实 Git 仓库子目录中记录仓库根路径、分支和 detached HEAD 短哈希。
12. 六个独立 Node 进程并发写入，60 条记录全部保留。
13. 文件权限为 0600；原子更新保留上一版备份；数据库损坏、格式错误、回调失败及模拟 ENOSPC 不覆盖最后有效数据。
14. 异常遗留的过期文件锁可恢复；失败后可继续成功写入。
15. 在实际 VS Code 中加载扩展、枚举所有贡献命令、检查侧边栏项；真实终端可 attach，重复点击复用终端。
16. 关闭 VS Code 终端后 attached client 归零，远程 tmux 继续存在；后台刷新可自动保存新窗口。
17. 在实际 VS Code 中调用恢复命令，重建并重新连接；任务详情能显示重载后的备注。

## 本轮发现并修复的问题

- 旧实现在多个 VS Code 窗口之间存在整库覆盖和临时文件冲突。
- 手工增加的窗口/分屏无法自动进入恢复记录。
- 恢复失败留下半成品，会话命令可能在重复恢复中再次执行。
- attach 反复创建终端，且依赖默认 shell 拼接命令。
- 同名 tmux 复用缺乏身份检查。
- tmux 不可用时，记录状态可能被误报为可恢复。
- tmux 的 set-option 目标语法与部分命令不同。
- tmux 3.4 在 Linux 中会转义原控制字符分隔符；已换用随机可打印分隔符，并在 macOS、Linux 实测。
- 原工程没有实际可安装的 VSIX；现使用官方打包工具生成并包含全部运行时依赖。

## 验证边界

- 原始验收的 Linux 逻辑在 Ubuntu 容器运行；之后已补充用户实际 SSH 主机测试（见本报告顶部）。其他主机的远程权限、shell 启动脚本、系统清理策略仍需按具体环境验证。
- 重启恢复以停止独立 tmux server、保留磁盘记录、创建新管理器的方式验证，没有重启用户电脑或服务器。
- Agent CLI 用普通测试命令替代；未消耗用户模型配额，也未验证每个 Agent 版本的登录与对话 resume 行为。具体旧对话需配置该 CLI 提供的恢复命令。
- 详细对话、完整终端输出、跨服务器同步和离线期间新增窗口的自动快照不在 1.0.0 功能范围。
- VS Code 交互测试覆盖实际命令注册、侧边栏数据、终端生命周期、自动刷新、详情和恢复；未声称覆盖所有主题、键盘布局及每一种对话框输入组合。

## 可复现命令

```bash
npm ci
npm run verify
npm run test:integration
npm run test:vscode
npm run package
RAS_TEST_VSIX=../remote-agent-sessions-1.0.0.vsix npm run test:vscode
```

测试源码位于 test/、integration/、scripts/。独立 tmux socket、临时目录和测试窗口在结束后清理；默认 tmux server 和日常 VS Code 配置不参与测试。

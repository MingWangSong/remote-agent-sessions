# 五分钟演示与验收脚本

目标：证明 2.1 从本地 VS Code 管理远端主机，会话在本地终端关闭后继续运行，并且任务记录可用于重建。历史实测证据见 `evidence/README.md`。

## 安全准备

使用一台测试服务器和一个专用 tmux socket，例如 `ras-public-demo`。添加主机时在 **tmux Socket Name** 填入该值；已有主机也可通过 **Edit Host Configuration** 修改。不要在默认 socket 上演示杀死 tmux server。录屏前隐藏用户名、IP、私有代码、端口、真实 Agent 对话和凭据。

## 操作、预期与证据

| 步骤 | 现场操作 | 通过标准 / 建议截图 |
| --- | --- | --- |
| 1：本地安装 | 从 VSIX 安装 2.1，打开扩展详情 | 显示 Installed Locally；远端无需插件 |
| 2：添加主机 | TmuxDock 点击 Add SSH Host，输入测试 SSH 别名和专用 socket | 主机显示 online，现有测试会话成为子项 |
| 3：创建 | 点击测试服务器行上的 New tmux Session，从子目录候选选目录，输入一次 `demo-persistent-task`，选择 Shell | 会话以同一个显示名/tmux 名出现并打开本地 SSH 终端 |
| 4：任务运行 | 在终端运行下方计时命令 | 每 2 秒输出；记下 tmux pane PID |
| 5：保存进度 | 右键 Edit Session Note，写 `已完成环境准备；下一步检查结果` | Show Session Details 显示相同备注 |
| 6：保活 | 关闭这个本地终端，再次点击同一会话 | tmux 仍存在、PID 未变、日志覆盖断开期间 |
| 7：布局 | Ctrl-C 停止计时器，增加一个 tmux 窗口和分屏，等待刷新 | 详情快照包含 2 个窗口、分屏与目录 |
| 8：重建命令 | 给一个分屏设置 `printf 'DEMO_RESTORED\n'` | 详情显示该命令且无凭据 |
| 9：故障模拟 | 再次确认主机使用 `ras-public-demo`，只停止这个 socket 的 tmux server | 会话变为 rebuild available，其他 tmux 不受影响 |
| 10：恢复 | 点击 Restore，选择运行命令 | 布局重建、出现 DEMO_RESTORED、备注仍在 |
| 11：改名 | 右键 Rename Session，把显示名和 tmux 名改为 `demo-renamed` | 侧栏、详情和 `tmux list-sessions` 同步变化 |
| 12：清理 | 右键 Delete Session 并确认，移除测试主机配置 | 远端 tmux 与本地记录均消失，日常主机不受影响 |

步骤 4：

```sh
tmux display-message -p '#{pane_pid}'
while true; do date -u '+%Y-%m-%dT%H:%M:%SZ'; sleep 2; done | tee demo-heartbeat.log
```

步骤 9 只能操作自己配置的专用 socket：

```sh
tmux -L ras-public-demo list-sessions
tmux -L ras-public-demo kill-server
```

绝不能省略 `-L ras-public-demo`，否则可能终止默认 server 的全部任务。本演示模拟 tmux server 消失，不声称执行了真实服务器重启；示例命令也不代表所有 Agent 都能恢复历史对话。

## 真实远程主机验收

已在本地 VS Code 通过本机 OpenSSH 添加一台隔离测试主机，识别预先存在的会话，并创建临时测试会话完成点击附着。远端 attached 数从 0 变为 1；关闭本地终端后回到 0，而 tmux 仍存活。测试会话随后精确删除，预先存在的会话未被终止。

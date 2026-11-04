# 从私有正式版到公开推广

当前状态：公开仓库与 Marketplace 已于 2026-09-18 发布 2.1.0。Publisher 为 `mingwangsong`，扩展 ID 为 `mingwangsong.remote-agent-sessions`。2.4.0 已完成本地回归、最终 VSIX 安装和实际窗口重载验收；发布时更新同一市场条目，不创建新 publisher。

## 发布前必须完成

1. **明确首批受众。** VS Code + OpenSSH + tmux + Agent CLI 用户，不笼统声称适合所有 AI 开发工具。
2. **找 5–10 位外部试用者。** 覆盖不同 SSH 配置、认证方式和 Linux 发行版，让他们独立完成安装、添加主机、连接、备注和重建；记录成功率和阻塞点。
3. **录制真实演示。** 按 `DEMO.md` 拍 3–5 分钟完整演示和 30 秒短版；遮挡主机、代码、对话和密钥。
4. **提供可信下载入口。** 内测分发 VSIX 与 SHA-256；公开用户无法访问当前私有仓库，需要 Marketplace 或公开发布页。
5. **注册正式 Marketplace publisher。** 正式 publisher 为 `mingwangsong`，本地兼容开发版仍为 `local`。从开发版转到市场版须先导出备份，再导入正式版，避免因扩展 ID 不同而看不到原 globalStorage。
6. **补齐支持与安全说明。** 发布兼容性矩阵、隐私说明、问题反馈入口和依赖许可证；保持默认无遥测，不采集 SSH 凭据或会话内容。
7. **发布后用真实数据推广。** 公开演示、测试范围与限制，观察新用户首次成功率、一次断线续接成功率和一周留存，不虚构下载量或评价。

源码是否公开与 Marketplace 上架是两个决定：可以继续保持私有源码并发布扩展包，但必须为用户提供可访问的安装与更新渠道。

## 已有的证明材料

- 25 项单元、持久化、SSH 参数与主机注册测试。
- 12 项本机真实 tmux/Git 集成测试。
- 9 项源码扩展宿主测试和 9 项最终 VSIX 宿主测试。
- 隔离 socket 的真实 SSH 创建、布局、停止、重建、重命名和删除测试。
- 本地 VS Code 点击真实远端会话，验证 attach → 关闭本地终端 → tmux 继续存活。
- 最终 VSIX 内容与源码逐文件一致性、依赖完整性和 SHA-256 校验。

这些证明软件在已测环境中工作，不等于所有主机、认证方式和 Agent CLI 都已兼容。

## Marketplace 操作依据

VS Code 官方支持把扩展打成 VSIX 分享，或注册 publisher 后发布到 Marketplace。正式发布凭据不得进入仓库、恢复命令或聊天记录。

参考（2026-09-13 核对）：[VS Code 官方发布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。

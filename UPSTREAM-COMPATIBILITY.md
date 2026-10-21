# Harness 更新兼容检查

`Harness compatibility` 工作流每日检查 npm `latest` 和 `next`，也支持手动运行及 PR 验证。它使用 Node 24、空白 DSH 数据目录和临时插件副本，不使用账号凭据。

每个候选版本执行完整测试（失败或跳过均阻止通过），启动真实 Web Profile，再用 Chromium 打开插件配置页、读取未登录状态、保存配置并重新加载检查。会话管理插件的对应工作流还验证真实会话回收、恢复和删除。

只有两条渠道的检查都通过，工作流才会更新精确 peerDependencies 并建立 `automation/harness-compatibility` PR。不会自动合并、修改产品逻辑或发布；接口变化导致失败时，保留测试、服务日志和页面截图供修复。浏览器验证使用全新 profile，因此不代表日常所有第三方插件组合或带登录模型调用均已验证。

本地运行：

```sh
node scripts/check-upstream.mjs latest /tmp/dsh-compat-result
# 已有 Chromium 时可指定可执行文件，省去下载：
DSH_TEST_BROWSER=/opt/google/chrome/chrome node scripts/check-upstream.mjs next /tmp/dsh-compat-result
```

仓库需启用 GitHub Actions，并允许 Actions 创建 PR。由 GITHUB_TOKEN 创建的 PR 不会自动触发后续 push/PR 工作流；该 PR 的依据是创建前已完成的兼容检查，证据链接写在 PR 正文。需要重跑时可手动触发本工作流。

本机更新器另行执行完整 profile 组合检查，并使用固定插件安装包。运行 `dsh-update latest --check-only` 验证候选；运行 `dsh-update latest` 验证后切换。更新前的运行数据保存在 `~/.dsh/backups/verified-update-*`，启动健康检查失败时恢复数据与旧版本。运行中的源码变化会中止更新。

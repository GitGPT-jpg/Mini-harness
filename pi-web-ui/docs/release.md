# 构建与发布

本仓库是上游 pi-web-ui 的定制源码版，来源见 [PROVENANCE.md](../PROVENANCE.md)。
package 元数据仍保留上游包名/仓库信息；不能据此把本仓库改动发布到上游 npm 包或上游仓库。

## 本地交付检查

在源码目录执行 `npm run typecheck`、`npm run lint`、相关 vitest 与 `npm run build`；
协议变化检查 `npm run check:protocol`，UI 变化验证实际页面，服务变化跑对应隔离冒烟。
格式化只处理本次改动，详细规则见 [开发工作流](development.md)。
纯文档交付检查引用和 diff，不宣称未运行的测试通过。

当前构建脚本为 build:web + build:server。原 Electron、插件/浏览器扩展发布流水线已移除，
不能继续调用其构建命令。仓库级打包入口为 `build/package.sh`（在仓库根运行），
产生 tarball 和 macOS 启动器 DMG；是否可交付应以本次打包及安装验证为准。

## 版本与发布目标

只有任务包含发布时才确定目标仓库、包名、版本、平台和凭据并执行发布。
升版本须同步 package.json 与 package-lock.json；保留 MIT 许可证及来源记录。
CHANGELOG 按实际交付提交写，语言变化可用 `npm run changelog:i18n` 生成记录；
`scripts/release-notes.mjs` 可预览说明，保留的 release-notes workflow 不等于本仓库已配置发布权限。

提交/推送前审查 diff，避免把其他窗口的修改一起纳入。不把旧交接中的推送状态当作当前远端状态。
更新构建产物后，运行中的后端仍是旧内存代码，需按部署方式重启；保持端口交接和会话排空规则。
不使用 npm 安装上游最新版来替换定制源码。

## 发布内容安全

示例使用 localhost、example.com 或占位符，不写真实公网地址、API key、cookie、
用户 kubeconfig、auth.json 或带口令的截图。检查归档内容，避免将运行态数据和测试临时凭据一起打包。
新增文档/文件后核对 gitignore，防止该交付的源码被忽略或不该交付的凭据进入版本库。

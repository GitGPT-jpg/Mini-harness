# 环境变量

事实源：`server/harness-env.ts`、`bin/harness.mjs` 和各配置的读取模块。
以下列出当前服务使用的配置；DSH、界面插件市场、设置预设分享和 Electron sidecar 的专属变量已退役。

## HARNESS 别名与优先级

`syncHarnessEnv()` 把映射表中**非空** HARNESS 值写入兼容变量，覆盖已有兼容值；
空字符串不覆盖。显式服务端 CLI 参数（如 `--port`）优先于环境变量。
映射是列举式的，不能给任意 PI_WEB 变量换前缀就认为有效。

| HARNESS 变量                     | 兼容变量                        | 服务默认值与用途                                             |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `HARNESS_PORT`                   | `PI_WEB_PORT`                   | 8787；HTTP/WS 端口                                           |
| `HARNESS_HOST`                   | `PI_WEB_HOST`                   | 127.0.0.1；默认仅 loopback                                   |
| `HARNESS_CWD`                    | `PI_WEB_CWD`                    | process.cwd()；会话工作目录                                  |
| `HARNESS_DATA_DIR`               | `PI_WEB_DATA_DIR`               | ~/.pi-web；客户端状态等数据                                  |
| `HARNESS_TOKEN`                  | `PI_WEB_TOKEN`                  | 空；共享口令，auto 写入数据目录的 pi-web-token               |
| `HARNESS_SDK`                    | `PI_WEB_SDK`                    | SDK 解析器默认跟随较新的祖先副本；bundled 固定随包副本       |
| `HARNESS_SDK_DIR`                | `PI_WEB_SDK_DIR`                | 空；SDK 副本选择提示，见 resolve-global-sdk.ts               |
| `HARNESS_AGENT_DIR`              | `PI_CODING_AGENT_DIR`           | ~/.pi/agent；模型、凭据、技能、会话                          |
| `HARNESS_ALLOW_HOSTS`            | `PI_WEB_ALLOW_HOSTS`            | 空；逗号分隔 Host hostname 白名单                            |
| `HARNESS_ALLOW_ORIGINS`          | `PI_WEB_ALLOW_ORIGINS`          | 空；额外 WS Origin 白名单                                    |
| `HARNESS_HISTORY_WINDOW`         | `PI_WEB_HISTORY_WINDOW`         | 300；首份快照历史条数，另有字符预算；0/off/false/no 关闭窗口 |
| `HARNESS_TOOL_TIMEOUT_MS`        | `PI_WEB_TOOL_TIMEOUT_MS`        | 1200000；工具看门狗部署默认值，已保存设置优先                |
| `HARNESS_TOOL_LAZY_LOADING`      | `PI_WEB_TOOL_LAZY_LOADING`      | **默认开**；仅 0/off/false/no 关闭，已保存设置优先           |
| `HARNESS_SHELL`                  | `PI_WEB_SHELL`                  | 自动探测；PTY shell 显式覆盖                                 |
| `HARNESS_DEV_CACHE`              | `PI_WEB_DEV_CACHE`              | 服务器映射表支持；1/true 开开发缓存                          |
| `HARNESS_MAX_SUBAGENTS`          | `PI_WEB_MAX_SUBAGENTS`          | 16；活跃轻量子代理并发上限                                   |
| `HARNESS_MAX_OPEN_CONVERSATIONS` | `PI_WEB_MAX_OPEN_CONVERSATIONS` | 8；每项目普通对话上限                                        |

最后三项仅在服务端映射表中，当前 CLI 的提前映射表没有它们。
`HARNESS_ENGINE` → `PI_WEB_ENGINE` 仍保留兼容映射，但服务端固定使用 pi；它不能恢复已删除的引擎。

**启动路径有区别**：`bin/harness.mjs` 在导入 CLI 前映射主要变量；直接导入 server/index 时，
部分模块会在 `syncHarnessEnv()` 执行前初始化常量。对工具默认值、agent-dir 等初始化敏感配置，
应使用 harness CLI，或在进程启动前显式设置相应兼容变量。SDK 解析器直接读取 HARNESS_SDK/SDK_DIR。

仓库的 `pi-web-cockpit/start-hardened.sh` 默认设置 PI_WEB_TOKEN=auto、PI_WEB_LOCALE=zh、
PI_WEB_MANAGED=1、PI_WEB_SDK=bundled，并显式传入 host=127.0.0.1、port=${PI_WEB_PORT:-8787}、
cwd=仓库根。因此通过该脚本改端口用 PI_WEB_PORT；只设 HARNESS_PORT 不会覆盖脚本已传入的参数。
开发脚本也显式设置兼容端口与 Vite Origin，隔离验证时应核对最终启动命令。

## 其他有效配置

以下没有 HARNESS 别名，仍使用原名。

| 变量                                        | 默认              | 用途/事实源                                                    |
| ------------------------------------------- | ----------------- | -------------------------------------------------------------- |
| `PI_WEB_STALL_NOTIFY_MS`                    | 180000            | 无 SDK 事件的流式告警，0 关闭，不自动 abort；agent-service.ts  |
| `PI_WEB_OFFLINE_ROWS_TTL_MS`                | 1800000           | 离线会话行宽限期，0/off/false/no 关闭，上限 6 小时             |
| `PI_WEB_VISION_TIMEOUT_MS`                  | 90000             | 视觉桥转写超时；vision-bridge.ts                               |
| `PI_WEB_TERMINAL_IDLE_MS`                   | 15000             | agent 触碰终端后的静默提示，0 关闭；terminals.ts               |
| `PI_WEB_TERMINAL_IDLE_LINES`                | 10                | 静默提示的尾部行数，限制 1..500                                |
| `PI_WEB_UPLOAD_RETENTION_DAYS`              | 14                | 上传清理保留期，0 关闭；uploads.ts                             |
| `PI_WEB_SUBAGENT_WAIT_CAP_SECONDS`          | 看门狗的 0.8 倍   | 子代理 wait 上限；subagents.ts                                 |
| `PI_WEB_GIT_EXTENSION_CHECK`                | 开                | pi 的 git 源扩展更新检查，0/false/no/off 关闭；update-check.ts |
| `PI_WEB_LOCALE`                             | 自动探测          | 首访语言回退，不覆盖用户选择；locales.ts                       |
| `PI_WEB_LOCALE_BASE_URL`                    | 上游 raw 仓库地址 | 语言包下载根；先版本 tag 再 main；index.ts/locales.ts          |
| `PI_WEB_MANAGED`                            | 关                | 1/true/yes/on 禁止应用内更新/安装引擎；managed.ts              |
| `PI_WEB_TABS`                               | 未限制            | 保留视图白名单，chat 不可关；tabs.ts；不恢复已裁剪的面板       |
| `PI_WEB_LAUNCHED_BY`、`PI_WEB_SERVICE_NAME` | 空                | 平台服务安装器写入的来源标记；launch-origin.ts                 |
| `PI_WEB_PKG_ROOT`                           | 自动定位          | 包根显式覆盖；pkg-info.ts                                      |
| `PI_EVAL_PROJECT_DIR`、`PI_EVAL_WORKDIR`    | 空                | eval 子进程的项目/工作目录注入；eval-tool.ts                   |
| `PI_WEB_CHROME`                             | 自动探测          | 测试使用的 Chrome 可执行文件；tests/lib/chrome.mjs             |

## Loop 与集群

| 变量                        | 默认                 | 用途                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------ |
| `MINI_HARNESS_RUNTIME_ROOT` | ~/.mini-harness/runs | Loop state/journal/evidence 根目录，独立于 UI data-dir |
| `HARNESS_ROOT`              | 空                   | 自动寻找 validate.py 的候选根；不是通用配置前缀        |
| `KUBECONFIG`                | kubectl 默认规则     | 集群连接；界面保存配置后服务进程更新该值               |

`HARNESS_METRIC: {...}` 是 validator 标准输出中的指标标记，**不是环境变量**。
经验卡片写到 `<DATA_DIR>/knowledge/`，并在相应 run 目录备份。

## 鉴权与生效边界

口令可通过 Bearer、X-PI-Token、查询参数或 pi_web_token cookie 提供。
auto 模式复用 `<DATA_DIR>/pi-web-token`，首次生成文件权限为 0600。
health 探针开放，但匿名 health 请求不能反射 token cookie；cookie 值解码后比较。
Host 校验和 Origin 校验按 `server/index.ts` 的各自规则执行，不能因开放一个白名单就移除另一道检查。

工具超时和按需加载是部署默认值，已存盘偏好优先；其余配置是否动态读取取决于读取点，
改环境后重启是可靠的生效方式。不要把旧文档中列出的变量视为一定有消费者；
验证新变量时应检查启动器、导入顺序和最终读取点。

更多说明：[部署](deployment.md)、[工具预算](tool-context-budget.md)、[核心架构](architecture-core.md)。

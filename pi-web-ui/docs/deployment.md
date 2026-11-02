# 部署

当前是 pi-only 的 Node + Express + WebSocket 服务。
原 Electron 桌面壳已删除；仓库 setup 生成的 macOS 启动器不是 Electron 应用。
首次安装与源码构建由仓库根 `setup.sh` 负责，启动用 `pi-web-cockpit/start-hardened.sh`。

## 启动入口

以下前台命令在源码目录执行（先安装依赖并构建）：

```bash
node bin/harness.mjs --port 9000 --cwd /path/to/project
```

package bin 还提供 harness / mini-harness，以及兼容名 pi-web-ui / piwebui。
保留的服务管理命令为 `server install|uninstall|start|stop|restart|status`，
另有 `server shortcut`、`quiesce`、`unquiesce`。按 `bin/pi-web-ui.mjs` 的帮助使用。
界面插件 install/plugins/uninstall 命令已移除，不能再用来安装 wiki；wiki 是 setup 管理的 pi 扩展。

服务端参数包括 `--port`、`--host`、`--cwd`、`--data-dir`、`--agent-dir`、`--no-browser`。
只支持 pi，旧 engine 参数/变量不能恢复 DSH。
环境别名、默认值与导入时序限制见 [环境变量](env-vars.md)。

仓库启动脚本默认 loopback:8787、auto token、bundled SDK 和 managed 模式。
它显式传入 port/host/cwd，隔离测试通过 PI_WEB_PORT 改端口；不要追加重复的 --port。
生产工作区应是具体项目目录，避免把家目录根用于递归扫描。

## 平台服务与 Docker

兼容 CLI 的 `server install` 支持 macOS launchd、Linux systemd 和 Windows HKCU 登录 Run 键。
Windows 使用 wscript/VBS 隐藏启动器及看门狗，不需管理员；服务崩溃后可自动重启。
旧任务计划安装的迁移、快捷方式和 PID 清理都在 CLI 中处理。
服务安装时显式给 cwd/data-dir，避免意外使用默认目录。

Linux 安装器会把 PI_WEB_TOKEN 写入 unit；非特权端口不添加 capability，
1–1023 端口使用 CAP_NET_BIND_SERVICE，服务仍以调用用户运行。
安装文件及 systemctl 操作才提权，配置经 stdin 传递，token 不放在命令行参数中。
unit 使用 0600；`--print` 会打印完整配置（可能含 token），不要公开其输出。
重装会 daemon-reload 并重启，需再次提供 token；环境变量不等于秘密存储。
其他平台需要检查生成的服务环境，不能假定交互 shell 的 PATH/locale/凭据会被继承。

Docker 的构建和挂载以本仓库 Dockerfile/docker-compose.yml 为准；不要替换成上游预构建镜像。
容器监听需显式配置 0.0.0.0，外部访问范围由端口映射与反代决定。
UI 数据与 SDK agent 目录分开持久化；Loop 运行根另由 MINI_HARNESS_RUNTIME_ROOT 控制。
改 client-state.json 前先停对应实例，避免内存状态回写覆盖文件。

## Token 与反代

auto token 保存在 `<DATA_DIR>/pi-web-token`，权限 0600，重启复用。
首次浏览器访问可带 `?token=...`，后续按既有 token/cookie 机制鉴权；不要把完整链接写进公开日志。
监听非 loopback 时使用 TLS 反代，HTTP 不加密口令。

子路径部署（如 `https://example.com/pi/`）需要剥离前缀；浏览器的 WS/API/themes 请求经 appUrl() 加回前缀。
下面仅展示转发段，公网部署在外层配置 TLS：

```nginx
location /pi/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

`proxy_pass` 末尾斜杠负责剥离 /pi/；`Host` 必须使用 `$http_host` 保留端口，
否则 Origin 与 Host 不同权威会被拒绝。WebSocket 长连接应显式延长超时。
需要额外 Origin 时设置允许列表，不要删掉服务端校验。

Vite 静态 assets 的路径与 appUrl() 不同：子路径部署需用对应 base 构建，
或为产物中的 /assets/ 加单独转发。完整配置参考 `deploy/nginx-subpath.conf`，
应用前对照当前产物核验。插件静态路由已移除，无需为其配置转发。

## 更新与验证

更新源码后重新构建、按原部署方式重启；只更新磁盘不会替换正在运行的后端。
测试用独立端口 ≥8900 和临时 data-dir/agent-dir，不停止用户已有服务。
验证 health、鉴权、WS 重连和实际任务入口；真实模型/集群调用单独记录，
不把上一次安装或旧版本测试结果作为当前部署结论。

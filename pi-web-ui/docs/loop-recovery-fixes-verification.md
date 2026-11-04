# 恢复闭环五项修复：执行记录

## A. 代码状态

- 分支：`harness-cockpit`。
- 完整起始 SHA：`1d4d2fa33b19d9eb361c16b2ac7713e654b483bb`。
- 起始工作区已有未提交修改：`server/loop/discovery.ts`、`operation.ts`、`recovery.ts`。本轮在其基础上保留有用语义并修复，未将其当作可丢弃基线。
- 本轮以 `1d4d2fa33b19d9eb361c16b2ac7713e654b483bb` 为起始 HEAD；交付提交和远端状态以本次操作结束时的 Git 检查为准。未重启用户的 8787 服务。
- 生产修改：`server/loop/{storage,fingerprint,operation-runner}.ts` 新增，`{discovery,extension,operation,recovery,routes}.ts` 接线；`server/agent-service.ts`、`server/index.ts`；`web/src/components/{TaskModal,RunDetailModal}.tsx`、`web/src/loop-status.ts`、`web/src/i18n.tsx` 和语言包；`package.json/package-lock.json` 增加 YAML 解析依赖。测试、隔离 fixture 和三份恢复说明一并保留，已有文件不回退。

## 开工核对

| 历史问题                  | 开工时实际调用链与缺口                                              | 修复位置                                                    | 回归入口                                    |
| ------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| F1 破坏性文件 CAS         | 已有补丁改成 wx 锁，但检查后移走孤儿锁仍有竞争；Run 无同代 revision | `storage.ts`、`recovery.ts`、`extension.ts`                 | `loop-storage-f1`、租约竞争及核心恢复测试   |
| F2 恢复结果未进入统一验收 | `resumeLoop → observeRunOperation` 仅生成提示；消费字段未接线       | `extension.ts`、`agent-service.ts`                          | `loop-core-restart`、`loop-extension`       |
| F3 恢复后停止未取消原实体 | 持久取消辅助函数与产品 stop 入口断开；旧握手只有 PID                | `operation.ts`、独立 runner、stop 入口                      | `loop-operation-f3`、核心 HTTP stop         |
| F4 内容指纹不全           | 旧调用仍使用 Git status/diff，验收契约覆盖不足                      | `fingerprint.ts`、执行与恢复接线                            | `loop-fingerprint-f4`、原指纹回归           |
| F5 发现前输入不统一       | `TaskModal` 命令在顶层，discover/startLoop 只送 inputs              | `discovery.ts`、routes、startLoop、TaskModal、创建/工具入口 | `loop-inputs-f5`、manifest 回归、浏览器脚本 |

状态、租约、operation、原始证据和 UI 的权威边界，以及升级和回滚约束，见 [本地恢复存储与升级](loop-recovery-storage.md)。

## 独立基线与检查记录

在隔离 detached worktree 检出上述 SHA，复用现有依赖，执行完整 Vitest：

```sh
npm test -- --configLoader=native --no-cache --reporter=default --reporter=json \
  --outputFile.json=/private/tmp/pi-vitest-baseline-1d4d2fa-ZvEUil/vitest-results.json
```

退出码 **0**；**324 个文件全部通过，3378 用例通过、8 跳过、0 失败**。实际环境为 macOS、Node 24.21.0、npm 11.19.0、Vitest 5.0.1。原始日志、结果、运行环境和清理记录保留在 `/private/tmp/pi-vitest-baseline-1d4d2fa-ZvEUil/`。不能把本轮后续失败描述为该基线的既有失败。

首次集成全量运行 `npm test -- --reporter=dot` 退出码 1：3487 通过、7 失败、8 跳过。失败涉及语言包同步及旧恢复/指纹回归，原始输出为 `/Users/zhangteng14/.comate-engine/store/terminals/1aw7hq.output`。之后发现一项旧 UI 测试仍断言 WS stop，按真实 HTTP 接口更新并增加取消确认、202 轮询断言。最终结果在下文单独记录，不覆盖失败证据。

## 已执行的浏览器路径

```sh
npm run build:web
node tests/loop-recovery-ui-test.mjs --source
```

源码后端与构建前端，真实 Chrome、真实鉴权 HTTP；独立 data/agent/workspace/runtime。最终退出码 **0**，五项检查通过：

1. TaskModal 发出原始顶层命令，发现入口据此消除对应缺口。
2. 修改命令后，预览使用新输入。
3. 顶层与 inputs 的显式命令冲突返回 HTTP 400。
4. 弹窗正常关闭，浏览器无未捕获异常。
5. 未鉴权 discover/recover/stop 均返回 401。

最终证据目录：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/harness-recovery-ui-kYnkTo/`，包含 `evidence.json`、`task-discovery.png`、`server.log`。早期四项通过证据 `harness-recovery-ui-z1xqF8` 仍保留。此前脚本因首次配置提示和连接就绪前点击而超时，按真实 UI 就绪条件修正，没有关闭鉴权或填入真实凭据。

恢复停止的完整服务浏览器覆盖另见下文 C；两类测试均未调用外部模型。

## 复现范围

基础模块测试：

```sh
npx vitest run tests/unit/loop-storage-f1.test.ts tests/unit/loop-operation-f3.test.ts \
  tests/unit/loop-fingerprint-f4.test.ts tests/unit/loop-inputs-f5.test.ts \
  tests/unit/loop-manifest-f5.test.ts
```

完整宿主恢复 fixture：

```sh
npx vitest run tests/unit/loop-core-restart.test.ts
```

fixture 使用独立旧/新宿主、外部控制进程、真实命令和 append-only 启动计数，HTTP 调用生产路由。它不是实际外部模型或集群；最终通过项、原始产物与覆盖缺口见下文。

## 基础机制的独立实测

### F1：租约真实暂停与崩溃一致性

`loop-storage-f1.test.ts` 完整运行 **40/40 通过**，退出码 0。S07 使用真实旧宿主 A：取得租约后 `SIGSTOP`，`ps` 确认停止态，等待 31 秒越过生产 TTL，期间 lease 字节未改变；B 取得下一 generation，再 `SIGCONT` A。A 的续租、条件提交、旧代释放及受控追加动作全部被拒绝，B 的状态保持原样。

单项 S07 耗时 31.355 秒，完整 storage 运行中的 S07 耗时 31.305 秒。单项原始日志：`/Users/zhangteng14/.comate-engine/store/terminals/hon26e.output`。这里的受控追加动作是 fixture 使用生产 lease 构成的围栏；不将其单独称为完整模型调度验证。

人工“按代码验证收下”也在每个 Git 子步骤前后核对本地 claim、owner/generation、revision 和评审异常状态。确定性回归通过真实 Git clean filter 在 `git add` 内注入租约过期，断言后续没有 commit、状态没有写成 done。该文件定向测试 34/34 通过；已经发出的 Git 命令不能撤销，但失权后不得新增下一命令或提交验收。

### F3：执行实体、结果完整性与取消

`loop-operation-f3.test.ts` 与既有 operation 回归最初 **24/24 通过**，独立核验补出结果发布时读到旧空握手的竞态，修复后 **26/26 通过**。消费端在 result 出现后重新读取其依赖身份；不是放宽身份匹配。包含宿主 SIGKILL 后保留同一命令、启动窗口未知不重放、runner 跨宿主超时、TERM 后有界 KILL、取消请求宿主再次死亡、其他 run 不受影响、错误 host/boot/start/nonce 拒绝信号，以及日志篡改、丢失、越界路径和超限拒绝消费。

原始证据：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/operation-f3-ZYNzcR/test-evidence.json`。结果保留原始退出码，同时使用 killed/timedOut 判断；后台后代未退出时，即使 shell code=0 也不能通过验收。

### F4/F5：内容快照与输入契约

discovery、fingerprint、inputs、manifest 定向回归 **60/60 通过**，类型检查通过。内容快照覆盖同长度替换、暂存和未暂存混合、已有未跟踪文件变化、目录删除、worktree/非 Git、二进制、执行权限和受控链接；当前能力包与完整验收配置参与身份。

manifest 使用 `yaml@2.9.0` 真正解析多文档及 Kubernetes List。显式 namespace、多个 manifest 或不同资源 namespace 冲突均阻止启动；ConfigMap 正文中的 namespace 不当作元数据。读取上限为每文件 256 KiB、一次 16 文件、每文件 32 文档、256 资源、List 嵌套 16 层。解析错误、重复键、非法类型、越界链接、敏感路径及读取期间修改均受阻。

上述是本地文件及生产入口回归，不是实际 Kubernetes 部署或模型执行验证。

另有命令显式脚本依赖回归：`python build/validator.py` 位于忽略目录，未单独填写 validatorPath 时，同长度内容变化也必须改变指纹。修复后的相关定向组合 **46/46 通过**。复杂 shell 保持兼容；无法静态推断的动态依赖限制见存储说明。

## B. 五项修复的主流程接线

| 项目 | 根因 → 修改及接线                                                                                                                                                                                                | 验证与剩余限制                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| F1   | 移走目标或回收 TTL 锁不能实现 CAS → 同 Run SQLite 互斥覆盖 lease/state/operation 条件更新，owner/generation/revision 一起检查；JSON 原子替换；启动和显式恢复迁移                                                 | 真实进程竞争、SIGKILL、SIGSTOP 31 秒及损坏迁移。仅同宿主支持的本地文件系统；JSON 多文件没有整体事务回滚   |
| F2   | observer 只给模型提示，正常路径再次执行 → 正常 validator 与 observer 共用 `validationFromOperation/recordValidationOutcome`，consumedResults 与 history/validatedRound/metrics 同提交；reviewStep 持久化请求身份 | 核心五条跨宿主链、三个确定性交错。reviewer 请求后结果未知停 review-error，不承诺外部请求 exactly-once     |
| F3   | 新服务没有旧 AbortController → `stopRunExternal` 使用持久 operation，独立 runner 核验 host/boot/start/nonce 和 PGID，TERM 后有界升级；HTTP 与详情区分请求和确认                                                  | 真实原父子退出、202 界面轮询、重复停止。主动逃逸进程组和无适配器远端 job 不支持                           |
| F4   | Git status/diff 不能代表实际内容 → `currentFingerprintOf` 接入创建、执行和恢复，双遍快照覆盖实际 cwd/index/内容及当前验收契约                                                                                    | 同长度替换、staged/untracked、worktree、显式忽略脚本、超限和敏感排除。动态 shell 的隐式外部依赖需声明     |
| F5   | 顶层字段在 missing 检查后才合并 → `normalizeTaskInputs` 前置到 TaskModal 预览、HTTP discover、startLoop、createLoopRun/工具及恢复契约                                                                            | 顶层/inputs/冲突/空值/非法约束与 YAML；Chrome 实际表单和 401。真实模型跨 workspace 工具映射没有端到端验收 |

恢复新服务会按原 `sessionId` 查找并打开会话，找不到则明确受阻；不会把任务绑到当前陌生会话，也不会因重新观察增加 attempt。

## C. 两条独立端到端证据

### 完成链

命令 `npx vitest run tests/unit/loop-core-restart.test.ts`，五个模式通过（退出码 0），也包含在最终全量结果中。

可核查样例：

- 目录：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/loop-core-restart-8ldX7U/`。
- A PID `80332` 被 SIGKILL，B PID `83606` 重新导入生产服务类/扩展。
- run `20261103121235-4e9093`；operation `17e802dd7d613373dc812fe0b77d08c0`；attempt `fe96bb8eb178` 保持不变，generation 1 → 2。
- `starts.jsonl` 只有一行：原命令 PID `83455`，子进程 `83519`，nonce `3b9493ca-8214-45ad-a440-28283cd75ff4`。
- B 收到原输出 `HARNESS_METRIC score=42 unit=items`，状态 `done`、验收 `passed-validator-only`；消费记录与 history 各一次，重复 loop_done/agent_end 不重跑。
- 原始事实：`evidence.json`、`runs/<runId>/state.json`、`operations/<opId>/{runner,entity,result}.json`、stdout/stderr、每轮验收报告。此例原配置没有 reviewer；必需 reviewer 的未知请求分支另有独立测试，未伪称该例通过了模型评审。

三个额外消费并发/崩溃测试 `npx vitest run tests/unit/loop-consumption-f2.test.ts`，退出码 0，3/3：

- R04 同轮两个生产入口竞争：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/loop-consumption-f2-S2UehB/evidence.json`。
- S06 消费、heartbeat、stop、旧 waiter：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/loop-consumption-f2-daOi9M/evidence.json`。
- R05 消费文件 fsync 后 rename 前杀 B，C 唯一应用：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/loop-consumption-f2-qJpB9Z/evidence.json`。

### 停止链

```sh
node tests/loop-recovery-browser-stop-test.mjs --source
node tests/loop-recovery-browser-stop-test.mjs --source --pending-stop
```

普通停止 9 项通过；等待确认分支 10 项通过；两者退出码均为 0。A 为确定性本地模型/会话 fixture，启动生产 extension 的真实长命令与忽略 TERM 的后代；A 被 SIGKILL 后，B 为完整 `server/index.ts`，真实浏览器进入任务台，点击恢复发 WS `loop_resume`，点击停止发生产 HTTP 请求。

普通链原始目录：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/harness-browser-stop-wvkX6o/`。

最终构建后的 202 链原始目录：`/var/folders/gt/c5kp4lp9485309mfts8h66r80000gn/T/harness-browser-stop-kbGyxX/`。包含 `evidence.json`、服务日志、`starts.jsonl`、operation 原始事实及 `screenshots/`。较早通过的 `harness-browser-stop-k1ozP5` 证据仍保留。

断言包括：原 operation/attempt 保留、启动计数 1；取消确认对话框不发送请求；202 不能显示确认停止且继续轮询；恢复测试自己的 runner 后，产品 stop 使原父子进程退出并落 `groupGone`；状态/HTTP/页面停止时间一致，无验收成功或重新执行；重复停止确认时间不变。`cleanupSurvivors=[]`，清理 kill 不计为产品成功。

B 恢复用到测试预置的 SDK 兼容原会话记录，没有真实模型调用；202 注入只暂停测试所拥有的 runner。上述覆盖不能称为生产集群或真实模型验收。

## D. 最终工程检查与覆盖

2026-11-03 最后一次完整运行：

```sh
npm test -- --reporter=dot --reporter=json \
  --outputFile.json=/private/tmp/mini-harness-final-vitest-20261103-accept-fenced.json
npm run typecheck
npm run lint
npm run check:protocol
npm run build
```

- Vitest：**332 文件全部通过；3525 通过、8 跳过、0 失败；退出码 0**。机器可读原始结果位于上述 JSON 文件，3533 为总数；原始终端日志 `/Users/zhangteng14/.comate-engine/store/terminals/x5v2dc.output`。
- 类型检查、lint（0 警告/0 错误）、协议 v40 检查及串行双端构建退出码均为 0。
- 最后人工收下围栏修改后再次执行类型检查、lint 与 `build:server`，均通过；前端不受此修改影响，保留已通过的浏览器构建证据。
- 构建仍有 `advancedChunks` 弃用与大 chunk 提示，不影响构建成功；未为消除提示扩大本轮范围。
- 修改文件格式与 `git diff --check` 单独核验。语言包已同步；本机无 OpenCC，繁中使用同步脚本内置转换。
- 历史列表新增有界只读扫描；损坏/超大记录不被吞成空列表。启动迁移、列表只读、指纹失效、原 attempt 接续及停止 UI 已纳入回归。

逐项 S01–S10、R01–R10、C01–C08、H01–H08、I01–I08 的状态和边界见 [覆盖矩阵](loop-recovery-coverage.md)。源码核验、单元测试、真实多进程、SIGKILL/SIGSTOP、生产 HTTP、真实 Chrome 均已执行。没有运行真实模型、真实集群、Linux 实机；没有把 CI 结果计为本轮独立验证。

通用 `test:smoke` 全套未运行：其中旧脚本存在释放占用端口和继承进程环境的行为，不适合直接用于本轮隔离边界。相关实际 HTTP/WS/UI 路径由本轮独立目录、环境白名单和自有 PID 的浏览器测试覆盖，不称为全套 smoke 通过。

## E. 交付结论与剩余限制

**已完成且已验证：** F1–F5 的本地主流程、同宿主真实恢复完成链、恢复停止链、唯一结果应用、迁移备份/冲突处理、输入与内容身份，以及上述工程检查。

**已实现但未完整验证：** Linux 平台分支；真实模型工具与 worktree 知识映射；R07/R08/R10 的全部异常组合。矩阵中保留“部分通过”，不将本地适配器冒充外部模型。下一步优先在隔离 Linux 本地文件系统与获准测试模型上跑相同链路，并补旧 attempt 晚到的专项核心组合（P2 验证缺口）。

**不支持或不能保证：** 多宿主共享/NFS/Windows/列明文件系统、无真实适配器的远端 job、旧协议在途实体直接升级、主动逃逸进程组、任意 shell 动态依赖的自动推断，以及外部 reviewer exactly-once。旧版/新版混写需在升级流程中禁止，不能靠新版标记约束人为重新启动的旧程序。

升级前必须停止旧写者并备份，详见 [操作与升级说明](loop-recovery-storage.md)。本轮未将这些修改部署到日常服务，也未改动用户日常运行数据。

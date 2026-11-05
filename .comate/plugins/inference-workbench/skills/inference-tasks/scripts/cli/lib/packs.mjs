/**
 * 能力模板注册表（Capability Packs）（自 dsh-inference-workbench `src/packs.ts` 原样移植，
 * 其源头是 Mini-harness `loop/packs.ts`）。
 *
 * 保留四个模板：推理性能 / 服务配置验证 / 缓存损耗 + code-smoke（本地代码验证冒烟，测试任务）。
 */

const INFER_FORGE = "infer-forge-harness";
const MINI_HARNESS = "mini-harness";
const IFH_HEAD = "04322f7";

const PREFILL_PERF_SRC = {
	repo: INFER_FORGE,
	path: "tasks/sglang_prefill_perf_optimize/task.yaml",
	version: IFH_HEAD,
	applicable: "P800 SGLang Prefill 主机↔设备同步消除的性能优化（perf-016）",
};

const DECODE_SVC_SRC = {
	repo: INFER_FORGE,
	path: "tasks/decode_perf_service/task.yaml",
	version: IFH_HEAD,
	applicable: "NVIDIA GPU 单 decode 引擎测量服务就绪验证（perf-021）",
};

const CACHE_LOSS_SRC = {
	repo: MINI_HARNESS,
	path: "skills/cache-loss-optimization/SKILL.md",
	version: "harness-cockpit@5050258",
	applicable: "ASCache 开启后 uncache ITPS 相对 disable-radix-cache 的损耗优化",
};

const SMOKE_SRC = {
	repo: "dsh-inference-workbench",
	path: "scripts/smoke-validator.mjs",
	version: "0.1.0",
	applicable: "本地、可复现、无需生产集群的代码验证冒烟任务",
};

const CAPABILITY_PACKS = [
	{
		id: "inference-perf",
		name: "推理性能（吞吐最大化）",
		version: "1.2.0",
		title: "推理性能（吞吐最大化）",
		summary: "对齐 infer-forge perf-016：以 prefill 端到端吞吐为主指标（maximize），token 逐位一致 + span 无退化为硬约束。",
		family: "performance",
		kind: "development",
		entry: "P800 SGLang Prefill 热路径 host↔device 同步消除；证据 = candidate arm trace 对照 recorded reference。",
		goal: "优化推理服务的吞吐：在保持答案逐 token 一致、设备时间线 span 不劣化的前提下，尽量提高实测 prefill 吞吐。",
		criteria: "以验收命令输出的 HARNESS_METRIC.input_throughput 为主指标（tokens/s，越大越好）；token 逐位一致（tokens_parity=1）与 span 无退化（span_regression<=0.02）为硬约束，缺一不可。",
		primaryMetric: "input_throughput",
		metricDirection: "maximize",
		metricUnit: "tokens/s",
		hardConstraints: [
			{ name: "span 无退化", metric: "span_regression", op: "lte", value: 0.02 },
			{ name: "token 逐位一致", metric: "tokens_parity", op: "gte", value: 1 },
			{ name: "精度无退化", metric: "acc_drop", op: "lte", value: 0.01 },
		],
		inputs: [
			{ id: "validateCmd", label: "验收命令", required: true, source: "user", hint: "真实压测的 --validate 命令，须输出 HARNESS_METRIC.input_throughput / span_regression / tokens_parity" },
			{ id: "pod", label: "目标 Pod", required: true, source: "user", hint: "perf-016 自己重启引擎一次，Pod 是唯一必要输入" },
			{ id: "kubeconfig", label: "kubeconfig（集群）", source: "discovery", hint: "访问目标 Pod 的 kubeconfig；缺省从 KUBECONFIG / ~/.kube/config 发现，任务启动时快照固定" },
			{ id: "baseline", label: "参照快照", source: "discovery", sourceOf: "上一 run 的 reference_snapshot.json（this vs last）", hint: "未提供则本轮记录 reference，不应用 mechanism" },
		],
		validatorInterface: {
			validateCmdHint: "真实 prefill 压测的 --validate 命令（输出 HARNESS_METRIC.input_throughput 与 span_regression / tokens_parity）",
			precheckCmdHint: "python3 validate.py --precheck",
			artifactRootsHint: ["runs"],
		},
		evidence: { metric: "input_throughput", artifacts: ["baseline_trace.json", "candidate_trace.json", "signals.json", "prefill_optimization.json"] },
		maxRounds: 6,
		useReviewer: true,
		auto: true,
		clusterRelevant: true,
		knowledge: {
			summary: "一次 engine boot 只做一件事：记录 reference 或应用一个 mechanism 并对照记录。成功态要求吞吐不退化 + token 逐位一致 + span 无退化。",
			requiredInputs: [
				{ id: "pod", label: "目标 Pod", required: true, source: "user", hint: "已就绪的 SGLang 引擎 Pod" },
				{ id: "validateCmd", label: "验收命令", required: true, source: "user", hint: "真实压测 --validate 命令" },
				{ id: "mechanism", label: "机制", source: "discovery", sourceOf: "references/profiles/*.json 的机制注册表", hint: "单步路径缺省由 profile 决定" },
			],
			discovery: [
				{ probe: "references/profiles/*.json 机制注册表", expect: "chip 专属机制清单（日志模式、覆盖哪些 plugin 文件）" },
				{ probe: "上一 run 的 reference_snapshot.json", expect: "记录 engine、吞吐、greedy ids 与 trace 的参照快照" },
			],
			entries: [
				{ id: "run", kind: "script", path: "tasks/sglang_prefill_perf_optimize/run.py", role: "一 boot 一 run：记录 reference 或应用 mechanism 并对照" },
				{ id: "measure", kind: "script", path: "tasks/sglang_prefill_perf_optimize/Script/measure_prefill.py", role: "aiakperf 驱动，权威 input_throughput 采集" },
				{ id: "validate", kind: "validator", path: "tasks/sglang_prefill_perf_optimize/validate.py", role: "读 report，不重跑采集；判定吞吐/span/token 门禁" },
			],
			executionOrder: ["1. 记录 reference（首 run 无 mechanism）", "2. 应用一个 mechanism（overlay plugin + env）", "3. aiakperf 压测 + 抓 candidate trace", "4. validator 对照 reference：throughput / span / token parity"],
			metric: {
				name: "input_throughput",
				unit: "tokens/s",
				direction: "maximize",
				definition: "prefill 端到端吞吐（input throughput token/s，来自 aiakperf 摘要表，非 kernel gap 本身）",
				hardConstraints: [
					{ name: "span 无退化", metric: "span_regression", op: "lte", value: 0.02 },
					{ name: "token 逐位一致", metric: "tokens_parity", op: "gte", value: 1 },
				],
			},
			evidence: {
				required: ["candidate_trace.json", "baseline_trace.json", "signals.json", "greedy_ids 对照"],
				locations: ["<artifacts>/applied_code/<mechanism>/", "<artifacts>/prefill_optimization.json"],
			},
			commonFailures: [
				{ symptom: "sync 计数下降但 span 上升（CP 漂移）", recovery: "span 是硬门禁，不得因吞吐噪声带过；回滚该 mechanism" },
				{ symptom: "吞吐只持平（ratio≈1.0）", recovery: "任务目标是提升，持平仍不满足意图，换机制或判无进展" },
			],
			impact: {
				scope: ["引擎已安装的 sglang_kunlun plugin 覆盖", "launch 环境变量"],
				confirmBefore: ["重启引擎", "覆盖 plugin 文件"],
			},
		},
		references: [
			{ id: "task", title: "perf-016 任务契约", kind: "skill", source: PREFILL_PERF_SRC, summary: "acceptance：min_throughput_ratio=1.0、require_token_parity、require_span_no_regression(max 0.02)、min_target_op_reduction=0.05" },
			{ id: "measure", title: "measure_prefill.py 口径", kind: "script-doc", source: { ...PREFILL_PERF_SRC, path: "tasks/sglang_prefill_perf_optimize/Script/measure_prefill.py" }, summary: "权威 input_throughput 从 aiakperf 摘要表取；avg_cache_hit_rate 只是观测，不是吞吐" },
		],
		provenance: [PREFILL_PERF_SRC],
	},
	{
		id: "service-config-verify",
		name: "服务配置验证（decode 引擎就绪）",
		version: "1.0.0",
		title: "服务配置验证（decode 引擎就绪）",
		summary: "对齐 infer-forge perf-021：给定 kubeconfig 与 decode 部署 YAML，验证单 decode GPU 引擎带 fake transfer/dispatch flags 与 profiler 目录且 /health 200。",
		family: "performance",
		kind: "verification",
		entry: "布尔就绪验证（无 maximize/minimize 指标）：Pod Running + /health 200 + /metrics 有 sglang: series + 启动脚本 flags 齐全。",
		goal: "验证一个 decode-only 测量服务是否就绪：启动脚本携带 fake transfer/dispatch flags 与 profiler 目录，/health 返回 200，/metrics 导出 sglang: series。",
		criteria: "布尔验证，无主指标：Pod phase=Running；/health=200；/metrics 含 sglang: series；prepared 启动脚本含 --disaggregation-transfer-backend fake、--ep-dispatch-algorithm fake 与 SGLANG_TORCH_PROFILER_DIR；kubectl 操作都限定在传入 kubeconfig+namespace。",
		primaryMetric: null,
		metricDirection: null,
		inputs: [
			{ id: "kubeconfig", label: "kubeconfig", required: true, source: "user", hint: "到达目标集群的 kubeconfig（输入文件，永不入库）" },
			{ id: "deploy_yaml", label: "部署 YAML", required: true, source: "user", hint: "decode 部署多文档 manifest（ConfigMap launch.sh + Pod）" },
			{ id: "namespace", label: "namespace", source: "project-config", sourceOf: "缺省取自 manifest，不一致时拒绝", hint: "缺省从 manifest 取" },
		],
		validatorInterface: {
			validateCmdHint: "真实 kubectl/curl 的就绪检查（Pod Running + /health 200 + /metrics sglang: series + flags 校验）",
			precheckCmdHint: "kubectl --kubeconfig <cfg> cluster-info --request-timeout=5s",
			artifactRootsHint: ["runs"],
		},
		evidence: { metric: "（无，布尔就绪）", artifacts: ["pod_status.json", "health_result.json", "metrics_probe.json", "prepared.yaml", "kubernetes_operations.json"] },
		maxRounds: 3,
		useReviewer: true,
		auto: true,
		clusterRelevant: true,
		knowledge: {
			summary: "就绪证明，不是性能测量。通过 = 多个独立信号全部满足；每个失败有明确 exit_state（health_timeout / flags_missing / metrics_missing / profiler_env_missing 等）。",
			requiredInputs: [
				{ id: "kubeconfig", label: "kubeconfig", required: true, source: "user" },
				{ id: "deploy_yaml", label: "部署 YAML", required: true, source: "user" },
				{ id: "namespace", label: "namespace", source: "project-config", sourceOf: "缺省取自 manifest" },
			],
			discovery: [
				{ probe: "manifest 的 namespace / Pod 名 / ConfigMap launch.sh", expect: "从 manifest 读取；与显式 namespace 冲突时拒绝" },
				{ probe: "运行容器的 /proc/<pid>/environ", expect: "SGLANG_TORCH_PROFILER_DIR 在启动前 export；复用 Pod 时目录必须已就绪" },
			],
			entries: [
				{ id: "run", kind: "script", path: "tasks/decode_perf_service/run.py", role: "改写启动脚本 + apply manifest + 就绪探测" },
				{ id: "validate", kind: "validator", path: "tasks/decode_perf_service/validate.py", role: "从原始 manifest 重推导 prepared 脚本并核对 flags / health / metrics" },
			],
			executionOrder: ["1. 读 manifest，改写到 attempt 本地副本（不动调用方文件）", "2. Pod 不存在才 apply；已存在只观察绝不重 apply", "3. 等 Pod Running + /health 200", "4. 核对 /metrics sglang: series 与启动脚本 flags"],
			metric: {
				name: "",
				unit: "",
				direction: null,
				definition: "布尔就绪验证，无数值主指标；通过 = 多个信号全满足",
			},
			evidence: {
				required: ["pod_status.json（phase Running + UID）", "health_result.json（200）", "metrics_probe.json（sglang: series）", "prepared.yaml（flags 齐全）"],
				locations: ["<artifacts>/"],
			},
			commonFailures: [
				{ symptom: "Pod 已存在但 profiler 目录未导出", recovery: "复用 Pod 不重 apply，profiler 目录必须已 live；否则 profiler_env_missing" },
				{ symptom: "/health 200 但 /metrics 无 sglang: series", recovery: "metrics_missing：压测无指标源，判失败不冒充就绪" },
			],
			impact: {
				scope: ["目标集群（仅 Pod 不存在时 apply ConfigMap/Pod）"],
				confirmBefore: ["apply manifest 到集群", "重启引擎以固定 accept_len"],
			},
		},
		references: [
			{ id: "task", title: "perf-021 任务契约", kind: "skill", source: DECODE_SVC_SRC, summary: "exit_states 显式区分 health_timeout / apply_failed / flags_missing / metrics_missing / profiler_env_missing / model_id_unresolved" },
			{ id: "skill", title: "decode_perf_service SKILL.md", kind: "skill", source: { ...DECODE_SVC_SRC, path: "tasks/decode_perf_service/SKILL.md" }, summary: "就绪证明不证明性能；吞吐/延迟属于 perf-022" },
		],
		provenance: [DECODE_SVC_SRC],
	},
	{
		id: "cache-loss",
		name: "缓存损耗（损耗率最小化）",
		version: "1.2.0",
		title: "缓存损耗（损耗率最小化）",
		summary: "修正指标口径：loss_pct = (1 - ITPS_ascache,uncache / ITPS_disable-radix-cache,uncache)*100（真实 ASCache 损耗）；cache_hit 是独立观测项，不是损耗。",
		family: "performance",
		kind: "development",
		entry: "ASCache 开启后 uncache ITPS 相对 disable-radix-cache 的比值损耗；on/off 两组场景各测一遍。",
		goal: "降低缓存命中损耗：压低开启 ASCache 后 uncache ITPS 相对 disable-radix-cache 的比值损耗（越小越好），同时命中率与稳定性达标。",
		criteria: "以验收命令输出的 HARNESS_METRIC.loss_pct 为主指标（loss_pct=(1 - ITPS_ascache,uncache/ITPS_disable-radix-cache,uncache)*100，越小越好）；必须报出 HARNESS_SCENARIO=ascache-on-vs-radix-off；cache_hit（命中率）、input_len、loss_std（稳定性）为独立硬约束，缺一不可。",
		primaryMetric: "loss_pct",
		metricDirection: "minimize",
		metricUnit: "%",
		metricThreshold: { op: "lt", value: 20 },
		metricScenario: "ascache-on-vs-radix-off",
		hardConstraints: [
			{ name: "命中率下限（独立观测）", metric: "cache_hit", op: "gte", value: 0.96 },
			{ name: "输入长度", metric: "input_len", op: "gte", value: 81920 },
			{ name: "稳定性（多轮方差）", metric: "loss_std", op: "lte", value: 0.5 },
		],
		inputs: [
			{ id: "validateCmd", label: "验收命令", required: true, source: "user", hint: "真实 ASCache 的 --validate 命令，须在 on/off 两组场景各跑一遍" },
			{ id: "kubeconfig", label: "kubeconfig（集群）", source: "discovery", hint: "访问压测 Pod 的 kubeconfig；缺省从 KUBECONFIG / ~/.kube/config 发现，任务启动时快照固定" },
			{ id: "cache_hit", label: "命中率下限", source: "pack-default", defaultValue: "0.96", sourceOf: "ASCache 目标命中率下限", hint: "命中率是独立观测项，不参与 loss 计算" },
			{ id: "input_len", label: "输入长度", source: "pack-default", defaultValue: "81920", sourceOf: "80K 输入长度下限", hint: "输入长度下限" },
		],
		validatorInterface: {
			validateCmdHint: "真实 ASCache 的 --validate 命令（on/off 两组场景，输出 HARNESS_METRIC.loss_pct + HARNESS_SCENARIO + cache_hit）",
			precheckCmdHint: "python3 validate.py --precheck",
			artifactRootsHint: ["runs"],
		},
		evidence: { metric: "loss_pct", artifacts: ["loss_pct 公式记录", "on/off 场景对比日志", "命中率采样", "输入长度记录", "多轮稳定性记录"] },
		maxRounds: 6,
		useReviewer: true,
		auto: true,
		clusterRelevant: true,
		knowledge: {
			summary: "损耗是 ITPS 比值（1 - 开 cache 的 uncache ITPS / 关 cache 的 uncache ITPS），不是 (1 - 命中率)。命中率是独立的压测观测项。",
			requiredInputs: [
				{ id: "validateCmd", label: "验收命令", required: true, source: "user" },
				{ id: "cache_hit", label: "命中率下限", source: "pack-default", sourceOf: "0.96" },
				{ id: "input_len", label: "输入长度", source: "pack-default", sourceOf: "81920" },
			],
			discovery: [
				{ probe: "压测脚本 bench_ascache.py / 引擎日志的命中率", expect: "命中率从引擎自身日志证实，不靠 trace 推断" },
				{ probe: "插桩后 instrumented_no_cache 分母", expect: "损耗分母优先用插桩后测得的 no_cache，否则记录 clean_baseline" },
			],
			entries: [
				{ id: "baseline", kind: "workflow", path: "perf-029-sglang-perfmap-baseline", role: "关 cache（--disable-radix-cache）基准采集" },
				{ id: "benchmark", kind: "workflow", path: "perf-030-sglang-ascache-benchmark", role: "开 cache（--enable-asradix-cache）排除预热压测抓 trace" },
				{ id: "loss-analysis", kind: "workflow", path: "perf-031-sglang-cache-loss-analysis", role: "损耗归因 + 独立重算审查（verify.py）" },
			],
			executionOrder: ["1. 关 cache 基准采集（ServingBaseline）", "2. AST 细粒度插桩（CacheProbeReport）", "3. 开 cache 排除预热压测抓 trace", "4. 损耗拆解 + 独立重算审查", "5. 逐轮优化 + 2 次复测确认"],
			metric: {
				name: "loss_pct",
				unit: "%",
				direction: "minimize",
				definition: "loss_pct = (1 - ITPS_ascache,uncache / ITPS_disable-radix-cache,uncache) * 100；命中率 cache_hit 是独立观测，不参与 loss 计算",
				threshold: { op: "lt", value: 20 },
				scenario: "ascache-on-vs-radix-off",
				hardConstraints: [
					{ name: "命中率下限（独立观测）", metric: "cache_hit", op: "gte", value: 0.96 },
					{ name: "输入长度", metric: "input_len", op: "gte", value: 81920 },
					{ name: "稳定性", metric: "loss_std", op: "lte", value: 0.5 },
				],
			},
			evidence: {
				required: ["baseline_report.json（关 cache ITPS）", "benchmark_report.json（开 cache uncache ITPS + 命中率）", "loss_comparison_report.json"],
				locations: ["<artifacts>/", "<artifacts>/applied_code/"],
			},
			commonFailures: [
				{ symptom: "把命中率当损耗（loss_pct=(1-hit)*100）", recovery: "拒绝该口径：loss 是 ITPS 比值损耗，命中率是独立硬约束" },
				{ symptom: "profile 窗口混入充 cache 预热", recovery: "窗口必须框定在预热后的实际发压阶段（--warmup-excluded）" },
			],
			impact: {
				scope: ["引擎源码（sglang）/ SDK（sglang/baidu/attentionstore/sdk）", "启动脚本"],
				confirmBefore: ["重启引擎（pkill -9 sglang，仅限独占测试 Pod）", "插桩与源码修改"],
			},
		},
		references: [
			{ id: "skill", title: "cache-loss-optimization SKILL", kind: "skill", source: CACHE_LOSS_SRC, summary: "6 阶段 10 步：基线→插桩→压测→损耗归因→逐轮优化→2 次复测；target_loss<0.20" },
		],
		provenance: [CACHE_LOSS_SRC],
	},
	{
		id: "code-smoke",
		name: "本地代码验证（冒烟测试）",
		version: "0.1.0",
		title: "本地代码验证（冒烟测试）",
		summary: "测试任务：在本地工作目录运行一个可复现的代码验证脚本，输出结构化 HARNESS_METRIC 并通过指标门禁。无需生产集群。",
		family: "smoke",
		kind: "verification",
		entry: "本地、可复现的代码验证：执行者在工作目录完成代码修改，validator 跑检查并输出 HARNESS_METRIC.smoke_ok。",
		goal: "跑通一条端到端链路：执行者在工作目录完成一个可复现的代码验证，validator 输出结构化结果，任务按规则判定通过 / 失败 / 受阻。",
		criteria: "validator 输出 HARNESS_METRIC.smoke_ok=1（硬约束），并保留日志与产物作为证据；本模板明确标注为测试任务。",
		primaryMetric: null,
		metricDirection: null,
		hardConstraints: [{ name: "冒烟校验通过", metric: "smoke_ok", op: "gte", value: 1 }],
		inputs: [
			{ id: "workspace", label: "工作目录", required: true, source: "user", hint: "本地 Git 仓库或临时目录；冒烟任务在此目录内完成" },
			{ id: "validateCmd", label: "验收命令", required: true, source: "user", hint: "本地可复现的验证命令（如 node validator.mjs）；输出 HARNESS_METRIC.smoke_ok" },
			{ id: "goal", label: "任务目标", required: true, source: "user", hint: "本冒烟任务要完成的具体代码目标（如：让 validator 要求的文件存在且内容正确）" },
		],
		validatorInterface: {
			validateCmdHint: "本地验证命令（如 node <plugin>/scripts/smoke-validator.mjs --workspace <dir>），输出 HARNESS_METRIC.smoke_ok 与 HARNESS_SCENARIO",
			precheckCmdHint: "git -C <workspace> status --short",
			artifactRootsHint: ["runs"],
		},
		evidence: { metric: "smoke_ok", artifacts: ["validator 日志", "工作目录 diff / 变更清单"] },
		maxRounds: 3,
		useReviewer: false,
		auto: true,
		smokeTest: true,
		clusterRelevant: false,
		knowledge: {
			summary: "冒烟任务：由执行者在工作目录内完成一个明确、可复现的代码验证，validator 输出结构化指标，任务逻辑按指标门禁判定通过/失败/受阻。",
			requiredInputs: [
				{ id: "workspace", label: "工作目录", required: true, source: "user" },
				{ id: "validateCmd", label: "验收命令", required: true, source: "user" },
				{ id: "goal", label: "任务目标", required: true, source: "user" },
			],
			discovery: [
				{ probe: "工作目录是否存在、是否为 git 仓库", expect: "存在；临时目录可非 git（快照引用为 null）" },
				{ probe: "validator 脚本是否存在于工作目录或任务自带的脚本", expect: "可执行；输出 HARNESS_METRIC" },
			],
			entries: [
				{ id: "run", kind: "tool", path: "comate 子代理（executor）", role: "在工作目录完成代码修改与验证命令执行" },
				{ id: "validate", kind: "validator", path: "<validateCmd>", role: "输出 HARNESS_METRIC.smoke_ok 的结构化结果" },
			],
			executionOrder: ["1. 读工作目录与 validator 契约", "2. 完成代码修改（如补全缺失文件）", "3. 运行验收命令采集结构化结果", "4. 指标门禁判定通过 / 失败"],
			metric: {
				name: "smoke_ok",
				unit: "",
				direction: null,
				definition: "冒烟校验通过标记（1 = 通过）；硬约束 gate 判定",
				hardConstraints: [{ name: "冒烟校验通过", metric: "smoke_ok", op: "gte", value: 1 }],
			},
			evidence: {
				required: ["validator 日志（含 HARNESS_METRIC 行）", "工作目录变更清单"],
				locations: ["<artifacts>/"],
			},
			commonFailures: [
				{ symptom: "validator 未输出 smoke_ok", recovery: "缺少必要约束证据：补齐验证脚本输出，命令 exit 0 不等于指标达标" },
				{ symptom: "工作目录不存在", recovery: "受阻：确认工作目录路径后重试" },
			],
			impact: {
				scope: ["本地工作目录"],
				confirmBefore: [],
			},
		},
		references: [
			{ id: "validator", title: "冒烟验证脚本契约", kind: "script-doc", source: SMOKE_SRC, summary: "输出 HARNESS_METRIC: {\"smoke_ok\": 1} 或 HARNESS_METRIC: smoke_ok=1；场景标记 HARNESS_SCENARIO 可选" },
		],
		provenance: [SMOKE_SRC],
	},
];

/** 返回能力模板目录（第一层：不含知识/参考材料）。 */
export function listCapabilityPacks() {
	return CAPABILITY_PACKS.map(({ knowledge: _k, references: _r, ...pack }) => ({ ...pack }));
}

export function resolvePack(id) {
	if (!id) return null;
	return CAPABILITY_PACKS.find((pack) => pack.id === id) ?? null;
}

export function getPackKnowledge(id) {
	return resolvePack(id)?.knowledge ?? null;
}

/** 由 CapabilityPack 派生统一的 MetricTarget（主指标口径）。 */
export function metricTargetOf(pack) {
	if (!pack.primaryMetric) return null;
	return {
		metric: pack.primaryMetric,
		direction: pack.metricDirection ?? "maximize",
		...(pack.metricUnit ? { unit: pack.metricUnit } : {}),
		...(pack.metricThreshold ? { threshold: pack.metricThreshold } : {}),
		...(pack.metricScenario ? { scenario: pack.metricScenario } : {}),
	};
}

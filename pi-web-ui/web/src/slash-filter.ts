/**
 * slash 命令的候选匹配 —— 纯函数、零依赖（可被 tsconfig.tests.json 单测）。
 *
 * 目录里的 skill 条目名是 `skill:<目录名>`（`server/slash-commands.ts` 里拼的
 * `` `skill:${skill.name}` ``），而用户实际习惯直接敲 skill 名。这里让 skill 条目
 * 同时用「完整名」与「去掉 `skill:` 的裸名」参与匹配：
 *   - 敲 `/review` 能列出并补全 `skill:review`（此前直接空匹配 → 菜单连消失）；
 *   - 补全插入的仍是 `/skill:review `——SDK 只展开 `startsWith("/skill:")` 的调用，
 *     所以裸名只解决「找得到」，不改变调用形态，也不动服务端协议。
 *
 * 只放宽 skill：扩展命令的 `new:2` 是重名去冲突后缀、插件名可能自带命名空间，
 * 它们的裸名没有「必须显式写前缀才能调用」的语义，不该跟着放宽。
 */

/** skill 命令在目录里的命名空间前缀。 */
export const SKILL_NAMESPACE = "skill:";

/** 词边界字符集：空白、破折号、下划线、点、斜杠、冒号。与上游 pi-tui 保持一致。 */
export const WORD_BOUNDARY_CHARS = /[\s\-_./:]/;

/**
 * 匹配分级（高到低）：
 * Exact (全字匹配) > StartsWith (词首前缀) > WordBoundary (词边界前缀) > Subsequence (子序列模糊匹配)。
 */
export const enum MatchTier {
	Exact = 0,
	StartsWith = 1,
	WordBoundary = 2,
	Subsequence = 3,
}

export interface FuzzyScoreResult {
	tier: MatchTier;
	score: number;
}

/** 一条命令参与匹配的候选串（均为小写）。非 skill 命令只有它自己的名字。 */
export function slashCandidates(name: string, source: string): string[] {
	const full = name.toLowerCase();
	if (source === "skill" && full.startsWith(SKILL_NAMESPACE)) {
		return [full, full.slice(SKILL_NAMESPACE.length)];
	}
	return [full];
}

/** 检查 candidate 中是否存在某个非 0 的词边界位置，紧随其后以 query 开头。 */
function findWordBoundaryPrefixIndex(query: string, candidate: string): number {
	let idx = 0;
	while (idx < candidate.length) {
		const next = candidate.indexOf(query, idx);
		if (next === -1) return -1;
		if (next > 0 && WORD_BOUNDARY_CHARS.test(candidate[next - 1])) {
			return next;
		}
		idx = next + 1;
	}
	return -1;
}

/**
 * 对单一候选串计算模糊匹配分级与得分。
 * 纯函数、零依赖。不匹配返回 null。
 *
 * 打分口径沿用 pi-tui：
 * - 连续命中：每次递增 -5 分
 * - 跳字惩罚：每跳 1 字 +2 分
 * - 词边界命中：-10 分
 * - 命中位置微调：+0.1 × 下标
 * - 全字完全匹配额外奖励：-100 分
 */
export function fuzzyScore(query: string, candidate: string): FuzzyScoreResult | null {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	if (!q) {
		return { tier: MatchTier.Exact, score: 0 };
	}
	if (q.length > c.length) {
		return null;
	}

	let tier: MatchTier = MatchTier.Subsequence;
	let prefixStart = -1;

	if (c === q) {
		tier = MatchTier.Exact;
		prefixStart = 0;
	} else if (c.startsWith(q)) {
		tier = MatchTier.StartsWith;
		prefixStart = 0;
	} else {
		const wb = findWordBoundaryPrefixIndex(q, c);
		if (wb !== -1) {
			tier = MatchTier.WordBoundary;
			prefixStart = wb;
		}
	}

	// 若命中 Exact / StartsWith / WordBoundary，匹配段从 prefixStart 连续展开
	if (prefixStart !== -1) {
		let score = 0;
		let consecutiveMatches = 0;
		for (let j = 0; j < q.length; j++) {
			const pos = prefixStart + j;
			const isWordBoundary = pos === 0 || WORD_BOUNDARY_CHARS.test(c[pos - 1]);
			if (j > 0) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			}
			if (isWordBoundary) {
				score -= 10;
			}
			score += pos * 0.1;
		}
		if (tier === MatchTier.Exact) {
			score -= 100;
		}
		return { tier, score };
	}

	// 否则走贪心子序列扫描与打分（沿用 pi-tui 口径）
	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	while (queryIndex < q.length) {
		const i = c.indexOf(q[queryIndex], lastMatchIndex + 1);
		if (i === -1) {
			return null; // 不是子序列，不匹配
		}

		const isWordBoundary = i === 0 || WORD_BOUNDARY_CHARS.test(c[i - 1]);

		if (lastMatchIndex === i - 1) {
			consecutiveMatches++;
			score -= consecutiveMatches * 5;
		} else {
			consecutiveMatches = 0;
			if (lastMatchIndex >= 0) {
				score += (i - lastMatchIndex - 1) * 2;
			}
		}

		if (isWordBoundary) {
			score -= 10;
		}

		score += i * 0.1;
		lastMatchIndex = i;
		queryIndex++;
	}

	return { tier: MatchTier.Subsequence, score };
}

/**
 * 按已输入的 `prefix`（`/` 之后、首个空格之前的那段）过滤并分级排序候选。
 *
 * 排序逻辑：
 * 1. 分级（高到低）：Exact > StartsWith > 词边界前缀 (WordBoundary) > 子序列 (Subsequence)；
 * 2. 同级内规则：
 *    - 前三级（Exact / StartsWith / WordBoundary）严格保持目录原顺序（内置 → 扩展/模板 → skills → 插件）；
 *    - 子序列级按 fuzzy 打分升序（更佳匹配优先）；打分相同保持原顺序。
 *
 * 对 skill 条目：`revi` / `review` / `skill:review` 都能命中 `skill:review`。
 * `prefix` 为空即返回全部新数组副本；无匹配时返回空数组。
 */
export function filterSlashCommands<T extends { name: string; source: string }>(
	commands: readonly T[],
	prefix: string,
): T[] {
	const query = prefix.toLowerCase();
	if (!query) return [...commands];

	type ScoredCommand = {
		cmd: T;
		tier: MatchTier;
		score: number;
		index: number;
	};

	const matches: ScoredCommand[] = [];

	for (let i = 0; i < commands.length; i++) {
		const cmd = commands[i];
		const candidates = slashCandidates(cmd.name, cmd.source);
		let best: FuzzyScoreResult | null = null;

		for (const cand of candidates) {
			const res = fuzzyScore(query, cand);
			if (!res) continue;
			if (!best || res.tier < best.tier || (res.tier === best.tier && res.score < best.score)) {
				best = res;
			}
		}

		if (best) {
			matches.push({
				cmd,
				tier: best.tier,
				score: best.score,
				index: i,
			});
		}
	}

	matches.sort((a, b) => {
		if (a.tier !== b.tier) {
			return a.tier - b.tier;
		}
		if (a.tier < MatchTier.Subsequence) {
			return a.index - b.index;
		}
		if (Math.abs(a.score - b.score) > 1e-6) {
			return a.score - b.score;
		}
		return a.index - b.index;
	});

	return matches.map((m) => m.cmd);
}

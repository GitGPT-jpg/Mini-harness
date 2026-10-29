/**
 * 右侧文件树「显示隐藏文件」开关的纯函数部分。
 *
 * 服务端本来就会下发 dotfiles（只过滤 node_modules / .git / .pi-web 之类的噪声），
 * 所以「隐藏」在客户端过滤即可：不动 wire 协议、不影响搜索与其他面板、也不需要重启服务。
 */

/** 该条目名是否属于「隐藏」（以 `.` 开头）。`..`（上级目录行）不算隐藏。 */
export function isHiddenEntryName(name: string): boolean {
	return name.startsWith(".") && name !== "..";
}

/** 按开关过滤目录项：`showHidden` 为假时隐藏以 `.` 开头的条目（保持原顺序，不改动入参）。 */
export function visibleTreeEntries<T extends { name: string }>(
	entries: readonly T[],
	showHidden: boolean,
): readonly T[] {
	if (showHidden) return entries;
	return entries.filter((entry) => !isHiddenEntryName(entry.name));
}

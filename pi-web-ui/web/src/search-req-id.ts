/**
 * 全局搜索请求 ID 分配器。
 * 供 ChatInput（@ 内置文件补全）与 GlobalSearchModal（Ctrl+K 全局搜索）共享，
 * 避免各自私有计数导致 reqId 编号空间重叠引发并发响应错乱认领（issue #496）。
 */
let searchReqCounter = 1;

export function nextSearchReqId(): number {
	return ++searchReqCounter;
}

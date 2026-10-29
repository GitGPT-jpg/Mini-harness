/**
 * canvas-client.ts — Canvas Studio 独立 WebSocket 客户端。
 *
 * 绕行主 use-chat.ts，独立持有与服务端的专用事件与状态通道。
 */
import { appUrl } from "../../base-url";
import { PROTOCOL_VERSION } from "../../protocol-version";
import type { ClientMessage, ServerMessage } from "../../types";
import { randomUuid } from "../../uuid";

type CanvasMessageListener = (msg: ServerMessage) => void;

export class CanvasClient {
	private ws: WebSocket | null = null;
	private readonly clientId = `canvas:${randomUuid().slice(0, 8)}`;
	private readonly listeners = new Set<CanvasMessageListener>();
	private disposed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** 当前正在编辑的工程：重连/刷新后恢复它而非硬编码 default（#704，跨会话落 localStorage）。 */
	private currentGraphId = CanvasClient.readLastGraphId();

	private static lastGraphKey(): string {
		return "pi-web-ui.canvas.lastGraphId";
	}

	private static readLastGraphId(): string {
		try {
			const saved = localStorage.getItem(CanvasClient.lastGraphKey());
			if (saved && /^[A-Za-z0-9._-]{1,64}$/.test(saved)) return saved;
		} catch {
			// 无痕/禁用存储时回落 default
		}
		return "default";
	}

	/** 外部发送通道（主 WS）切工程时同步追踪，保证重连恢复的是当前工程（#704）。 */
	setCurrentGraphId(id: string): void {
		if (typeof id === "string" && id) {
			this.currentGraphId = id;
			try {
				localStorage.setItem(CanvasClient.lastGraphKey(), id);
			} catch {
				// 存储不可写时仅保内存
			}
		}
	}

	connect(): void {
		if (this.disposed || this.ws) return;
		try {
			const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${wsProtocol}//${location.host}${appUrl("/ws")}`;
			const ws = new WebSocket(wsUrl);
			this.ws = ws;

			ws.onopen = () => {
				if (this.ws !== ws) return;
				this.send({
					type: "hello",
					clientId: this.clientId,
					protocolVersion: PROTOCOL_VERSION,
				});
				this.send({ type: "canvas_list" });
				this.send({ type: "canvas_cards" });
				this.send({ type: "canvas_load", id: this.currentGraphId });
			};

			ws.onmessage = (ev) => {
				if (this.ws !== ws) return;
				try {
					const msg = JSON.parse(ev.data as string) as ServerMessage;
					for (const l of this.listeners) {
						l(msg);
					}
				} catch {
					// 忽略格式错误
				}
			};

			ws.onclose = () => {
				if (this.ws === ws) {
					this.ws = null;
				}
				if (!this.disposed && !this.reconnectTimer) {
					this.reconnectTimer = setTimeout(() => {
						this.reconnectTimer = null;
						this.connect();
					}, 2000);
				}
			};
		} catch {
			// 忽略网络初始化错误
		}
	}

	send(msg: ClientMessage): boolean {
		// 跟踪当前工程：canvas_load / canvas_save 均以显式 id 为准（#704，顺带持久化）
		if (msg.type === "canvas_load" && typeof (msg as { id?: unknown }).id === "string") {
			this.setCurrentGraphId((msg as { id: string }).id);
		} else if (msg.type === "canvas_save" && typeof (msg as { graph?: { id?: unknown } }).graph?.id === "string") {
			this.setCurrentGraphId((msg as { graph: { id: string } }).graph.id);
		}
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
			return true;
		}
		return false;
	}

	subscribe(fn: CanvasMessageListener): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	dispose(): void {
		this.disposed = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.listeners.clear();
	}
}

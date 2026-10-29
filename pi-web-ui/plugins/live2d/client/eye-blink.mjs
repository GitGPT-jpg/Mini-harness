/**
 * Live2D 自然与节奏眨眼引擎 (Eye Blink Engine)
 * 实现符合二次元生理学与萌宠物理规律的眼睑开闭曲线
 * 包含：自然随机眨眼、灵动双重连眨 (Double Blink)、单眼 Wink (抛媚眼) 与音乐节拍联动
 */

export class EyeBlinkEngine {
	constructor(options = {}) {
		this.enabled = options.enabled !== false;

		// 眨眼状态机: "idle" | "closing" | "closed" | "opening"
		this.state = "idle";
		this.stateTime = 0;

		// 物理时间参数 (毫秒)
		this.closingDuration = options.closingDuration || 75; // 闭眼耗时 (快)
		this.closedDuration = options.closedDuration || 25; // 闭合保持 (极短)
		this.openingDuration = options.openingDuration || 135; // 睁眼耗时 (柔和缓开)

		// 自然眨眼间隔 (毫秒)
		this.minInterval = options.minInterval || 2400;
		this.maxInterval = options.maxInterval || 5200;
		this.doubleBlinkChance = options.doubleBlinkChance ?? 0.2; // 20% 概率连续双眨

		this.nextBlinkTimer = this._getRandomInterval();
		this.pendingDoubleBlink = false;

		// 左右眼开合度 [0.0 ~ 1.0] (1.0 为全睁，0.0 为全闭)
		this.leftOpen = 1.0;
		this.rightOpen = 1.0;

		// 单眼 Wink 状态
		this.winkSide = null; // null | "left" | "right"
		this.winkDuration = 550;
		this.winkTimer = 0;
	}

	_getRandomInterval() {
		return this.minInterval + Math.random() * (this.maxInterval - this.minInterval);
	}

	/** 外部手动触发眨眼 (一次完整自然眨眼) */
	triggerBlink() {
		if (this.state === "idle") {
			this.state = "closing";
			this.stateTime = 0;
			this.winkSide = null;
		}
	}

	/** 外部手动触发单眼 Wink */
	triggerWink(side = "right") {
		this.winkSide = side === "left" ? "left" : "right";
		this.winkTimer = this.winkDuration;
	}

	/** 音乐节拍触发联动眨眼 */
	onMusicBeat() {
		if (!this.enabled || this.state !== "idle" || this.winkSide) return;
		// 如果距离下次眨眼还有较长时间，且随机命中，则顺应节拍可爱的眨一下
		if (this.nextBlinkTimer > 1000 && Math.random() < 0.28) {
			this.triggerBlink();
		}
	}

	setEnabled(val) {
		this.enabled = Boolean(val);
		if (!this.enabled) {
			this.leftOpen = 1.0;
			this.rightOpen = 1.0;
			this.state = "idle";
			this.winkSide = null;
		}
	}

	/**
	 * 每一帧渲染循环调用，更新眨眼状态机
	 * @param {number} deltaMs 距离上一帧的时间跨度 (毫秒)
	 * @returns {{ left: number, right: number }} 左右眼开合系数 [0.0 ~ 1.0]
	 */
	update(deltaMs) {
		if (!this.enabled) {
			return { left: 1.0, right: 1.0 };
		}

		// 限制单帧最大时间步长，避免页面卡顿跳帧导致的异常
		const dt = Math.min(deltaMs, 100);

		// 1. 处理单眼 Wink (抛媚眼)
		if (this.winkSide) {
			this.winkTimer -= dt;
			if (this.winkTimer <= 0) {
				this.winkSide = null;
				this.leftOpen = 1.0;
				this.rightOpen = 1.0;
			} else {
				// Wink 曲线：前 15% 快速闭上，中间保持，后 25% 睁开
				const progress = 1 - this.winkTimer / this.winkDuration;
				let ratio = 0;
				if (progress < 0.15) {
					ratio = 1 - progress / 0.15;
				} else if (progress > 0.75) {
					ratio = (progress - 0.75) / 0.25;
				} else {
					ratio = 0;
				}

				if (this.winkSide === "left") {
					this.leftOpen = ratio;
					this.rightOpen = 1.0;
				} else {
					this.leftOpen = 1.0;
					this.rightOpen = ratio;
				}
				return { left: this.leftOpen, right: this.rightOpen };
			}
		}

		// 2. 双眼自然眨眼状态机
		this.stateTime += dt;

		switch (this.state) {
			case "idle": {
				this.leftOpen = 1.0;
				this.rightOpen = 1.0;
				this.nextBlinkTimer -= dt;

				if (this.nextBlinkTimer <= 0) {
					this.state = "closing";
					this.stateTime = 0;
				}
				break;
			}

			case "closing": {
				const progress = Math.min(1.0, this.stateTime / this.closingDuration);
				// 使用非线性缓动：闭眼越来越快 (加速闭合)
				const easeClose = Math.pow(1 - progress, 1.8);
				this.leftOpen = easeClose;
				this.rightOpen = easeClose;

				if (progress >= 1.0) {
					this.state = "closed";
					this.stateTime = 0;
					this.leftOpen = 0.0;
					this.rightOpen = 0.0;
				}
				break;
			}

			case "closed": {
				this.leftOpen = 0.0;
				this.rightOpen = 0.0;

				if (this.stateTime >= this.closedDuration) {
					this.state = "opening";
					this.stateTime = 0;
				}
				break;
			}

			case "opening": {
				const progress = Math.min(1.0, this.stateTime / this.openingDuration);
				// 使用平滑正弦缓动：睁眼平滑柔和
				const easeOpen = Math.sin((progress * Math.PI) / 2);
				this.leftOpen = easeOpen;
				this.rightOpen = easeOpen;

				if (progress >= 1.0) {
					this.state = "idle";
					this.stateTime = 0;
					this.leftOpen = 1.0;
					this.rightOpen = 1.0;

					// 判定是否触发萌态连续双重眨眼
					if (this.pendingDoubleBlink) {
						this.pendingDoubleBlink = false;
						this.nextBlinkTimer = this._getRandomInterval();
					} else if (Math.random() < this.doubleBlinkChance) {
						this.pendingDoubleBlink = true;
						this.nextBlinkTimer = 110; // 110ms 后立即再眨一次
					} else {
						this.nextBlinkTimer = this._getRandomInterval();
					}
				}
				break;
			}
		}

		return {
			left: Math.max(0.0, Math.min(1.0, this.leftOpen)),
			right: Math.max(0.0, Math.min(1.0, this.rightOpen)),
		};
	}
}

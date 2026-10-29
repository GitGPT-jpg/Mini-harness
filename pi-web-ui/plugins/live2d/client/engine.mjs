/**
 * Live2D WebGL 引擎包装层 (Pixi.js + pixi-live2d-display)
 * 本地依赖优先 + CDN 自动降级，支持 Cubism 2 / 3 / 4 模型
 */
import { EMOTION_ALIAS_MAP } from "./models.mjs";
import { AudioLipSyncEngine } from "./audio-lipsync.mjs";
import { EyeBlinkEngine } from "./eye-blink.mjs";

function loadScript(src) {
	return new Promise((resolve, reject) => {
		// 避免重复注入相同脚本
		const existing = document.querySelector(`script[src="${src}"]`);
		if (existing) {
			if (existing.dataset.loaded === "true") return resolve();
			existing.addEventListener("load", () => resolve());
			existing.addEventListener("error", (e) => reject(e));
			return;
		}
		const s = document.createElement("script");
		s.src = src;
		s.async = false;
		s.onload = () => {
			s.dataset.loaded = "true";
			resolve();
		};
		s.onerror = (err) => reject(err);
		document.head.appendChild(s);
	});
}

let engineReadyPromise = null;

export function ensureLive2dEngine(clientBase) {
	if (engineReadyPromise) return engineReadyPromise;

	engineReadyPromise = (async () => {
		// 1. 尝试从本地 vendor 加载
		try {
			// Cubism 4 Core
			if (!window.Live2DCubismCore) {
				await loadScript(`${clientBase}/vendor/live2dcubismcore.min.js`);
			}
			// Cubism 2 Core
			if (!window.Live2D) {
				await loadScript(`${clientBase}/vendor/live2d.min.js`);
			}
			// Pixi.js
			if (!window.PIXI) {
				await loadScript(`${clientBase}/vendor/pixi.min.js`);
			}
			// pixi-live2d-display
			if (!window.PIXI?.live2d?.Live2DModel) {
				await loadScript(`${clientBase}/vendor/pixi-live2d-display.min.js`);
			}
		} catch (localErr) {
			console.warn("[live2d] 本地 vendor 加载失败，回退 CDN：", localErr);
			// 2. 回退 CDN
			if (!window.Live2DCubismCore) {
				await loadScript("https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2dcubismcore.min.js");
			}
			if (!window.Live2D) {
				await loadScript("https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js");
			}
			if (!window.PIXI) {
				await loadScript("https://cdn.jsdelivr.net/npm/pixi.js@6.5.8/dist/browser/pixi.min.js");
			}
			if (!window.PIXI?.live2d?.Live2DModel) {
				await loadScript("https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/index.min.js");
			}
		}

		if (!window.PIXI || !window.PIXI.live2d?.Live2DModel) {
			throw new Error("Live2D 渲染引擎未能成功加载");
		}
		return window.PIXI;
	})();

	return engineReadyPromise;
}

export class Live2DStage {
	constructor(canvas, options = {}) {
		this.canvas = canvas;
		this.options = options;
		this.app = null;
		this.model = null;
		this.currentModelKey = "";
		this.mode = options.mode || "mouse"; // "mouse" | "idle"
		this.disposed = false;
		this.expressions = [];
		this.motions = [];
		this._onMouseMove = this._handleMouseMove.bind(this);

		// 音频口型对齐与自然眨眼引擎
		this.audioSync = new AudioLipSyncEngine({
			sensitivity: options.lipSyncSensitivity ?? 1.25,
			voiceOnly: options.voiceOnly !== false,
			onBeat: () => {
				this.eyeBlink?.onMusicBeat();
			},
		});
		this.eyeBlink = new EyeBlinkEngine({
			enabled: options.autoBlink !== false,
		});
		this._onBeforeModelUpdate = null;
		this._lastMouthOpen = 0.0;
		this._lastTickerTime = performance.now();
		this._beatGroove = 0.0;
	}

	async init() {
		const PIXI = window.PIXI;
		const width = this.canvas.width || 280;
		const height = this.canvas.height || 340;

		this.app = new PIXI.Application({
			view: this.canvas,
			transparent: true,
			backgroundAlpha: 0,
			preserveDrawingBuffer: true,
			width,
			height,
			autoDensity: true,
			antialias: true,
			resolution: window.devicePixelRatio || 1,
		});

		window.addEventListener("mousemove", this._onMouseMove, { passive: true });
	}

	/**
	 * 智能检测指定视口像素坐标是否为完全透明
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {boolean} true 为透明（应点击穿透），false 为非透明角色身体（应响应交互）
	 */
	isPixelTransparent(clientX, clientY) {
		if (!this.app || !this.canvas || !this.model || this.disposed) return true;
		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return true;
		if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
			return true;
		}

		try {
			const gl = this.app.renderer?.gl;
			if (!gl) return false;

			const scaleX = this.canvas.width / rect.width;
			const scaleY = this.canvas.height / rect.height;
			const x = Math.floor((clientX - rect.left) * scaleX);
			const y = Math.floor((clientY - rect.top) * scaleY);
			// WebGL 纹理垂直 Y 轴从底部起算
			const glY = this.canvas.height - y - 1;

			if (x >= 0 && x < this.canvas.width && glY >= 0 && glY < this.canvas.height) {
				const pixel = new Uint8Array(4);
				gl.readPixels(x, glY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
				// pixel[3] 为 Alpha 灰度通道值，阈值取 16 过滤 WebGL 抗锯齿透明噪点
				return pixel[3] < 16;
			}
		} catch {
			return false;
		}
		return true;
	}

	async loadModel(modelConfig) {
		if (this.disposed || !this.app) return;
		const PIXI = window.PIXI;

		this.currentModelKey = modelConfig.key || "";

		// 先加载 Live2D 模型实例，成功后再替换旧模型，避免加载失败时导致舞台变空白
		const Live2DModel = PIXI.live2d.Live2DModel;
		const newModel = await Live2DModel.from(modelConfig.url, {
			autoInteract: false,
		});

		if (this.disposed) {
			newModel.destroy();
			return;
		}

		// 销毁旧模型
		if (this.model) {
			try {
				this.app.stage.removeChild(this.model);
				this.model.destroy();
			} catch {}
			this.model = null;
		}

		this.model = newModel;
		this.app.stage.addChild(newModel);

		// 设置锚点与居中缩放
		newModel.anchor.set(0.5, 0.5);
		const canvasW = this.canvas.width;
		const canvasH = this.canvas.height;
		newModel.x = canvasW / 2;
		newModel.y = canvasH / 2 + (modelConfig.offsetY || 0);

		// 计算最佳自适应缩放比
		const fitScale = Math.min(canvasW / newModel.width, canvasH / newModel.height) * 0.95 * (modelConfig.scale || 1.0);
		newModel.scale.set(fitScale, fitScale);
		this.baseScale = fitScale;

		// 提取该模型拥有的所有表情与动作
		this.expressions = this._extractExpressions(newModel, modelConfig);
		this.motions = this._extractMotions(newModel, modelConfig);

		// 挂钩口型与眨眼更新管线
		this._hookModelLipSyncAndBlink(newModel);

		// 开启默认模式
		this.setMode(this.mode);
	}

	_hookModelLipSyncAndBlink(model) {
		const internal = model?.internalModel;
		if (!internal) return;

		// 避免重复绑定
		if (this._onBeforeModelUpdate) {
			internal.off?.("beforeModelUpdate", this._onBeforeModelUpdate);
		}

		this._onBeforeModelUpdate = () => {
			if (this.disposed || !this.model) return;
			const core = this.model.internalModel?.coreModel;
			if (!core) return;

			const now = performance.now();
			const deltaMs = Math.max(1, Math.min(100, now - this._lastTickerTime));
			this._lastTickerTime = now;

			// 1. 自然与节拍眨眼驱动
			if (this.eyeBlink) {
				const blink = this.eyeBlink.update(deltaMs);
				this._applyBlink(core, blink);
			}

			// 2. 音频音乐口型对齐驱动
			if (this.audioSync) {
				const mouthOpen = this.audioSync.update();
				if (mouthOpen > 0.001 || this._lastMouthOpen > 0.001) {
					this._applyMouth(core, mouthOpen);
					this._lastMouthOpen = mouthOpen;
				}

				// 3. 伴随音乐节拍轻微律动微摆 (Groove)
				if (this.audioSync.isPlaying()) {
					if (this.audioSync.isBeat) {
						this._beatGroove = 1.0;
					}
					if (this._beatGroove > 0.01) {
						this._applyBeatGroove(core, this._beatGroove);
						this._beatGroove *= 0.88;
					}
				}
			}
		};

		internal.on("beforeModelUpdate", this._onBeforeModelUpdate);
	}

	_applyBlink(core, blink) {
		// Cubism 4 Core
		if (typeof core.setParameterValueById === "function") {
			try {
				let curL = core.getParameterValueById("ParamEyeLOpen");
				let curR = core.getParameterValueById("ParamEyeROpen");
				if (curL === undefined || isNaN(curL)) curL = 1.0;
				if (curR === undefined || isNaN(curR)) curR = 1.0;

				core.setParameterValueById("ParamEyeLOpen", curL * blink.left);
				core.setParameterValueById("ParamEyeROpen", curR * blink.right);

				// 兜底其它可能在 eyeBlinkIds 中的特殊眼睛参数
				const blinkIds = this.model?.internalModel?.eyeBlinkIds;
				if (Array.isArray(blinkIds)) {
					for (const id of blinkIds) {
						if (id !== "ParamEyeLOpen" && id !== "ParamEyeROpen") {
							const v = core.getParameterValueById(id);
							core.setParameterValueById(id, (isNaN(v) ? 1.0 : v) * blink.left);
						}
					}
				}
			} catch {}
			return;
		}

		// Cubism 2 Core
		if (typeof core.setParamFloat === "function") {
			try {
				let curL = typeof core.getParamFloat === "function" ? core.getParamFloat("PARAM_EYE_L_OPEN") : 1.0;
				let curR = typeof core.getParamFloat === "function" ? core.getParamFloat("PARAM_EYE_R_OPEN") : 1.0;
				if (curL === undefined || isNaN(curL)) curL = 1.0;
				if (curR === undefined || isNaN(curR)) curR = 1.0;
				core.setParamFloat("PARAM_EYE_L_OPEN", curL * blink.left);
				core.setParamFloat("PARAM_EYE_R_OPEN", curR * blink.right);
			} catch {}
		}
	}

	_applyMouth(core, mouthOpen) {
		// 夸张放大一级, 让中小音量下嘴型依然清晰可见 (上限钳制 1.0)
		// 基底只垫 0.03: VAD 关门时间奏真正闭嘴, 不会一直半张着
		const v = Math.max(0.0, Math.min(1.0, mouthOpen * 1.25 + (mouthOpen > 0.03 ? 0.03 : 0)));
		// Cubism 4 Core
		if (typeof core.setParameterValueById === "function") {
			try {
				core.setParameterValueById("ParamMouthOpenY", v);
				core.setParameterValueById("PARAM_MOUTH_OPEN_Y", v);

				const lipSyncIds = this.model?.internalModel?.lipSyncIds;
				if (Array.isArray(lipSyncIds)) {
					for (const id of lipSyncIds) {
						core.setParameterValueById(id, v);
					}
				}
				// 注意: 不再每帧覆盖 ParamMouthForm, 该参数控制嘴角形态会被表情/动作接管,
				// 强行写入会把嘴收窄反而让张嘴看起来不明显
			} catch {}
			return;
		}

		// Cubism 2 Core
		if (typeof core.setParamFloat === "function") {
			try {
				core.setParamFloat("PARAM_MOUTH_OPEN_Y", v);
			} catch {}
			try {
				core.setParamFloat("ParamMouthOpenY", v);
			} catch {}
		}
	}

	_applyBeatGroove(core, groove) {
		const swayZ = Math.sin(performance.now() / 160) * groove * 1.5;
		const swayX = Math.cos(performance.now() / 200) * groove * 0.8;
		// Cubism 4 Core
		if (typeof core.addParameterValueById === "function") {
			try {
				core.addParameterValueById("ParamAngleZ", swayZ);
				core.addParameterValueById("ParamBodyAngleX", swayX);
			} catch {}
			return;
		}
		// Cubism 2 Core
		if (typeof core.addToParamFloat === "function") {
			try {
				core.addToParamFloat("PARAM_ANGLE_Z", swayZ);
			} catch {}
		}
	}

	triggerBlink() {
		this.eyeBlink?.triggerBlink();
	}

	triggerWink(side = "right") {
		this.eyeBlink?.triggerWink(side);
	}

	setAutoBlink(enabled) {
		this.eyeBlink?.setEnabled(enabled);
	}

	setLipSyncSensitivity(sens) {
		this.audioSync?.setSensitivity(sens);
	}

	setVoiceOnly(enabled) {
		this.audioSync?.setVoiceOnly(enabled);
	}

	_extractExpressions(model, modelConfig) {
		const set = new Set(modelConfig.expressions || []);
		try {
			const expManager = model.internalModel?.motionManager?.expressionManager;
			if (expManager?.definitions) {
				for (const def of expManager.definitions) {
					if (def.name) set.add(def.name);
				}
			}
		} catch {}
		return Array.from(set);
	}

	_extractMotions(model, modelConfig) {
		const list = [...(modelConfig.motions || [])];
		try {
			const motions = model.internalModel?.motionManager?.definitions;
			if (motions) {
				for (const group of Object.keys(motions)) {
					if (!list.includes(group)) list.push(group);
				}
			}
		} catch {}
		return list;
	}

	setMode(mode) {
		this.mode = mode;
		if (!this.model) return;
		if (mode === "idle") {
			// 平滑回正视线
			this.model.focus(this.canvas.width / 2, this.canvas.height / 2);
		}
	}

	_handleMouseMove(e) {
		if (this.disposed || !this.model) return;
		if (this.app?.ticker && !this.app.ticker.started) return;

		const rect = this.canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;

		if (this.mode === "mouse") {
			// 将鼠标在浏览器视口中的绝对坐标转为相对于 canvas 内部的坐标
			const x = e.clientX - rect.left;
			const y = e.clientY - rect.top;
			this.model.focus(x, y);
		}

		if (typeof this.onHoverPixel === "function") {
			const inside =
				e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
			if (inside) {
				this.onHoverPixel(this.isPixelTransparent(e.clientX, e.clientY));
			} else {
				this.onHoverPixel(null);
			}
		}
	}

	stop() {
		try {
			if (this.app?.ticker?.started) {
				this.app.ticker.stop();
			}
		} catch {}
	}

	start() {
		try {
			if (this.app?.ticker && !this.app.ticker.started) {
				this.app.ticker.start();
			}
		} catch {}
	}

	/** 播放指定表情或根据语义别名匹配播放 */
	playExpression(nameOrAlias) {
		if (!this.model) return false;
		let targetExp = nameOrAlias;

		// 如果传入的是语义别名（如 happy, sad, angry），尝试匹配模型已有的表情
		const lower = String(nameOrAlias).toLowerCase();
		if (EMOTION_ALIAS_MAP[lower]) {
			const candidates = EMOTION_ALIAS_MAP[lower];
			for (const c of candidates) {
				const found = this.expressions.find((e) => e.toLowerCase() === c.toLowerCase());
				if (found) {
					targetExp = found;
					break;
				}
			}
		} else {
			// 模糊匹配现有表情
			const found = this.expressions.find((e) => e.toLowerCase() === lower);
			if (found) targetExp = found;
		}

		try {
			this.model.expression(targetExp);
			return true;
		} catch (err) {
			console.warn("[live2d] 播放表情失败:", targetExp, err);
			return false;
		}
	}

	/** 播放指定动作（不区分大小写匹配实际动作名称） */
	playMotion(group, index = 0) {
		if (!this.model) return false;
		let targetGroup = group;
		if (this.motions && this.motions.length > 0) {
			const lower = String(group).toLowerCase();
			const found = this.motions.find((m) => m.toLowerCase() === lower);
			if (found) targetGroup = found;
		}
		try {
			this.model.motion(targetGroup, index);
			return true;
		} catch (err) {
			console.warn("[live2d] 播放动作失败:", targetGroup, err);
			return false;
		}
	}

	/** 检测点击命中区域并触发互动 */
	hitTest(clientX, clientY) {
		if (!this.model) return null;
		const rect = this.canvas.getBoundingClientRect();
		const x = clientX - rect.left;
		const y = clientY - rect.top;

		try {
			const hitAreas = this.model.hitTest(x, y);
			if (hitAreas && hitAreas.length > 0) {
				const area = String(hitAreas[0]).toLowerCase();
				if (area.includes("head")) return "head";
				if (area.includes("body")) return "body";
				if (area.includes("mouth")) return "mouth";
				return hitAreas[0];
			}
		} catch {}

		// 默认区域粗略判定（上 35% 为头部，其余为身体）
		const relY = y / rect.height;
		return relY < 0.35 ? "head" : "body";
	}

	resize(width, height) {
		if (!this.app) return;
		this.canvas.width = width;
		this.canvas.height = height;
		this.app.renderer.resize(width, height);
		if (this.model) {
			this.model.x = width / 2;
			this.model.y = height / 2;
		}
	}

	destroy() {
		this.disposed = true;
		window.removeEventListener("mousemove", this._onMouseMove);
		if (this.audioSync) {
			try {
				this.audioSync.destroy();
			} catch {}
			this.audioSync = null;
		}
		if (this.model) {
			try {
				this.model.destroy();
			} catch {}
			this.model = null;
		}
		if (this.app) {
			try {
				this.app.destroy(true, { children: true, texture: true, baseTexture: true });
			} catch {}
			this.app = null;
		}
	}
}

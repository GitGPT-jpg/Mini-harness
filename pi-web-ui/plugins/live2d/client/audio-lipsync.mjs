/**
 * Live2D 音乐与音频口型对齐分析引擎 (Audio Lip Sync Engine - Pro VAD Edition)
 *
 * 核心特性：
 * 1. 音量解耦拓扑 (Source -> Analyser -> Gain -> Destination) + 自适应动态范围归一化 (AGC)，彻底排除音量与母带响度影响
 * 2. 多频带共振峰特征提取：精准分离低频伴奏 (Bass)、第一共振峰 F1 (开口度)、第二共振峰 F2 (咬字)、唇齿音 (Sibilance)
 * 3. 双重人声门控 (VAD)：非对称慢速伴奏基底剥离 + 半波整流频谱通量 (Spectral Flux)，纯伴奏/间奏自动闭嘴
 * 4. 拟人音节动力学：辅音瞬态微闭合 (Consonant Dip) + 长音持续衰减 (Sustain Decay)，避免高潮段嘴巴一直死张
 */

let sharedAudioCtx = null;

function getSharedAudioContext() {
	if (!sharedAudioCtx) {
		const AudioCtx = window.AudioContext || window.webkitAudioContext;
		if (AudioCtx) {
			sharedAudioCtx = new AudioCtx();
		}
	}
	if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
		void sharedAudioCtx.resume();
	}
	return sharedAudioCtx;
}

/**
 * 基于归一化自相关的基频估计 (F0 65~500Hz) + 周期性强度 (voicing clarity)
 * 输入为 AnalyserNode 字节时域数据 (0~255, 128 为零点), 输出 { f0, clarity }
 * 用途：识别机器般恒定音高的鼓点/贝斯 Loop (人声自带颤音与音高游走)
 */
function estimateVocalF0(timeBytes, sampleRate) {
	const n = timeBytes.length;
	const minLag = Math.max(2, Math.floor(sampleRate / 500));
	const maxLag = Math.min(n - 1, Math.ceil(sampleRate / 65));
	let e0 = 0;
	for (let i = 0; i < n; i++) {
		const v = (timeBytes[i] - 128) / 128;
		e0 += v * v;
	}
	if (e0 < 1e-9) return { f0: 0, clarity: 0 };
	let best = 0,
		bestLag = 0;
	for (let lag = minLag; lag <= maxLag; lag++) {
		let s = 0,
			e1 = 0;
		for (let i = 0; i + lag < n; i++) {
			const a = (timeBytes[i] - 128) / 128;
			const b = (timeBytes[i + lag] - 128) / 128;
			s += a * b;
			e1 += b * b;
		}
		const c = s / Math.sqrt(e0 * e1 + 1e-12);
		if (c > best) {
			best = c;
			bestLag = lag;
		}
	}
	return { f0: bestLag ? sampleRate / bestLag : 0, clarity: best };
}

export class AudioLipSyncEngine {
	constructor(options = {}) {
		this.options = options;
		this.audioCtx = null;
		this.analyser = null;
		this.gainNode = null;
		this.sourceNode = null;

		// 媒体音频元素
		this.audioEl = null;
		this._mediaElementSource = null;
		this._currentBlobUrl = null;

		// 提升 FFT 精度至 1024 (约 43Hz/bin)，精准分离人声共振峰与低频伴奏
		this.fftSize = 1024;
		this.timeDomainData = new Uint8Array(this.fftSize);
		this.frequencyData = new Uint8Array(this.fftSize / 2);
		this.prevVocalBins = new Float32Array(this.fftSize / 2);

		// 口型平滑与参数配置
		this.mouthOpen = 0.0;
		this.rawVolume = 0.0;
		this.sensitivity = options.sensitivity ?? 1.25; // 灵敏度增益 0.5 ~ 2.5
		this.noiseGate = options.noiseGate ?? 0.018; // 绝对静音底噪门限
		this.attackRate = options.attackRate ?? 0.72; // 吐字张嘴速度 (快而跟手)
		this.decayRate = options.decayRate ?? 0.28; // 闭嘴回落速度 (自然收拢)
		this.volume = options.volume ?? 0.85;

		// 自适应人声检测 (VAD) 与动态范围控制 (AGC) 状态
		this.voiceOnly = options.voiceOnly ?? true;
		this.vocalFloor = null; // 慢速伴奏床基底
		this.vocalPeak = 0.15; // 自适应人声峰值包络 (用于消除歌曲本身音量大小差异)
		this.prevVocalEnergy = 0; // 上一帧人声能量
		this.fluxEnv = 0; // 音节起始频谱通量包络 (检测“正在吐字”)
		this.vadGain = 0; // VAD 开门权重 [0.0 ~ 1.0]
		this.sustainTimer = 0; // 持续高能量计时 (抑制长音/高潮一直大张嘴)
		this.syllablePulse = 0; // 拟人音节律动脉冲
		this._vadWarmup = 0; // 切歌预热帧数
		this._lastUpdateTime = 0;
		this.hangover = 0; // 人声延续窗 (字间停顿/辅音不断嘴)
		this.hangoverBirth = -1e9; // 当前 hangover 起始时刻 (ms)
		this.prevRms = 0; // 上一帧 RMS (稳态检测)
		this.clarityS = 0; // 平滑后的周期性强度 ( voicing )
		this.runMean = 0; // 当前稳态基频游程均值
		this.runLen = 0; // 当前稳态游程长度 (帧)
		this.lastLongRun = null; // 上一个长稳态游程 {p, t}
		this.prevMachineVeto = false; // 上一帧机器 veto 状态 (边沿检测)
		this.killCooldownUntil = -1e9; // birth-kill 后的冷静期 (防机器反复起音)
		this.envRing = new Array(240).fill(0); // 人声包络环形缓冲 (循环重复检测)
		this.loopVotes = 0; // 循环重复投票数
		this.loopCorr = 0; // 最近一次循环相关系数 (调试)
		this.loopTick = 0; // 循环检测节流计数

		// 节拍检测
		this.lastBeatTime = 0;
		this.beatEnergyAvg = 0.0;
		this.isBeat = false;

		// 播放器状态
		this.state = "idle"; // "idle" | "playing" | "paused"
		this.trackTitle = "";
		this.duration = 0;
		this.currentTime = 0;
		this.isDemoActive = false;
		this._demoTimer = null;
		this._demoNodes = [];

		// 回调函数
		this.onProgress = options.onProgress || null;
		this.onStateChange = options.onStateChange || null;
		this.onBeat = options.onBeat || null;
		this.onEnded = options.onEnded || null;

		this._initAudioElement();
	}

	_initAudioElement() {
		this.audioEl = new Audio();
		this.audioEl.crossOrigin = "anonymous";
		this.audioEl.preload = "auto";

		this.audioEl.addEventListener("play", () => {
			this.state = "playing";
			this._ensureContextResumed();
			this.onStateChange?.(this.state);
		});

		this.audioEl.addEventListener("pause", () => {
			if (this.state !== "idle") {
				this.state = "paused";
				this.onStateChange?.(this.state);
			}
		});

		this.audioEl.addEventListener("ended", () => {
			this.state = "idle";
			this.mouthOpen = 0.0;
			this.rawVolume = 0.0;
			this._resetVadState();
			this.onStateChange?.(this.state);
			this.onEnded?.();
		});

		this.audioEl.addEventListener("timeupdate", () => {
			this.currentTime = this.audioEl.currentTime || 0;
			this.duration = this.audioEl.duration || 0;
			this.onProgress?.(this.currentTime, this.duration);
		});

		this.audioEl.addEventListener("error", () => {
			console.warn("[live2d] 音频播放错误:", this.audioEl.error);
			this.state = "idle";
			this.mouthOpen = 0.0;
			this._resetVadState();
			this.onStateChange?.(this.state);
		});
	}

	_resetVadState() {
		this.vocalFloor = null;
		this.vocalPeak = 0.12;
		this.prevVocalEnergy = 0;
		this.fluxEnv = 0;
		this.vadGain = 0;
		this.sustainTimer = 0;
		this.syllablePulse = 0;
		this._vadWarmup = 8; // 切歌后前8帧快速校准伴奏基底
		this.prevVocalBins.fill(0);
		this.hangover = 0;
		this.hangoverBirth = -1e9;
		this.prevRms = 0;
		this.clarityS = 0;
		this.runMean = 0;
		this.runLen = 0;
		this.lastLongRun = null;
		this.prevMachineVeto = false;
		this.killCooldownUntil = -1e9;
		this.envRing.fill(0);
		this.loopVotes = 0;
		this.loopCorr = 0;
		this.loopTick = 0;
	}

	setVoiceOnly(val) {
		this.voiceOnly = Boolean(val);
		if (!this.voiceOnly) this.vadGain = 1;
		else this.vadGain = 0;
	}

	_ensureContext() {
		if (this.audioCtx && this.analyser && this.gainNode) {
			this._ensureContextResumed();
			return true;
		}
		this.audioCtx = getSharedAudioContext();
		if (!this.audioCtx) return false;

		try {
			this.analyser = this.audioCtx.createAnalyser();
			this.analyser.fftSize = this.fftSize;
			// 降低硬件平滑常数，保留字头辅音/元音瞬态特征
			this.analyser.smoothingTimeConstant = 0.15;

			this.gainNode = this.audioCtx.createGain();
			this.gainNode.gain.setValueAtTime(this.volume, this.audioCtx.currentTime);

			/**
			 * 关键拓扑：Source -> Analyser -> GainNode -> Destination
			 * 让 Analyser 处于 GainNode 之前，彻底消除用户调节音量对口型分析的影响！
			 */
			this.analyser.connect(this.gainNode);
			this.gainNode.connect(this.audioCtx.destination);
			return true;
		} catch (err) {
			console.warn("[live2d] 创建 AudioContext 节点失败:", err);
			return false;
		}
	}

	_ensureContextResumed() {
		if (this.audioCtx && this.audioCtx.state === "suspended") {
			void this.audioCtx.resume();
		}
	}

	_connectMediaElement() {
		if (this._mediaElementSource) return;
		if (!this._ensureContext()) return;
		try {
			this._mediaElementSource = this.audioCtx.createMediaElementSource(this.audioEl);
			// 直接接入 analyser，而非 gainNode（音量解耦）
			this._mediaElementSource.connect(this.analyser);
		} catch (err) {
			console.warn("[live2d] 连接 mediaElementSource 异常:", err);
		}
	}

	/**
	 * 播放本地文件 (File 或 Blob)
	 */
	async playFile(file) {
		if (!file) return;
		this.stop();
		this._resetVadState();
		this._ensureContextResumed();
		this._connectMediaElement();

		if (this._currentBlobUrl) {
			URL.revokeObjectURL(this._currentBlobUrl);
			this._currentBlobUrl = null;
		}

		this._currentBlobUrl = URL.createObjectURL(file);
		this.trackTitle = file.name ? file.name.replace(/\.[^/.]+$/, "") : "本地音乐";
		this.audioEl.src = this._currentBlobUrl;
		this.audioEl.volume = 1.0;

		try {
			await this.audioEl.play();
		} catch (err) {
			console.warn("[live2d] 自动播放失败 (需用户手势触发):", err);
		}
	}

	/**
	 * 播放音频 URL 直链
	 */
	async playUrl(url, title = "") {
		if (!url) return;
		this.stop();
		this._resetVadState();
		this._ensureContextResumed();
		this._connectMediaElement();

		this.trackTitle = title || url.split("/").pop().split("?")[0] || "网络音频";
		this.audioEl.src = url;
		this.audioEl.volume = 1.0;

		try {
			await this.audioEl.play();
		} catch (err) {
			console.warn("[live2d] 播放 URL 失败:", err);
		}
	}

	/**
	 * 播放 Base64 音频
	 */
	async playBase64(base64, mimeType = "audio/mpeg", title = "语音朗读") {
		if (!base64) return;
		let raw = base64;
		const match = raw.match(/^data:(audio\/[^;]+);base64,(.+)$/);
		if (match) {
			mimeType = match[1];
			raw = match[2];
		}
		const binary = atob(raw);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const blob = new Blob([bytes], { type: mimeType });
		await this.playFile(blob);
		this.trackTitle = title;
	}

	/**
	 * 播放内置合成的示范轻音乐旋律 (Demo Melody)
	 */
	playDemo() {
		this.stop();
		this._resetVadState();
		if (!this._ensureContext()) return;
		this._ensureContextResumed();

		this.isDemoActive = true;
		this.state = "playing";
		this.trackTitle = "🎹 示范旋律 (Demo Melody)";
		this.onStateChange?.(this.state);

		const ctx = this.audioCtx;
		const now = ctx.currentTime + 0.05;
		const bpm = 112;
		const beatSec = 60 / bpm;

		const chords = [
			[261.63, 329.63, 392.0, 493.88], // Cmaj7
			[220.0, 261.63, 329.63, 392.0], // Am7
			[293.66, 349.23, 440.0, 523.25], // Dm7
			[196.0, 246.94, 293.66, 349.23], // G7
		];

		const melodyNotes = [
			{ note: 523.25, time: 0, dur: 0.5 },
			{ note: 659.25, time: 0.5, dur: 0.5 },
			{ note: 587.33, time: 1.0, dur: 1.0 },
			{ note: 493.88, time: 2.0, dur: 0.5 },
			{ note: 523.25, time: 2.5, dur: 1.5 },
			{ note: 440.0, time: 4.0, dur: 0.5 },
			{ note: 523.25, time: 4.5, dur: 0.5 },
			{ note: 659.25, time: 5.0, dur: 1.0 },
			{ note: 587.33, time: 6.0, dur: 1.0 },
			{ note: 523.25, time: 7.0, dur: 1.0 },
			{ note: 587.33, time: 8.0, dur: 0.5 },
			{ note: 698.46, time: 8.5, dur: 0.5 },
			{ note: 659.25, time: 9.0, dur: 1.0 },
			{ note: 587.33, time: 10.0, dur: 0.5 },
			{ note: 440.0, time: 10.5, dur: 1.5 },
			{ note: 493.88, time: 12.0, dur: 0.5 },
			{ note: 587.33, time: 12.5, dur: 0.5 },
			{ note: 523.25, time: 13.0, dur: 1.5 },
			{ note: 392.0, time: 14.5, dur: 1.5 },
		];

		const totalBars = 4;
		const totalDuration = totalBars * 4 * beatSec;
		this.duration = totalDuration;

		// 1. 合成和弦伴奏 (接入 this.analyser)
		for (let b = 0; b < totalBars; b++) {
			const chordTime = now + b * 4 * beatSec;
			const chordFreqs = chords[b % chords.length];

			chordFreqs.forEach((freq) => {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.setValueAtTime(freq, chordTime);

				const padVol = 0.08 / chordFreqs.length;
				gain.gain.setValueAtTime(0.001, chordTime);
				gain.gain.linearRampToValueAtTime(padVol, chordTime + 0.4);
				gain.gain.setValueAtTime(padVol, chordTime + 3.2 * beatSec);
				gain.gain.exponentialRampToValueAtTime(0.001, chordTime + 4 * beatSec);

				osc.connect(gain);
				gain.connect(this.analyser);
				osc.start(chordTime);
				osc.stop(chordTime + 4 * beatSec);
				this._demoNodes.push(osc);
			});
		}

		// 2. 合成主旋律 (模拟歌唱音节，接入 this.analyser)
		melodyNotes.forEach((m) => {
			const noteTime = now + m.time * beatSec;
			const dur = m.dur * beatSec;

			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = "triangle";
			osc.frequency.setValueAtTime(m.note, noteTime);

			gain.gain.setValueAtTime(0.001, noteTime);
			gain.gain.linearRampToValueAtTime(0.22, noteTime + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.001, noteTime + Math.max(0.1, dur));

			osc.connect(gain);
			gain.connect(this.analyser);
			osc.start(noteTime);
			osc.stop(noteTime + Math.max(0.12, dur));
			this._demoNodes.push(osc);
		});

		// 3. 节拍底鼓
		for (let i = 0; i < totalBars * 4; i++) {
			const beatTime = now + i * beatSec;
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = i % 2 === 0 ? "sine" : "triangle";
			osc.frequency.setValueAtTime(i % 2 === 0 ? 120 : 240, beatTime);
			osc.frequency.exponentialRampToValueAtTime(30, beatTime + 0.08);

			gain.gain.setValueAtTime(0.2, beatTime);
			gain.gain.exponentialRampToValueAtTime(0.001, beatTime + 0.09);

			osc.connect(gain);
			gain.connect(this.analyser);
			osc.start(beatTime);
			osc.stop(beatTime + 0.1);
			this._demoNodes.push(osc);
		}

		const startTime = performance.now();
		const timerInterval = setInterval(() => {
			if (!this.isDemoActive) {
				clearInterval(timerInterval);
				return;
			}
			const elapsed = (performance.now() - startTime) / 1000;
			this.currentTime = elapsed;
			this.onProgress?.(elapsed, totalDuration);

			if (elapsed >= totalDuration) {
				clearInterval(timerInterval);
				this.stop();
			}
		}, 80);
		this._demoTimer = timerInterval;
	}

	togglePlayPause() {
		if (this.state === "playing") {
			this.pause();
		} else if (this.state === "paused") {
			this.resume();
		} else {
			this.playDemo();
		}
	}

	pause() {
		if (this.isDemoActive) {
			this.stop();
			return;
		}
		if (this.audioEl) {
			this.audioEl.pause();
		}
	}

	resume() {
		this._ensureContextResumed();
		if (this.audioEl && this.audioEl.src) {
			this.audioEl.play().catch(() => {});
		}
	}

	seek(seconds) {
		if (this.audioEl && Number.isFinite(seconds) && this.audioEl.duration) {
			this.audioEl.currentTime = Math.max(0, Math.min(seconds, this.audioEl.duration));
			// 跳转进度后重置基底，防止从高潮跳到前奏时基底过高
			this.vocalFloor = null;
		}
	}

	stop() {
		this.state = "idle";
		this.mouthOpen = 0.0;
		this.rawVolume = 0.0;
		this.currentTime = 0;
		this._resetVadState();

		if (this._demoTimer) {
			clearInterval(this._demoTimer);
			this._demoTimer = null;
		}
		if (this._demoNodes.length > 0) {
			for (const node of this._demoNodes) {
				try {
					node.stop();
					node.disconnect();
				} catch {}
			}
			this._demoNodes = [];
		}
		this.isDemoActive = false;

		if (this.audioEl) {
			try {
				this.audioEl.pause();
				this.audioEl.currentTime = 0;
			} catch {}
		}
		this.onStateChange?.(this.state);
	}

	setVolume(vol) {
		const v = Math.max(0.0, Math.min(1.0, vol));
		this.volume = v;
		if (this.gainNode && this.audioCtx) {
			this.gainNode.gain.setValueAtTime(v, this.audioCtx.currentTime);
		}
	}

	setSensitivity(sens) {
		this.sensitivity = Math.max(0.3, Math.min(2.5, sens));
	}

	/**
	 * 计算指定频率区间 [lowHz, highHz] 的归一化平均能量 (0.0 ~ 1.0)
	 */
	_getBandEnergy(lowHz, highHz, binWidth) {
		const startBin = Math.max(1, Math.floor(lowHz / binWidth));
		const endBin = Math.min(this.frequencyData.length - 1, Math.ceil(highHz / binWidth));
		if (endBin < startBin) return 0;

		let sum = 0;
		for (let b = startBin; b <= endBin; b++) {
			sum += this.frequencyData[b];
		}
		return sum / ((endBin - startBin + 1) * 255);
	}

	/**
	 * 每一帧由 Live2D 渲染循环调用
	 * @returns {number} 口型张开度 [0.0 ~ 1.0]
	 */
	update() {
		if (this.state !== "playing" || !this.analyser) {
			if (this.mouthOpen > 0.001) {
				this.mouthOpen += (0 - this.mouthOpen) * 0.25;
			} else {
				this.mouthOpen = 0;
			}
			this.rawVolume = 0;
			return this.mouthOpen;
		}

		const now = performance.now();
		const dt = this._lastUpdateTime ? Math.min(0.1, (now - this._lastUpdateTime) / 1000) : 1 / 60;
		this._lastUpdateTime = now;

		// 1. 获取时域 RMS (用于绝对静音门限检测)
		this.analyser.getByteTimeDomainData(this.timeDomainData);
		let sumSq = 0;
		for (let i = 0; i < this.timeDomainData.length; i++) {
			const norm = (this.timeDomainData[i] - 128) / 128;
			sumSq += norm * norm;
		}
		const rms = Math.sqrt(sumSq / this.timeDomainData.length);
		this.rawVolume = rms;
		const sampleRate0 = this.audioCtx?.sampleRate || 44100;

		// 1b. 发声稳态游程跟踪 (机器单音高 veto)：人声自带颤音/音高游走，
		// 而鼓机 Loop / 合成器贝斯会锁定同一基频数百毫秒，据此拦截
		const { f0: estF0, clarity: estClarity } = estimateVocalF0(this.timeDomainData, sampleRate0);
		this.clarityS += (estClarity - this.clarityS) * (estClarity > this.clarityS ? 0.4 : 0.1);
		const rmsStable = this.prevRms > 1e-4 ? Math.abs(rms - this.prevRms) / this.prevRms < 0.3 : false;
		this.prevRms = rms;
		const voicedNow = this.clarityS > 0.45 && estF0 >= 65 && estF0 <= 500 && rms > this.noiseGate * 0.5;
		const steadyNow = voicedNow && rmsStable;
		if (steadyNow) {
			if (this.runLen === 0) {
				this.runMean = estF0;
				this.runLen = 1;
			} else if (Math.abs(estF0 - this.runMean) / this.runMean < 0.015) {
				this.runMean += (estF0 - this.runMean) / (this.runLen + 1);
				this.runLen++;
			} else {
				if (this.runLen >= 8) this.lastLongRun = { p: this.runMean, t: now };
				this.runMean = estF0;
				this.runLen = 1;
			}
		} else {
			if (this.runLen >= 8) this.lastLongRun = { p: this.runMean, t: now };
			this.runLen = 0;
		}
		let machineVeto = false;
		if (this.runLen >= 8) machineVeto = true;
		else if (
			this.lastLongRun &&
			now - this.lastLongRun.t < 750 &&
			this.runLen > 0 &&
			Math.abs(this.runMean - this.lastLongRun.p) / this.lastLongRun.p < 0.02
		)
			machineVeto = true;
		// birth-kill：veto 在 hangover 出生 600ms 内锁存 = 机器无疑，
		// 掐掉这次张嘴、拍扁平滑状态，并冷静 400ms 防反复起音抽动
		if (machineVeto && !this.prevMachineVeto && this.hangover > 0 && now - this.hangoverBirth < 600) {
			this.hangover = 0;
			this.vadGain *= 0.25;
			this.killCooldownUntil = now + 400;
		}
		this.prevMachineVeto = machineVeto;

		// 绝对静音快速截断
		if (rms < this.noiseGate * 0.5) {
			this.mouthOpen += (0 - this.mouthOpen) * this.decayRate;
			if (this.mouthOpen < 0.002) this.mouthOpen = 0;
			this.hangover = 0;
			this.runLen = 0;
			return this.mouthOpen;
		}

		// 2. 获取频域数据并划分声学特征频带
		this.analyser.getByteFrequencyData(this.frequencyData);
		const sampleRate = this.audioCtx?.sampleRate || 44100;
		const binWidth = sampleRate / this.fftSize;

		// 低频伴奏/底鼓带 (50Hz ~ 220Hz)：主要由贝斯、底鼓贡献
		const bassEnergy = this._getBandEnergy(50, 220, binWidth);
		// 第一共振峰 F1 (280Hz ~ 900Hz)：元音开口度核心频段 (决定嘴巴张多大)
		const f1Energy = this._getBandEnergy(280, 900, binWidth);
		// 第二共振峰 F2 (900Hz ~ 2800Hz)：人声咬字与辨识度核心频段
		const f2Energy = this._getBandEnergy(900, 2800, binWidth);
		// 唇齿摩擦音/高频泛音 (2800Hz ~ 5200Hz)：辅助判断字头辅音
		const sibEnergy = this._getBandEnergy(2800, 5200, binWidth);
		// 超高频伴奏带 (6000Hz ~ 11000Hz)：主要由镲片 Hi-Hat 贡献
		const highHatEnergy = this._getBandEnergy(6000, 11000, binWidth);

		// 3. 节拍检测 (保持原有接口行为)
		if (bassEnergy > 0.32 && bassEnergy > this.beatEnergyAvg * 1.32 && now - this.lastBeatTime > 220) {
			this.lastBeatTime = now;
			this.isBeat = true;
			this.onBeat?.();
		} else {
			this.isBeat = false;
		}
		this.beatEnergyAvg = this.beatEnergyAvg * 0.85 + bassEnergy * 0.15;

		// 4. 计算人声核心频段半波整流频谱通量 (Spectral Flux)
		// 只统计每个频点“能量上升”的部分，精准捕捉每个字唱出/说出的瞬间，忽略平稳延音和伴奏Pad
		const vocalStartBin = Math.max(1, Math.floor(280 / binWidth));
		const vocalEndBin = Math.min(this.frequencyData.length - 1, Math.ceil(3200 / binWidth));
		let spectralFlux = 0;
		for (let b = vocalStartBin; b <= vocalEndBin; b++) {
			const cur = this.frequencyData[b] / 255;
			const diff = cur - this.prevVocalBins[b];
			if (diff > 0) {
				spectralFlux += diff;
			}
			this.prevVocalBins[b] = cur;
		}
		spectralFlux /= vocalEndBin - vocalStartBin + 1;

		// 减去低频底鼓引发的连带冲击，得到纯人声音节瞬态通量
		const bassJump = Math.max(0, bassEnergy - this.beatEnergyAvg);
		const cleanFlux = Math.max(0, spectralFlux - bassJump * 0.35);
		this.fluxEnv = Math.max(cleanFlux, this.fluxEnv * Math.pow(0.08, dt)); // 快速上升、约180ms自然衰减

		// 5. 合成原始人声能量 (加权突出 F1/F2 共振峰，抑制低频轰鸣)
		const vocalRaw = f1Energy * 0.48 + f2Energy * 0.42 + sibEnergy * 0.1;

		// 5b. 人声包络入环 (循环重复检测用)
		this.envRing.push(vocalRaw);
		this.envRing.shift();

		// 切歌预热阶段：快速校准基底，保持闭嘴
		if (this._vadWarmup > 0) {
			this._vadWarmup--;
			this.vocalFloor = this.vocalFloor === null ? vocalRaw : this.vocalFloor * 0.6 + vocalRaw * 0.4;
			this.vocalPeak = Math.max(this.vocalPeak, vocalRaw + 0.08);
			this.prevVocalEnergy = vocalRaw;
			return 0;
		}

		// 6. 非对称慢速基底跟踪 (估计纯音乐伴奏床 vocalFloor)
		if (this.vocalFloor === null) {
			this.vocalFloor = vocalRaw;
		} else if (vocalRaw < this.vocalFloor) {
			// 当能量下降（如字间停顿、间奏回落）时，基底迅速下探跟进
			this.vocalFloor += (vocalRaw - this.vocalFloor) * 0.25;
		} else {
			// 当能量高于基底时：
			// 如果缺乏音节通量 (fluxEnv 很小，说明是平直的纯音乐伴奏或长Pad)，基底较快上移将其吞没；
			// 如果音节通量活跃 (正在连续唱歌吐字)，基底极慢上移，保留人声凸起高度！
			const floorCreepRate = this.fluxEnv > 0.022 ? 0.008 : 0.065;
			this.vocalFloor += (vocalRaw - this.vocalFloor) * floorCreepRate;
		}

		// 7. 自适应峰值包络归一化 (AGC：消除音量大小与歌曲母带响度差异)
		// 无论歌曲整体很响还是很小声，prominence 都代表“当前声音相对于本曲动态范围的突出程度”
		const prominence = Math.max(0, vocalRaw - this.vocalFloor * 0.92);
		if (prominence > this.vocalPeak) {
			this.vocalPeak += (prominence - this.vocalPeak) * 0.35; // 遇到更大音量迅速扩张上限
		} else {
			this.vocalPeak = Math.max(0.06, this.vocalPeak * Math.pow(0.75, dt)); // 缓慢回落适应轻声段落
		}
		const normalizedVocal = Math.min(1.2, prominence / this.vocalPeak);

		// 8. 自适应人声活动检测 (VAD 门控：能量判定 + 人声延续窗 + 双层机器拦截)
		if (this.voiceOnly && !this.isDemoActive) {
			// 特征 A：人声频段能量与伴奏(低频+极高频)的信噪比
			const accompEnergy = bassEnergy * 0.65 + highHatEnergy * 0.35 + 0.02;
			const vocalToAccompRatio = (f1Energy * 0.4 + f2Energy * 0.6) / accompEnergy;

			// 特征 B：相对伴奏基底的跳出显著度
			const crestOverFloor = prominence / (this.vocalFloor + 0.03);

			// 能量层判定是否有人声吐字：
			// 条件1: 中高频人声占比合理 (非纯鼓点/纯贝斯)
			// 条件2: 具有显著的基底跳出 (crestOverFloor) 或 明显的字头瞬态通量 (fluxEnv)
			const isVocalActive =
				vocalRaw > this.noiseGate && vocalToAccompRatio > 0.52 && (crestOverFloor > 0.18 || this.fluxEnv > 0.02);

			// 8b. 循环重复 veto：鼓机 Loop 的人声包络会以固定周期自我重复，
			// 而歌声旋律从不精确重复。用包络自相关捕捉 0.75~2.7s 周期即判定为循环伴奏。
			this.loopTick++;
			if (this.loopTick % 4 === 0) {
				const W = 60;
				const cur = this.envRing.slice(-W);
				let mean = 0;
				for (const v of cur) mean += v;
				mean /= W;
				let varr = 0;
				for (const v of cur) varr += (v - mean) * (v - mean);
				if (varr > 1e-8) {
					let best = 0;
					for (let lag = 45; lag <= 160; lag += 3) {
						const past = this.envRing.slice(-W - lag, -lag);
						let m2 = 0;
						for (const v of past) m2 += v;
						m2 /= W;
						let cov = 0,
							v2 = 0;
						for (let i = 0; i < W; i++) {
							cov += (cur[i] - mean) * (past[i] - m2);
							v2 += (past[i] - m2) * (past[i] - m2);
						}
						const c = cov / Math.sqrt(varr * v2 + 1e-12);
						if (c > best) best = c;
					}
					this.loopCorr = best;
					if (best > 0.78) this.loopVotes = Math.min(5, this.loopVotes + 1);
					else if (best < 0.55) this.loopVotes = Math.max(0, this.loopVotes - 2);
				}
			}
			const loopBlock = this.loopVotes >= 2;
			if (loopBlock) this.hangover = 0;

			// 8c. 人声延续窗：字间停顿/辅音不断嘴；机器 veto 只拦新建不掐旧声，
			// 循环 veto 则直接清零 (循环段内不可能有人声起音)
			const blocked = loopBlock || machineVeto;
			if (this.hangover > 0) {
				if (isVocalActive && !loopBlock) this.hangover = 30;
				else this.hangover--;
			} else if (isVocalActive && !blocked && now > this.killCooldownUntil) {
				this.hangover = 30;
				this.hangoverBirth = now;
			}

			const targetVad = this.hangover > 0 ? 1.0 : 0.0;
			// 开门极快 (不吞字头)，关门适中 (字尾自然闭合)
			const vadSpeed = targetVad > this.vadGain ? 0.55 : 0.14;
			this.vadGain += (targetVad - this.vadGain) * vadSpeed;
		} else {
			this.vadGain = 1.0;
		}

		// 9. 拟人音节咬字动力学 (解决“高潮/长音一直张大嘴”与“缺乏咬字感”)
		const energyDelta = vocalRaw - this.prevVocalEnergy;
		this.prevVocalEnergy = vocalRaw;

		// (a) 辅音微闭合与字头脉冲：利用相邻帧能量变化率制造咬字起伏
		if (energyDelta < -0.008) {
			// 音节尾部或遇到塞音/擦音，施加向下的微闭合拉力
			this.syllablePulse = Math.max(-0.35, energyDelta * 6.5);
		} else if (energyDelta > 0.012 || cleanFlux > 0.028) {
			// 新音节字头爆发，重置长音计时并给予张嘴脉冲
			this.syllablePulse = Math.min(0.25, energyDelta * 4.0 + cleanFlux * 2.5);
			this.sustainTimer = Math.max(0, this.sustainTimer - 0.15);
		} else {
			this.syllablePulse *= 0.75;
		}

		// (b) 长音/高潮持续防僵死：当能量持续高企但缺乏新音节通量 (如拖长音“啊——”或高潮伴奏墙)
		if (normalizedVocal > 0.45 && cleanFlux < 0.016) {
			this.sustainTimer += dt;
		} else {
			this.sustainTimer = Math.max(0, this.sustainTimer - dt * 2.5);
		}
		// 超过 0.35 秒无新字头时，逐渐回落至半开或闭合状态，避免嘴巴死撑
		const sustainDamping = this.sustainTimer > 0.35 ? Math.max(0.25, Math.exp(-(this.sustainTimer - 0.35) * 2.2)) : 1.0;

		// (c) 开口度映射：F1 决定大开口(如 a/o)，F2 高而 F1 低时为扁唇音(如 i/e，限制最大开口度更拟真)
		const vowelShapeFactor = f1Energy / (f1Energy + f2Energy * 0.8 + 0.001); // 0.35(扁音) ~ 0.75(大开口音)
		const shapeScale = 0.65 + vowelShapeFactor * 0.55;

		// 10. 汇总目标口型大小
		let target = (normalizedVocal * shapeScale + this.syllablePulse) * sustainDamping * this.vadGain;
		if (target > 0.02) {
			target = Math.pow(target, 0.78) * this.sensitivity;
		} else {
			target = 0;
		}

		// 限制在 [0.0 ~ 1.0]
		target = Math.max(0.0, Math.min(1.0, target));

		// 11. 双速率物理滤波
		const rate = target > this.mouthOpen ? this.attackRate : this.decayRate;
		this.mouthOpen += (target - this.mouthOpen) * rate;
		if (this.mouthOpen < 0.003) this.mouthOpen = 0;

		return this.mouthOpen;
	}

	getMouthOpen() {
		return this.mouthOpen;
	}

	getRawVolume() {
		return this.rawVolume;
	}

	isPlaying() {
		return this.state === "playing";
	}

	destroy() {
		this.stop();
		if (this._currentBlobUrl) {
			URL.revokeObjectURL(this._currentBlobUrl);
			this._currentBlobUrl = null;
		}
		if (this.audioEl) {
			this.audioEl.src = "";
			this.audioEl = null;
		}
		if (this._mediaElementSource) {
			try {
				this._mediaElementSource.disconnect();
			} catch {}
			this._mediaElementSource = null;
		}
	}
}

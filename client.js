// dsh-voice-stream — 浏览器端：流式语音输入。
//
// 与官方语音录入的区别只在“什么时候转写”：
//   官方：整段录音 → 点停止 → 一次 transcribe → 插入草稿。
//   本插件：16 kHz 连续采集 → 按停顿切句 → 每切出一句就 transcribe 一次
//           → 识别结果实时显示在录音条里 → 停止时把全文一次性插入草稿。
//
// 切句用浏览器端的能量 VAD（自适应底噪），识别仍走 Host 的同一个
// SenseVoice provider，所以文字质量和官方一致，只是提前出现。
//
// 纯 ES2020 + React.createElement（无 JSX、无打包器）；唯一 require 是 react。
window.__ModuleLoader__.load({
	id: "@jichong/dsh-voice-stream",
	factory(require) {
		const React = require("react");
		const { useState, useEffect, useRef, useCallback } = React;
		const h = React.createElement;

		const PKG = "@jichong/dsh-voice-stream";
		const NS = "voice-stream";
		const API = "/voice-stream-api";
		const CSS_ID = `${PKG}/vs.css`;

		/* ───────────────────────── 文案（zh / en） ───────────────────────── */

		const ZH = {
			"dictate": "流式语音输入",
			"dictateHint": "流式语音输入（右键打开设置）",
			"setup": "语音服务未就绪，点击查看",
			"requesting": "正在获取麦克风…",
			"listening": "正在听，说完一句就出字…",
			"finishing": "正在收尾…",
			"empty": "没有识别到语音",
			"conflict": "草稿已被修改，转写结果需要手动插入",
			"insert": "插入",
			"discard": "丢弃",
			"cancel": "取消",
			"stop": "停止",
			"retry": "重新录制",
			"failed": "识别失败：{message}",
			"interrupted": "识别中断：{message}",
			"micUnsupported": "当前浏览器不支持麦克风采集",
			"micPermission": "麦克风权限被拒绝",
			"micMissing": "没有找到可用的麦克风",
			"micInterrupted": "麦克风被中断",
			"micEmpty": "没有采集到音频",
			"dialogTitle": "流式语音输入",
			"dialogHint": "按停顿自动切句：说完一句，文字会在录音条里立刻出现；点停止后一次性写入草稿。",
			"provider": "识别引擎",
			"status": "状态",
			"polish": "停止后用大模型整理",
			"polishHint": "去掉口头禅、补标点后再写入草稿；会多等 1–3 秒。",
			"polishModel": "整理模型",
			"polishing": "正在整理文字…",
			"polishFailed": "整理失败，已插入识别原文：{message}",
			"polishUnavailable": "整理模型不可用",
			"disconnected": "无法连接 Host 服务，请检查 DSH 是否仍在运行。",
			"language": "识别语言",
			"ready": "已就绪",
			"standby": "已就绪（首次识别时会唤醒进程）",
			"unprepared": "本地识别模型尚未准备，首次需要联网下载（约 239 MB）。",
			"downloading": "正在下载模型…",
			"checking": "正在检查模型…",
			"loading": "正在加载模型…",
			"waking": "正在唤醒识别进程…",
			"cancelling": "正在取消…",
			"failedPrep": "模型准备失败：{message}",
			"prepareStart": "下载并准备",
			"prepareCancel": "取消准备",
			"close": "关闭",
			"unavailable": "语音服务未加载：请确认已启用 Voice Input（语音输入）插件。",
			"locHost": "本地",
			"locCloud": "云端",
			"langAuto": "自动",
			"langZh": "中文",
			"langEn": "英文",
			"langYue": "粤语",
			"langJa": "日语",
			"langKo": "韩语",
		};

		const EN = {
			"dictate": "Streaming dictation",
			"dictateHint": "Streaming dictation (right-click for settings)",
			"setup": "Speech service not ready, click for details",
			"requesting": "Requesting microphone…",
			"listening": "Listening — text appears when you pause…",
			"finishing": "Finishing…",
			"empty": "No speech recognized",
			"conflict": "The draft changed; insert the transcript manually",
			"insert": "Insert",
			"discard": "Discard",
			"cancel": "Cancel",
			"stop": "Stop",
			"retry": "Record again",
			"failed": "Recognition failed: {message}",
			"interrupted": "Recognition interrupted: {message}",
			"micUnsupported": "This browser cannot capture a microphone",
			"micPermission": "Microphone permission denied",
			"micMissing": "No microphone available",
			"micInterrupted": "The microphone was interrupted",
			"micEmpty": "No audio was captured",
			"dialogTitle": "Streaming dictation",
			"dialogHint": "Segmented by pauses: each finished phrase appears in the capture row while you keep speaking, and the whole transcript is inserted after Stop.",
			"provider": "Recognizer",
			"status": "Status",
			"polish": "Tidy up with the model after Stop",
			"polishHint": "Removes filler and fixes punctuation before inserting; adds 1–3 s.",
			"polishModel": "Tidy model",
			"polishing": "Tidying text…",
			"polishFailed": "Tidy failed; inserted the raw transcript: {message}",
			"polishUnavailable": "Tidy model unavailable",
			"disconnected": "Cannot reach the Host service. Check that DSH is still running.",
			"language": "Language",
			"ready": "Ready",
			"standby": "Ready (the worker wakes on the first phrase)",
			"unprepared": "The local model is not prepared yet; the first run downloads about 239 MB.",
			"downloading": "Downloading model…",
			"checking": "Checking model…",
			"loading": "Loading model…",
			"waking": "Waking the recognizer…",
			"cancelling": "Cancelling…",
			"failedPrep": "Preparation failed: {message}",
			"prepareStart": "Download and prepare",
			"prepareCancel": "Cancel preparation",
			"close": "Close",
			"unavailable": "The speech service is not loaded. Enable the Voice Input plugin.",
			"locHost": "Local",
			"locCloud": "Cloud",
			"langAuto": "Auto",
			"langZh": "Chinese",
			"langEn": "English",
			"langYue": "Cantonese",
			"langJa": "Japanese",
			"langKo": "Korean",
		};

		let currentLocale = "zh";
		let translate = null;

		function detectLocale() {
			try {
				const value = String(typeof navigator === "undefined" ? "" : navigator.language ?? "").toLowerCase();
				return value.startsWith("zh") ? "zh" : "en";
			} catch {
				return "zh";
			}
		}

		/** 由 apply 注入；用于读取当前会话在输入框里选中的模型。 */
		let modelDirectories = null;

		/** 读当前会话的模型选择（与输入框模型按钮同源）；读不到返回 null。 */
		function currentModelSelection(sessionId) {
			try {
				const directory = modelDirectories?.directoryFor?.(sessionId);
				const state = directory?.store?.getSnapshot?.();
				const current = state?.pending ?? state?.current ?? null;
				if (current === null || typeof current.provider !== "string" || typeof current.model !== "string") return null;
				return { provider: current.provider, model: current.model };
			} catch {
				return null;
			}
		}

		const POLISH_PREF_KEY = "dsh-voice-stream:polish";

		/** 整理开关存 localStorage：默认开，关掉后停止即插入原文。 */
		function readPolishPref() {
			try {
				return localStorage.getItem(POLISH_PREF_KEY) !== "off";
			} catch {
				return true;
			}
		}

		function writePolishPref(value) {
			try {
				localStorage.setItem(POLISH_PREF_KEY, value ? "on" : "off");
			} catch {
				/* 隐私模式等场景忽略 */
			}
		}

		function t(key, vars) {
			const dict = currentLocale === "en" ? EN : ZH;
			let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
			if (typeof translate === "function") {
				try {
					const localized = translate(key, vars);
					if (typeof localized === "string" && localized !== key) text = localized;
				} catch {
					/* 用内置文案兜底 */
				}
			}
			if (vars !== null && typeof vars === "object") {
				text = text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
			}
			return text;
		}

		function languageLabel(language) {
			if (language === "auto") return t("langAuto");
			if (language === "zh") return t("langZh");
			if (language === "en") return t("langEn");
			if (language === "yue") return t("langYue");
			if (language === "ja") return t("langJa");
			if (language === "ko") return t("langKo");
			return language;
		}

		/* ───────────────────────── 纯函数 ───────────────────────── */

		function rmsOf(samples) {
			if (samples.length === 0) return 0;
			let sum = 0;
			for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
			return Math.sqrt(sum / samples.length);
		}

		/** 16 kHz 单声道 Float32 → PCM16 WAV（Host 与官方 UI 使用的同一契约）。 */
		function encodeWave(samples) {
			const bytes = new Uint8Array(44 + samples.length * 2);
			const view = new DataView(bytes.buffer);
			const text = (at, value) => {
				for (let i = 0; i < value.length; i += 1) bytes[at + i] = value.charCodeAt(i);
			};
			text(0, "RIFF");
			view.setUint32(4, bytes.length - 8, true);
			text(8, "WAVE");
			text(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true);
			view.setUint32(28, 32000, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			text(36, "data");
			view.setUint32(40, samples.length * 2, true);
			for (let i = 0; i < samples.length; i += 1) {
				const value = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
			}
			return bytes;
		}

		function bytesToBase64(bytes) {
			let text = "";
			for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
			return btoa(text);
		}

		/** 拼接两句识别结果：中日韩文字直接相连，拉丁文字之间补一个空格。 */
		const CJK = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\uff00-\uffef]/;
		function joinText(left, right) {
			const a = String(left ?? "").trim();
			const b = String(right ?? "").trim();
			if (a === "") return b;
			if (b === "") return a;
			return CJK.test(a[a.length - 1]) || CJK.test(b[0]) ? a + b : `${a} ${b}`;
		}

		function formatDuration(seconds) {
			const value = Math.max(0, Math.floor(Number(seconds) || 0));
			const minutes = Math.floor(value / 60);
			const rest = value % 60;
			return `${minutes}:${String(rest).padStart(2, "0")}`;
		}

		function formatBytes(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value < 0) return "";
			if (value < 1024) return `${value} B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
			return `${(value / 1024 / 1024).toFixed(1)} MB`;
		}

		function errorText(error) {
			if (error === null || error === undefined) return t("micUnsupported");
			const message = String(error.message ?? error);
			return message;
		}

		/* ───────────────────────── 停顿分段器 ───────────────────────── */

		/**
		 * 能量 VAD：以 20 ms 帧判断有声/静音，有声开始后等一段静音再切句。
		 * 只在“一句话结束”时切，因此每次送出的音频都是完整语句，
		 * 不会把词切两半；底噪用慢速 EMA 自适应，安静房间足够稳。
		 */
		class Segmenter {
			constructor(options = {}) {
				const sampleRate = Number(options.sampleRate) > 0 ? Number(options.sampleRate) : 16000;
				this.sampleRate = sampleRate;
				this.frameSamples = Math.max(80, Math.round(sampleRate * 0.02));
				this.preRollSamples = Math.round((sampleRate * (options.preRollMs ?? 300)) / 1000);
				this.hangoverSamples = Math.round((sampleRate * (options.hangoverMs ?? 600)) / 1000);
				this.minVoicedSamples = Math.round((sampleRate * (options.minSpeechMs ?? 260)) / 1000);
				this.maxSegmentSamples = Math.round((sampleRate * (options.maxSegmentMs ?? 15000)) / 1000);
				this.tailKeepSamples = Math.round(sampleRate * 0.12);
				this.onSegment = typeof options.onSegment === "function" ? options.onSegment : null;
				this.reset();
			}

			reset() {
				this.carry = new Float32Array(0);
				this.preRoll = [];
				this.preRollLength = 0;
				this.inSpeech = false;
				this.onset = 0;
				this.segment = [];
				this.segmentLength = 0;
				this.voicedSamples = 0;
				this.lastVoicedAt = 0;
				this.silenceSamples = 0;
				this.noiseFloor = 0.004;
				this.level = 0;
			}

			get amplitude() {
				return this.level;
			}

			threshold() {
				const floor = Math.min(Math.max(this.noiseFloor, 0.003), 0.03);
				return Math.max(0.006, Math.min(0.06, floor * 2.2));
			}

			/** 输入任意长度的采样；内部按帧切分，余量留到下一次。 */
			push(samples) {
				if (samples === null || samples === undefined || samples.length === 0) return;
				const merged = new Float32Array(this.carry.length + samples.length);
				merged.set(this.carry, 0);
				merged.set(samples, this.carry.length);
				let offset = 0;
				while (merged.length - offset >= this.frameSamples) {
					this.consume(merged.subarray(offset, offset + this.frameSamples));
					offset += this.frameSamples;
				}
				this.carry = merged.slice(offset);
			}

			consume(frame) {
				const rms = rmsOf(frame);
				this.level = rms;
				const threshold = this.threshold();
				const voiced = rms > threshold;

				if (voiced) this.noiseFloor = Math.max(0.002, this.noiseFloor * 0.999);
				else this.noiseFloor = Math.min(0.05, this.noiseFloor * 0.98 + rms * 0.02);

				if (!this.inSpeech) {
					this.preRoll.push(frame.slice());
					this.preRollLength += frame.length;
					while (this.preRollLength > this.preRollSamples && this.preRoll.length > 1) {
						this.preRollLength -= this.preRoll[0].length;
						this.preRoll.shift();
					}
					if (voiced) this.onset += 1;
					else this.onset = 0;
					if (this.onset >= 2) this.begin();
					return;
				}

				this.segment.push(frame.slice());
				this.segmentLength += frame.length;
				if (voiced) {
					this.voicedSamples += frame.length;
					this.lastVoicedAt = this.segmentLength;
					this.silenceSamples = 0;
				} else {
					this.silenceSamples += frame.length;
				}

				if (this.silenceSamples >= this.hangoverSamples) this.close(false);
				else if (this.segmentLength >= this.maxSegmentSamples) this.close(true);
			}

			begin() {
				this.inSpeech = true;
				this.onset = 0;
				this.segment = this.preRoll;
				this.segmentLength = this.preRollLength;
				this.voicedSamples = 0;
				this.lastVoicedAt = 0;
				this.silenceSamples = 0;
				this.preRoll = [];
				this.preRollLength = 0;
			}

			close(forced) {
				const kept = Math.min(this.segmentLength, Math.max(0, this.lastVoicedAt) + this.tailKeepSamples);
				const samples = new Float32Array(kept);
				let offset = 0;
				for (const frame of this.segment) {
					if (offset >= kept) break;
					const take = Math.min(frame.length, kept - offset);
					samples.set(frame.subarray(0, take), offset);
					offset += take;
				}
				const voiced = this.voicedSamples;
				this.inSpeech = false;
				this.segment = [];
				this.segmentLength = 0;
				this.voicedSamples = 0;
				this.lastVoicedAt = 0;
				this.silenceSamples = 0;
				this.onset = 0;
				if (voiced >= this.minVoicedSamples && kept > 0 && this.onSegment !== null) this.onSegment(samples, { forced: forced === true });
			}

			/** 停止录音：把最后一句（即使还没等到停顿）也送出去。 */
			flush() {
				if (this.inSpeech) this.close(true);
				this.carry = new Float32Array(0);
				this.preRoll = [];
				this.preRollLength = 0;
				this.onset = 0;
			}
		}

		/* ───────────────────────── 麦克风采集 ───────────────────────── */

		function micError(kind) {
			const error = new Error(kind);
			error.kind = kind;
			return error;
		}

		function mapMicError(error) {
			if (error instanceof DOMException) {
				if (error.name === "NotAllowedError" || error.name === "SecurityError") return micError("permission");
				if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return micError("missing");
			}
			return micError("unavailable");
		}

		function micErrorText(error) {
			const kind = error?.kind ?? "";
			if (kind === "permission") return t("micPermission");
			if (kind === "missing") return t("micMissing");
			if (kind === "interrupted") return t("micInterrupted");
			if (kind === "empty") return t("micEmpty");
			return t("micUnsupported");
		}

		/** 一次录音的浏览器资源（麦克风 + AudioContext + 采集节点）。 */
		class Capture {
			constructor({ onLevel, onFailure } = {}) {
				this.onLevel = typeof onLevel === "function" ? onLevel : () => {};
				this.onFailure = typeof onFailure === "function" ? onFailure : () => {};
				this.onSamples = null;
				this.sampleRate = 16000;
				this.stream = null;
				this.context = null;
				this.processor = null;
				this.source = null;
				this.mute = null;
				this.disposed = false;
			}

			async start() {
				if (typeof navigator === "undefined" || navigator?.mediaDevices?.getUserMedia === undefined) throw micError("unavailable");
				let stream;
				try {
					stream = await navigator.mediaDevices.getUserMedia({
						audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
						video: false,
					});
				} catch (error) {
					throw mapMicError(error);
				}
				if (this.disposed) {
					for (const track of stream.getTracks()) track.stop();
					throw micError("unavailable");
				}
				this.stream = stream;
				let context;
				try {
					context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
				} catch {
					context = new AudioContext();
				}
				if (context.state === "suspended") await context.resume();
				this.context = context;
				this.sampleRate = context.sampleRate;
				this.source = context.createMediaStreamSource(stream);
				this.processor = context.createScriptProcessor(2048, 1, 1);
				this.processor.onaudioprocess = (event) => {
					if (this.disposed) return;
					const input = event.inputBuffer.getChannelData(0);
					const copy = new Float32Array(input.length);
					copy.set(input);
					this.onLevel(rmsOf(copy));
					if (this.onSamples !== null) this.onSamples(copy);
				};
				this.mute = context.createGain();
				this.mute.gain.value = 0;
				this.source.connect(this.processor);
				this.processor.connect(this.mute);
				this.mute.connect(context.destination);
				for (const track of stream.getTracks()) {
					track.addEventListener("ended", () => {
						if (!this.disposed) this.onFailure(micError("interrupted"));
					});
				}
			}

			amplitude() {
				return 0;
			}

			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				try {
					for (const track of this.stream?.getTracks?.() ?? []) track.stop();
				} catch {
					/* ignore */
				}
				try {
					this.processor?.disconnect?.();
					this.source?.disconnect?.();
					this.mute?.disconnect?.();
				} catch {
					/* ignore */
				}
				const context = this.context;
				this.context = null;
				this.stream = null;
				this.processor = null;
				this.source = null;
				this.mute = null;
				if (context !== null) {
					context.close?.().catch?.(() => undefined);
				}
			}

			stop() {
				this.dispose();
			}
		}

		/* ───────────────────────── Host API ───────────────────────── */

		async function api(path, { method = "GET", body, signal } = {}) {
			const response = await fetch(`${API}${path}`, {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
				credentials: "same-origin",
				cache: "no-store",
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (payload === null || payload.ok !== true) {
				const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
				error.code = payload?.error?.code ?? `http/${response.status}`;
				error.status = response.status;
				throw error;
			}
			return payload.data;
		}

		/** 把一个分段重采样到 16 kHz；AudioContext 已经是 16 kHz 时原样返回。 */
		async function toSixteenK(samples, sampleRate) {
			if (sampleRate === 16000) return samples;
			try {
				const target = Math.max(1, Math.round((samples.length * 16000) / sampleRate));
				const offline = new OfflineAudioContext(1, target, 16000);
				const buffer = offline.createBuffer(1, samples.length, sampleRate);
				buffer.copyToChannel(samples, 0);
				const source = offline.createBufferSource();
				source.buffer = buffer;
				source.connect(offline.destination);
				source.start();
				const rendered = await offline.startRendering();
				return rendered.getChannelData(0);
			} catch {
				return samples;
			}
		}

		/**
		 * 一次录音会话：采集 → 分段 → 逐段转写，返回完整文本。
		 * 转写串行执行，保证文本顺序与说话顺序一致。
		 */
		function createSession({ providerId, language, onText, onLevel, onFailure }) {
			const abort = new AbortController();
			let capture = null;
			let segmenter = null;
			let chain = Promise.resolve();
			let failure = null;
			let text = "";
			let stopping = false;
			let finished = false;

			const enqueue = (samples, sampleRate) => {
				if (finished || abort.signal.aborted) return;
				chain = chain
					.then(async () => {
						if (abort.signal.aborted || failure !== null) return;
						const pcm = await toSixteenK(samples, sampleRate);
						const audioBase64 = bytesToBase64(encodeWave(pcm));
						const result = await api("/transcribe", {
							method: "POST",
							body: { audioBase64, providerId, language },
							signal: abort.signal,
						});
						if (abort.signal.aborted) return;
						const part = typeof result?.text === "string" ? result.text.trim() : "";
						if (part !== "") {
							text = joinText(text, part);
							onText?.(part);
						}
					})
					.catch((error) => {
						if (abort.signal.aborted) return;
						failure = error;
						onFailure?.(error);
					});
			};

			const fail = (error) => {
				if (abort.signal.aborted || failure !== null) return;
				failure = error;
				onFailure?.(error);
			};

			return {
				get text() {
					return text;
				},
				get failure() {
					return failure;
				},
				async start() {
					capture = new Capture({ onLevel, onFailure: fail });
					await capture.start();
					const sampleRate = capture.sampleRate;
					segmenter = new Segmenter({
						sampleRate,
						onSegment: (samples) => enqueue(samples, sampleRate),
					});
					capture.onSamples = (samples) => segmenter.push(samples);
				},
				async stop() {
					if (stopping) return text;
					stopping = true;
					try {
						capture?.stop();
					} catch {
						/* ignore */
					}
					try {
						segmenter?.flush();
					} catch {
						/* ignore */
					}
					await chain;
					finished = true;
					if (abort.signal.aborted) throw micError("cancelled");
					if (failure !== null) throw failure;
					return text;
				},
				dispose() {
					finished = true;
					abort.abort();
					try {
						capture?.dispose();
					} catch {
						/* ignore */
					}
					capture = null;
					segmenter = null;
				},
			};
		}

		/* ───────────────────────── 样式 ───────────────────────── */

		function cssText() {
			return `
.vs-anchor{display:inline-flex;align-items:center;justify-content:center}
.vs-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;opacity:.72;cursor:pointer;transition:background .15s ease,opacity .15s ease}
.vs-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));opacity:1}
.vs-trigger:disabled{opacity:.35;cursor:default}
.vs-row{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:2px 4px}
.vs-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:24px;height:24px;padding:0;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.32));border-radius:50%;background:transparent;color:inherit;cursor:pointer}
.vs-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.vs-icon-btn:disabled{opacity:.4;cursor:default}
.vs-stop{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
.vs-time{flex:0 0 auto;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,inherit)}
.vs-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l2,rgba(127,127,127,.5))}
.vs-row[data-phase="recording"] .vs-dot{background:var(--dsw-alias-state-error-primary,#e5484d);animation:vs-pulse 1.1s ease-in-out infinite}
.vs-meter{flex:0 0 44px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.25));overflow:hidden}
.vs-meter-fill{display:block;height:100%;width:0;border-radius:2px;background:var(--dsw-alias-state-business-primary,currentColor);opacity:.8;transition:width .08s linear}
.vs-caption{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.vs-caption.vs-error{color:var(--dsw-alias-state-error-primary,#e5484d)}
.vs-note{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.vs-text-btn{flex:0 0 auto;padding:2px 10px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.32));border-radius:999px;background:transparent;color:inherit;font-size:12px;cursor:pointer}
.vs-text-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.vs-spinner{flex:0 0 auto;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-top-color:currentColor;border-radius:50%;animation:vs-spin .8s linear infinite}
.vs-mask{position:fixed;inset:0;z-index:2100;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42))}
.vs-dialog{width:min(440px,100%);max-height:min(76vh,640px);overflow:auto;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:12px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:0 18px 48px rgba(0,0,0,.32);padding:18px 20px;font-size:13px;line-height:1.55}
.vs-dialog h3{margin:0 0 8px;font-size:15px;font-weight:600}
.vs-hint{margin:0 0 14px;color:var(--dsw-alias-label-secondary,inherit)}
.vs-field{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.vs-field-label{color:var(--dsw-alias-label-secondary,inherit)}
.vs-field-value{text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-select{max-width:180px;padding:3px 8px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:6px;background:transparent;color:inherit;font-size:12px}
.vs-progress{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.22));overflow:hidden;margin:6px 0}
.vs-progress-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#1f6feb);transition:width .25s ease}
.vs-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.vs-btn{padding:5px 12px;border:0.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:7px;background:transparent;color:inherit;font-size:12px;cursor:pointer}
.vs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.vs-btn:disabled{opacity:.45;cursor:default}
.vs-btn.primary{border-color:var(--dsw-alias-button-primary-fill,#1f6feb);background:var(--dsw-alias-button-primary-fill,#1f6feb);color:var(--dsw-alias-label-primary-foreground,#fff)}
@keyframes vs-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}
@keyframes vs-spin{to{transform:rotate(360deg)}}
`;
		}

		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = cssText();
			document.head.append(tag);
		}

		/* ───────────────────────── 图标 ───────────────────────── */

		function microphoneIcon() {
			return h(
				"svg",
				{ width: 17, height: 17, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
				h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
				h("path", { d: "M5 11a7 7 0 0 0 14 0" }),
				h("path", { d: "M12 18v3" }),
			);
		}

		function closeIcon() {
			return h(
				"svg",
				{ width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", "aria-hidden": "true" },
				h("path", { d: "M6 6l12 12" }),
				h("path", { d: "M18 6L6 18" }),
			);
		}

		function stopIcon() {
			return h("svg", { width: 10, height: 10, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" }, h("rect", { x: 5, y: 5, width: 14, height: 14, rx: 3 }));
		}

		/* ───────────────────────── 准备状态文案 ───────────────────────── */

		function preparationText(preparation) {
			if (preparation === null || preparation === undefined) return t("unprepared");
			const phase = preparation.phase;
			if (phase === "ready") return t("ready");
			if (phase === "standby") return t("standby");
			if (phase === "unprepared") return t("unprepared");
			if (phase === "checking") return t("checking");
			if (phase === "loading") return t("loading");
			if (phase === "waking") return t("waking");
			if (phase === "cancelling") return t("cancelling");
			if (phase === "downloading") {
				const done = formatBytes(preparation.completedBytes);
				const total = preparation.totalBytes === undefined ? "" : ` / ${formatBytes(preparation.totalBytes)}`;
				return `${t("downloading")} ${done}${total}`;
			}
			if (phase === "failed") return t("failedPrep", { message: String(preparation.message ?? "") });
			if (phase === "cancelled") return t("unprepared");
			return String(phase);
		}

		function isPreparing(preparation) {
			if (preparation === null || preparation === undefined) return false;
			return ["checking", "downloading", "loading", "waking", "cancelling"].includes(preparation.phase);
		}

		function progressOf(preparation) {
			if (preparation?.phase !== "downloading") return null;
			const total = Number(preparation.totalBytes);
			if (!Number.isFinite(total) || total <= 0) return null;
			return Math.max(0, Math.min(100, Math.round((Number(preparation.completedBytes) / total) * 100)));
		}

		/* ───────────────────────── 准备对话框 ───────────────────────── */

		function SetupDialog({ catalog, available, connected, onClose, onRefresh, polishEnabled, polishAvailable, polishInfo, polishModel, onTogglePolish }) {
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const provider = catalog?.providers?.find((item) => item.id === catalog.selection?.providerId) ?? null;
			const preparation = provider?.preparation ?? null;
			const preparing = isPreparing(preparation);
			const percent = progressOf(preparation);
			const languages = Array.isArray(provider?.languages) && provider.languages.length > 0 ? provider.languages : ["auto"];
			const selectedLanguage = typeof catalog?.selection?.language === "string" ? catalog.selection.language : languages[0];

			const prepare = async () => {
				if (busy) return;
				setBusy(true);
				setError("");
				try {
					await api("/prepare", {
						method: "POST",
						body: provider === null ? {} : { providerId: provider.id },
					});
					await onRefresh?.();
				} catch (failure) {
					setError(errorText(failure));
				} finally {
					setBusy(false);
				}
			};

			const cancelPreparation = async () => {
				if (busy) return;
				setBusy(true);
				setError("");
				try {
					await api("/prepare/cancel", {
						method: "POST",
						body: provider === null ? {} : { providerId: provider.id },
					});
					await onRefresh?.();
				} catch (failure) {
					setError(errorText(failure));
				} finally {
					setBusy(false);
				}
			};

			const changeLanguage = async (language) => {
				if (provider === null) return;
				setError("");
				try {
					await api("/configure", { method: "POST", body: { providerId: provider.id, language } });
					await onRefresh?.();
				} catch (failure) {
					setError(errorText(failure));
				}
			};

			return h(
				"div",
				{
					className: "vs-mask",
					onMouseDown: (event) => {
						if (event.target === event.currentTarget) onClose?.();
					},
				},
				h(
					"div",
					{ className: "vs-dialog", role: "dialog", "aria-modal": "true", onMouseDown: (event) => event.stopPropagation() },
					h("h3", null, t("dialogTitle")),
					h("p", { className: "vs-hint" }, t("dialogHint")),
					!connected
						? h("div", { className: "vs-field" }, h("span", null, t("disconnected")))
						: null,
					connected && !available
						? h("div", { className: "vs-field" }, h("span", null, t("unavailable")))
						: null,
					available && provider !== null
						? h(
								"div",
								{ className: "vs-field" },
								h("span", { className: "vs-field-label" }, t("provider")),
								h("span", { className: "vs-field-value" }, `${provider.name} · ${provider.location === "cloud" ? t("locCloud") : t("locHost")}`),
							)
						: null,
					available && provider !== null
						? h(
								"div",
								{ className: "vs-field" },
								h("span", { className: "vs-field-label" }, t("language")),
								h(
									"select",
									{
										className: "vs-select",
										value: languages.includes(selectedLanguage) ? selectedLanguage : languages[0],
										onChange: (event) => void changeLanguage(event.target.value),
									},
									...languages.map((language) => h("option", { key: language, value: language }, languageLabel(language))),
								),
							)
						: null,
					available && provider !== null
						? h(
								"label",
								{ className: "vs-field", title: t("polishHint") },
								h("span", { className: "vs-field-label" }, t("polish")),
								h("input", {
									type: "checkbox",
									checked: polishAvailable === true && polishEnabled === true,
									disabled: polishAvailable !== true,
									onChange: (event) => onTogglePolish?.(event.target.checked),
								}),
							)
						: null,
					available && provider !== null && polishEnabled && polishAvailable
						? h(
								"div",
								{ className: "vs-field" },
								h("span", { className: "vs-field-label" }, t("polishModel")),
								h("span", { className: "vs-field-value" }, polishModel !== null && polishModel !== undefined
									? `${polishModel.provider} / ${polishModel.model}`
									: polishInfo === null
										? "…"
										: polishInfo.available === true
											? `${polishInfo.provider} / ${polishInfo.model}`
											: String(polishInfo.message ?? t("polishUnavailable"))),
							)
						: null,
					available && provider !== null
						? h(
								"div",
								{ className: "vs-field" },
								h("span", { className: "vs-field-label" }, t("status")),
								h("span", { className: "vs-field-value", title: preparationText(preparation) }, preparationText(preparation)),
							)
						: null,
					percent !== null
						? h("div", { className: "vs-progress" }, h("span", { className: "vs-progress-fill", style: { width: `${percent}%` } }))
						: null,
					error !== "" ? h("div", { className: "vs-field vs-caption vs-error", style: { color: "#e5484d" } }, error) : null,
					h(
						"div",
						{ className: "vs-dialog-actions" },
						available && provider !== null && (preparation?.phase === "unprepared" || preparation?.phase === "failed" || preparation?.phase === "cancelled")
							? h("button", { type: "button", className: "vs-btn primary", disabled: busy, onClick: () => void prepare() }, t("prepareStart"))
							: null,
						available && preparing
							? h("button", { type: "button", className: "vs-btn", disabled: busy || preparation?.phase === "cancelling", onClick: () => void cancelPreparation() }, t("prepareCancel"))
							: null,
						h("button", { type: "button", className: "vs-btn", onClick: () => onClose?.() }, t("close")),
					),
				),
			);
		}

		/* ───────────────────────── 输入框控件 ───────────────────────── */

		function VoiceInput(props) {
			const { sessionId, inputActions, locked, onActiveChange } = props;
			const [catalog, setCatalog] = useState(null);
			const [available, setAvailable] = useState(false);
			const [connected, setConnected] = useState(true);
			const [phase, setPhase] = useState("idle");
			const [message, setMessage] = useState("");
			const [committed, setCommitted] = useState("");
			const [pending, setPending] = useState("");
			const [dialogOpen, setDialogOpen] = useState(false);
			const [level, setLevel] = useState(0);
			const [seconds, setSeconds] = useState(0);
			const [polishEnabled, setPolishEnabled] = useState(() => readPolishPref());
			const [polishInfo, setPolishInfo] = useState(null);
			const [polishReady, setPolishReady] = useState(true);
			const committedRef = useRef("");
			const sessionRef = useRef(null);
			const spanRef = useRef(null);
			const stoppingRef = useRef(false);
			const generation = useRef(0);
			const phaseRef = useRef("idle");
			const languageRef = useRef("auto");
			const polishAbortRef = useRef(null);
			phaseRef.current = phase;

			const provider = catalog?.providers?.find((item) => item.id === catalog.selection?.providerId) ?? null;
			const preparation = provider?.preparation ?? null;
			const preparing = isPreparing(preparation);
			const usable = available && provider !== null && preparation !== null && ["ready", "standby", "waking"].includes(preparation.phase);

			const refresh = useCallback(async () => {
				try {
					const data = await api("/status");
					setConnected(true);
					setAvailable(data?.available === true);
					setPolishReady(data?.polishAvailable !== false);
					if (data?.catalog !== undefined) setCatalog(data.catalog ?? null);
				} catch {
					setConnected(false);
				}
			}, []);

			// 轮询状态：准备中或打开对话框时快，空闲时慢。
			useEffect(() => {
				let disposed = false;
				let timer = null;
				const tick = async () => {
					await refresh();
					if (disposed) return;
					timer = setTimeout(tick, dialogOpen || preparing ? 700 : 3000);
				};
				void tick();
				return () => {
					disposed = true;
					if (timer !== null) clearTimeout(timer);
				};
			}, [refresh, dialogOpen, preparing]);

			// 对话框打开时解析一次「用哪个模型整理」，只用于展示。
			useEffect(() => {
				if (!dialogOpen) return undefined;
				let disposed = false;
				api("/polish/info")
					.then((info) => {
						if (!disposed) setPolishInfo(info);
					})
					.catch((error) => {
						if (!disposed) setPolishInfo({ available: false, provider: null, model: null, message: errorText(error) });
					});
				return () => {
					disposed = true;
				};
			}, [dialogOpen]);

			const resetToIdle = useCallback(() => {
				setPhase("idle");
				setCommitted("");
				committedRef.current = "";
			}, []);

			const failWith = useCallback((error) => {
				const keep = committedRef.current;
				const text = error?.kind !== undefined ? micErrorText(error) : errorText(error);
				if (keep.trim() !== "") {
					setPending(keep);
					setMessage(t("interrupted", { message: text }));
				} else {
					setMessage(t("failed", { message: text }));
				}
				setPhase("feedback");
			}, []);

			const start = useCallback(async () => {
				if (locked || sessionRef.current !== null) return;
				if (!usable || catalog === null || provider === null) {
					setDialogOpen(true);
					return;
				}
				const run = ++generation.current;
				stoppingRef.current = false;
				spanRef.current = inputActions.captureInsertion();
				committedRef.current = "";
				setCommitted("");
				setPending("");
				setMessage("");
				setSeconds(0);
				setLevel(0);
				setPhase("requesting");
				const languages = Array.isArray(provider.languages) ? provider.languages : [];
				const configured = typeof catalog.selection?.language === "string" ? catalog.selection.language : "auto";
				const language = languages.length === 0 || languages.includes(configured)
					? configured
					: languages.includes("auto")
						? "auto"
						: languages[0];
				languageRef.current = language;
				const session = createSession({
					providerId: catalog.selection.providerId,
					language,
					onLevel: (value) => {
						if (run === generation.current) setLevel(value);
					},
					onText: (part) => {
						if (run !== generation.current) return;
						committedRef.current = joinText(committedRef.current, part);
						setCommitted(committedRef.current);
					},
					onFailure: (error) => {
						if (run !== generation.current) return;
						sessionRef.current = null;
						session.dispose();
						failWith(error);
					},
				});
				sessionRef.current = session;
				try {
					await session.start();
				} catch (error) {
					session.dispose();
					sessionRef.current = null;
					if (run !== generation.current) return;
					failWith(error);
					return;
				}
				if (run !== generation.current) {
					session.dispose();
					return;
				}
				setPhase("recording");
			}, [catalog, failWith, inputActions, locked, provider, usable]);

			const cancel = useCallback(() => {
				generation.current += 1;
				const session = sessionRef.current;
				sessionRef.current = null;
				stoppingRef.current = false;
				polishAbortRef.current?.abort();
				polishAbortRef.current = null;
				session?.dispose();
				setPending("");
				setMessage("");
				setCommitted("");
				committedRef.current = "";
				setPhase("idle");
				setDialogOpen(false);
			}, []);

			const stop = useCallback(async () => {
				const session = sessionRef.current;
				if (session === null || phase !== "recording" || stoppingRef.current) return;
				stoppingRef.current = true;
				const run = generation.current;
				setPhase("finishing");
				let text = "";
				try {
					text = await session.stop();
				} catch (error) {
					sessionRef.current = null;
					stoppingRef.current = false;
					if (run === generation.current) failWith(error);
					return;
				}
				sessionRef.current = null;
				stoppingRef.current = false;
				if (run !== generation.current) return;
				if (text.trim() === "") {
					setPhase("feedback");
					setMessage(t("empty"));
					return;
				}
				// 停止后先过大模型整理；整理不可用或失败就用识别原文，绝不挡住输入。
				let polishFailure = null;
				if (polishEnabled && polishReady) {
					setPhase("polishing");
					const controller = new AbortController();
					polishAbortRef.current = controller;
					// 与输入框当前模型保持一致；读不到就让 Host 用它自己的默认解析。
					const selection = currentModelSelection(sessionId);
					try {
						const result = await api("/polish", {
							method: "POST",
							body: {
								text,
								language: languageRef.current,
								...(selection === null ? {} : { provider: selection.provider, model: selection.model }),
							},
							signal: controller.signal,
						});
						if (typeof result?.text === "string" && result.text.trim() !== "") text = result.text.trim();
					} catch (error) {
						if (controller.signal.aborted) return;
						polishFailure = error;
					} finally {
						if (polishAbortRef.current === controller) polishAbortRef.current = null;
					}
					if (run !== generation.current) return;
				}

				if (!inputActions.insertText(text, spanRef.current)) {
					setPending(text);
					setMessage(t("conflict"));
					setPhase("feedback");
					return;
				}
				if (polishFailure !== null) {
					setMessage(t("polishFailed", { message: errorText(polishFailure) }));
					setPhase("feedback");
					return;
				}
				resetToIdle();
			}, [failWith, inputActions, phase, polishEnabled, polishReady, resetToIdle]);

			// 录音条展开时告诉输入框让位。
			const expanded = phase !== "idle";
			useEffect(() => {
				onActiveChange?.(expanded);
				return () => onActiveChange?.(false);
			}, [expanded, onActiveChange]);

			// 会话切换、窗口失焦、页面隐藏、Esc：放弃本次录音。
			useEffect(() => {
				setPending("");
				setMessage("");
				setCommitted("");
				committedRef.current = "";
				setPhase("idle");
				setDialogOpen(false);
				return () => {
					generation.current += 1;
					const session = sessionRef.current;
					sessionRef.current = null;
					polishAbortRef.current?.abort();
					polishAbortRef.current = null;
					session?.dispose();
				};
			}, [sessionId]);

			useEffect(() => {
				const blur = () => {
					if (phaseRef.current === "recording") cancel();
				};
				const visibility = () => {
					if (document.hidden && phaseRef.current === "recording") cancel();
				};
				const escape = (event) => {
					if (event.key !== "Escape") return;
					if (sessionRef.current !== null) {
						event.preventDefault();
						cancel();
					} else if (dialogOpen) {
						setDialogOpen(false);
					}
				};
				window.addEventListener("blur", blur);
				document.addEventListener("visibilitychange", visibility);
				document.addEventListener("keydown", escape);
				return () => {
					window.removeEventListener("blur", blur);
					document.removeEventListener("visibilitychange", visibility);
					document.removeEventListener("keydown", escape);
				};
			}, [cancel, dialogOpen]);

			useEffect(() => {
				if (phase !== "recording") return undefined;
				const started = Date.now();
				const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
				return () => clearInterval(timer);
			}, [phase]);

			const dialog = dialogOpen
				? h(SetupDialog, {
						catalog,
						available,
						connected,
						polishEnabled,
						polishAvailable: polishReady,
						polishInfo,
						polishModel: currentModelSelection(sessionId),
						onTogglePolish: (value) => {
							setPolishEnabled(value);
							writePolishPref(value);
						},
						onClose: () => setDialogOpen(false),
						onRefresh: refresh,
					})
				: null;

			if (phase === "idle") {
				return h(
					React.Fragment,
					null,
					h(
						"span",
						{ className: "vs-anchor" },
						h(
							"button",
							{
								type: "button",
								className: "vs-trigger",
								title: usable ? t("dictateHint") : t("setup"),
								"aria-label": usable ? t("dictate") : t("setup"),
								disabled: locked,
								onMouseDown: (event) => event.preventDefault(),
								onContextMenu: (event) => {
									event.preventDefault();
									setDialogOpen(true);
								},
								onClick: () => {
									if (usable) void start();
									else setDialogOpen(true);
								},
							},
							microphoneIcon(),
						),
					),
					dialog,
				);
			}

			if (phase === "feedback") {
				return h(
					React.Fragment,
					null,
					h(
						"div",
						{ className: "vs-row", "data-phase": "feedback" },
						h(
							"button",
							{
								type: "button",
								className: "vs-icon-btn",
								title: pending === "" ? t("cancel") : t("discard"),
								"aria-label": pending === "" ? t("cancel") : t("discard"),
								onClick: () => {
									setPending("");
									setMessage("");
									generation.current += 1;
									resetToIdle();
								},
							},
							closeIcon(),
						),
						h("span", { className: "vs-caption vs-error", title: message }, message),
						pending !== ""
							? h(
									"button",
									{
										type: "button",
										className: "vs-text-btn",
										onClick: () => {
											if (inputActions.insertText(pending, inputActions.captureInsertion())) {
												setPending("");
												resetToIdle();
											}
										},
									},
									t("insert"),
								)
							: h(
									"button",
									{
										type: "button",
										className: "vs-icon-btn",
										title: t("retry"),
										"aria-label": t("retry"),
										disabled: locked || !usable,
										onClick: () => {
											setMessage("");
											resetToIdle();
											void start();
										},
									},
									microphoneIcon(),
								),
					),
					dialog,
				);
			}

			const caption = phase === "requesting"
				? t("requesting")
				: committed !== ""
					? committed
					: t(phase === "recording" ? "listening" : phase === "polishing" ? "polishing" : "finishing");
			return h(
				React.Fragment,
				null,
				h(
					"div",
					{ className: "vs-row", "data-phase": phase },
					h(
						"button",
						{ type: "button", className: "vs-icon-btn", title: t("cancel"), "aria-label": t("cancel"), onClick: cancel },
						closeIcon(),
					),
					h("span", { className: "vs-dot" }),
					h("span", { className: "vs-time" }, formatDuration(seconds)),
					h("span", { className: "vs-meter" }, h("span", { className: "vs-meter-fill", style: { width: `${Math.min(100, Math.round(Math.sqrt(level) * 180))}%` } })),
					h("span", { className: "vs-caption", title: committed === "" ? caption : committed }, caption),
					phase === "polishing" && committed !== "" ? h("span", { className: "vs-note" }, t("polishing")) : null,
					phase === "recording"
						? h(
								"button",
								{ type: "button", className: "vs-icon-btn vs-stop", title: t("stop"), "aria-label": t("stop"), onClick: () => void stop() },
								stopIcon(),
							)
						: h("span", { className: "vs-spinner" }),
				),
				dialog,
			);
		}

		/* ───────────────────────── 挂载 ───────────────────────── */

		const inject = ["slots"];

		function apply(ctx) {
			currentLocale = detectLocale();
			try {
				const locale = ctx.get?.("locale");
				if (locale !== undefined && locale !== null) {
					ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), "voice-stream: locale");
					const bound = locale.bind(NS);
					if (typeof bound === "function") translate = (key, vars) => bound(key, vars);
				}
			} catch {
				/* 保留内置文案 */
			}
			ensureCss();
			ctx.inject(["modelDirectories"], (child) =>
				child.effect(() => {
					modelDirectories = child.modelDirectories;
					return () => {
						modelDirectories = null;
					};
				}, "voice-stream: model directories"),
			);
			ctx.slots.inject("conversation.input.activity", () =>
				ctx.slots.register({ name: "conversation.input.activity" }, VoiceInput),
			);
		}

		return {
			name: NS,
			inject,
			apply,
			__test: {
				t,
				rmsOf,
				encodeWave,
				bytesToBase64,
				joinText,
				formatDuration,
				formatBytes,
				Segmenter,
			},
		};
	},
});

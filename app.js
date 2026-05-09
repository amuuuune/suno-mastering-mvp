(function () {
  "use strict";

  const TARGETS = {
    natural: { label: "Natural", lufs: -16 },
    streaming: { label: "Streaming", lufs: -14 },
    loud: { label: "Loud", lufs: -10.5 },
  };

  const DEFAULT_BASE_SETTINGS = {
    baseLowCutHz: 26,
    baseMudHz: 230,
    baseMudDb: 0.9,
    baseHarshHz: 3600,
    baseHarshDb: 0.7,
    baseArtifactAmount: 18,
    baseLowMonoHz: 145,
    baseLowMonoAmount: 95,
  };

  const BASE_CONTROL_KEYS = Object.keys(DEFAULT_BASE_SETTINGS);
  const TONE_CONTROL_KEYS = ["brightness", "body", "impact", "width", "smoothness"];

  const PRESETS = {
    balanced: { target: "streaming", brightness: 0, body: 0, impact: 0, width: 0, smoothness: 0 },
    aiClean: { target: "streaming", baseArtifactAmount: 55, baseHarshHz: 3900, baseHarshDb: 1.3, brightness: -4, body: 0, impact: -6, width: 0, smoothness: 32 },
    vocalForward: { target: "streaming", baseArtifactAmount: 28, brightness: 12, body: -2, impact: 8, width: -8, smoothness: 12 },
    warm: { target: "natural", baseMudDb: 1.1, baseHarshDb: 0.9, brightness: -16, body: 34, impact: -4, width: -4, smoothness: 22 },
    bright: { target: "streaming", baseArtifactAmount: 22, baseHarshDb: 0.9, brightness: 28, body: -6, impact: 4, width: 8, smoothness: 8 },
    soft: { target: "natural", baseArtifactAmount: 48, baseHarshDb: 1.5, brightness: -8, body: 8, impact: -18, width: 0, smoothness: 44 },
    loud: { target: "loud", baseArtifactAmount: 28, baseHarshDb: 1.0, brightness: 10, body: 8, impact: 42, width: 2, smoothness: 12 },
    wide: { target: "streaming", brightness: 6, body: -6, impact: 0, width: 44, smoothness: 8 },
    bassRich: { target: "streaming", baseMudDb: 1.2, baseLowMonoHz: 135, baseLowMonoAmount: 92, brightness: -8, body: 32, impact: -2, width: 0, smoothness: 14 },
    thinFix: { target: "streaming", baseMudDb: 1.0, brightness: -10, body: 38, impact: -6, width: -4, smoothness: 20 },
    punch: { target: "streaming", brightness: 5, body: 10, impact: 32, width: 0, smoothness: 8 },
    night: { target: "natural", baseArtifactAmount: 50, baseHarshDb: 1.6, brightness: -18, body: 12, impact: -20, width: -4, smoothness: 52 },
    sns: { target: "loud", baseArtifactAmount: 30, brightness: 18, body: 6, impact: 30, width: 12, smoothness: 16 },
    natural: { target: "natural", brightness: 0, body: 6, impact: -12, width: 0, smoothness: 12 },
  };

  const BACKEND_FALLBACK_URL = "http://127.0.0.1:18765";
  const PROCESS_DEBOUNCE_MS = 520;
  const PLAYBACK_CROSSFADE_SECONDS = 0.16;

  const state = {
    audioContext: null,
    fileName: "",
    originalBuffer: null,
    processedBuffer: null,
    originalAnalysis: null,
    processedAnalysis: null,
    spectrum: [],
    displayMode: "before",
    isProcessing: false,
    isAnalyzing: false,
    isExporting: false,
    processTimer: 0,
    processVersion: 0,
    selectedPreset: "balanced",
    waveformCache: {
      before: null,
      after: null,
    },
    settings: {
      baseClean: true,
      ...DEFAULT_BASE_SETTINGS,
      target: "streaming",
      brightness: 0,
      body: 0,
      impact: 0,
      width: 0,
      smoothness: 0,
    },
    backend: {
      checked: false,
      reachable: false,
      ffmpeg: false,
      version: "",
      url: "",
      message: "",
    },
    needsProcess: false,
  playback: {
    source: null,
    gainNode: null,
    previewNodes: null,
    startedAt: 0,
    offset: 0,
    isPlaying: false,
    rafId: 0,
  },
  };

  const elements = {};

  function $(id) {
    return document.getElementById(id);
  }

  function dbToAmp(db) {
    return 10 ** (db / 20);
  }

  function ampToDb(amp) {
    if (!Number.isFinite(amp) || amp <= 0) {
      return -Infinity;
    }
    return 20 * Math.log10(amp);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatDb(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value.toFixed(1)} dB`;
  }

  function formatLu(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value.toFixed(1)} LU`;
  }

  function formatLufs(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${value.toFixed(1)}`;
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return `${Math.round(value * 100)}%`;
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const rest = safeSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function sanitizeFileBase(name) {
    return (name || "master")
      .replace(/\.[^/.]+$/, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .slice(0, 80);
  }

  function getAudioContext() {
    if (!state.audioContext) {
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return state.audioContext;
  }

  function setStatus(message) {
    elements.appStatus.textContent = message;
    if (!elements.processBanner) {
      return;
    }
    const active = /読み込み|処理|調整待ち|解析|書き出し|仕上げ/.test(message);
    elements.processBanner.hidden = !active;
    elements.processMessage.textContent = message;
  }

  function setEnabled(enabled) {
    const ids = [
      "playPause",
      "stopPlayback",
      "beforeMode",
      "afterMode",
      "levelMatch",
      "baseClean",
      "resetBaseControls",
      "baseLowCutHz",
      "baseMudHz",
      "baseMudDb",
      "baseHarshHz",
      "baseHarshDb",
      "baseArtifactAmount",
      "baseLowMonoHz",
      "baseLowMonoAmount",
      "resetControls",
      "brightness",
      "body",
      "impact",
      "width",
      "smoothness",
      "bitDepth",
      "exportWav",
    ];
    ids.forEach((id) => {
      elements[id].disabled = !enabled;
    });
    document.querySelectorAll(".target-button, .preset-strip button").forEach((button) => {
      button.disabled = !enabled;
    });
    updateBaseControlAvailability();
    updateBackendUi();
  }

  function updateSliderOutputs() {
    TONE_CONTROL_KEYS.forEach((key) => {
      elements[key].value = state.settings[key];
      elements[`${key}Value`].textContent = String(state.settings[key]);
    });
    updateBaseSliderOutputs();
  }

  function formatBaseControlValue(key, value) {
    if (key === "baseMudDb" || key === "baseHarshDb") {
      return value <= 0 ? "0dB" : `-${Number(value).toFixed(1)}dB`;
    }
    if (key === "baseHarshHz") {
      return `${(Number(value) / 1000).toFixed(1)}kHz`;
    }
    if (key === "baseArtifactAmount" || key === "baseLowMonoAmount") {
      return `${Math.round(Number(value))}%`;
    }
    return `${Math.round(Number(value))}Hz`;
  }

  function updateBaseSliderOutputs() {
    BASE_CONTROL_KEYS.forEach((key) => {
      if (!elements[key]) {
        return;
      }
      elements[key].value = state.settings[key];
      elements[`${key}Value`].textContent = formatBaseControlValue(key, state.settings[key]);
    });
    updateBaseControlAvailability();
  }

  function updateBaseControlAvailability() {
    if (!elements.baseLowCutHz) {
      return;
    }
    const enabled = Boolean(state.originalBuffer && elements.baseClean.checked);
    BASE_CONTROL_KEYS.forEach((key) => {
      elements[key].disabled = !enabled;
    });
    elements.resetBaseControls.disabled = !enabled;
  }

  function updateTargetButtons() {
    document.querySelectorAll(".target-button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.target === state.settings.target);
    });
  }

  function updatePresetButtons() {
    document.querySelectorAll(".preset-strip button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.preset === state.selectedPreset);
    });
  }

  function updateModeButtons() {
    const afterAvailable = Boolean(state.originalBuffer);
    if (!afterAvailable && state.displayMode === "after") {
      state.displayMode = "before";
    }
    elements.beforeMode.classList.toggle("is-active", state.displayMode === "before");
    elements.afterMode.classList.toggle("is-active", state.displayMode === "after");
    elements.afterMode.disabled = !afterAvailable;
  }

  function getBackendBase() {
    if (window.location.protocol === "file:") {
      return BACKEND_FALLBACK_URL;
    }
    return window.location.origin;
  }

  function updateBackendUi() {
    if (!elements.backendStatus) {
      return;
    }
    const hasProcessedAudio = canExportCurrent();
    if (!state.backend.checked) {
      elements.backendStatus.textContent = "確認中";
      elements.backendNote.textContent = "ローカルPythonサーバーとffmpegを確認しています。WAVがマスター、MP3は任意コピーです。";
    } else if (!state.backend.reachable) {
      elements.backendStatus.textContent = "未接続";
      elements.backendNote.textContent = "精密仕上げを使うには start_backend.ps1 を起動してください。WAVはブラウザ簡易書き出しに戻ります。";
    } else if (!state.backend.ffmpeg) {
      elements.backendStatus.textContent = "ffmpegなし";
      elements.backendNote.textContent = "サーバーは動いていますが、ffmpegが見つかりません。WAVは簡易書き出し、MP3コピーは無効です。";
    } else {
      elements.backendStatus.textContent = "接続済み";
      elements.backendNote.textContent = state.backend.message || state.backend.version || "ffmpeg精密エンジンを使えます。WAVがマスター、MP3は任意コピーです。";
    }
    const ready = hasProcessedAudio && state.backend.reachable && state.backend.ffmpeg;
    elements.exportWav.disabled = !canExportCurrent();
    elements.preciseAnalyze.disabled = !ready;
    elements.exportMp3.disabled = !ready;
  }

  function canUsePreciseBackend() {
    return Boolean(state.backend.reachable && state.backend.ffmpeg && canExportCurrent());
  }

  function canExportCurrent() {
    return Boolean(state.processedBuffer && !state.isProcessing && !state.isAnalyzing && !state.isExporting && !state.needsProcess);
  }

  function clearPreciseReadout(message) {
    if (!elements.preciseLufs) {
      return;
    }
    elements.preciseLufs.textContent = "--";
    elements.preciseTruePeak.textContent = "--";
    elements.preciseLra.textContent = "--";
    if (message) {
      state.backend.message = message;
      elements.backendNote.textContent = message;
    }
  }

  async function checkBackend() {
    state.backend.url = getBackendBase();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1600);
    try {
      const response = await fetch(`${state.backend.url}/api/health`, {
        signal: controller.signal,
      });
      const payload = await response.json();
      state.backend.checked = true;
      state.backend.reachable = Boolean(payload.ok);
      state.backend.ffmpeg = Boolean(payload.ffmpeg);
      state.backend.version = payload.version || "";
    } catch (error) {
      state.backend.checked = true;
      state.backend.reachable = false;
      state.backend.ffmpeg = false;
      state.backend.version = "";
    } finally {
      window.clearTimeout(timer);
      updateBackendUi();
    }
  }

  function getCurrentBuffer() {
    return state.displayMode === "after" && state.processedBuffer ? state.processedBuffer : state.originalBuffer;
  }

  function getPlaybackSourceBuffer() {
    return state.originalBuffer;
  }

  function getPlaybackGain() {
    if (!elements.levelMatch.checked || state.displayMode !== "before" || !state.originalAnalysis || !state.processedAnalysis) {
      return 1;
    }
    const gainDb = state.processedAnalysis.lufs - state.originalAnalysis.lufs;
    return dbToAmp(clamp(gainDb, -18, 18));
  }

  function setAudioParam(param, value, now, smooth) {
    const safeValue = Number.isFinite(value) ? value : 0;
    const time = Number.isFinite(now) ? now : 0;
    param.cancelScheduledValues(time);
    if (smooth) {
      param.setTargetAtTime(safeValue, time, 0.025);
    } else {
      param.setValueAtTime(safeValue, time);
    }
  }

  function createFilterNode(context, type, frequency, q, gainDb) {
    const node = context.createBiquadFilter();
    node.type = type;
    node.frequency.setValueAtTime(frequency, context.currentTime);
    node.Q.setValueAtTime(q, context.currentTime);
    if (typeof node.gain !== "undefined") {
      node.gain.setValueAtTime(gainDb, context.currentTime);
    }
    return node;
  }

  function createSoftClipCurve(driveValue) {
    const drive = 1 + Math.max(0, driveValue / 100) * 0.8;
    const samples = 1024;
    const curve = new Float32Array(samples);
    const normalizer = Math.tanh(drive);
    for (let i = 0; i < samples; i += 1) {
      const x = (i / (samples - 1)) * 2 - 1;
      curve[i] = drive <= 1.01 ? x : Math.tanh(x * drive) / normalizer;
    }
    return curve;
  }

  function createStereoWidthMatrix(context) {
    const input = context.createGain();
    const output = context.createGain();
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const leftToLeft = context.createGain();
    const leftToRight = context.createGain();
    const rightToLeft = context.createGain();
    const rightToRight = context.createGain();

    input.connect(splitter);
    splitter.connect(leftToLeft, 0);
    splitter.connect(leftToRight, 0);
    splitter.connect(rightToLeft, 1);
    splitter.connect(rightToRight, 1);
    leftToLeft.connect(merger, 0, 0);
    rightToLeft.connect(merger, 0, 0);
    leftToRight.connect(merger, 0, 1);
    rightToRight.connect(merger, 0, 1);
    merger.connect(output);

    return {
      input,
      output,
      leftToLeft,
      leftToRight,
      rightToLeft,
      rightToRight,
    };
  }

  function connectRealtimePreviewGraph(context, source) {
    const nodes = {
      lowCut: createFilterNode(context, "highpass", 24, 0.72, 0),
      mud: createFilterNode(context, "peaking", 280, 0.9, 0),
      harsh: createFilterNode(context, "peaking", 3600, 1.2, 0),
      artifactShelf: createFilterNode(context, "highshelf", 4200, 0.7, 0),
      artifactPeak: createFilterNode(context, "peaking", 7800, 1.4, 0),
      bodyShelf: createFilterNode(context, "lowshelf", 115, 0.75, 0),
      bodyPeak: createFilterNode(context, "peaking", 260, 0.85, 0),
      brightShelf: createFilterNode(context, "highshelf", 7600, 0.7, 0),
      brightPeak: createFilterNode(context, "peaking", 4200, 1, 0),
      smoothPeak: createFilterNode(context, "peaking", 4200, 0.9, 0),
      compressor: context.createDynamicsCompressor(),
      makeupGain: context.createGain(),
      softClip: context.createWaveShaper(),
      limiter: context.createDynamicsCompressor(),
      finalGain: context.createGain(),
      widthMatrix: null,
    };

    nodes.softClip.oversample = "2x";
    nodes.limiter.threshold.setValueAtTime(-1, context.currentTime);
    nodes.limiter.knee.setValueAtTime(0, context.currentTime);
    nodes.limiter.ratio.setValueAtTime(20, context.currentTime);
    nodes.limiter.attack.setValueAtTime(0.003, context.currentTime);
    nodes.limiter.release.setValueAtTime(0.08, context.currentTime);

    const serialNodes = [
      nodes.lowCut,
      nodes.mud,
      nodes.harsh,
      nodes.artifactShelf,
      nodes.artifactPeak,
      nodes.bodyShelf,
      nodes.bodyPeak,
      nodes.brightShelf,
      nodes.brightPeak,
      nodes.smoothPeak,
      nodes.compressor,
      nodes.makeupGain,
      nodes.softClip,
    ];

    source.connect(serialNodes[0]);
    for (let index = 0; index < serialNodes.length - 1; index += 1) {
      serialNodes[index].connect(serialNodes[index + 1]);
    }

    let outputCursor = serialNodes[serialNodes.length - 1];
    if (state.originalBuffer && state.originalBuffer.numberOfChannels >= 2) {
      nodes.widthMatrix = createStereoWidthMatrix(context);
      outputCursor.connect(nodes.widthMatrix.input);
      outputCursor = nodes.widthMatrix.output;
    }

    outputCursor.connect(nodes.limiter);
    nodes.limiter.connect(nodes.finalGain);
    nodes.finalGain.connect(context.destination);

    state.playback.previewNodes = nodes;
    state.playback.gainNode = nodes.finalGain;
    updateRealtimePreview(false);
  }

  function updateRealtimePreview(smooth = true) {
    const nodes = state.playback.previewNodes;
    if (!nodes || !state.audioContext) {
      return;
    }
    const now = state.audioContext.currentTime;
    const settings = state.settings;
    const baseEnabled = Boolean(settings.baseClean);
    const brightness = settings.brightness / 100;
    const body = settings.body / 100;
    const impactPositive = Math.max(0, settings.impact / 100);
    const impactNegative = Math.max(0, -settings.impact / 100);
    const smoothPositive = Math.max(0, settings.smoothness / 100);
    const smoothNegative = Math.max(0, -settings.smoothness / 100);
    const artifactAmount = baseEnabled ? clamp(settings.baseArtifactAmount / 100, 0, 1) : 0;

    setAudioParam(nodes.lowCut.frequency, baseEnabled ? settings.baseLowCutHz : 10, now, smooth);
    setAudioParam(nodes.mud.frequency, settings.baseMudHz, now, smooth);
    setAudioParam(nodes.mud.gain, baseEnabled ? -settings.baseMudDb : 0, now, smooth);
    setAudioParam(nodes.harsh.frequency, settings.baseHarshHz, now, smooth);
    setAudioParam(nodes.harsh.gain, baseEnabled ? -settings.baseHarshDb : 0, now, smooth);
    setAudioParam(nodes.artifactShelf.gain, -artifactAmount * 3.4, now, smooth);
    setAudioParam(nodes.artifactPeak.gain, -artifactAmount * 2.1, now, smooth);
    setAudioParam(nodes.bodyShelf.gain, body * 3.1, now, smooth);
    setAudioParam(nodes.bodyPeak.gain, body * 1.05, now, smooth);
    setAudioParam(nodes.brightShelf.gain, brightness * 3.4, now, smooth);
    setAudioParam(nodes.brightPeak.gain, brightness * 0.9 + smoothNegative * 1.2, now, smooth);
    setAudioParam(nodes.smoothPeak.gain, -smoothPositive * 3.2, now, smooth);

    setAudioParam(nodes.compressor.threshold, -18 - impactPositive * 8 + impactNegative * 7, now, smooth);
    setAudioParam(nodes.compressor.ratio, clamp(1.25 + impactPositive * 2.8 - impactNegative * 0.3, 1, 20), now, smooth);
    setAudioParam(nodes.compressor.attack, 0.006 + impactNegative * 0.01, now, smooth);
    setAudioParam(nodes.compressor.release, 0.08 + impactPositive * 0.08, now, smooth);
    setAudioParam(nodes.makeupGain.gain, dbToAmp(impactPositive * 2.4 - impactNegative * 1.2), now, smooth);
    nodes.softClip.curve = createSoftClipCurve(settings.impact);

    if (nodes.widthMatrix) {
      const widthNormalized = settings.width / 100;
      const sideGain = widthNormalized >= 0
        ? 1 + widthNormalized * 0.48
        : 1 + widthNormalized * 0.36;
      const same = (1 + sideGain) / 2;
      const cross = (1 - sideGain) / 2;
      setAudioParam(nodes.widthMatrix.leftToLeft.gain, same, now, smooth);
      setAudioParam(nodes.widthMatrix.rightToRight.gain, same, now, smooth);
      setAudioParam(nodes.widthMatrix.leftToRight.gain, cross, now, smooth);
      setAudioParam(nodes.widthMatrix.rightToLeft.gain, cross, now, smooth);
    }

    const target = TARGETS[settings.target] || TARGETS.streaming;
    const targetGainDb = state.originalAnalysis && Number.isFinite(state.originalAnalysis.lufs)
      ? clamp(target.lufs - state.originalAnalysis.lufs, -13, 10)
      : 0;
    setAudioParam(nodes.finalGain.gain, dbToAmp(targetGainDb), now, smooth);
  }

  function copyBufferChannels(buffer) {
    const channels = [];
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      channels.push(new Float32Array(buffer.getChannelData(channel)));
    }
    return channels;
  }

  function createAudioBufferFromChannels(channels, sampleRate) {
    const context = getAudioContext();
    const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
    channels.forEach((channelData, index) => {
      buffer.copyToChannel(channelData, index);
    });
    return buffer;
  }

  function makeBiquad(type, frequency, q, gainDb, sampleRate) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const sn = Math.sin(omega);
    const cs = Math.cos(omega);
    const alpha = sn / (2 * q);
    const a = 10 ** (gainDb / 40);
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;

    if (type === "highpass") {
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = (1 + cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
    } else if (type === "lowpass") {
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = (1 - cs) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cs;
      a2 = 1 - alpha;
    } else if (type === "peaking") {
      b0 = 1 + alpha * a;
      b1 = -2 * cs;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cs;
      a2 = 1 - alpha / a;
    } else if (type === "lowshelf") {
      const sqrtA = Math.sqrt(a);
      const shelfAlpha = sn / 2 * Math.sqrt(2);
      b0 = a * ((a + 1) - (a - 1) * cs + 2 * sqrtA * shelfAlpha);
      b1 = 2 * a * ((a - 1) - (a + 1) * cs);
      b2 = a * ((a + 1) - (a - 1) * cs - 2 * sqrtA * shelfAlpha);
      a0 = (a + 1) + (a - 1) * cs + 2 * sqrtA * shelfAlpha;
      a1 = -2 * ((a - 1) + (a + 1) * cs);
      a2 = (a + 1) + (a - 1) * cs - 2 * sqrtA * shelfAlpha;
    } else if (type === "highshelf") {
      const sqrtA = Math.sqrt(a);
      const shelfAlpha = sn / 2 * Math.sqrt(2);
      b0 = a * ((a + 1) + (a - 1) * cs + 2 * sqrtA * shelfAlpha);
      b1 = -2 * a * ((a - 1) + (a + 1) * cs);
      b2 = a * ((a + 1) + (a - 1) * cs - 2 * sqrtA * shelfAlpha);
      a0 = (a + 1) - (a - 1) * cs + 2 * sqrtA * shelfAlpha;
      a1 = 2 * ((a - 1) - (a + 1) * cs);
      a2 = (a + 1) - (a - 1) * cs - 2 * sqrtA * shelfAlpha;
    }

    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
    };
  }

  function applyBiquad(data, coeffs) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < data.length; i += 1) {
      const x0 = data[i];
      const y0 = coeffs.b0 * x0 + coeffs.b1 * x1 + coeffs.b2 * x2 - coeffs.a1 * y1 - coeffs.a2 * y2;
      data[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
  }

  function removeDcOffset(channels) {
    channels.forEach((channel) => {
      let sum = 0;
      for (let i = 0; i < channel.length; i += 1) {
        sum += channel[i];
      }
      const mean = sum / channel.length;
      if (Math.abs(mean) < 1e-8) {
        return;
      }
      for (let i = 0; i < channel.length; i += 1) {
        channel[i] -= mean;
      }
    });
  }

  function applyFilterToAll(channels, type, frequency, q, gainDb, sampleRate) {
    channels.forEach((channel) => {
      applyBiquad(channel, makeBiquad(type, frequency, q, gainDb, sampleRate));
    });
  }

  function lowMono(channels, sampleRate, amount, frequency = 145) {
    if (channels.length < 2 || amount <= 0) {
      return;
    }
    const left = channels[0];
    const right = channels[1];
    const length = left.length;
    const side = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      side[i] = (left[i] - right[i]) * 0.5;
    }
    const sideLow = new Float32Array(side);
    applyBiquad(sideLow, makeBiquad("lowpass", frequency, 0.7, 0, sampleRate));
    for (let i = 0; i < length; i += 1) {
      const mid = (left[i] + right[i]) * 0.5;
      const adjustedSide = side[i] - sideLow[i] * amount;
      left[i] = mid + adjustedSide;
      right[i] = mid - adjustedSide;
    }
  }

  function applyStereoWidth(channels, widthValue, sampleRate) {
    if (channels.length < 2) {
      return;
    }
    const normalized = widthValue / 100;
    const sideGain = normalized >= 0 ? 1 + normalized * 0.48 : 1 + normalized * 0.36;
    const left = channels[0];
    const right = channels[1];
    for (let i = 0; i < left.length; i += 1) {
      const mid = (left[i] + right[i]) * 0.5;
      const side = (left[i] - right[i]) * 0.5 * sideGain;
      left[i] = mid + side;
      right[i] = mid - side;
    }
  }

  function applyDynamicBandTamer(channels, sampleRate, frequency, q, amount, options = {}) {
    if (amount <= 0) {
      return;
    }
    const length = channels[0].length;
    const bandChannels = channels.map((channel) => {
      const boosted = new Float32Array(channel);
      applyBiquad(boosted, makeBiquad("peaking", frequency, q, 9, sampleRate));
      for (let i = 0; i < length; i += 1) {
        boosted[i] -= channel[i];
      }
      return boosted;
    });
    const threshold = options.threshold || 0.24;
    const knee = options.knee || 0.34;
    const absoluteFloor = options.absoluteFloor || 0.012;
    const maxReductionDb = options.maxReductionDb || 5;
    const attack = Math.exp(-1 / (sampleRate * (options.attackSeconds || 0.004)));
    const release = Math.exp(-1 / (sampleRate * (options.releaseSeconds || 0.08)));
    let detector = 0;

    for (let i = 0; i < length; i += 1) {
      let bandPeak = 0;
      let fullPeak = 0;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        bandPeak = Math.max(bandPeak, Math.abs(bandChannels[channelIndex][i]));
        fullPeak = Math.max(fullPeak, Math.abs(channels[channelIndex][i]));
      }
      const ratio = bandPeak / Math.max(fullPeak, 1e-5);
      const ratioPressure = clamp((ratio - threshold) / knee, 0, 1);
      const levelPressure = clamp((bandPeak - absoluteFloor) / Math.max(absoluteFloor * 5, 1e-5), 0, 1);
      const target = ratioPressure * levelPressure;
      detector = target > detector
        ? attack * detector + (1 - attack) * target
        : release * detector + (1 - release) * target;
      const gain = dbToAmp(-detector * maxReductionDb * amount);
      const bandMix = (1 - gain) * clamp(0.55 + amount * 0.35, 0.55, 0.9);
      if (bandMix <= 0.0001) {
        continue;
      }
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        channels[channelIndex][i] -= bandChannels[channelIndex][i] * bandMix;
      }
    }
  }

  function applyDynamicSmoothness(channels, sampleRate, smoothnessValue) {
    const normalized = smoothnessValue / 100;
    const amount = Math.max(0, normalized);
    const edge = Math.max(0, -normalized);
    if (amount > 0.01) {
      applyArtifactTamer(channels, sampleRate, amount * 48);
      applyFilterToAll(channels, "peaking", 4200, 0.9, -amount * 0.45, sampleRate);
    } else if (edge > 0.01) {
      applyFilterToAll(channels, "peaking", 3100, 1.2, edge * 1.2, sampleRate);
      applyFilterToAll(channels, "highshelf", 7200, 0.7, edge * 1.1, sampleRate);
    }
  }

  function applyArtifactTamer(channels, sampleRate, amountValue) {
    const amount = clamp(amountValue / 100, 0, 1);
    if (amount <= 0.01) {
      return;
    }
    const cutoff = 4200;
    const lowCoeff = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    const attack = Math.exp(-1 / (sampleRate * 0.0015));
    const release = Math.exp(-1 / (sampleRate * 0.045));
    const lows = channels.map(() => 0);
    const highs = channels.map(() => 0);
    let detector = 0;
    const maxHighReduction = 0.78 * amount;
    const length = channels[0].length;

    for (let i = 0; i < length; i += 1) {
      let highPeak = 0;
      let fullPeak = 0;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        const sample = channels[channelIndex][i];
        lows[channelIndex] += lowCoeff * (sample - lows[channelIndex]);
        const high = sample - lows[channelIndex];
        highs[channelIndex] = high;
        highPeak = Math.max(highPeak, Math.abs(high));
        fullPeak = Math.max(fullPeak, Math.abs(sample));
      }
      const ratio = highPeak / Math.max(fullPeak, 1e-5);
      const ratioPressure = clamp((ratio - 0.36) / 0.34, 0, 1);
      const levelPressure = clamp((highPeak - 0.006) / 0.05, 0, 1);
      const target = ratioPressure * levelPressure;
      detector = target > detector
        ? attack * detector + (1 - attack) * target
        : release * detector + (1 - release) * target;
      const highGain = clamp(1 - detector * maxHighReduction, 0.25, 1);
      if (highGain > 0.995) {
        continue;
      }
      const reduction = 1 - highGain;
      for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
        channels[channelIndex][i] -= highs[channelIndex] * reduction;
      }
    }
  }

  function applyCompressor(channels, sampleRate, impactValue) {
    const normalized = impactValue / 100;
    const positive = Math.max(0, normalized);
    const negative = Math.max(0, -normalized);
    const thresholdDb = -18 - positive * 8 + negative * 7;
    const ratio = 1.25 + positive * 2.8 - negative * 0.3;
    const makeupDb = positive * 2.4 - negative * 1.2;
    const attack = Math.exp(-1 / (sampleRate * (0.006 + negative * 0.01)));
    const release = Math.exp(-1 / (sampleRate * (0.08 + positive * 0.08)));
    const makeup = dbToAmp(makeupDb);
    const thresholdAmp = dbToAmp(thresholdDb);
    const compressionExponent = 1 - (1 / ratio);
    const length = channels[0].length;
    let envelope = 0;

    for (let i = 0; i < length; i += 1) {
      let peak = 0;
      for (const channel of channels) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
      envelope = peak > envelope
        ? attack * envelope + (1 - attack) * peak
        : release * envelope + (1 - release) * peak;
      let gain = makeup;
      if (envelope > thresholdAmp) {
        gain *= (thresholdAmp / envelope) ** compressionExponent;
      }
      for (const channel of channels) {
        channel[i] *= gain;
      }
    }
  }

  function applySoftClip(channels, driveValue) {
    const drive = 1 + Math.max(0, driveValue / 100) * 0.8;
    if (drive <= 1.01) {
      return;
    }
    const normalizer = Math.tanh(drive);
    channels.forEach((channel) => {
      for (let i = 0; i < channel.length; i += 1) {
        channel[i] = Math.tanh(channel[i] * drive) / normalizer;
      }
    });
  }

  function applyGain(channels, gain) {
    channels.forEach((channel) => {
      for (let i = 0; i < channel.length; i += 1) {
        channel[i] *= gain;
      }
    });
  }

  function applyLimiter(channels, sampleRate, ceilingDb) {
    const ceiling = dbToAmp(ceilingDb);
    const length = channels[0].length;
    const lookaheadSamples = Math.max(1, Math.floor(sampleRate * 0.006));
    const release = Math.exp(-1 / (sampleRate * 0.09));
    const peaks = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let peak = 0;
      for (const channel of channels) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
      peaks[i] = peak;
    }

    const deque = new Int32Array(length);
    let head = 0;
    let tail = 0;
    let nextIndex = 0;
    let gain = 1;
    for (let i = 0; i < length; i += 1) {
      const windowEnd = Math.min(length - 1, i + lookaheadSamples);
      while (nextIndex <= windowEnd) {
        while (tail > head && peaks[deque[tail - 1]] <= peaks[nextIndex]) {
          tail -= 1;
        }
        deque[tail] = nextIndex;
        tail += 1;
        nextIndex += 1;
      }
      while (tail > head && deque[head] < i) {
        head += 1;
      }
      const futurePeak = tail > head ? peaks[deque[head]] : peaks[i];
      const target = futurePeak > ceiling ? ceiling / futurePeak : 1;
      gain = target < gain ? target : gain * release + (1 - release) * target;
      for (const channel of channels) {
        channel[i] *= gain;
      }
    }

    for (let i = 0; i < length; i += 1) {
      let peak = 0;
      for (const channel of channels) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
      if (peak > ceiling) {
        const guardGain = ceiling / peak;
        for (const channel of channels) {
          channel[i] *= guardGain;
        }
      }
    }
  }

  function getPeakFromChannels(channels) {
    let peak = 0;
    channels.forEach((channel) => {
      for (let i = 0; i < channel.length; i += 1) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
    });
    return peak;
  }

  function getCatmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  function estimateTruePeak(channels, samplePeak = null) {
    const referencePeak = Number.isFinite(samplePeak) ? samplePeak : getPeakFromChannels(channels);
    if (referencePeak <= 0) {
      return 0;
    }
    let peak = referencePeak;
    const interpolationFloor = Math.max(0.08, referencePeak * 0.45);
    channels.forEach((channel) => {
      for (let i = 0; i < channel.length - 1; i += 1) {
        const p1 = channel[i];
        const p2 = channel[i + 1];
        if (Math.max(Math.abs(p1), Math.abs(p2)) < interpolationFloor) {
          continue;
        }
        const p0 = channel[Math.max(0, i - 1)];
        const p3 = channel[Math.min(channel.length - 1, i + 2)];
        for (let step = 1; step < 4; step += 1) {
          peak = Math.max(peak, Math.abs(getCatmullRom(p0, p1, p2, p3, step / 4)));
        }
      }
    });
    return peak;
  }

  function makeMonoForAnalysis(channels) {
    const length = channels[0].length;
    const mono = new Float32Array(length);
    const scale = 1 / channels.length;
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const channel = channels[channelIndex];
      for (let i = 0; i < length; i += 1) {
        mono[i] += channel[i] * scale;
      }
    }
    return mono;
  }

  function estimateLufs(channels, sampleRate) {
    const weighted = makeMonoForAnalysis(channels);
    applyBiquad(weighted, makeBiquad("highpass", 60, 0.7, 0, sampleRate));
    applyBiquad(weighted, makeBiquad("highshelf", 1500, 0.7, 4, sampleRate));

    const blockSize = Math.max(1, Math.floor(sampleRate * 0.4));
    const blockPowers = [];
    for (let start = 0; start < weighted.length; start += blockSize) {
      const end = Math.min(weighted.length, start + blockSize);
      let sumSquares = 0;
      for (let i = start; i < end; i += 1) {
        sumSquares += weighted[i] * weighted[i];
      }
      const meanSquare = sumSquares / Math.max(1, end - start);
      const blockLufs = -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-12));
      if (blockLufs > -70) {
        blockPowers.push(meanSquare);
      }
    }

    if (!blockPowers.length) {
      return -Infinity;
    }
    const ungated = blockPowers.reduce((sum, value) => sum + value, 0) / blockPowers.length;
    const relativeGate = -0.691 + 10 * Math.log10(Math.max(ungated, 1e-12)) - 10;
    const gated = blockPowers.filter((value) => -0.691 + 10 * Math.log10(Math.max(value, 1e-12)) >= relativeGate);
    const integratedPower = (gated.length ? gated : blockPowers).reduce((sum, value) => sum + value, 0) / (gated.length || blockPowers.length);
    return -0.691 + 10 * Math.log10(Math.max(integratedPower, 1e-12));
  }

  function estimateShortTermLufs(channels, sampleRate) {
    const mono = makeMonoForAnalysis(channels);
    applyBiquad(mono, makeBiquad("highpass", 60, 0.7, 0, sampleRate));
    applyBiquad(mono, makeBiquad("highshelf", 1500, 0.7, 4, sampleRate));
    const windowSize = Math.max(1, Math.floor(sampleRate * 3));
    const step = Math.max(1, Math.floor(sampleRate * 0.5));
    let maxLufs = -Infinity;
    let start = 0;
    let end = Math.min(mono.length, windowSize);
    let sumSquares = 0;
    for (let i = 0; i < end; i += 1) {
      sumSquares += mono[i] * mono[i];
    }
    while (start < mono.length) {
      const meanSquare = sumSquares / Math.max(1, end - start);
      maxLufs = Math.max(maxLufs, -0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-12)));
      if (end === mono.length) {
        break;
      }
      const nextStart = Math.min(start + step, mono.length - 1);
      const nextEnd = Math.min(mono.length, nextStart + windowSize);
      for (let i = start; i < nextStart; i += 1) {
        sumSquares -= mono[i] * mono[i];
      }
      for (let i = end; i < nextEnd; i += 1) {
        sumSquares += mono[i] * mono[i];
      }
      start = nextStart;
      end = nextEnd;
    }
    return maxLufs;
  }

  function estimateCorrelation(channels) {
    if (channels.length < 2) {
      return 1;
    }
    const left = channels[0];
    const right = channels[1];
    const step = Math.max(1, Math.floor(left.length / 180000));
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < left.length; i += step) {
      xy += left[i] * right[i];
      xx += left[i] * left[i];
      yy += right[i] * right[i];
    }
    return xy / Math.sqrt(Math.max(xx * yy, 1e-12));
  }

  function analyzeChannels(channels, sampleRate) {
    const peak = getPeakFromChannels(channels);
    const truePeak = estimateTruePeak(channels, peak);
    const lufs = estimateLufs(channels, sampleRate);
    const shortTerm = estimateShortTermLufs(channels, sampleRate);
    const correlation = estimateCorrelation(channels);
    const crest = ampToDb(peak) - lufs;
    return {
      lufs,
      shortTerm,
      peakDb: ampToDb(peak),
      truePeakDb: ampToDb(truePeak),
      correlation,
      crest,
    };
  }

  function analyzeBuffer(buffer) {
    return analyzeChannels(copyBufferChannels(buffer), buffer.sampleRate);
  }

  function analyzeGainLevel(channels, sampleRate) {
    const peak = getPeakFromChannels(channels);
    return {
      lufs: estimateLufs(channels, sampleRate),
      peakDb: ampToDb(peak),
    };
  }

  function handleProcessingFailure(error, message = "処理失敗") {
    console.error(error);
    const hasPreviousAfter = Boolean(state.processedBuffer);
    state.isProcessing = false;
    state.needsProcess = hasPreviousAfter;
    if (!hasPreviousAfter) {
      state.processedAnalysis = null;
    }
    if (state.originalBuffer) {
      setEnabled(true);
    }
    updateModeButtons();
    updateMeters();
    drawWaveform();
    drawSpectrum();
    updateBackendUi();
    setStatus(message);
    elements.exportNote.textContent = hasPreviousAfter
      ? "新しいAfter生成に失敗しました。今のAfterは前回生成分です。設定を少し戻すか、もう一度調整してください。"
      : "読み込みは完了していますが、After生成に失敗しました。音源を再読み込みするか、設定を変えてもう一度試してください。";
  }

  function handleLoadFailure(error, file) {
    const partiallyLoaded = Boolean(file && state.originalBuffer && state.fileName === file.name);
    if (partiallyLoaded) {
      handleProcessingFailure(error, "読み込み後の処理失敗");
      return;
    }
    console.error(error);
    state.isProcessing = false;
    state.needsProcess = false;
    state.processedBuffer = null;
    state.processedAnalysis = null;
    state.waveformCache.after = null;
    updateModeButtons();
    updateBackendUi();
    setStatus("読み込み失敗");
    elements.exportNote.textContent = "この形式はブラウザで読み込めませんでした。WAVまたはMP3で試してください。";
  }

  function processMaster(version) {
    if (!state.originalBuffer) {
      return;
    }

    state.isProcessing = true;
    updateModeButtons();
    updateMeters();
    drawWaveform();
    drawSpectrum();
    setStatus("処理中");
    updateBackendUi();
    const jobVersion = Number.isFinite(version) ? version : ++state.processVersion;
    const settings = { ...state.settings };

    window.setTimeout(() => {
      if (jobVersion !== state.processVersion || !state.originalBuffer) {
        return;
      }
      try {
        const sampleRate = state.originalBuffer.sampleRate;
        const channels = copyBufferChannels(state.originalBuffer);
        const brightness = settings.brightness / 100;
        const body = settings.body / 100;
        const hasWidthChange = Math.abs(settings.width) > 0.5;

        removeDcOffset(channels);
        if (settings.baseClean) {
          applyFilterToAll(channels, "highpass", settings.baseLowCutHz, 0.72, 0, sampleRate);
          if (settings.baseMudDb > 0) {
            applyFilterToAll(channels, "peaking", settings.baseMudHz, 0.9, -settings.baseMudDb, sampleRate);
          }
          if (settings.baseHarshDb > 0) {
            applyFilterToAll(channels, "peaking", settings.baseHarshHz, 1.2, -settings.baseHarshDb, sampleRate);
          }
          applyArtifactTamer(channels, sampleRate, settings.baseArtifactAmount);
          lowMono(channels, sampleRate, settings.baseLowMonoAmount / 100, settings.baseLowMonoHz);
        }

        if (Math.abs(body) > 0.01) {
          applyFilterToAll(channels, "lowshelf", 115, 0.75, body * 3.1, sampleRate);
          applyFilterToAll(channels, "peaking", 260, 0.85, body * 1.05, sampleRate);
        }

        if (Math.abs(brightness) > 0.01) {
          applyFilterToAll(channels, "highshelf", 7600, 0.7, brightness * 3.4, sampleRate);
          applyFilterToAll(channels, "peaking", 4200, 1, brightness * 0.9, sampleRate);
        }

        applyDynamicSmoothness(channels, sampleRate, settings.smoothness);

        if (hasWidthChange) {
          applyStereoWidth(channels, settings.width, sampleRate);
        }
        applyCompressor(channels, sampleRate, settings.impact);
        applySoftClip(channels, settings.impact);

        const preLevel = analyzeGainLevel(channels, sampleRate);
        const targetLufs = TARGETS[settings.target].lufs;
        const gainDbByLoudness = Number.isFinite(preLevel.lufs) ? targetLufs - preLevel.lufs : 0;
        const gainDbByPeak = Number.isFinite(preLevel.peakDb) ? -1 - preLevel.peakDb : 0;
        const gainDb = clamp(Math.min(gainDbByLoudness, gainDbByPeak + Math.max(0, settings.impact / 100) * 1.3), -18, 18);
        applyGain(channels, dbToAmp(gainDb));
        let limiterApplied = false;
        if (preLevel.peakDb + gainDb > -0.95 || settings.impact > 0) {
          applyLimiter(channels, sampleRate, -1);
          limiterApplied = true;
        }
        const browserTruePeakDb = ampToDb(estimateTruePeak(channels));
        if (browserTruePeakDb > -0.8) {
          applyGain(channels, dbToAmp(-1 - browserTruePeakDb));
          if (limiterApplied || browserTruePeakDb > -0.2) {
            applyLimiter(channels, sampleRate, -1);
          }
        }

        if (jobVersion !== state.processVersion || !state.originalBuffer) {
          return;
        }

        const shouldRestartAfter = Boolean(state.displayMode === "after" && state.playback.isPlaying && state.audioContext);
        const usingRealtimePreview = Boolean(state.playback.previewNodes);
        const afterOffset = shouldRestartAfter
          ? clamp(state.audioContext.currentTime - state.playback.startedAt, 0, state.originalBuffer.duration)
          : state.playback.offset;

        const processedAnalysis = analyzeChannels(channels, sampleRate);
        state.waveformCache.after = null;
        state.processedBuffer = createAudioBufferFromChannels(channels, sampleRate);
        state.processedAnalysis = processedAnalysis;
        state.spectrum = computeSpectrum(state.processedBuffer);
        state.isProcessing = false;
        state.needsProcess = false;
        const didCrossfade = shouldRestartAfter && !usingRealtimePreview && crossfadePlaybackToBuffer(state.processedBuffer, afterOffset);

        updateModeButtons();
        updateMeters();
        drawWaveform();
        drawSpectrum();
        updateBackendUi();
        setStatus("準備完了");
        if (shouldRestartAfter && !usingRealtimePreview && !didCrossfade) {
          state.playback.offset = clamp(afterOffset, 0, Math.max(0, state.processedBuffer.duration - 0.01));
          startPlayback();
        }
      } catch (error) {
        if (jobVersion === state.processVersion) {
          handleProcessingFailure(error);
        }
      }
    }, 20);
  }

  function scheduleProcess() {
    if (!state.originalBuffer) {
      return;
    }
    updateRealtimePreview(true);
    window.clearTimeout(state.processTimer);
    state.processVersion += 1;
    const nextVersion = state.processVersion;
    state.needsProcess = true;
    clearPreciseReadout("設定を変更しました。After再生成後に精密解析できます。");
    setStatus("調整待ち");
    updateModeButtons();
    updateBackendUi();
    state.processTimer = window.setTimeout(() => processMaster(nextVersion), PROCESS_DEBOUNCE_MS);
  }

  function computeSpectrum(buffer) {
    const channels = copyBufferChannels(buffer);
    const mono = makeMonoForAnalysis(channels);
    const size = 2048;
    const bins = 80;
    const values = [];
    const segmentCount = Math.min(14, Math.max(1, Math.floor(mono.length / size)));
    const starts = [];
    if (segmentCount === 1) {
      starts.push(Math.max(0, Math.floor((mono.length - size) / 2)));
    } else {
      for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
        starts.push(Math.floor((mono.length - size) * (segmentIndex / (segmentCount - 1))));
      }
    }
    for (let bin = 0; bin < bins; bin += 1) {
      const frequency = 35 * (2 ** (bin / 9.5));
      const k = Math.round((frequency * size) / buffer.sampleRate);
      let magnitudeSum = 0;
      for (const segmentStart of starts) {
        let real = 0;
        let imag = 0;
        for (let n = 0; n < size; n += 1) {
          const sample = mono[segmentStart + n] || 0;
          const windowValue = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1));
          const phase = (-2 * Math.PI * k * n) / size;
          real += sample * windowValue * Math.cos(phase);
          imag += sample * windowValue * Math.sin(phase);
        }
        magnitudeSum += Math.sqrt(real * real + imag * imag);
      }
      values.push(magnitudeSum / starts.length);
    }
    const max = Math.max(...values, 1e-9);
    return values.map((value) => clamp(20 * Math.log10(value / max) + 52, 0, 52) / 52);
  }

  function getFileWarning(file, buffer) {
    const warnings = [];
    const sizeMb = file.size / (1024 * 1024);
    if (buffer.duration > 600) {
      warnings.push("10分超の長尺です。処理に時間がかかる可能性があります。");
    }
    if (sizeMb > 120) {
      warnings.push("ファイルサイズが大きめです。ブラウザのメモリ使用量に注意してください。");
    }
    if (buffer.sampleRate > 48000) {
      warnings.push(`${Math.round(buffer.sampleRate / 1000)}kHz音源です。処理が重くなる場合があります。`);
    }
    return warnings.join(" ");
  }

  function renderFileSummary(file, buffer) {
    const sizeMb = file.size / (1024 * 1024);
    elements.fileSummary.querySelector("span").textContent = file.name;
    elements.fileSummary.querySelector("strong").textContent = `${formatTime(buffer.duration)} / ${buffer.sampleRate}Hz / ${sizeMb.toFixed(1)}MB`;
    const warning = getFileWarning(file, buffer);
    elements.fileWarning.hidden = !warning;
    elements.fileWarning.textContent = warning;
  }

  function drawWaveform() {
    const canvas = elements.waveformCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#101313";
    ctx.fillRect(0, 0, width, height);

    if (!state.originalBuffer) {
      ctx.fillStyle = "#a7afa7";
      ctx.font = "700 28px system-ui, sans-serif";
      ctx.fillText("音源待ち", 34, height / 2);
      return;
    }

    drawBufferWave(ctx, state.originalBuffer, "#54615c", 0.55, "before");
    if (state.processedBuffer) {
      drawBufferWave(ctx, state.processedBuffer, state.displayMode === "after" ? "#77d7b2" : "#3f8a6a", state.displayMode === "after" ? 0.95 : 0.5, "after");
    }

    const duration = getCurrentBuffer() ? getCurrentBuffer().duration : state.originalBuffer.duration;
    const position = state.playback.isPlaying
      ? clamp(state.audioContext.currentTime - state.playback.startedAt, 0, duration)
      : state.playback.offset;
    const x = duration > 0 ? (position / duration) * width : 0;
    ctx.strokeStyle = "#f4c15d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  function getWaveformPeaks(buffer, cacheKey, width) {
    const cached = state.waveformCache[cacheKey];
    if (cached && cached.buffer === buffer && cached.width === width) {
      return cached.peaks;
    }
    const channel = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
    const peaks = new Float32Array(width * 2);
    for (let x = 0; x < width; x += 1) {
      const start = x * samplesPerPixel;
      let min = 0;
      let max = 0;
      for (let i = 0; i < samplesPerPixel; i += 1) {
        const sample = channel[start + i] || 0;
        min = Math.min(min, sample);
        max = Math.max(max, sample);
      }
      peaks[x * 2] = min;
      peaks[x * 2 + 1] = max;
    }
    state.waveformCache[cacheKey] = { buffer, width, peaks };
    return peaks;
  }

  function drawBufferWave(ctx, buffer, color, alpha, cacheKey) {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const peaks = getWaveformPeaks(buffer, cacheKey, width);
    const center = height / 2;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const min = peaks[x * 2];
      const max = peaks[x * 2 + 1];
      ctx.moveTo(x, center + min * center * 0.86);
      ctx.lineTo(x, center + max * center * 0.86);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawSpectrum() {
    const canvas = elements.spectrumCanvas;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#101313";
    ctx.fillRect(0, 0, width, height);

    const values = state.spectrum;
    if (!values.length) {
      ctx.fillStyle = "#a7afa7";
      ctx.font = "700 22px system-ui, sans-serif";
      ctx.fillText("Spectrum", 28, height / 2);
      return;
    }

    const barWidth = width / values.length;
    values.forEach((value, index) => {
      const x = index * barWidth;
      const barHeight = value * (height - 28);
      const hue = index < values.length * 0.25 ? "#77d7b2" : index < values.length * 0.62 ? "#f4c15d" : "#a7c4ff";
      ctx.fillStyle = hue;
      ctx.fillRect(x + 1, height - barHeight - 16, Math.max(2, barWidth - 2), barHeight);
    });

    ctx.fillStyle = "#a7afa7";
    ctx.font = "700 16px system-ui, sans-serif";
    ctx.fillText("Low", 18, height - 8);
    ctx.fillText("Mid", width * 0.47, height - 8);
    ctx.fillText("High", width - 58, height - 8);
  }

  function buildFlags(analysis) {
    if (!analysis) {
      return [{ text: "音源待ち", type: "warn" }];
    }
    const flags = [];
    if (analysis.truePeakDb > -0.3) {
      flags.push({ text: "音割れ注意", type: "danger" });
    } else {
      flags.push({ text: "True Peak安全", type: "ok" });
    }
    if (analysis.lufs > -9) {
      flags.push({ text: "音圧強め", type: "warn" });
    } else if (analysis.lufs < -18) {
      flags.push({ text: "自然寄り", type: "ok" });
    } else {
      flags.push({ text: "配信向け", type: "ok" });
    }
    if (analysis.correlation < 0.12) {
      flags.push({ text: "広げすぎ注意", type: "warn" });
    } else {
      flags.push({ text: "ステレオ安定", type: "ok" });
    }
    if (analysis.crest < 6) {
      flags.push({ text: "密度高め", type: "warn" });
    }
    return flags;
  }

  function updateMeters() {
    const analysis = state.displayMode === "after" ? state.processedAnalysis : state.originalAnalysis;
    elements.lufsValue.textContent = formatLufs(analysis && analysis.lufs);
    elements.peakValue.textContent = formatDb(analysis && analysis.peakDb);
    elements.truePeakValue.textContent = formatDb(analysis && analysis.truePeakDb);
    elements.stereoValue.textContent = analysis ? formatPercent((analysis.correlation + 1) / 2) : "--";
    elements.beforeLufs.textContent = formatLufs(state.originalAnalysis && state.originalAnalysis.lufs);
    elements.afterLufs.textContent = formatLufs(state.processedAnalysis && state.processedAnalysis.lufs);
    elements.shortTermLufs.textContent = formatLufs(analysis && analysis.shortTerm);
    elements.crestValue.textContent = formatDb(analysis && analysis.crest);

    elements.signalFlags.replaceChildren();
    buildFlags(analysis).forEach((flag) => {
      const node = document.createElement("span");
      node.className = `signal-flag ${flag.type}`;
      node.textContent = flag.text;
      elements.signalFlags.append(node);
    });

    if (state.originalBuffer) {
      const target = TARGETS[state.settings.target];
      const precise = canUsePreciseBackend() ? "ffmpeg精密仕上げON" : "ブラウザ簡易書き出し";
      elements.exportNote.textContent = `${target.label} ${target.lufs} LUFS目標 / WAV ${elements.bitDepth.value} bit / ${precise}`;
    }
  }

  function refreshTimeReadout() {
    const buffer = getPlaybackSourceBuffer();
    const duration = buffer ? buffer.duration : 0;
    const position = state.playback.isPlaying && state.audioContext
      ? clamp(state.audioContext.currentTime - state.playback.startedAt, 0, duration)
      : clamp(state.playback.offset, 0, duration);
    elements.timeReadout.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
  }

  function tickPlayback() {
    refreshTimeReadout();
    drawWaveform();
    if (state.playback.isPlaying) {
      state.playback.rafId = window.requestAnimationFrame(tickPlayback);
    }
  }

  function stopPlayback(resetOffset) {
    if (state.playback.source) {
      state.playback.source.onended = null;
      try {
        state.playback.source.stop();
      } catch (error) {
        // Source may already be stopped.
      }
      try {
        state.playback.source.disconnect();
      } catch (error) {
        // Source may already be disconnected.
      }
    }
    if (state.playback.gainNode) {
      try {
        state.playback.gainNode.disconnect();
      } catch (error) {
        // Gain node may already be disconnected.
      }
    }
    if (state.playback.rafId) {
      window.cancelAnimationFrame(state.playback.rafId);
    }
    state.playback.source = null;
    state.playback.gainNode = null;
    state.playback.previewNodes = null;
    state.playback.isPlaying = false;
    if (resetOffset) {
      state.playback.offset = 0;
    }
    elements.playPause.textContent = "再生";
    refreshTimeReadout();
    drawWaveform();
  }

  async function startPlayback() {
    const buffer = getPlaybackSourceBuffer();
    if (!buffer) {
      return;
    }
    const context = getAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }
    stopPlayback(false);
    const source = context.createBufferSource();
    source.buffer = buffer;
    if (state.displayMode === "after") {
      connectRealtimePreviewGraph(context, source);
    } else {
      const gainNode = context.createGain();
      gainNode.gain.value = getPlaybackGain();
      source.connect(gainNode).connect(context.destination);
      state.playback.gainNode = gainNode;
    }
    const offset = clamp(state.playback.offset, 0, Math.max(0, buffer.duration - 0.01));
    source.start(0, offset);
    state.playback.source = source;
    state.playback.startedAt = context.currentTime - offset;
    state.playback.isPlaying = true;
    elements.playPause.textContent = "一時停止";
    attachPlaybackEndedHandler(source);
    tickPlayback();
  }

  function attachPlaybackEndedHandler(source) {
    source.onended = () => {
      if (!state.playback.isPlaying) {
        return;
      }
      state.playback.offset = 0;
      stopPlayback(false);
    };
  }

  function crossfadePlaybackToBuffer(buffer, offset) {
    if (!buffer || !state.audioContext || !state.playback.isPlaying) {
      return false;
    }
    const context = state.audioContext;
    const oldSource = state.playback.source;
    const oldGain = state.playback.gainNode;
    if (!oldSource || !oldGain) {
      return false;
    }
    const safeOffset = clamp(offset, 0, Math.max(0, buffer.duration - 0.01));
    const now = context.currentTime;
    const fadeEnd = now + PLAYBACK_CROSSFADE_SECONDS;
    const source = context.createBufferSource();
    const gainNode = context.createGain();
    source.buffer = buffer;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(getPlaybackGain(), fadeEnd);
    source.connect(gainNode).connect(context.destination);

    oldSource.onended = null;
    oldGain.gain.cancelScheduledValues(now);
    oldGain.gain.setValueAtTime(oldGain.gain.value, now);
    oldGain.gain.linearRampToValueAtTime(0, fadeEnd);
    source.start(now, safeOffset);
    try {
      oldSource.stop(fadeEnd + 0.02);
    } catch (error) {
      // Source may already be stopped.
    }

    state.playback.source = source;
    state.playback.gainNode = gainNode;
    state.playback.startedAt = now - safeOffset;
    state.playback.offset = safeOffset;
    state.playback.isPlaying = true;
    elements.playPause.textContent = "一時停止";
    attachPlaybackEndedHandler(source);
    return true;
  }

  function pausePlayback() {
    if (!state.playback.isPlaying || !state.audioContext) {
      return;
    }
    const buffer = getCurrentBuffer();
    state.playback.offset = clamp(state.audioContext.currentTime - state.playback.startedAt, 0, buffer ? buffer.duration : 0);
    stopPlayback(false);
  }

  function switchMode(mode) {
    if (!state.originalBuffer) {
      return;
    }
    const wasPlaying = state.playback.isPlaying;
    if (wasPlaying && state.audioContext) {
      const buffer = getCurrentBuffer();
      state.playback.offset = clamp(state.audioContext.currentTime - state.playback.startedAt, 0, buffer ? buffer.duration : 0);
    }
    stopPlayback(false);
    state.displayMode = mode;
    updateModeButtons();
    updateMeters();
    drawWaveform();
    if (wasPlaying) {
      startPlayback();
    }
  }

  async function loadAudioFile(file) {
    if (!file) {
      return;
    }
    setStatus("読み込み中");
    window.clearTimeout(state.processTimer);
    state.processVersion += 1;
    state.needsProcess = true;
    state.isProcessing = true;
    updateBackendUi();
    stopPlayback(true);
    const context = getAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    state.fileName = file.name;
    state.originalBuffer = decoded;
    state.processedBuffer = null;
    state.waveformCache.before = null;
    state.waveformCache.after = null;
    state.originalAnalysis = analyzeBuffer(decoded);
    state.processedAnalysis = null;
    state.spectrum = computeSpectrum(decoded);
    state.displayMode = "before";
    state.playback.offset = 0;
    state.selectedPreset = "balanced";
    state.needsProcess = true;
    clearPreciseReadout("新しい音源を読み込みました。After生成後に精密解析できます。");

    renderFileSummary(file, decoded);
    setEnabled(true);
    updateModeButtons();
    updateMeters();
    drawWaveform();
    drawSpectrum();
    updateBackendUi();
    state.processVersion += 1;
    processMaster(state.processVersion);
  }

  function setSliderValue(key, value) {
    state.settings[key] = Number(value);
    elements[key].value = state.settings[key];
    elements[`${key}Value`].textContent = String(state.settings[key]);
  }

  function setBaseSliderValue(key, value) {
    state.settings[key] = Number(value);
    elements[key].value = state.settings[key];
    elements[`${key}Value`].textContent = formatBaseControlValue(key, state.settings[key]);
  }

  function resetBaseControls() {
    state.selectedPreset = "";
    BASE_CONTROL_KEYS.forEach((key) => {
      setBaseSliderValue(key, DEFAULT_BASE_SETTINGS[key]);
    });
    updatePresetButtons();
    scheduleProcess();
  }

  function applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) {
      return;
    }
    state.selectedPreset = name;
    state.settings.baseClean = preset.baseClean !== false;
    elements.baseClean.checked = state.settings.baseClean;
    state.settings.target = preset.target || "streaming";
    BASE_CONTROL_KEYS.forEach((key) => {
      setBaseSliderValue(key, preset[key] ?? DEFAULT_BASE_SETTINGS[key]);
    });
    TONE_CONTROL_KEYS.forEach((key) => {
      setSliderValue(key, preset[key] ?? 0);
    });
    updateBaseControlAvailability();
    updateTargetButtons();
    updatePresetButtons();
    scheduleProcess();
  }

  function resetToneControls() {
    state.selectedPreset = "";
    TONE_CONTROL_KEYS.forEach((key) => {
      setSliderValue(key, 0);
    });
    updatePresetButtons();
    scheduleProcess();
  }

  function seekFromCanvas(event) {
    const buffer = getCurrentBuffer();
    if (!buffer) {
      return;
    }
    const rect = elements.waveformCanvas.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    state.playback.offset = ratio * buffer.duration;
    const wasPlaying = state.playback.isPlaying;
    stopPlayback(false);
    if (wasPlaying) {
      startPlayback();
    } else {
      refreshTimeReadout();
      drawWaveform();
    }
  }

  function audioBufferToWav(buffer, bitDepth) {
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = bitDepth === 24 ? 3 : 2;
    const blockAlign = channels * bytesPerSample;
    const dataLength = buffer.length * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(arrayBuffer);
    let offset = 0;

    function writeString(value) {
      for (let i = 0; i < value.length; i += 1) {
        view.setUint8(offset, value.charCodeAt(i));
        offset += 1;
      }
    }

    writeString("RIFF");
    view.setUint32(offset, 36 + dataLength, true); offset += 4;
    writeString("WAVE");
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, channels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * blockAlign, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, bitDepth, true); offset += 2;
    writeString("data");
    view.setUint32(offset, dataLength, true); offset += 4;

    const channelData = copyBufferChannels(buffer);
    for (let i = 0; i < buffer.length; i += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = clamp(channelData[channel][i], -1, 1);
        if (bitDepth === 24) {
          let intSample = sample < 0 ? sample * 0x800000 : sample * 0x7fffff;
          intSample = Math.round(intSample);
          view.setUint8(offset, intSample & 0xff); offset += 1;
          view.setUint8(offset, (intSample >> 8) & 0xff); offset += 1;
          view.setUint8(offset, (intSample >> 16) & 0xff); offset += 1;
        } else {
          const intSample = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
          view.setInt16(offset, intSample, true); offset += 2;
        }
      }
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  function getWavFileName() {
    const bitDepth = Number(elements.bitDepth.value);
    const target = TARGETS[state.settings.target].label.toLowerCase();
    return `${sanitizeFileBase(state.fileName)}-${target}-master-${bitDepth}bit.wav`;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportBrowserWav() {
    if (!canExportCurrent()) {
      return;
    }
    const bitDepth = Number(elements.bitDepth.value);
    const blob = audioBufferToWav(state.processedBuffer, bitDepth);
    downloadBlob(blob, getWavFileName());
    setStatus("書き出し完了");
  }

  async function exportWav() {
    if (!canExportCurrent()) {
      return;
    }
    if (canUsePreciseBackend()) {
      await exportFinalized("wav");
      return;
    }
    exportBrowserWav();
  }

  function getProcessedWavBlob() {
    if (!state.processedBuffer) {
      return null;
    }
    return audioBufferToWav(state.processedBuffer, 24);
  }

  function getMp3FileName() {
    const target = TARGETS[state.settings.target].label.toLowerCase();
    return `${sanitizeFileBase(state.fileName)}-${target}-copy-320k.mp3`;
  }

  function updatePreciseFieldsFromHeaders(response) {
    const lufs = Number(response.headers.get("X-SMB-LUFS"));
    const truePeak = Number(response.headers.get("X-SMB-TRUE-PEAK"));
    const lra = Number(response.headers.get("X-SMB-LRA"));
    if (Number.isFinite(lufs)) {
      elements.preciseLufs.textContent = formatLufs(lufs);
    }
    if (Number.isFinite(truePeak)) {
      elements.preciseTruePeak.textContent = formatDb(truePeak);
    }
    if (Number.isFinite(lra)) {
      elements.preciseLra.textContent = formatLu(lra);
    }
    if (Number.isFinite(lufs) || Number.isFinite(truePeak)) {
      state.backend.message = `精密仕上げ後: ${formatLufs(lufs)} LUFS / ${formatDb(truePeak)} TP`;
      elements.backendNote.textContent = state.backend.message;
    }
    return { lufs, truePeak, lra };
  }

  function getFinalizeWarning(format, values) {
    const targetLufs = TARGETS[state.settings.target].lufs;
    const warnings = [];
    if (!Number.isFinite(values.lufs) || !Number.isFinite(values.truePeak)) {
      warnings.push("書き出し後の精密値を取得できませんでした。");
    } else {
      if (Math.abs(values.lufs - targetLufs) > 0.7) {
        warnings.push(`目標LUFSから${Math.abs(values.lufs - targetLufs).toFixed(1)}LUずれています。`);
      }
      if (values.truePeak > -1) {
        warnings.push("True Peakが-1.0dBTPを超えています。");
      }
    }
    if (format === "mp3") {
      warnings.push("MP3は圧縮コピーです。保存用マスターはWAVを使ってください。");
    }
    return warnings.join(" ");
  }

  async function exportFinalized(format) {
    const blob = getProcessedWavBlob();
    if (!blob) {
      return;
    }
    const isMp3 = format === "mp3";
    state.isExporting = true;
    setStatus(isMp3 ? "MP3精密仕上げ中" : "WAV精密仕上げ中");
    elements.exportWav.disabled = true;
    elements.exportMp3.disabled = true;
    updateBackendUi();
    const formData = new FormData();
    formData.append("audio", blob, "after-master.wav");
    formData.append("format", format);
    formData.append("name", isMp3 ? getMp3FileName() : getWavFileName());
    formData.append("bitDepth", elements.bitDepth.value);
    formData.append("targetI", String(TARGETS[state.settings.target].lufs));
    formData.append("targetTP", "-1");
    formData.append("targetLRA", "11");
    try {
      const response = await fetch(`${state.backend.url}/api/finalize`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        let message = "精密仕上げに失敗しました。";
        try {
          const payload = await response.json();
          message = payload.error || message;
        } catch (error) {
          // Non-JSON error responses fall back to the generic message.
        }
        throw new Error(message);
      }
      const finalizedBlob = await response.blob();
      const values = updatePreciseFieldsFromHeaders(response);
      downloadBlob(finalizedBlob, isMp3 ? getMp3FileName() : getWavFileName());
      const warning = getFinalizeWarning(format, values);
      if (warning) {
        state.backend.message = warning;
        elements.backendNote.textContent = state.backend.message;
      } else {
        state.backend.message = `精密仕上げ後: ${formatLufs(values.lufs)} LUFS / ${formatDb(values.truePeak)} TP`;
        elements.backendNote.textContent = state.backend.message;
      }
      setStatus(isMp3 ? "MP3精密仕上げ完了" : "WAV精密仕上げ完了");
    } catch (error) {
      state.backend.message = error.message || "精密仕上げに失敗しました。";
      elements.backendNote.textContent = state.backend.message;
      setStatus("精密仕上げ失敗");
    } finally {
      state.isExporting = false;
      elements.exportWav.disabled = !canExportCurrent();
      updateBackendUi();
      updateMeters();
    }
  }

  async function analyzeWithBackend() {
    if (!canExportCurrent()) {
      return;
    }
    const blob = getProcessedWavBlob();
    if (!blob) {
      return;
    }
    setStatus("精密解析中");
    state.isAnalyzing = true;
    elements.preciseAnalyze.disabled = true;
    updateBackendUi();
    const formData = new FormData();
    formData.append("audio", blob, "after-master.wav");
    formData.append("targetI", String(TARGETS[state.settings.target].lufs));
    formData.append("targetTP", "-1");
    formData.append("targetLRA", "11");
    try {
      const response = await fetch(`${state.backend.url}/api/analyze`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "精密解析に失敗しました。");
      }
      const analysis = payload.analysis;
      elements.preciseLufs.textContent = formatLufs(analysis.input_i);
      elements.preciseTruePeak.textContent = formatDb(analysis.input_tp);
      elements.preciseLra.textContent = formatLu(analysis.input_lra);
      state.backend.message = "ffmpeg loudnormでAfter音源を解析しました。";
      elements.backendNote.textContent = state.backend.message;
      setStatus("精密解析完了");
    } catch (error) {
      state.backend.message = error.message || "精密解析に失敗しました。";
      elements.backendNote.textContent = state.backend.message;
      setStatus("精密解析失敗");
    } finally {
      state.isAnalyzing = false;
      updateBackendUi();
    }
  }

  async function exportMp3() {
    if (!canUsePreciseBackend()) {
      return;
    }
    await exportFinalized("mp3");
  }

  function wireEvents() {
    elements.fileInput.addEventListener("change", (event) => {
      const file = event.target.files[0];
      loadAudioFile(file).catch((error) => handleLoadFailure(error, file));
    });

    ["dragenter", "dragover"].forEach((type) => {
      elements.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragging");
      });
    });

    ["dragleave", "drop"].forEach((type) => {
      elements.dropZone.addEventListener(type, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragging");
      });
    });

    elements.dropZone.addEventListener("drop", (event) => {
      const file = event.dataTransfer.files[0];
      loadAudioFile(file).catch((error) => handleLoadFailure(error, file));
    });

    elements.playPause.addEventListener("click", () => {
      if (state.playback.isPlaying) {
        pausePlayback();
      } else {
        startPlayback();
      }
    });
    elements.stopPlayback.addEventListener("click", () => stopPlayback(true));
    elements.beforeMode.addEventListener("click", () => switchMode("before"));
    elements.afterMode.addEventListener("click", () => switchMode("after"));
    elements.levelMatch.addEventListener("change", () => {
      if (state.playback.previewNodes) {
        updateRealtimePreview(false);
      } else if (state.playback.gainNode) {
        state.playback.gainNode.gain.value = getPlaybackGain();
      }
    });
    elements.waveformCanvas.addEventListener("click", seekFromCanvas);
    elements.exportWav.addEventListener("click", exportWav);
    elements.recheckBackend.addEventListener("click", () => {
      state.backend.checked = false;
      updateBackendUi();
      checkBackend();
    });
    elements.preciseAnalyze.addEventListener("click", analyzeWithBackend);
    elements.exportMp3.addEventListener("click", exportMp3);
    elements.baseClean.addEventListener("change", () => {
      state.selectedPreset = "";
      state.settings.baseClean = elements.baseClean.checked;
      updateBaseControlAvailability();
      updatePresetButtons();
      scheduleProcess();
    });
    elements.resetBaseControls.addEventListener("click", resetBaseControls);
    elements.resetControls.addEventListener("click", resetToneControls);

    document.querySelectorAll(".target-button").forEach((button) => {
      button.addEventListener("click", () => {
        state.settings.target = button.dataset.target;
        state.selectedPreset = "";
        updateTargetButtons();
        updatePresetButtons();
        scheduleProcess();
      });
    });

    document.querySelectorAll(".preset-strip button").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.dataset.preset));
    });

    TONE_CONTROL_KEYS.forEach((key) => {
      elements[key].addEventListener("input", () => {
        state.selectedPreset = "";
        setSliderValue(key, elements[key].value);
        updatePresetButtons();
        scheduleProcess();
      });
    });

    BASE_CONTROL_KEYS.forEach((key) => {
      elements[key].addEventListener("input", () => {
        state.selectedPreset = "";
        setBaseSliderValue(key, elements[key].value);
        updatePresetButtons();
        scheduleProcess();
      });
    });

    elements.bitDepth.addEventListener("change", updateMeters);
    window.addEventListener("resize", () => {
      drawWaveform();
      drawSpectrum();
    });
  }

  function initElements() {
    [
      "appStatus",
      "dropZone",
      "fileInput",
      "fileSummary",
      "fileWarning",
      "processBanner",
      "processMessage",
      "waveformCanvas",
      "spectrumCanvas",
      "playPause",
      "stopPlayback",
      "beforeMode",
      "afterMode",
      "levelMatch",
      "timeReadout",
      "lufsValue",
      "peakValue",
      "truePeakValue",
      "stereoValue",
      "signalFlags",
      "baseClean",
      "resetBaseControls",
      "baseLowCutHz",
      "baseLowCutHzValue",
      "baseMudHz",
      "baseMudHzValue",
      "baseMudDb",
      "baseMudDbValue",
      "baseHarshHz",
      "baseHarshHzValue",
      "baseHarshDb",
      "baseHarshDbValue",
      "baseArtifactAmount",
      "baseArtifactAmountValue",
      "baseLowMonoHz",
      "baseLowMonoHzValue",
      "baseLowMonoAmount",
      "baseLowMonoAmountValue",
      "resetControls",
      "brightness",
      "body",
      "impact",
      "width",
      "smoothness",
      "brightnessValue",
      "bodyValue",
      "impactValue",
      "widthValue",
      "smoothnessValue",
      "beforeLufs",
      "afterLufs",
      "shortTermLufs",
      "crestValue",
      "bitDepth",
      "exportWav",
      "exportNote",
      "backendStatus",
      "backendNote",
      "recheckBackend",
      "preciseAnalyze",
      "exportMp3",
      "preciseLufs",
      "preciseTruePeak",
      "preciseLra",
    ].forEach((id) => {
      elements[id] = $(id);
    });
  }

  function init() {
    initElements();
    setEnabled(false);
    updateSliderOutputs();
    updateTargetButtons();
    updatePresetButtons();
    updateModeButtons();
    updateMeters();
    drawWaveform();
    drawSpectrum();
    wireEvents();
    checkBackend();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

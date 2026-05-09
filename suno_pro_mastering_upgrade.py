#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Suno Mastering Bench - Pro preset/adaptive mastering upgrade patcher

Usage:
  python suno_pro_mastering_upgrade.py /path/to/suno-mastering-mvp

What it changes:
  - Replaces the preset table with stronger, purpose-based mastering presets.
  - Adds track-dependent adaptive mastering analysis to app.js.
  - Uses adaptive settings in realtime preview and offline processing where the current code reads state.settings.
  - Strengthens existing high-frequency artifact control, compression, and soft clipping ranges.
  - Adds a small UI readout that explains what the preset/auto analysis changed.
  - Creates *.bak-pro-mastering backups before writing.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import shutil
from typing import Dict, Tuple


MARKER = "PRO_MASTERING_UPGRADE_V1"


PRESETS_BLOCK = r"""  const PRESETS = {
    balanced: {
      label: "Clean Streaming Master",
      goal: "自然に整えて配信向けに完成させる標準マスター",
      target: "streaming",
      baseArtifactAmount: 42,
      baseMudDb: 1.1,
      baseHarshDb: 1.2,
      brightness: 4,
      body: 4,
      impact: 12,
      width: 3,
      smoothness: 20,
    },
    aiClean: {
      label: "AI Artifact Rescue",
      goal: "Suno/AI音源のザラつき・刺さり・不自然な高域を抑える",
      target: "streaming",
      baseArtifactAmount: 74,
      baseHarshHz: 4100,
      baseHarshDb: 2.0,
      baseMudDb: 1.2,
      brightness: -6,
      body: 2,
      impact: 4,
      width: -2,
      smoothness: 56,
    },
    vocalForward: {
      label: "Vocal Forward Master",
      goal: "歌を前に出しつつ、刺さりと広がりすぎを抑える",
      target: "streaming",
      baseArtifactAmount: 48,
      baseHarshHz: 3600,
      baseHarshDb: 1.6,
      brightness: 8,
      body: -2,
      impact: 16,
      width: -8,
      smoothness: 28,
    },
    warm: {
      label: "Warm Ballad Master",
      goal: "柔らかく温かい、長時間聴ける仕上げ",
      target: "natural",
      baseArtifactAmount: 56,
      baseMudDb: 1.3,
      baseHarshDb: 1.5,
      brightness: -15,
      body: 26,
      impact: 0,
      width: -2,
      smoothness: 36,
    },
    bright: {
      label: "Bright Pop Master",
      goal: "明るさと抜けを作るが、AIっぽい高域は自動で抑える",
      target: "streaming",
      baseArtifactAmount: 36,
      baseHarshDb: 1.3,
      brightness: 28,
      body: -6,
      impact: 12,
      width: 8,
      smoothness: 22,
    },
    soft: {
      label: "Soft Gentle Master",
      goal: "耳に優しく、刺激の少ない仕上げ",
      target: "natural",
      baseArtifactAmount: 64,
      baseHarshDb: 2.1,
      brightness: -8,
      body: 6,
      impact: -18,
      width: 0,
      smoothness: 62,
    },
    loud: {
      label: "Loud Modern Master",
      goal: "音圧感を上げる。潰れすぎる曲は自動で保護する",
      target: "loud",
      baseArtifactAmount: 42,
      baseMudDb: 1.2,
      baseHarshDb: 1.5,
      brightness: 10,
      body: 6,
      impact: 54,
      width: 2,
      smoothness: 24,
    },
    wide: {
      label: "Wide Cinematic Master",
      goal: "広がりを出す。低域の左右ブレは自動で中央へ寄せる",
      target: "streaming",
      baseArtifactAmount: 40,
      baseLowMonoHz: 150,
      baseLowMonoAmount: 100,
      brightness: 5,
      body: -4,
      impact: 8,
      width: 46,
      smoothness: 22,
    },
    bassRich: {
      label: "Bass Rich Master",
      goal: "低域を太くする。膨らみすぎる曲は自動で整理する",
      target: "streaming",
      baseMudDb: 1.4,
      baseLowMonoHz: 135,
      baseLowMonoAmount: 100,
      brightness: -6,
      body: 34,
      impact: 8,
      width: -2,
      smoothness: 24,
    },
    thinFix: {
      label: "Thin Fix Master",
      goal: "薄いAI音源に厚みと安定感を足す",
      target: "streaming",
      baseMudDb: 1.0,
      brightness: -6,
      body: 42,
      impact: 4,
      width: -4,
      smoothness: 26,
    },
    punch: {
      label: "Punchy Pop/Rock Master",
      goal: "キック・スネア・前ノリ感を強める",
      target: "streaming",
      baseArtifactAmount: 36,
      baseMudDb: 1.2,
      brightness: 6,
      body: 10,
      impact: 46,
      width: 0,
      smoothness: 20,
    },
    night: {
      label: "Night Safe Master",
      goal: "夜でも聴きやすい、刺さらない控えめマスター",
      target: "natural",
      baseArtifactAmount: 70,
      baseHarshDb: 2.2,
      brightness: -18,
      body: 10,
      impact: -24,
      width: -6,
      smoothness: 70,
    },
    sns: {
      label: "Loud SNS Master",
      goal: "Shorts/TikTok向けに前へ出る音圧。高域は自動保護する",
      target: "loud",
      baseArtifactAmount: 48,
      baseMudDb: 1.2,
      brightness: 16,
      body: 6,
      impact: 52,
      width: 10,
      smoothness: 26,
    },
    natural: {
      label: "Natural Preserve Master",
      goal: "元音源の雰囲気を残して、軽く整える",
      target: "natural",
      baseArtifactAmount: 36,
      baseHarshDb: 1.1,
      brightness: 0,
      body: 6,
      impact: -8,
      width: 0,
      smoothness: 18,
    },
  };"""


ADAPTIVE_HELPERS = r"""
  const PRO_MASTERING_UPGRADE_VERSION = "PRO_MASTERING_UPGRADE_V1";

  const ADAPTIVE_LIMITS = {
    baseLowCutHz: [18, 45],
    baseMudHz: [160, 320],
    baseMudDb: [0, 3],
    baseHarshHz: [2500, 5200],
    baseHarshDb: [0, 3],
    baseArtifactAmount: [0, 100],
    baseLowMonoHz: [80, 190],
    baseLowMonoAmount: [0, 100],
    brightness: [-100, 100],
    body: [-100, 100],
    impact: [-100, 100],
    width: [-100, 100],
    smoothness: [-100, 100],
  };

  const PRESET_ADAPTIVE_WEIGHTS = {
    balanced: { highTame: 1.0, aiTame: 1.0, smooth: 1.0, impactLift: 5 },
    aiClean: { highTame: 1.55, aiTame: 1.65, smooth: 1.45, impactLift: 0 },
    vocalForward: { highTame: 1.15, aiTame: 1.15, smooth: 1.1, impactLift: 4 },
    warm: { highTame: 1.2, aiTame: 1.25, smooth: 1.2, impactLift: 1 },
    bright: { highTame: 0.8, aiTame: 0.9, smooth: 0.75, impactLift: 4 },
    soft: { highTame: 1.45, aiTame: 1.4, smooth: 1.5, impactLift: 0 },
    loud: { highTame: 0.95, aiTame: 1.0, smooth: 0.85, impactLift: 11 },
    wide: { highTame: 1.0, aiTame: 1.0, smooth: 0.95, impactLift: 3 },
    bassRich: { highTame: 1.0, aiTame: 1.0, smooth: 1.0, impactLift: 3 },
    thinFix: { highTame: 1.0, aiTame: 1.0, smooth: 1.05, impactLift: 2 },
    punch: { highTame: 0.95, aiTame: 0.95, smooth: 0.85, impactLift: 10 },
    night: { highTame: 1.6, aiTame: 1.55, smooth: 1.65, impactLift: 0 },
    sns: { highTame: 1.05, aiTame: 1.1, smooth: 0.95, impactLift: 10 },
    natural: { highTame: 1.0, aiTame: 1.0, smooth: 1.0, impactLift: 0 },
  };

  function clampSetting(key, value) {
    const limits = ADAPTIVE_LIMITS[key];
    if (!limits || !Number.isFinite(value)) {
      return value;
    }
    return clamp(value, limits[0], limits[1]);
  }

  function rmsArray(data) {
    if (!data || data.length === 0) {
      return 0;
    }
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / data.length);
  }

  function peakArray(data) {
    let peak = 0;
    for (let i = 0; i < data.length; i += 1) {
      const abs = Math.abs(data[i]);
      if (abs > peak) {
        peak = abs;
      }
    }
    return peak;
  }

  function subtractArrays(a, b) {
    const length = Math.min(a.length, b.length);
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = a[i] - b[i];
    }
    return out;
  }

  function filterCopy(data, sampleRate, type, frequency, q = 0.7) {
    const nyquistSafe = Math.max(20, Math.min(frequency, sampleRate * 0.46));
    const out = new Float32Array(data);
    applyBiquad(out, makeBiquad(type, nyquistSafe, q, 0, sampleRate));
    return out;
  }

  function createAnalysisMono(buffer) {
    const channelCount = buffer.numberOfChannels;
    const sourceLength = buffer.length;
    const stride = Math.max(1, Math.floor(buffer.sampleRate / 24000));
    const maxSourceLength = Math.min(sourceLength, Math.floor(buffer.sampleRate * 240));
    const outLength = Math.max(1, Math.floor(maxSourceLength / stride));
    const data = new Float32Array(outLength);

    for (let i = 0; i < outLength; i += 1) {
      const index = Math.min(sourceLength - 1, i * stride);
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        sum += buffer.getChannelData(channel)[index] || 0;
      }
      data[i] = sum / channelCount;
    }

    return {
      data,
      sampleRate: buffer.sampleRate / stride,
      stride,
    };
  }

  function createAnalysisStereo(buffer, stride, maxFrames) {
    if (buffer.numberOfChannels < 2) {
      return null;
    }
    const leftSource = buffer.getChannelData(0);
    const rightSource = buffer.getChannelData(1);
    const outLength = Math.max(1, Math.floor(maxFrames / stride));
    const mid = new Float32Array(outLength);
    const side = new Float32Array(outLength);

    for (let i = 0; i < outLength; i += 1) {
      const index = Math.min(buffer.length - 1, i * stride);
      const left = leftSource[index] || 0;
      const right = rightSource[index] || 0;
      mid[i] = (left + right) * 0.5;
      side[i] = (left - right) * 0.5;
    }

    return { mid, side };
  }

  function analyzeAdaptiveProfile(buffer) {
    if (!buffer || buffer.length === 0) {
      return null;
    }

    const monoInfo = createAnalysisMono(buffer);
    const mono = monoInfo.data;
    const sampleRate = monoInfo.sampleRate;
    const fullRms = Math.max(rmsArray(mono), 1e-8);
    const peak = Math.max(peakArray(mono), 1e-8);

    const low = filterCopy(mono, sampleRate, "lowpass", 140, 0.7);
    const low160 = filterCopy(mono, sampleRate, "lowpass", 160, 0.7);
    const low360 = filterCopy(mono, sampleRate, "lowpass", 360, 0.7);
    const mud = subtractArrays(low360, low160);

    const high2500 = filterCopy(mono, sampleRate, "highpass", 2500, 0.7);
    const high6500 = filterCopy(high2500, sampleRate, "lowpass", 6500, 0.7);
    const sibilanceBase = filterCopy(mono, sampleRate, "highpass", 5500, 0.7);
    const sibilance = filterCopy(sibilanceBase, sampleRate, "lowpass", 9500, 0.7);
    const air = filterCopy(mono, sampleRate, "highpass", 9000, 0.7);

    const maxFrames = Math.min(buffer.length, Math.floor(buffer.sampleRate * 240));
    const stereo = createAnalysisStereo(buffer, monoInfo.stride, maxFrames);
    let sideRatio = 0;
    let lowSideRatio = 0;
    if (stereo) {
      const midRms = Math.max(rmsArray(stereo.mid), 1e-8);
      const sideRms = rmsArray(stereo.side);
      const sideLow = filterCopy(stereo.side, sampleRate, "lowpass", 160, 0.7);
      sideRatio = sideRms / midRms;
      lowSideRatio = rmsArray(sideLow) / midRms;
    }

    return {
      lowRatio: rmsArray(low) / fullRms,
      mudRatio: rmsArray(mud) / fullRms,
      harshRatio: rmsArray(high6500) / fullRms,
      sibilanceRatio: rmsArray(sibilance) / fullRms,
      airRatio: rmsArray(air) / fullRms,
      crestDb: ampToDb(peak / fullRms),
      sideRatio,
      lowSideRatio,
    };
  }

  function getAdaptiveProfile() {
    if (!state.originalBuffer) {
      return null;
    }
    if (state.adaptiveProfile && state.adaptiveProfileBuffer === state.originalBuffer) {
      return state.adaptiveProfile;
    }

    try {
      state.adaptiveProfile = analyzeAdaptiveProfile(state.originalBuffer);
      state.adaptiveProfileBuffer = state.originalBuffer;
    } catch (error) {
      console.warn("Adaptive mastering analysis failed:", error);
      state.adaptiveProfile = null;
      state.adaptiveProfileBuffer = state.originalBuffer;
    }

    return state.adaptiveProfile;
  }

  function addDelta(delta, key, amount) {
    if (!Number.isFinite(amount) || amount === 0) {
      return;
    }
    delta[key] = (delta[key] || 0) + amount;
  }

  function createAdaptiveDelta(profile, presetKey) {
    const weights = PRESET_ADAPTIVE_WEIGHTS[presetKey] || PRESET_ADAPTIVE_WEIGHTS.balanced;
    const delta = {};

    const lowThin = clamp((0.18 - profile.lowRatio) / 0.09, 0, 1);
    const lowBoom = clamp((profile.lowRatio - 0.34) / 0.18, 0, 1);
    const muddy = clamp((profile.mudRatio - 0.17) / 0.16, 0, 1);
    const harsh = clamp((profile.harshRatio - 0.24) / 0.20, 0, 1);
    const sibilant = clamp((profile.sibilanceRatio - 0.15) / 0.15, 0, 1);
    const airyButSharp = clamp((profile.airRatio - 0.075) / 0.09, 0, 1);
    const crushed = clamp((8.5 - profile.crestDb) / 4.5, 0, 1);
    const dynamicRoom = clamp((profile.crestDb - 12.5) / 5.5, 0, 1);
    const tooWide = clamp((profile.sideRatio - 0.72) / 0.42, 0, 1);
    const lowWide = clamp((profile.lowSideRatio - 0.18) / 0.22, 0, 1);

    addDelta(delta, "body", lowThin * 14 - lowBoom * 18);
    addDelta(delta, "baseMudDb", muddy * 0.85 + lowBoom * 0.45);
    addDelta(delta, "baseLowCutHz", lowBoom * 5);
    addDelta(delta, "baseHarshDb", (harsh * 0.75 + sibilant * 0.95 + airyButSharp * 0.35) * weights.highTame);
    addDelta(delta, "baseArtifactAmount", (harsh * 16 + sibilant * 24 + airyButSharp * 12) * weights.aiTame);
    addDelta(delta, "smoothness", (harsh * 15 + sibilant * 20 + airyButSharp * 10) * weights.smooth);
    addDelta(delta, "brightness", -(harsh * 7 + sibilant * 9 + airyButSharp * 5) * weights.highTame);
    addDelta(delta, "impact", dynamicRoom * weights.impactLift - crushed * 22);
    addDelta(delta, "width", -(tooWide * 14 + lowWide * 10));
    addDelta(delta, "baseLowMonoAmount", lowWide * 24);
    addDelta(delta, "baseLowMonoHz", lowWide * 18);

    if (presetKey === "bright" && !harsh && !sibilant) {
      addDelta(delta, "brightness", 3);
    }
    if (presetKey === "aiClean" || presetKey === "night") {
      addDelta(delta, "baseHarshDb", 0.15);
      addDelta(delta, "smoothness", 4);
    }
    if ((presetKey === "loud" || presetKey === "sns") && crushed > 0.3) {
      addDelta(delta, "smoothness", 6);
      addDelta(delta, "baseArtifactAmount", 6);
    }

    return delta;
  }

  function applyAdaptiveDelta(settings, delta) {
    const effective = { ...settings };
    Object.keys(delta).forEach((key) => {
      if (typeof effective[key] === "number") {
        effective[key] = clampSetting(key, effective[key] + delta[key]);
      }
    });
    return effective;
  }

  function formatSigned(value, decimals = 0) {
    if (!Number.isFinite(value) || Math.abs(value) < 0.05) {
      return "±0";
    }
    const fixed = Number(value).toFixed(decimals);
    return value > 0 ? `+${fixed}` : fixed;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateAdaptiveReadout(profile, delta, effective) {
    const node = document.getElementById("masteringCoach");
    if (!node) {
      return;
    }

    if (!profile || !delta || !effective) {
      node.textContent = "音源を読み込むと、曲に合わせた自動補正の内容を表示します。";
      return;
    }

    const preset = PRESETS[state.selectedPreset] || {};
    const items = [];
    if ((delta.baseArtifactAmount || 0) > 7 || (delta.smoothness || 0) > 6) {
      items.push(`AI高域 ${formatSigned(delta.baseArtifactAmount || 0)}% / なめらかさ ${formatSigned(delta.smoothness || 0)}`);
    }
    if ((delta.baseMudDb || 0) > 0.18) {
      items.push(`濁り整理 ${formatSigned(delta.baseMudDb || 0, 1)}dB`);
    }
    if (Math.abs(delta.body || 0) > 5) {
      items.push(`太さ ${formatSigned(delta.body || 0)}`);
    }
    if (Math.abs(delta.impact || 0) > 5) {
      items.push(`迫力 ${formatSigned(delta.impact || 0)}`);
    }
    if (Math.abs(delta.width || 0) > 5) {
      items.push(`広がり ${formatSigned(delta.width || 0)}`);
    }
    if ((delta.baseLowMonoAmount || 0) > 6) {
      items.push(`低域センター ${formatSigned(delta.baseLowMonoAmount || 0)}%`);
    }

    if (items.length === 0) {
      items.push("曲のバランス良好：主に音量・軽いEQ・安全リミットを適用");
    }

    const signature = `${state.selectedPreset}|${items.join("|")}|${Math.round(profile.crestDb * 10)}`;
    if (node.dataset.signature === signature) {
      return;
    }
    node.dataset.signature = signature;
    node.innerHTML = [
      `<strong>${escapeHtml(preset.label || "Master")}</strong>`,
      `<span>${escapeHtml(preset.goal || "曲に合わせて補正します")}</span>`,
      `<span>自動補正: ${items.map(escapeHtml).join(" / ")}</span>`,
      `<span>Crest ${profile.crestDb.toFixed(1)}dB / Low ${(profile.lowRatio * 100).toFixed(0)}% / Harsh ${(profile.harshRatio * 100).toFixed(0)}%</span>`,
    ].join(" ");
  }

  function getEffectiveSettings() {
    const settings = { ...state.settings };
    const profile = getAdaptiveProfile();
    if (!profile || !settings.baseClean) {
      updateAdaptiveReadout(null, null, null);
      return settings;
    }

    const delta = createAdaptiveDelta(profile, state.selectedPreset);
    const effective = applyAdaptiveDelta(settings, delta);
    updateAdaptiveReadout(profile, delta, effective);
    return effective;
  }
"""


PRESET_BUTTONS = r"""          <div class="preset-strip" aria-label="プリセット">
            <button data-preset="balanced" type="button" disabled>Clean配信</button>
            <button data-preset="aiClean" type="button" disabled>AI Rescue</button>
            <button data-preset="vocalForward" type="button" disabled>歌を前に</button>
            <button data-preset="warm" type="button" disabled>Warm Ballad</button>
            <button data-preset="bright" type="button" disabled>Bright Pop</button>
            <button data-preset="soft" type="button" disabled>Soft Gentle</button>
            <button data-preset="loud" type="button" disabled>Loud Modern</button>
            <button data-preset="wide" type="button" disabled>Wide Cinematic</button>
            <button data-preset="bassRich" type="button" disabled>Bass Rich</button>
            <button data-preset="thinFix" type="button" disabled>Thin Fix</button>
            <button data-preset="punch" type="button" disabled>Punchy Rock</button>
            <button data-preset="night" type="button" disabled>Night Safe</button>
            <button data-preset="sns" type="button" disabled>Loud SNS</button>
            <button data-preset="natural" type="button" disabled>Natural</button>
          </div>"""


CSS_APPEND = r"""
/* PRO_MASTERING_UPGRADE_V1 */
.mastering-coach {
  align-items: flex-start;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  gap: 0.28rem;
  line-height: 1.45;
  margin-top: 0.8rem;
  padding: 0.85rem 1rem;
}

.mastering-coach strong {
  font-size: 0.95rem;
}

.mastering-coach span {
  opacity: 0.86;
}
"""


def backup_file(path: pathlib.Path) -> None:
    backup = path.with_name(path.name + ".bak-pro-mastering")
    if not backup.exists():
        shutil.copy2(path, backup)


def patch_app_js(path: pathlib.Path) -> Tuple[str, list[str]]:
    text = path.read_text(encoding="utf-8")
    notes: list[str] = []

    if MARKER in text:
        notes.append("app.js: already contains upgrade marker; skipped helper insertion and preset replacement.")
        return text, notes

    pattern = r"  const PRESETS = \{[\s\S]*?\n  \};\n\n  const BACKEND_FALLBACK_URL"
    text, count = re.subn(pattern, PRESETS_BLOCK + "\n\n  const BACKEND_FALLBACK_URL", text, count=1)
    if count != 1:
        raise RuntimeError("app.js: could not locate PRESETS block.")
    notes.append("app.js: replaced preset definitions with pro mastering presets.")

    marker = "  function formatTime(seconds) {"
    if marker not in text:
        raise RuntimeError("app.js: could not find formatTime insertion point.")
    text = text.replace(marker, ADAPTIVE_HELPERS + "\n\n" + marker, 1)
    notes.append("app.js: inserted adaptive audio analysis and effective settings helpers.")

    state_marker = "    spectrum: [],\n    displayMode:"
    if state_marker in text:
        text = text.replace(
            state_marker,
            '    spectrum: [],\n'
            '    adaptiveProfile: null,\n'
            '    adaptiveProfileBuffer: null,\n'
            '    lastAdaptiveSignature: "",\n'
            '    displayMode:',
            1,
        )
        notes.append("app.js: added adaptive profile cache to state.")
    else:
        notes.append("app.js: state insertion point not found; adaptive cache will still work only if state accepts dynamic fields.")

    settings_pattern = "    const settings = state.settings;\n"
    settings_replacements = text.count(settings_pattern)
    text = text.replace(settings_pattern, "    const settings = getEffectiveSettings();\n")
    notes.append(f"app.js: routed {settings_replacements} settings reads through getEffectiveSettings().")

    numeric_replacements: Dict[str, str] = {
        "const drive = 1 + Math.max(0, driveValue / 100) * 0.8;":
            "const drive = 1 + Math.max(0, driveValue / 100) * 1.35;",
        "setAudioParam(nodes.artifactShelf.gain, -artifactAmount * 3.4, now, smooth);":
            "setAudioParam(nodes.artifactShelf.gain, -artifactAmount * 5.2, now, smooth);",
        "setAudioParam(nodes.artifactPeak.gain, -artifactAmount * 2.1, now, smooth);":
            "setAudioParam(nodes.artifactPeak.gain, -artifactAmount * 3.8, now, smooth);",
        "setAudioParam(nodes.bodyShelf.gain, body * 3.1, now, smooth);":
            "setAudioParam(nodes.bodyShelf.gain, body * 4.2, now, smooth);",
        "setAudioParam(nodes.bodyPeak.gain, body * 1.05, now, smooth);":
            "setAudioParam(nodes.bodyPeak.gain, body * 1.55, now, smooth);",
        "setAudioParam(nodes.brightShelf.gain, brightness * 3.4, now, smooth);":
            "setAudioParam(nodes.brightShelf.gain, brightness * 4.6, now, smooth);",
        "setAudioParam(nodes.brightPeak.gain, brightness * 0.9 + smoothNegative * 1.2, now, smooth);":
            "setAudioParam(nodes.brightPeak.gain, brightness * 1.2 + smoothNegative * 1.4, now, smooth);",
        "setAudioParam(nodes.smoothPeak.gain, -smoothPositive * 3.2, now, smooth);":
            "setAudioParam(nodes.smoothPeak.gain, -smoothPositive * 4.6, now, smooth);",
        "setAudioParam(nodes.compressor.threshold, -18 - impactPositive * 8 + impactNegative * 7, now, smooth);":
            "setAudioParam(nodes.compressor.threshold, -20 - impactPositive * 13 + impactNegative * 8, now, smooth);",
        "setAudioParam(nodes.compressor.ratio, clamp(1.25 + impactPositive * 2.8 - impactNegative * 0.3, 1, 20), now, smooth);":
            "setAudioParam(nodes.compressor.ratio, clamp(1.35 + impactPositive * 4.2 - impactNegative * 0.35, 1, 20), now, smooth);",
        "setAudioParam(nodes.compressor.release, 0.08 + impactPositive * 0.08, now, smooth);":
            "setAudioParam(nodes.compressor.release, 0.07 + impactPositive * 0.13, now, smooth);",
        "setAudioParam(nodes.makeupGain.gain, dbToAmp(impactPositive * 2.4 - impactNegative * 1.2), now, smooth);":
            "setAudioParam(nodes.makeupGain.gain, dbToAmp(impactPositive * 4.2 - impactNegative * 1.4), now, smooth);",
    }
    changed = 0
    for old, new in numeric_replacements.items():
        if old in text:
            text = text.replace(old, new, 1)
            changed += 1
    notes.append(f"app.js: strengthened {changed} realtime DSP constants.")

    return text, notes


def patch_index_html(path: pathlib.Path) -> Tuple[str, list[str]]:
    text = path.read_text(encoding="utf-8")
    notes: list[str] = []

    if "AI音源を読み込み、基本補正から好みの仕上げまで耳で決めるマスタリング作業台。" in text:
        text = text.replace(
            "AI音源を読み込み、基本補正から好みの仕上げまで耳で決めるマスタリング作業台。",
            "AI音源を読み込み、解析ベースのプロ風プリセットで配信向けに仕上げるマスタリング作業台。",
            1,
        )
        notes.append("index.html: updated product lead copy.")

    text, count = re.subn(
        r'          <div class="preset-strip" aria-label="プリセット">[\s\S]*?          </div>',
        PRESET_BUTTONS,
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError("index.html: could not locate preset button strip.")
    notes.append("index.html: replaced preset button labels.")

    if 'id="masteringCoach"' not in text:
        signal = '        <div class="signal-row" id="signalFlags"></div>'
        if signal not in text:
            raise RuntimeError("index.html: could not locate signalFlags insertion point.")
        text = text.replace(
            signal,
            signal + '\n'
            '        <div class="signal-row mastering-coach" id="masteringCoach" aria-live="polite">'
            '音源を読み込むと、曲に合わせた自動補正の内容を表示します。'
            '</div>',
            1,
        )
        notes.append("index.html: added mastering coach readout.")

    return text, notes


def patch_styles_css(path: pathlib.Path) -> Tuple[str, list[str]]:
    if not path.exists():
        return "", ["styles.css: not found; skipped."]
    text = path.read_text(encoding="utf-8")
    if MARKER in text:
        return text, ["styles.css: already contains upgrade marker; skipped."]
    return text.rstrip() + "\n\n" + CSS_APPEND.strip() + "\n", ["styles.css: added mastering coach styling."]


def run(repo: pathlib.Path, dry_run: bool = False) -> int:
    app = repo / "app.js"
    index = repo / "index.html"
    styles = repo / "styles.css"

    if not app.exists() or not index.exists():
        raise SystemExit(f"Repository path must contain app.js and index.html: {repo}")

    outputs: list[str] = []

    new_app, notes = patch_app_js(app)
    outputs.extend(notes)

    new_index, notes = patch_index_html(index)
    outputs.extend(notes)

    new_styles, notes = patch_styles_css(styles)
    outputs.extend(notes)

    if dry_run:
        print("\n".join(outputs))
        print("\nDry run only. No files written.")
        return 0

    for path in [app, index] + ([styles] if styles.exists() else []):
        backup_file(path)

    app.write_text(new_app, encoding="utf-8")
    index.write_text(new_index, encoding="utf-8")
    if styles.exists():
        styles.write_text(new_styles, encoding="utf-8")

    print("\n".join(outputs))
    print("\nUpgrade applied.")
    print("Backups:")
    print(f"  {app.name}.bak-pro-mastering")
    print(f"  {index.name}.bak-pro-mastering")
    if styles.exists():
        print(f"  {styles.name}.bak-pro-mastering")
    print("\nRecommended check:")
    print("  1. Open index.html or your local server.")
    print("  2. Load a Suno/AI track.")
    print("  3. Compare Clean配信 / AI Rescue / Loud SNS with 音量マッチ enabled.")
    print("  4. Export WAV and run 精密解析 if the backend is available.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".", help="Path to suno-mastering-mvp repository")
    parser.add_argument("--dry-run", action="store_true", help="Show changes without writing files")
    args = parser.parse_args()
    return run(pathlib.Path(args.repo).resolve(), args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())

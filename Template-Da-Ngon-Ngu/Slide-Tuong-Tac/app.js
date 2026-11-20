(function () {
  "use strict";

  let DATA = window.COURSE_CURRICULUM || window.LAO_CURRICULUM;
  if (!DATA || !DATA.chapters) {
    document.getElementById("workspace").innerHTML =
      '<div class="card">Không tải được dữ liệu <code>curriculum_data.js</code>. Hãy kiểm tra lại thư mục.</div>';
    return;
  }

  let META = DATA.meta || {};
  let TARGET_LANG = META.target_lang || {};
  let PWA_CFG = META.pwa || {};
  let FONTS_CFG = META.fonts || {};

  let STORAGE_KEY = PWA_CFG.storage_key || "self_study_progress_v1";
  let THEME_KEY = PWA_CFG.theme_storage_key || "self_study_theme";
  const SHELL_CACHE_NAME = "course-shell-v3";
  const MEDIA_CACHE_NAME = "course-media-v2";

  function hydrateCurriculumData(newData) {
    DATA = newData;
    META = DATA.meta || {};
    TARGET_LANG = META.target_lang || {};
    PWA_CFG = META.pwa || {};
    FONTS_CFG = META.fonts || {};
    STORAGE_KEY = PWA_CFG.storage_key || STORAGE_KEY;
    THEME_KEY = PWA_CFG.theme_storage_key || THEME_KEY;
  }

  const authState = {
    serverAvailable: false,
    authenticated: false,
    unlocked: false,
    tier: null,
    user: null,
    tab: "activate",
  };

  const state = {
    viewType: "lesson", // "lesson" | "exam" | "dict" | "locked"
    chapterIdx: 0,
    lessonIdx: 0,
    lockedChapter: null,
    mode: "slides", // "slides" | "vocab" | "dialogue" | "quiz" | "practice"
    slideIdx: 0,
    showTarget: true,
    showPhonetic: true,
    showMeaning: true,
    slowSpeed: false,
    recallAutoMode: false,
    recallTimerId: null,
    dialoguePlaying: false,
    dialogueCancelToken: 0,
    hideRole: "",
    activeVocabRecId: "",
    activeDialogueRecId: "",
    quiz: null, // active quiz state
    examHidePromptScript: true,
    progress: loadProgress(),
    theme: localStorage.getItem(THEME_KEY) || "light",
  };

  let currentAudio = null;
  let currentAudioBlobUrl = "";
  let deferredInstallPrompt = null;

  // In-session voice recording store: recId -> { url, durationSec }
  const recordings = new Map();
  let activeRec = null; // { recId, recorder, stream, chunks, startMs, timerId }

  function getViewSignature() {
    return `${state.viewType}:${state.chapterIdx}:${state.lessonIdx}:${state.mode}:${state.slideIdx}`;
  }

  function getTarget(item) {
    return (item && (item.target ?? item.lao)) || "";
  }

  function getTts(item) {
    return (item && (item.tts_target ?? item.tts_lao ?? getTarget(item))) || "";
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        return {
          completedUnits: p.completedUnits || {},
          learnedCards: p.learnedCards || {},
          examScores: p.examScores || {},
          quizScores: p.quizScores || {},
          examDrafts: p.examDrafts || {},
        };
      }
    } catch (_) {
      // Ignore corrupt storage
    }
    return {
      completedUnits: {},
      learnedCards: {},
      examScores: {},
      quizScores: {},
      examDrafts: {},
    };
  }

  let progressSyncTimer = null;

  function mergeProgress(localP, remoteP) {
    if (!remoteP || typeof remoteP !== "object") return localP;
    const merged = {
      completedUnits: { ...(remoteP.completedUnits || {}), ...(localP.completedUnits || {}) },
      learnedCards: { ...(remoteP.learnedCards || {}), ...(localP.learnedCards || {}) },
      examScores: { ...(remoteP.examScores || {}) },
      quizScores: { ...(remoteP.quizScores || {}) },
      examDrafts: { ...(remoteP.examDrafts || {}), ...(localP.examDrafts || {}) },
    };
    for (const [k, v] of Object.entries(localP.examScores || {})) {
      merged.examScores[k] = Math.max(Number(merged.examScores[k] || 0), Number(v || 0));
    }
    for (const [k, v] of Object.entries(localP.quizScores || {})) {
      merged.quizScores[k] = Math.max(Number(merged.quizScores[k] || 0), Number(v || 0));
    }
    return merged;
  }

  function scheduleServerProgressSync() {
    if (!authState.serverAvailable || !authState.authenticated) return;
    if (progressSyncTimer) clearTimeout(progressSyncTimer);
    progressSyncTimer = setTimeout(() => {
      fetch("/api/progress", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.progress),
      }).catch(() => {});
    }, 800);
  }

  function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    updateOverallBar();
    scheduleServerProgressSync();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function translateUrl(targetText) {
    const sl = encodeURIComponent(TARGET_LANG.google_translate_sl || "lo");
    const tl = encodeURIComponent(TARGET_LANG.google_translate_tl || "vi");
    return (
      `https://translate.google.com/?sl=${sl}&tl=${tl}&text=` +
      encodeURIComponent(targetText || "") +
      "&op=translate"
    );
  }

  function applyDynamicBrandingAndFonts() {
    if (META.course_title) document.title = META.course_title;
    const flagEl = document.getElementById("brandFlag");
    const titleEl = document.getElementById("brandTitle");
    const subEl = document.getElementById("brandSubtitle");
    if (flagEl && META.flag_emoji) flagEl.textContent = META.flag_emoji;
    if (titleEl && (META.short_title || META.course_title)) {
      titleEl.textContent = META.short_title || META.course_title;
    }
    if (subEl && META.subtitle) subEl.textContent = META.subtitle;

    const tgBtn = document.getElementById("toggleTarget");
    const phBtn = document.getElementById("togglePhonetic");
    const mnBtn = document.getElementById("toggleMeaning");
    if (tgBtn && TARGET_LANG.script_label) tgBtn.textContent = TARGET_LANG.script_label;
    if (phBtn && TARGET_LANG.phonetic_label) phBtn.textContent = TARGET_LANG.phonetic_label;
    if (mnBtn && TARGET_LANG.meaning_label) mnBtn.textContent = TARGET_LANG.meaning_label;

    // Inject @font-face for legal OFL webfont declared in course config
    const rules = [];
    if (FONTS_CFG.web_regular) {
      rules.push(
        `@font-face { font-family: "TargetWebFont"; font-weight: 400; font-style: normal; font-display: swap; src: url("${FONTS_CFG.web_regular}") format("truetype"); }`
      );
    }
    if (FONTS_CFG.web_bold) {
      rules.push(
        `@font-face { font-family: "TargetWebFont"; font-weight: 700; font-style: normal; font-display: swap; src: url("${FONTS_CFG.web_bold}") format("truetype"); }`
      );
    }
    if (rules.length) {
      let styleEl = document.getElementById("targetFontStyle");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "targetFontStyle";
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = rules.join("\n");
    }
    if (FONTS_CFG.target_family) {
      document.documentElement.style.setProperty(
        "--font-target",
        `"TargetWebFont", "${FONTS_CFG.target_family}", sans-serif`
      );
    }
  }

  function stopCurrentAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      currentAudio = null;
    }
    if (currentAudioBlobUrl) {
      URL.revokeObjectURL(currentAudioBlobUrl);
      currentAudioBlobUrl = "";
    }
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  async function findCachedAudioBlobUrl(relPath) {
    if (!("caches" in window) || location.protocol === "file:") return "";
    try {
      const absUrl = new URL(relPath, location.href).href;
      const cache = await caches.open(MEDIA_CACHE_NAME);
      const cached = await cache.match(absUrl);
      if (!cached) return "";
      const blob = await cached.blob();
      return URL.createObjectURL(blob);
    } catch (_) {
      return "";
    }
  }

  function playMediaWithCacheFallback(relPath, playbackRate, onFinished, onAllFailed) {
    stopCurrentAudio();
    const audio = new Audio(relPath);
    audio.playbackRate = playbackRate;
    currentAudio = audio;

    let handledFailure = false;
    const handleFailure = async () => {
      if (handledFailure) return;
      handledFailure = true;
      const blobUrl = await findCachedAudioBlobUrl(relPath);
      if (blobUrl && currentAudio === audio) {
        currentAudioBlobUrl = blobUrl;
        audio.src = blobUrl;
        audio.playbackRate = playbackRate;
        audio.onerror = () => {
          stopCurrentAudio();
          if (onAllFailed) onAllFailed();
        };
        audio.play().catch(() => {
          stopCurrentAudio();
          if (onAllFailed) onAllFailed();
        });
        return;
      }
      if (currentAudio === audio) currentAudio = null;
      if (onAllFailed) onAllFailed();
    };

    audio.onended = () => {
      if (currentAudioBlobUrl) {
        URL.revokeObjectURL(currentAudioBlobUrl);
        currentAudioBlobUrl = "";
      }
      if (currentAudio === audio) currentAudio = null;
      if (onFinished) onFinished();
    };
    audio.onerror = handleFailure;
    audio.play().catch(handleFailure);
  }

  function playTargetAudio(audioId, targetText, onFinished) {
    const rate = state.slowSpeed ? 0.75 : 1.0;

    if (!audioId) {
      stopCurrentAudio();
      fallbackAudio(targetText, onFinished);
      return;
    }

    const src = `../Media-Audio/cards/${audioId}.mp3`;
    playMediaWithCacheFallback(src, rate, onFinished, () => fallbackAudio(targetText, onFinished));
  }

  function fallbackAudio(targetText, onFinished) {
    const cleanText = String(targetText || "").trim();
    if (!cleanText) {
      if (onFinished) onFinished();
      return;
    }

    const langPrefix = (TARGET_LANG.code || "lo").toLowerCase();
    if ("speechSynthesis" in window) {
      const voices = window.speechSynthesis.getVoices() || [];
      const matchVoice = voices.find(
        (v) => v.lang && v.lang.toLowerCase().startsWith(langPrefix)
      );
      if (matchVoice) {
        const utt = new SpeechSynthesisUtterance(cleanText);
        utt.voice = matchVoice;
        utt.lang = matchVoice.lang;
        utt.rate = state.slowSpeed ? 0.75 : 0.95;
        utt.onend = () => {
          if (onFinished) onFinished();
        };
        window.speechSynthesis.speak(utt);
        return;
      }
    }

    copyText(cleanText);
    showAudioToast(cleanText);
    if (onFinished) onFinished();
  }

  function showAudioToast(targetText) {
    let banner = document.getElementById("audioMissingBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "audioMissingBanner";
      banner.className = "audio-notice";
      const ws = document.getElementById("workspace");
      ws.insertBefore(banner, ws.firstChild);
    }
    banner.innerHTML = `
      <div>
        <strong>Chưa có file MP3 offline cho câu này</strong> — đã tự copy:
        <span class="target-text" style="font-weight:700;margin:0 6px;">${escapeHtml(targetText)}</span>
        <br/><small>Chạy <code>Cong-Cu-Tao-Audio-Video/setup_and_generate.sh</code> để tạo bộ audio MP3 offline.</small>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <a class="btn btn-sm btn-primary" href="${translateUrl(targetText)}" target="_blank" rel="noopener noreferrer">🔊 Nghe Google Dịch</a>
        <button class="btn btn-sm" id="closeAudioToast">✕</button>
      </div>
    `;
    const closeBtn = document.getElementById("closeAudioToast");
    if (closeBtn) closeBtn.onclick = () => banner.remove();
  }

  /* ==================== Voice Recorder (MediaRecorder) ==================== */

  function pickRecorderMimeType() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
    for (const m of candidates) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function stopActiveRecording() {
    if (!activeRec) return;
    clearInterval(activeRec.timerId);
    if (activeRec.watch) {
      clearInterval(activeRec.watch.intervalId);
      activeRec.watch.disconnect();
    }
    try {
      if (activeRec.recorder && activeRec.recorder.state !== "inactive") {
        activeRec.recorder.stop();
      }
    } catch (_) {
      // Ignore stop error
    }
    if (activeRec.stream) {
      activeRec.stream.getTracks().forEach((t) => t.stop());
    }
    activeRec = null;
  }

  function formatRecClock(sec) {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  /**
   * Watch mic level: drives the live level bars and stops the recording
   * automatically after `silenceMs` of quiet once the learner has spoken.
   *
   * Robustness notes (iOS Safari especially):
   * - The analyser is routed to the destination through a muted gain node;
   *   WebKit may not pull audio through a graph that ends nowhere, which
   *   left the meter reading pure silence.
   * - The noise floor is the *quietest* level seen (rolling min), so a
   *   learner who starts talking immediately does not raise the threshold.
   * - If the meter never moves (analyser dead), we never auto-stop for
   *   "no speech"; the learner taps to stop and the recording is kept.
   */
  function startSilenceWatch(recId, stream, silenceMs) {
    const actx = getAudioContext();
    if (!actx || !actx.createMediaStreamSource) return null;
    let src;
    let sink;
    let analyser;
    try {
      src = actx.createMediaStreamSource(stream);
      analyser = actx.createAnalyser();
      analyser.fftSize = 1024;
      sink = actx.createGain();
      sink.gain.value = 0;
      src.connect(analyser);
      analyser.connect(sink);
      sink.connect(actx.destination);
    } catch (_) {
      return null;
    }
    const buf = new Uint8Array(analyser.fftSize);
    const startMs = Date.now();
    let floor = Infinity;
    let smooth = 0;
    let heardSpeech = false;
    let lastLoudMs = startMs;
    let meterAlive = false;
    const levels = new Array(15).fill(0);

    const intervalId = setInterval(() => {
      if (!activeRec || activeRec.recId !== recId) return;
      if (actx.state !== "running") actx.resume().catch(() => {});
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
        const av = Math.abs(v);
        if (av > peak) peak = av;
      }
      const rms = Math.sqrt(sum / buf.length);
      if (peak > 0) meterAlive = true;
      const now = Date.now();
      smooth = smooth * 0.6 + rms * 0.4;
      if (now - startMs > 150) floor = Math.min(floor, smooth);
      const base = Number.isFinite(floor) ? floor : 0;
      // Speech must clearly rise above the room, but never needs to be loud
      const thresh = Math.min(0.045, Math.max(0.01, base * 2.2 + 0.006));
      if (smooth > thresh) {
        heardSpeech = true;
        lastLoudMs = now;
      } else if (heardSpeech && smooth > thresh * 0.6) {
        lastLoudMs = now;
      }

      levels.shift();
      levels.push(Math.min(1, smooth / 0.12));
      document.querySelectorAll(`[data-rec-live="${recId}"] i`).forEach((bar, i) => {
        bar.style.height = `${Math.round(6 + levels[i] * 34)}px`;
      });

      const elapsed = now - startMs;
      if (heardSpeech && now - lastLoudMs > silenceMs && elapsed > 1200) {
        stopActiveRecording();
      } else if (elapsed > 20000) {
        stopActiveRecording(); // hard cap
      } else if (!heardSpeech && meterAlive && elapsed > silenceMs + 5000) {
        stopActiveRecording(); // nothing said for ~8s: stop, scoring will judge it
      }
    }, 80);

    return {
      intervalId,
      src,
      disconnect() {
        try {
          src.disconnect();
          analyser.disconnect();
          sink.disconnect();
        } catch (_) {
          // Ignore disconnect error
        }
      },
    };
  }

  async function toggleRecord(recId, onComplete, onError, opts = {}) {
    if (opts.autoStopSilenceMs) getAudioContext(); // unlock AudioContext inside the tap (iOS)
    if (activeRec && activeRec.recId === recId) {
      stopActiveRecording();
      return;
    }
    if (activeRec) {
      stopActiveRecording();
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined") {
      const msg =
        location.protocol === "file:"
          ? "Trình duyệt chặn Micro khi mở file:// trực tiếp. Hãy chạy `python3 -m http.server 8080` trong thư mục dự án hoặc mở qua HTTPS."
          : "Trình duyệt không hỗ trợ ghi âm (MediaRecorder).";
      if (onError) onError(msg);
      return;
    }

    try {
      stopCurrentAudio();
      const startSig = getViewSignature();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks = [];
      const startMs = Date.now();

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const sameView = getViewSignature() === startSig;
        if (chunks.length) {
          const old = recordings.get(recId);
          if (old && old.url) URL.revokeObjectURL(old.url);
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
          const url = URL.createObjectURL(blob);
          const durationSec = Math.max(1, Math.round((Date.now() - startMs) / 1000));
          const bestScore = old ? old.bestScore || 0 : 0;
          recordings.set(recId, { blob, url, durationSec, assessment: null, bestScore });
          if (opts.onRecorded && sameView) {
            opts.onRecorded(recId);
            return;
          }
        }
        if (onComplete && sameView) onComplete();
      };

      const timerId = setInterval(() => {
        if (!activeRec || activeRec.recId !== recId) return;
        const sec = Math.floor((Date.now() - startMs) / 1000);
        document.querySelectorAll(`[data-rec-timer="${recId}"]`).forEach((labelEl) => {
          labelEl.textContent =
            labelEl.getAttribute("data-rec-fmt") === "listen"
              ? `Đang nghe… ${formatRecClock(sec)}`
              : `⏹ Dừng (${sec}s)`;
        });
      }, 400);

      activeRec = { recId, recorder, stream, chunks, startMs, timerId, watch: null };
      recorder.start();
      if (opts.autoStopSilenceMs) {
        activeRec.watch = startSilenceWatch(recId, stream, opts.autoStopSilenceMs);
      }
      if (onComplete) onComplete();
    } catch (err) {
      const msg =
        location.protocol === "file:"
          ? "Không bật được Micro ở chế độ file://. Hãy mở qua http://localhost:8080 hoặc HTTPS."
          : "Chưa được cấp quyền Micro. Hãy cho phép Micro trong cài đặt trình duyệt.";
      if (onError) onError(msg);
    }
  }

  /* ==================== AI Pronunciation Lab (Acoustic DTW & Tone Analyzer) ==================== */

  let audioContextInstance = null;
  function getAudioContext() {
    if (!audioContextInstance) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContextInstance = new AudioCtx();
    }
    if (audioContextInstance && audioContextInstance.state === "suspended") {
      audioContextInstance.resume().catch(() => {});
    }
    return audioContextInstance;
  }

  /**
   * Trim leading/trailing silence relative to the loudest part of the clip
   * (frame RMS), then normalise the peak. A fixed absolute threshold failed
   * on quiet phone recordings (everything trimmed away) and on clips with a
   * click at the end (the 3s auto-stop tail was kept).
   */
  function trimSilence(data) {
    const frame = 512;
    const n = Math.floor(data.length / frame);
    if (n < 2) return new Float32Array(0);
    const rms = new Float32Array(n);
    let maxR = 0;
    for (let f = 0; f < n; f++) {
      let sum = 0;
      for (let i = f * frame; i < (f + 1) * frame; i++) sum += data[i] * data[i];
      rms[f] = Math.sqrt(sum / frame);
      if (rms[f] > maxR) maxR = rms[f];
    }
    if (maxR < 0.005) return new Float32Array(0); // nothing above room noise
    const thr = Math.max(maxR * 0.12, 0.0015);
    let first = 0;
    while (first < n && rms[first] < thr) first++;
    let last = n - 1;
    while (last > first && rms[last] < thr) last--;
    const start = Math.max(0, (first - 1) * frame);
    const end = Math.min(data.length, (last + 2) * frame);
    const out = data.slice(start, end);
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) {
      const gain = 0.9 / peak;
      for (let i = 0; i < out.length; i++) out[i] *= gain;
    }
    return out;
  }

  function getEnergyEnvelope(data, frames = 50) {
    const step = Math.floor(data.length / frames);
    const env = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      const start = i * step;
      const end = Math.min(data.length, start + step);
      for (let j = start; j < end; j++) sum += data[j] * data[j];
      env[i] = Math.sqrt(sum / (end - start || 1));
    }
    let max = 0;
    for (let i = 0; i < frames; i++) if (env[i] > max) max = env[i];
    if (max > 0) for (let i = 0; i < frames; i++) env[i] /= max;
    return env;
  }

  function getPitchContour(data, sr, frames = 30) {
    const step = Math.floor(data.length / frames);
    const winSize = Math.min(1024, step);
    const minPeriod = Math.floor(sr / 450); // ~450Hz max
    const maxPeriod = Math.floor(sr / 75);  // ~75Hz min
    const pitches = new Float32Array(frames);

    for (let f = 0; f < frames; f++) {
      const offset = f * step;
      if (offset + winSize > data.length) break;

      let bestCorr = 0;
      let bestLag = -1;
      for (let lag = minPeriod; lag <= maxPeriod && lag < winSize; lag++) {
        let corr = 0;
        for (let i = 0; i < winSize - lag; i++) {
          corr += data[offset + i] * data[offset + i + lag];
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }
      if (bestLag > 0 && bestCorr > 0.04) {
        pitches[f] = sr / bestLag;
      } else {
        pitches[f] = 0;
      }
    }
    return pitches;
  }

  function analyzeAudioBuffers(refBuffer, userBuffer) {
    const refData = refBuffer.getChannelData(0);
    const userData = userBuffer.getChannelData(0);
    const sr = refBuffer.sampleRate;

    const trimmedRef = trimSilence(refData);
    const trimmedUser = trimSilence(userData);

    if (trimmedRef.length < 500 || trimmedUser.length < 500) {
      return {
        overall: 50,
        tone: 50,
        rhythm: 50,
        clarity: 50,
        msg: "Âm thanh quá ngắn hoặc chưa rõ tiếng. Hãy nói to và rõ hơn nhé.",
        refEnv: new Float32Array(50).fill(0.3),
        userEnv: new Float32Array(50).fill(0.3),
      };
    }

    // 1. Rhythm & Duration
    const refDur = trimmedRef.length / sr;
    const userDur = trimmedUser.length / sr;
    const durRatio = Math.min(refDur, userDur) / Math.max(refDur, userDur);
    const rhythm = Math.round(Math.min(100, Math.max(35, durRatio * 100)));

    // 2. Energy envelope & clarity
    const refEnv = getEnergyEnvelope(trimmedRef, 50);
    const userEnv = getEnergyEnvelope(trimmedUser, 50);

    let dot = 0, nRef = 0, nUsr = 0;
    for (let i = 0; i < 50; i++) {
      dot += refEnv[i] * userEnv[i];
      nRef += refEnv[i] * refEnv[i];
      nUsr += userEnv[i] * userEnv[i];
    }
    const envSim = (nRef > 0 && nUsr > 0) ? (dot / (Math.sqrt(nRef) * Math.sqrt(nUsr))) : 0.5;
    const clarity = Math.round(Math.min(100, Math.max(40, envSim * 100)));

    // 3. Pitch / Tone Contour (Autocorrelation)
    const refPitch = getPitchContour(trimmedRef, sr, 30);
    const userPitch = getPitchContour(trimmedUser, sr, 30);

    // Compare pitch *shape* in semitones relative to each speaker's own median,
    // so a male voice can match a female reference. Octave-jump frames are
    // clamped so one tracker error cannot sink the score.
    const toSemitones = (pitches) => {
      const voiced = Array.from(pitches).filter((f) => f > 0).sort((x, y) => x - y);
      if (voiced.length < 4) return null;
      const med = voiced[Math.floor(voiced.length / 2)];
      const st = Array.from(pitches, (f) => (f > 0 ? 12 * Math.log2(f / med) : null));
      // 3-point median filter to drop single-frame spikes
      return st.map((v, i) => {
        if (v === null) return null;
        const win = [st[i - 1], v, st[i + 1]].filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
        return win[Math.floor(win.length / 2)];
      });
    };
    const slopeOf = (pts) => {
      const n = pts.length;
      const mx = pts.reduce((acc, p) => acc + p[0], 0) / n;
      const my = pts.reduce((acc, p) => acc + p[1], 0) / n;
      let num = 0;
      let den = 0;
      for (const [x, y] of pts) {
        num += (x - mx) * (y - my);
        den += (x - mx) * (x - mx);
      }
      return den > 0 ? num / den : 0; // semitones per whole clip
    };
    const refSt = toSemitones(refPitch);
    const userSt = toSemitones(userPitch);
    let tone = 60;
    if (refSt && userSt) {
      const pairs = [];
      for (let i = 0; i < 30; i++) {
        if (refSt[i] !== null && userSt[i] !== null) pairs.push([i / 29, refSt[i], userSt[i]]);
      }
      if (pairs.length >= 5) {
        const meanDiff =
          pairs.reduce((acc, p) => acc + Math.min(6, Math.abs(p[1] - p[2])), 0) / pairs.length;
        const refSlope = slopeOf(pairs.map((p) => [p[0], p[1]]));
        const userSlope = slopeOf(pairs.map((p) => [p[0], p[2]]));
        let shape = Math.max(0, 1 - meanDiff / 5);
        // Rising vs falling where the reference clearly moves: a different tone
        if (Math.abs(refSlope) > 2 && Math.sign(refSlope) !== Math.sign(userSlope)) shape *= 0.5;
        tone = Math.round(40 + 60 * shape);
      }
    }

    // Overall weighted score: Lao is tonal, so tone dominates (Tone 60%, Clarity 20%, Rhythm 20%)
    const overall = Math.round(tone * 0.6 + clarity * 0.2 + rhythm * 0.2);

    let msg = "";
    if (overall >= 90) {
      msg = "🌟 Xuất sắc! Phát âm rất chuẩn thanh điệu và ngữ điệu người bản xứ!";
    } else if (overall >= 80) {
      msg = "👍 Rất tốt! Thanh điệu tự nhiên, chú ý ngắt nhịp dứt khoát hơn một chút.";
    } else if (overall >= 65) {
      msg = "💡 Khá tốt! Thanh điệu gần chuẩn, chú ý kéo dài độ ngân của nguyên âm.";
    } else {
      msg = "🔄 Cần luyện tập thêm. Hãy bấm '🔊 Nghe mẫu chuẩn' rồi bấm 'Phát âm lại' để thử lại nhé!";
    }

    return { overall, tone, rhythm, clarity, msg, refEnv, userEnv };
  }

  function drawWaveform(canvas, refEnv, userEnv) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.width = canvas.clientWidth || 300;
    const h = canvas.height = canvas.clientHeight || 90;
    ctx.clearRect(0, 0, w, h);

    const barCount = refEnv.length;
    const barW = Math.max(2, Math.floor(w / barCount) - 2);
    const midY = h / 2;

    // Center divider
    ctx.strokeStyle = "rgba(150, 150, 150, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // 1. Reference Audio Waveform (Top - Green)
    ctx.fillStyle = "#10b981";
    for (let i = 0; i < barCount; i++) {
      const x = i * (barW + 2);
      const val = refEnv[i] || 0;
      const barH = Math.max(2, val * (midY - 6));
      ctx.fillRect(x, midY - barH, barW, barH);
    }

    // 2. User Recorded Waveform (Bottom - Amber)
    ctx.fillStyle = "#f59e0b";
    for (let i = 0; i < barCount; i++) {
      const x = i * (barW + 2);
      const val = userEnv[i] || 0;
      const barH = Math.max(2, val * (midY - 6));
      ctx.fillRect(x, midY, barW, barH);
    }
  }

  async function assessPronunciation(recId, audioId, ttsText) {
    const saved = recordings.get(recId);
    if (!saved || !saved.blob || !audioId) return;

    saved.assessing = true;
    renderApp();

    try {
      const actx = getAudioContext();
      if (!actx) throw new Error("AudioContext không khả dụng");

      const refUrl = `../Media-Audio/cards/${audioId}.mp3`;
      const refResp = await fetch(refUrl);
      if (!refResp.ok) throw new Error("Không tải được audio mẫu");
      const refBufRaw = await refResp.arrayBuffer();
      const userBufRaw = await saved.blob.arrayBuffer();

      const [refBuffer, userBuffer] = await Promise.all([
        actx.decodeAudioData(refBufRaw.slice(0)),
        actx.decodeAudioData(userBufRaw.slice(0)),
      ]);

      const result = analyzeAudioBuffers(refBuffer, userBuffer);
      saved.assessment = result;
      saved.bestScore = Math.max(saved.bestScore || 0, result.overall);
    } catch (err) {
      console.warn("AI Assessment fallback:", err);
      // Never invent a score: the card shows "Chưa chấm được" and asks for a retry
      saved.assessment = {
        failed: true,
        overall: 0,
        tone: 0,
        rhythm: 0,
        clarity: 0,
        msg: "Chưa chấm được bản thu này. Hãy thử đọc lại.",
        refEnv: new Float32Array(50),
        userEnv: new Float32Array(50),
      };
    } finally {
      saved.assessing = false;
      renderApp();
      setTimeout(() => {
        const c = document.querySelector(`[data-waveform-canvas="${recId}"]`);
        if (c && saved.assessment) {
          drawWaveform(c, saved.assessment.refEnv, saved.assessment.userEnv);
        }
      }, 60);
    }
  }

  function openProModal() {
    const m = document.getElementById("proModal");
    if (m) m.classList.remove("hidden");
  }

  function closeProModal() {
    const m = document.getElementById("proModal");
    if (m) m.classList.add("hidden");
  }

  function renderRecorderHtml(recId, audioId, ttsText, label) {
    const isRecording = activeRec && activeRec.recId === recId;
    const saved = recordings.get(recId);
    const recBtnText = isRecording ? "⏹ Dừng (0s)" : saved ? "🎙️ Thu lại" : `🎙️ ${label || "Thu âm so sánh"}`;
    const recBtnAttr = isRecording ? `data-rec-timer="${escapeHtml(recId)}"` : "";

    let aiPanelHtml = "";
    if (saved && audioId) {
      if (saved.assessing) {
        aiPanelHtml = `
          <div class="rec-ai-panel" style="text-align:center;padding:16px;">
            <div style="font-weight:700;color:var(--primary);">⏳ Đang phân tích thanh điệu & sóng âm Waveform...</div>
          </div>
        `;
      } else if (saved.assessment) {
        const a = saved.assessment;
        const scoreClass = a.overall >= 85 ? "score-excellent" : a.overall >= 70 ? "score-good" : "score-practice";
        aiPanelHtml = `
          <div class="rec-ai-panel">
            <div class="rec-ai-header">
              <div class="rec-ai-title">👑 Phòng Lab Phát Âm AI</div>
              <div class="rec-ai-badge ${scoreClass}">${a.overall}%</div>
            </div>
            <div class="rec-ai-metrics">
              <div class="metric-card">
                <div>Thanh điệu (Tone)</div>
                <div class="metric-val">${a.tone}%</div>
              </div>
              <div class="metric-card">
                <div>Nhịp & Ngắt âm</div>
                <div class="metric-val">${a.rhythm}%</div>
              </div>
              <div class="metric-card">
                <div>Độ rõ âm</div>
                <div class="metric-val">${a.clarity}%</div>
              </div>
            </div>
            <div class="waveform-wrap">
              <canvas class="waveform-canvas" data-waveform-canvas="${escapeHtml(recId)}"></canvas>
              <div class="waveform-legend">
                <span class="legend-ref">■ Sóng âm mẫu (Bản xứ)</span>
                <span class="legend-user">■ Sóng âm giọng bạn</span>
              </div>
            </div>
            <div class="rec-ai-verdict">${escapeHtml(a.msg)}</div>
            <div class="rec-ai-actions">
              <span style="font-size:0.78rem;color:var(--text-muted);font-weight:700;">🏆 Kỷ lục: ${saved.bestScore || a.overall}%</span>
              <button class="btn btn-sm btn-gold" data-rec-reloop="${escapeHtml(recId)}" title="Luyện phát âm lại để nâng điểm">🔄 Phát âm lại</button>
            </div>
          </div>
        `;
      } else {
        aiPanelHtml = `
          <div style="margin-top:6px;display:flex;justify-content:center;">
            <button class="btn btn-sm btn-gold" data-rec-ai="${escapeHtml(recId)}" data-audio-id="${escapeHtml(audioId)}" data-tts="${escapeHtml(ttsText || "")}">
              ⚡ Chấm điểm AI &amp; Sóng âm Waveform
            </button>
          </div>
        `;
      }
    }

    return `
      <div class="recorder-box" data-rec-box="${escapeHtml(recId)}">
        <div class="rec-controls">
          <button class="btn btn-sm rec-btn ${isRecording ? "recording" : ""}" data-rec-toggle="${escapeHtml(recId)}" ${recBtnAttr}>
            ${recBtnText}
          </button>
          ${
            saved
              ? `<button class="btn btn-sm btn-primary" data-play-id="${escapeHtml(audioId || "")}" data-play-target="${escapeHtml(ttsText || "")}">🔊 Nghe mẫu</button>
                 <button class="btn btn-sm" data-rec-clear="${escapeHtml(recId)}" title="Xóa bản thu">🗑️</button>`
              : ""
          }
        </div>
        ${
          saved
            ? `<div class="rec-playback">
                 <audio controls src="${saved.url}"></audio>
                 <span style="font-size:0.75rem;color:var(--text-muted);">Giọng bạn (${saved.durationSec}s)</span>
               </div>`
            : ""
        }
        ${aiPanelHtml}
        <div class="rec-error hidden" data-rec-err="${escapeHtml(recId)}"></div>
      </div>
    `;
  }

  /* ==================== Slide card: Listen → Speak → Score ==================== */

  const ICON_SPEAKER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
  const ICON_MIC =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg>';
  const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  const ICON_RETRY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
  const PASS_SCORE = 80;

  function launchConfetti() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const colors = ["#146c53", "#f5a524", "#e0533d", "#3bb08f", "#4f7dff", "#ffd23f"];
    const layer = document.createElement("div");
    layer.className = "confetti-layer";
    for (let i = 0; i < 70; i++) {
      const piece = document.createElement("i");
      const dx = (Math.random() - 0.5) * 2;
      piece.style.left = `${50 + dx * 8}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty("--dx", `${dx * 48}vw`);
      piece.style.setProperty("--dy", `${-30 - Math.random() * 45}vh`);
      piece.style.setProperty("--rot", `${(Math.random() - 0.5) * 1080}deg`);
      piece.style.animationDelay = `${Math.random() * 0.15}s`;
      if (i % 3 === 0) piece.style.borderRadius = "50%";
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 2200);
  }

  function renderCardPracticeHtml(recId, audioId) {
    const isRecording = activeRec && activeRec.recId === recId;
    const saved = isRecording ? null : recordings.get(recId);
    const isPro = authState.tier === "pro";

    if (isRecording) {
      return `
        <div class="cp" data-rec-box="${escapeHtml(recId)}">
          <div class="cp-live" data-rec-live="${escapeHtml(recId)}">${"<i></i>".repeat(15)}</div>
          <div class="cp-acts">
            <div class="cp-act"><button class="cp-btn cp-spk" disabled aria-label="Nghe mẫu">${ICON_SPEAKER}</button><span>Nghe mẫu</span></div>
            <div class="cp-act"><button class="cp-btn cp-mic is-rec" data-cp-mic="${escapeHtml(recId)}" aria-label="Dừng thu">${ICON_STOP}</button>
              <span class="cp-rec-label" data-rec-timer="${escapeHtml(recId)}" data-rec-fmt="listen">Đang nghe… 0:00</span></div>
          </div>
          <div class="cp-hint">Im lặng 3 giây sẽ tự dừng</div>
          <div class="rec-error hidden" data-rec-err="${escapeHtml(recId)}"></div>
        </div>`;
    }

    let resultHtml = "";
    if (saved && saved.assessing) {
      resultHtml = `<div class="cp-result cp-result-wait">⏳ Đang chấm điểm phát âm…</div>`;
    } else if (saved && saved.assessment) {
      const a = saved.assessment;
      if (a.failed) {
        resultHtml = `
          <div class="cp-verdict cp-verdict-retry">
            <span class="cp-verdict-text"><b>Chưa chấm được</b><small>Bấm 🔊 nghe mẫu rồi đọc lại to, rõ nhé.</small></span>
            <button type="button" class="cp-retry" data-cp-retry="${escapeHtml(recId)}" aria-label="Đọc lại">${ICON_RETRY}</button>
          </div>`;
      } else if (a.overall >= PASS_SCORE) {
        resultHtml = `
          <div class="cp-verdict cp-verdict-pass" role="status">
            <span class="cp-verdict-badge">✓</span>
            <span class="cp-verdict-text"><b>ĐẠT!</b><small>Phát âm chuẩn rồi, sang thẻ tiếp nhé 🎉</small></span>
          </div>`;
      } else {
        resultHtml = `
          <div class="cp-verdict cp-verdict-retry" role="status">
            <span class="cp-verdict-text"><b>Chưa đạt</b><small>Nghe mẫu 🔊 rồi đọc lại nhé</small></span>
            <button type="button" class="cp-retry" data-cp-retry="${escapeHtml(recId)}" aria-label="Đọc lại">${ICON_RETRY}</button>
          </div>`;
      }
    } else if (saved && !isPro) {
      resultHtml = `
        <div class="cp-result cp-result-lock">
          <span>✅ Đã thu xong — bấm ▶ để nghe lại giọng bạn.</span>
          <button type="button" class="btn btn-sm btn-gold" data-cp-pro>👑 Chấm điểm % (PRO)</button>
        </div>`;
    }

    const actsHtml = saved
      ? `
        <div class="cp-acts cp-acts-3">
          <div class="cp-act"><button class="cp-btn cp-spk cp-sm" id="btnSlideAudio" aria-label="Nghe mẫu">${ICON_SPEAKER}</button><span>Mẫu</span></div>
          <div class="cp-act"><button class="cp-btn cp-mic cp-md" data-cp-mic="${escapeHtml(recId)}" aria-label="Đọc lại">${ICON_MIC}</button><span>Đọc lại</span></div>
          <div class="cp-act"><button class="cp-btn cp-me cp-sm" data-cp-me="${escapeHtml(recId)}" aria-label="Nghe giọng bạn">${ICON_PLAY}</button><span>Giọng bạn</span></div>
        </div>`
      : `
        <div class="cp-acts">
          <div class="cp-act"><button class="cp-btn cp-spk" id="btnSlideAudio" aria-label="Nghe phát âm mẫu">${ICON_SPEAKER}</button><span>Nghe mẫu</span></div>
          <div class="cp-act"><button class="cp-btn cp-mic" data-cp-mic="${escapeHtml(recId)}" aria-label="Đọc theo">${ICON_MIC}</button><span>Đọc theo</span></div>
        </div>
        <div class="cp-hint">Chạm 🎤 để đọc — tự dừng khi bạn im lặng 3 giây</div>`;

    return `
      <div class="cp" data-rec-box="${escapeHtml(recId)}" data-audio-id="${escapeHtml(audioId || "")}">
        ${resultHtml}
        ${actsHtml}
        <div class="rec-error hidden" data-rec-err="${escapeHtml(recId)}"></div>
      </div>`;
  }

  function bindCardPractice(container, recId, audioId, ttsText, onRefresh) {
    const showErr = (msg) => {
      const errEl = container.querySelector(`[data-rec-err="${recId}"]`);
      if (errEl) {
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
      }
    };

    const startRecording = () => {
      toggleRecord(recId, onRefresh, showErr, {
        autoStopSilenceMs: 3000,
        onRecorded: () => {
          if (authState.tier === "pro" && audioId) assessPronunciation(recId, audioId, ttsText);
          else onRefresh();
        },
      });
    };
    container.querySelectorAll(`[data-cp-mic="${recId}"], [data-cp-retry="${recId}"]`).forEach((btn) => {
      btn.onclick = startRecording;
    });

    // Celebrate a pass once per recording
    const saved = recordings.get(recId);
    if (saved && saved.assessment && !saved.assessment.failed && saved.assessment.overall >= PASS_SCORE && !saved.celebrated) {
      saved.celebrated = true;
      launchConfetti();
    }

    const meBtn = container.querySelector(`[data-cp-me="${recId}"]`);
    if (meBtn) {
      meBtn.onclick = () => {
        const saved = recordings.get(recId);
        if (!saved || !saved.url) return;
        stopCurrentAudio();
        const audio = new Audio(saved.url);
        currentAudio = audio;
        audio.play().catch(() => showErr("Không phát được bản thu trên trình duyệt này."));
      };
    }

    const proBtn = container.querySelector("[data-cp-pro]");
    if (proBtn) proBtn.onclick = openProModal;

  }

  function bindRecorderEvents(container, onRefresh) {
    container.querySelectorAll("[data-rec-toggle]").forEach((btn) => {
      btn.onclick = () => {
        const recId = btn.getAttribute("data-rec-toggle");
        toggleRecord(
          recId,
          () => onRefresh(),
          (msg) => {
            const errEl = container.querySelector(`[data-rec-err="${recId}"]`);
            if (errEl) {
              errEl.textContent = msg;
              errEl.classList.remove("hidden");
            }
          }
        );
      };
    });

    container.querySelectorAll("[data-rec-reloop]").forEach((btn) => {
      btn.onclick = () => {
        const recId = btn.getAttribute("data-rec-reloop");
        toggleRecord(
          recId,
          () => onRefresh(),
          (msg) => {
            const errEl = container.querySelector(`[data-rec-err="${recId}"]`);
            if (errEl) {
              errEl.textContent = msg;
              errEl.classList.remove("hidden");
            }
          }
        );
      };
    });

    container.querySelectorAll("[data-rec-ai]").forEach((btn) => {
      btn.onclick = () => {
        const recId = btn.getAttribute("data-rec-ai");
        const audioId = btn.getAttribute("data-audio-id");
        const tts = btn.getAttribute("data-tts");
        if (authState.tier !== "pro") {
          openProModal();
          return;
        }
        assessPronunciation(recId, audioId, tts);
      };
    });

    container.querySelectorAll("[data-rec-clear]").forEach((btn) => {
      btn.onclick = () => {
        const recId = btn.getAttribute("data-rec-clear");
        const old = recordings.get(recId);
        if (old && old.url) URL.revokeObjectURL(old.url);
        recordings.delete(recId);
        onRefresh();
      };
    });
  }

  /* ==================== PWA Install & Offline Audio Cache ==================== */

  function setPwaStatus(text) {
    const el = document.getElementById("pwaStatus");
    if (!el) return;
    if (!text) {
      el.classList.add("hidden");
      el.textContent = "";
    } else {
      el.textContent = text;
      el.classList.remove("hidden");
    }
  }

  function registerPWA() {
    const isHttpLocalOrHttps =
      location.protocol === "https:" ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";

    if (!isHttpLocalOrHttps) {
      setPwaStatus("Đang mở file:// (chạy HTTP/HTTPS để bật cài PWA & Micro).");
      return;
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("./sw.js")
        .then(async (reg) => {
          setPwaStatus("PWA sẵn sàng offline.");
          if (reg) {
            reg.update().catch(() => {});
          }
          if ("caches" in window) {
            try {
              const shellCache = await caches.open(SHELL_CACHE_NAME);
              const fontUrls = [FONTS_CFG.web_regular, FONTS_CFG.web_bold].filter(Boolean);
              await Promise.allSettled(fontUrls.map((u) => shellCache.add(u)));
            } catch (_) {
              // Optional font pre-cache
            }
          }
        })
        .catch(() => {});
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btn = document.getElementById("btnInstallPwa");
      if (btn) btn.classList.remove("hidden");
    });
  }

  async function cacheCurrentCourseAudioOffline() {
    if (!("caches" in window) || location.protocol === "file:") {
      setPwaStatus("Cần mở qua HTTPS hoặc localhost để lưu audio vào Cache Offline.");
      return;
    }

    const urls = new Set();
    const ch = getActiveChapter();
    const collectChapter = (chap) => {
      if (!chap || chap.locked) return;
      (chap.lessons || []).forEach((les) => {
        urls.add(`../Media-Audio/lessons/${les.id}_pimsleur.m4a`);
        les.vocab.forEach((v) => v.audio_id && urls.add(`../Media-Audio/cards/${v.audio_id}.mp3`));
        les.sentences.forEach((s) => s.audio_id && urls.add(`../Media-Audio/cards/${s.audio_id}.mp3`));
        les.dialogue.lines.forEach((d) => d.audio_id && urls.add(`../Media-Audio/cards/${d.audio_id}.mp3`));
      });
      if (chap.exam) {
        chap.exam.part_a.items.forEach((it) => it.audio_id && urls.add(`../Media-Audio/cards/${it.audio_id}.mp3`));
        chap.exam.part_b.items.forEach((it) => it.audio_id && urls.add(`../Media-Audio/cards/${it.audio_id}.mp3`));
      }
    };

    const unlockedCount = DATA.chapters.filter((c) => !c.locked).length;
    const cacheAll =
      unlockedCount > 1
        ? confirm(
            `Bạn muốn tải Audio Offline cho:\n• OK = Tất cả ${unlockedCount} chương đã mở khóa\n• Cancel = Chỉ Chương ${ch.number} (${ch.title})`
          )
        : true;
    if (cacheAll) DATA.chapters.forEach(collectChapter);
    else collectChapter(ch);

    const list = [...urls];
    const cache = await caches.open(MEDIA_CACHE_NAME);
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        const absUrl = new URL(list[i], location.href).href;
        const resp = await fetch(absUrl);
        if (resp.ok) {
          await cache.put(absUrl, resp);
          ok++;
        }
      } catch (_) {
        // Skip missing files cleanly
      }
      if ((i + 1) % 8 === 0 || i + 1 === list.length) {
        setPwaStatus(`Đang lưu offline: ${i + 1}/${list.length} (${ok} file sẵn sàng)...`);
      }
    }
    setPwaStatus(`Đã lưu offline ${ok}/${list.length} file audio.`);
  }

  /* ==================== Navigation & Progress ==================== */

  function getActiveChapter() {
    return DATA.chapters[state.chapterIdx];
  }

  function getActiveLesson() {
    return getActiveChapter().lessons[state.lessonIdx];
  }

  function getActiveUnitId() {
    if (state.viewType === "exam" && getActiveChapter().exam) return getActiveChapter().exam.id;
    if (state.viewType === "lesson") return getActiveLesson().id;
    return "";
  }

  function updateOverallBar() {
    const totalUnits = (META.stats?.lessons || 0) + (META.stats?.tests || 0);
    const doneCount = Object.values(state.progress.completedUnits).filter(Boolean).length;
    const cardCount = Object.values(state.progress.learnedCards).filter(Boolean).length;
    const pct = totalUnits > 0 ? Math.round((doneCount / totalUnits) * 100) : 0;
    document.getElementById("overallProgressBar").style.width = `${pct}%`;
    document.getElementById("overallUnitsText").textContent = `${doneCount}/${totalUnits} mục xong`;
    document.getElementById("overallCardsText").textContent = `${cardCount} thẻ thuộc`;
  }

  function renderSidebar() {
    const nav = document.getElementById("chapterNav");
    nav.innerHTML = DATA.chapters
      .map((ch, cIdx) => {
        if (ch.locked) {
          const activeLocked =
            state.viewType === "locked" &&
            state.lockedChapter &&
            state.lockedChapter.number === ch.number;
          return `
            <div class="chap-group">
              <button class="chap-header locked ${activeLocked ? "active" : ""}" data-locked-chap="${cIdx}">
                <span>🔒 Ch.${ch.number}: ${escapeHtml(ch.title)}</span>
                <span class="badge-lock">Khóa</span>
              </button>
            </div>
          `;
        }

        const lessonsHtml = ch.lessons
          .map((les, lIdx) => {
            const active =
              state.viewType === "lesson" &&
              state.chapterIdx === cIdx &&
              state.lessonIdx === lIdx;
            const done = !!state.progress.completedUnits[les.id];
            const quizBest = state.progress.quizScores[les.id];
            const badge = done
              ? '<span class="badge-done">✓</span>'
              : quizBest !== undefined
              ? `<span class="badge-done">${quizBest}%</span>`
              : "";
            return `
              <button class="nav-item ${active ? "active" : ""}" data-act="lesson" data-c="${cIdx}" data-l="${lIdx}">
                <span>Bài ${les.number}: ${escapeHtml(les.title.replace(/^Chương \d+\s*[–-]\s*Bài \d+:\s*/, ""))}</span>
                ${badge}
              </button>
            `;
          })
          .join("");

        let examHtml = "";
        if (ch.exam) {
          const examActive = state.viewType === "exam" && state.chapterIdx === cIdx;
          const examScore = state.progress.examScores[ch.exam.id];
          const examBadge =
            examScore !== undefined
              ? `<span class="badge-done">${examScore}đ</span>`
              : state.progress.completedUnits[ch.exam.id]
              ? '<span class="badge-done">✓</span>'
              : "";
          examHtml = `
            <button class="nav-item exam-item ${examActive ? "active" : ""}" data-act="exam" data-c="${cIdx}">
              <span>📝 Kiểm tra Chương ${ch.number}</span>
              ${examBadge}
            </button>
          `;
        }

        return `
          <div class="chap-group">
            <button class="chap-header" data-toggle-chap="${cIdx}">
              <span>Ch.${ch.number}: ${escapeHtml(ch.title)}</span>
              <span>${cIdx === state.chapterIdx ? "▾" : "▸"}</span>
            </button>
            <div class="chap-items ${cIdx === state.chapterIdx ? "" : "hidden"}" id="chapItems-${cIdx}">
              ${lessonsHtml}
              ${examHtml}
            </div>
          </div>
        `;
      })
      .join("");

    nav.querySelectorAll("[data-locked-chap]").forEach((btn) => {
      btn.addEventListener("click", () => {
        stopAllPlayback();
        const cIdx = Number(btn.getAttribute("data-locked-chap"));
        state.viewType = "locked";
        state.lockedChapter = DATA.chapters[cIdx];
        document.getElementById("sidebar").classList.remove("open");
        renderApp();
      });
    });

    nav.querySelectorAll("[data-toggle-chap]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-toggle-chap"));
        const panel = document.getElementById(`chapItems-${idx}`);
        panel.classList.toggle("hidden");
      });
    });

    nav.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        stopAllPlayback();
        state.quiz = null;
        const act = btn.getAttribute("data-act");
        const cIdx = Number(btn.getAttribute("data-c"));
        if (act === "lesson") {
          state.viewType = "lesson";
          state.chapterIdx = cIdx;
          state.lessonIdx = Number(btn.getAttribute("data-l"));
          state.slideIdx = 0;
        } else if (act === "exam") {
          state.viewType = "exam";
          state.chapterIdx = cIdx;
        }
        document.getElementById("sidebar").classList.remove("open");
        renderApp();
      });
    });
  }

  function renderTopbar() {
    const ch = getActiveChapter();
    let title = "";
    if (state.viewType === "lesson") {
      title = getActiveLesson().title;
    } else if (state.viewType === "exam" && ch.exam) {
      title = ch.exam.title;
    } else if (state.viewType === "locked" && state.lockedChapter) {
      title = `🔒 Chương ${state.lockedChapter.number}: ${state.lockedChapter.title}`;
    } else {
      title = "Từ Điển Sinh Tồn & Tra Cứu Toàn Khóa";
    }
    document.getElementById("activeTitle").textContent = title;

    const topbarTierEl = document.getElementById("topbarTierBadge");
    if (topbarTierEl) {
      if (authState.authenticated && authState.unlocked && authState.tier) {
        topbarTierEl.classList.remove("hidden");
        if (authState.tier === "pro") {
          topbarTierEl.className = "badge-tier badge-pro";
          topbarTierEl.textContent = "👑 PRO VIP";
        } else {
          topbarTierEl.className = "badge-tier badge-std";
          topbarTierEl.textContent = "⭐ STANDARD";
        }
      } else {
        topbarTierEl.classList.add("hidden");
      }
    }

    document.getElementById("toggleTarget").classList.toggle("on", state.showTarget);
    document.getElementById("togglePhonetic").classList.toggle("on", state.showPhonetic);
    document.getElementById("toggleMeaning").classList.toggle("on", state.showMeaning);
    document.getElementById("toggleSlowSpeed").textContent = state.slowSpeed ? "🐢 0.75x" : "⚡ 1.0x";

    const unitId = getActiveUnitId();
    const doneBtn = document.getElementById("btnMarkUnitDone");
    if (unitId) {
      doneBtn.classList.remove("hidden");
      const isDone = !!state.progress.completedUnits[unitId];
      doneBtn.innerHTML = isDone
        ? '✅<span class="hide-mobile"> Đã hoàn thành</span>'
        : '☑<span class="hide-mobile"> Đánh dấu xong</span>';
      doneBtn.title = isDone ? "Đã hoàn thành bài này" : "Đánh dấu xong bài này";
      doneBtn.classList.toggle("btn-primary", isDone);
    } else {
      doneBtn.classList.add("hidden");
    }

    const modeTabs = document.getElementById("modeTabs");
    if (state.viewType === "lesson") {
      modeTabs.classList.remove("hidden");
      modeTabs.querySelectorAll(".mode-tab").forEach((tab) => {
        tab.classList.toggle("active", tab.getAttribute("data-mode") === state.mode);
      });
    } else {
      modeTabs.classList.add("hidden");
    }
  }

  function clearRecallTimer() {
    if (state.recallTimerId) {
      clearInterval(state.recallTimerId);
      state.recallTimerId = null;
    }
  }

  function stopAllPlayback() {
    clearRecallTimer();
    stopActiveRecording();
    state.dialogueCancelToken++;
    state.dialoguePlaying = false;
    stopCurrentAudio();
  }

  /* ==================== Mode 1: Interactive Slides + Recorder ==================== */

  function buildLessonSlides(les) {
    const slides = [];
    slides.push({
      type: "cover",
      tag: `Bài ${les.number} • Khởi động`,
      title: les.title,
      tips: les.tips,
      lessonId: les.id,
      counts: `${les.vocab.length} từ vựng • ${les.sentences.length} mẫu câu • ${les.dialogue.lines.length} lượt hội thoại`,
    });

    les.vocab.forEach((v, idx) => {
      slides.push({
        type: "card",
        tag: `Từ vựng ${idx + 1}/${les.vocab.length}`,
        item: v,
      });
    });

    les.sentences.forEach((s, idx) => {
      slides.push({
        type: "card",
        tag: `Mẫu câu ${idx + 1}/${les.sentences.length}`,
        item: {
          audio_id: s.audio_id,
          target: getTarget(s),
          tts_target: getTts(s),
          phonetic: s.phonetic,
          vietnamese: s.vietnamese,
          note: s.context,
        },
      });
    });

    if (les.dialogue.lines.length > 0) {
      slides.push({
        type: "dialogue_preview",
        tag: "Hội thoại tổng hợp",
        context: les.dialogue.context,
        lines: les.dialogue.lines,
      });
    }

    if (les.practice.length > 0) {
      slides.push({
        type: "practice_summary",
        tag: "Thử thách phản xạ 15 phút",
        prompts: les.practice,
      });
    }
    return slides;
  }

  function renderSlideMode(ws, les) {
    const slides = buildLessonSlides(les);
    if (state.slideIdx >= slides.length) state.slideIdx = 0;
    if (state.slideIdx < 0) state.slideIdx = slides.length - 1;
    const s = slides[state.slideIdx];
    const pct = Math.round(((state.slideIdx + 1) / slides.length) * 100);

    let bodyHtml = "";
    if (s.type === "cover") {
      const tipsHtml = (s.tips.length ? s.tips : ["Tập trung nghe và nói thành tiếng tối thiểu 5 lần mỗi cụm."])
        .slice(0, 6)
        .map((t) => `<div class="slide-tip-item">${escapeHtml(t)}</div>`)
        .join("");
      bodyHtml = `
        <div class="slide-vi" style="font-size:1.6rem;">${escapeHtml(s.title)}</div>
        <div style="color:var(--text-muted);font-size:0.95rem;">${escapeHtml(s.counts)}</div>
        <div class="slide-tips-list">${tipsHtml}</div>
        <div style="margin-top:6px;">
          <button class="btn btn-sm" id="btnPlayPimsleur">🎧 Phát Track Luyện Nghe Cả Bài (M4A)</button>
        </div>
      `;
    } else if (s.type === "card") {
      const it = s.item;
      const targetTxt = getTarget(it);
      const ttsTxt = getTts(it);
      const recId = `slide_${it.audio_id}`;
      const recallBadge = state.recallAutoMode
        ? `<div class="recall-banner" id="recallCountdown">⏱️ Nghĩ trong 3 giây...</div>`
        : "";
      bodyHtml = `
        ${recallBadge}
        <div class="slide-vi maskable ${state.showMeaning ? "" : "masked"}" data-unmask="1">${escapeHtml(it.vietnamese)}</div>
        <div class="slide-target target-text maskable ${state.showTarget ? "" : "masked"}" data-unmask="1">${escapeHtml(targetTxt)}</div>
        <div class="slide-phonetic maskable ${state.showPhonetic ? "" : "masked"}" data-unmask="1">${escapeHtml(it.phonetic)}</div>
        ${it.note ? `<div class="slide-note">💡 ${escapeHtml(it.note)}</div>` : ""}
        ${renderCardPracticeHtml(recId, it.audio_id)}
      `;
    } else if (s.type === "dialogue_preview") {
      const linesHtml = s.lines
        .map((l) => {
          const tTxt = getTarget(l);
          const tts = getTts(l);
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid var(--border);text-align:left;">
              <div>
                <strong>${escapeHtml(l.role)}:</strong>
                <span class="target-text maskable ${state.showTarget ? "" : "masked"}" style="font-size:1.15rem;color:var(--primary);margin-left:6px;" data-unmask="1">${escapeHtml(tTxt)}</span>
                <span class="maskable ${state.showPhonetic ? "" : "masked"}" style="color:var(--accent);font-style:italic;margin-left:6px;" data-unmask="1">(${escapeHtml(l.phonetic)})</span>
                <div class="maskable ${state.showMeaning ? "" : "masked"}" style="font-size:0.86rem;color:var(--text-muted);" data-unmask="1">${escapeHtml(l.vietnamese)}</div>
              </div>
              <button class="btn btn-sm" data-play-id="${l.audio_id}" data-play-target="${escapeHtml(tts)}">🔊</button>
            </div>
          `;
        })
        .join("");
      bodyHtml = `
        <div class="slide-vi">${escapeHtml(s.context || "Hội thoại thực hành")}</div>
        <div style="width:100%;max-width:780px;max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:12px;">
          ${linesHtml}
        </div>
        <button class="btn btn-primary" id="btnGoDialogueTab">🎧 Mở trình phát Hội thoại Shadowing</button>
      `;
    } else if (s.type === "practice_summary") {
      const itemsHtml = s.prompts
        .slice(0, 6)
        .map((p) => `<div class="slide-tip-item">${escapeHtml(p)}</div>`)
        .join("");
      bodyHtml = `
        <div class="slide-vi">Thử thách nói thành tiếng không nhìn tài liệu!</div>
        <div class="slide-tips-list">${itemsHtml}</div>
      `;
    }

    ws.innerHTML = `
      <div class="slide-stage">
        <div>
          <div class="slide-meta">
            <span class="slide-tag">${escapeHtml(s.tag)}</span>
            <div style="display:flex;align-items:center;gap:10px;">
              <button class="btn btn-sm ${state.recallAutoMode ? "btn-accent" : ""}" id="btnToggleRecallTimer" title="Ẩn chữ & Phiên âm, đếm 3 giây tự bật đáp án">
                ⏱️ ${state.recallAutoMode ? "Đang bật Phản xạ 3s" : "Luyện Phản xạ 3s"}
              </button>
            </div>
          </div>
          <div class="slide-progress-track">
            <div class="slide-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>

        <div class="slide-body">${bodyHtml}</div>

        <div class="slide-footer">
          <div class="slide-nav-btns">
            <button class="btn slide-prev" id="btnPrevSlide" aria-label="Slide trước">←<span class="hide-mobile"> Trước</span></button>
            <span class="slide-count">${state.slideIdx + 1} / ${slides.length}</span>
            <button class="btn btn-primary slide-next" id="btnNextSlide">Tiếp →</button>
          </div>
          <div class="slide-shortcuts">
            Phím tắt: <b>← / →</b> chuyển slide • <b>Space</b> mở che chữ • <b>R</b> nghe lại
          </div>
        </div>
      </div>
    `;

    ws.querySelectorAll("[data-unmask]").forEach((el) => {
      el.addEventListener("click", () => el.classList.toggle("masked"));
    });

    document.getElementById("btnPrevSlide").onclick = () => {
      clearRecallTimer();
      stopActiveRecording();
      state.slideIdx--;
      renderWorkspace();
    };
    document.getElementById("btnNextSlide").onclick = () => {
      clearRecallTimer();
      stopActiveRecording();
      state.slideIdx++;
      renderWorkspace();
    };

    document.getElementById("btnToggleRecallTimer").onclick = () => {
      clearRecallTimer();
      state.recallAutoMode = !state.recallAutoMode;
      if (state.recallAutoMode) {
        state.showTarget = false;
        state.showPhonetic = false;
        state.showMeaning = true;
      } else {
        state.showTarget = true;
        state.showPhonetic = true;
      }
      renderTopbar();
      renderWorkspace();
    };

    if (s.type === "cover") {
      const pimBtn = document.getElementById("btnPlayPimsleur");
      if (pimBtn) {
        pimBtn.onclick = () => {
          const rate = state.slowSpeed ? 0.8 : 1.0;
          playMediaWithCacheFallback(
            `../Media-Audio/lessons/${s.lessonId}_pimsleur.m4a`,
            rate,
            null,
            () => showAudioToast(getTts(les.vocab[0]) || "")
          );
        };
      }
    }

    if (s.type === "card") {
      const it = s.item;
      const ttsTxt = getTts(it);
      const audioBtn = document.getElementById("btnSlideAudio");
      if (audioBtn) audioBtn.onclick = () => playTargetAudio(it.audio_id, ttsTxt);

      bindCardPractice(ws, `slide_${it.audio_id}`, it.audio_id, ttsTxt, () => renderSlideMode(ws, les));

      if (state.recallAutoMode) {
        let sec = 3;
        const badge = document.getElementById("recallCountdown");
        state.recallTimerId = setInterval(() => {
          sec--;
          if (sec > 0) {
            if (badge) badge.textContent = `⏱️ Nghĩ trong ${sec} giây...`;
          } else {
            clearRecallTimer();
            if (badge) badge.textContent = "💡 Đáp án chuẩn!";
            ws.querySelectorAll(".maskable").forEach((el) => el.classList.remove("masked"));
            playTargetAudio(it.audio_id, ttsTxt);
          }
        }, 1000);
      }
    }

    if (s.type === "dialogue_preview") {
      bindPlayButtons(ws);
      document.getElementById("btnGoDialogueTab").onclick = () => {
        state.mode = "dialogue";
        renderTopbar();
        renderWorkspace();
      };
    }
  }

  function bindPlayButtons(container) {
    container.querySelectorAll("[data-play-id]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-play-id");
        const txt = btn.getAttribute("data-play-target") || btn.getAttribute("data-play-lao") || "";
        playTargetAudio(id, txt);
      };
    });
  }

  /* ==================== Mode 2: Vocab & Sentences + Inline Recorder ==================== */

  function renderVocabMode(ws, les) {
    const renderCards = (items, title) => {
      if (!items.length) return "";
      const cardsHtml = items
        .map((it) => {
          const learned = !!state.progress.learnedCards[it.audio_id];
          const tgt = getTarget(it);
          const tts = getTts(it);
          const recId = `vocab_${it.audio_id}`;
          const recOpen = state.activeVocabRecId === it.audio_id;
          return `
            <div class="vocab-card ${learned ? "learned" : ""}">
              <div>
                <div class="vc-top">
                  <div class="vc-vi maskable ${state.showMeaning ? "" : "masked"}" data-unmask="1">${escapeHtml(it.vietnamese)}</div>
                  <button class="btn btn-sm" data-mark-id="${it.audio_id}" title="Đánh dấu đã thuộc">
                    ${learned ? "★" : "☆"}
                  </button>
                </div>
                <div class="vc-target target-text maskable ${state.showTarget ? "" : "masked"}" data-unmask="1">${escapeHtml(tgt)}</div>
                <div class="vc-phonetic maskable ${state.showPhonetic ? "" : "masked"}" data-unmask="1">${escapeHtml(it.phonetic)}</div>
                ${it.note ? `<div class="vc-note">${escapeHtml(it.note)}</div>` : ""}
              </div>
              <div class="vc-actions">
                <div style="display:flex;gap:6px;">
                  <button class="btn btn-sm btn-primary" data-play-id="${it.audio_id}" data-play-target="${escapeHtml(tts)}">🔊 Nghe</button>
                  <button class="btn btn-sm ${recOpen ? "btn-accent" : ""}" data-open-vrec="${it.audio_id}" title="Tự thu âm giọng bạn">🎙️</button>
                </div>
                <a class="btn btn-sm" href="${translateUrl(tts)}" target="_blank" rel="noopener noreferrer">🌐 Dịch</a>
              </div>
              ${recOpen ? renderRecorderHtml(recId, it.audio_id, tts, "Thu âm") : ""}
            </div>
          `;
        })
        .join("");
      return `<h3 style="margin:18px 0 10px;">${escapeHtml(title)} (${items.length})</h3><div class="vocab-grid">${cardsHtml}</div>`;
    };

    const sentencesNormalized = les.sentences.map((s) => ({
      audio_id: s.audio_id,
      vietnamese: s.vietnamese,
      target: getTarget(s),
      tts_target: getTts(s),
      phonetic: s.phonetic,
      note: s.context,
    }));

    const scriptLbl = TARGET_LANG.script_label || "Chữ gốc";
    const phLbl = TARGET_LANG.phonetic_label || "Phiên âm";
    const mnLbl = TARGET_LANG.meaning_label || "Nghĩa Việt";

    ws.innerHTML =
      `<div class="card"><strong>Mẹo:</strong> Bật/tắt nút <b>${escapeHtml(scriptLbl)} / ${escapeHtml(phLbl)} / ${escapeHtml(mnLbl)}</b> ở thanh trên để tự kiểm tra trí nhớ. Bấm <b>🎙️</b> trên từng thẻ để thu âm so sánh với giọng chuẩn.</div>` +
      renderCards(les.vocab, "Từ Vựng Trọng Tâm") +
      renderCards(sentencesNormalized, "Mẫu Câu Xương Sống");

    ws.querySelectorAll("[data-unmask]").forEach((el) => {
      el.addEventListener("click", () => el.classList.toggle("masked"));
    });
    bindPlayButtons(ws);
    bindRecorderEvents(ws, () => renderVocabMode(ws, les));

    ws.querySelectorAll("[data-open-vrec]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-open-vrec");
        state.activeVocabRecId = state.activeVocabRecId === id ? "" : id;
        renderVocabMode(ws, les);
      };
    });

    ws.querySelectorAll("[data-mark-id]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-mark-id");
        state.progress.learnedCards[id] = !state.progress.learnedCards[id];
        saveProgress();
        renderVocabMode(ws, les);
      };
    });
  }

  /* ==================== Mode 3: Dialogue Shadowing + Recorder ==================== */

  function renderDialogueMode(ws, les) {
    const lines = les.dialogue.lines;
    if (!lines.length) {
      ws.innerHTML = '<div class="card">Bài học này tập trung luyện âm/bảng chữ và không có bài hội thoại riêng. Hãy chuyển sang tab <b>Từ vựng &amp; Mẫu câu</b> hoặc <b>Slide</b>.</div>';
      return;
    }

    const roles = [...new Set(lines.map((l) => l.role))];
    const roleA = roles[0] || "A";
    const roleB = roles[1] || "B";

    const rowsHtml = lines
      .map((l, idx) => {
        const hiddenByRole =
          (state.hideRole === "A" && l.role === roleA) ||
          (state.hideRole === "B" && l.role === roleB);
        const tgt = getTarget(l);
        const tts = getTts(l);
        const recId = `dlg_${l.audio_id}`;
        const showRec = state.activeDialogueRecId === l.audio_id || hiddenByRole;
        return `
          <div class="dialogue-row" id="dlgRow-${idx}">
            <div>
              <span class="role-badge ${l.gender}">${escapeHtml(l.role)}</span>
            </div>
            <div>
              <div class="target-text maskable ${state.showTarget && !hiddenByRole ? "" : "masked"}" style="font-size:1.35rem;font-weight:700;color:var(--primary);" data-unmask="1">${escapeHtml(tgt)}</div>
              <div class="maskable ${state.showPhonetic && !hiddenByRole ? "" : "masked"}" style="color:var(--accent);font-style:italic;font-weight:600;" data-unmask="1">${escapeHtml(l.phonetic)}</div>
              <div class="maskable ${state.showMeaning ? "" : "masked"}" style="color:var(--text-muted);font-size:0.92rem;" data-unmask="1">${escapeHtml(l.vietnamese)}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-sm btn-primary" data-play-id="${l.audio_id}" data-play-target="${escapeHtml(tts)}">🔊</button>
              <button class="btn btn-sm ${showRec ? "btn-accent" : ""}" data-open-drec="${l.audio_id}" title="Thu âm lượt nói này">🎙️</button>
              <a class="btn btn-sm" href="${translateUrl(tts)}" target="_blank" rel="noopener noreferrer">🌐</a>
            </div>
            ${showRec ? `<div class="dialogue-rec-wrap">${renderRecorderHtml(recId, l.audio_id, tts, "Thu vai " + l.role)}</div>` : ""}
          </div>
        `;
      })
      .join("");

    ws.innerHTML = `
      <div class="card">
        <div style="margin-bottom:10px;"><strong>Tình huống:</strong> ${escapeHtml(les.dialogue.context || "Hội thoại thực tế")}</div>
        <div class="dialogue-controls">
          <button class="btn btn-primary" id="btnPlayAllDialogue">
            ${state.dialoguePlaying ? "⏹ Dừng phát nối tiếp" : "▶ Phát cả đoạn + Dừng 2 giây (Shadowing)"}
          </button>
          <button class="btn btn-sm ${state.hideRole === "A" ? "btn-accent" : ""}" id="btnHideA">🎭 Đóng vai ${escapeHtml(roleA)} (ẩn lời + mở mic)</button>
          <button class="btn btn-sm ${state.hideRole === "B" ? "btn-accent" : ""}" id="btnHideB">🎭 Đóng vai ${escapeHtml(roleB)} (ẩn lời + mở mic)</button>
          ${state.hideRole ? '<button class="btn btn-sm" id="btnShowAllRoles">Hiện cả 2 vai</button>' : ""}
        </div>
      </div>
      ${rowsHtml}
    `;

    ws.querySelectorAll("[data-unmask]").forEach((el) => {
      el.addEventListener("click", () => el.classList.toggle("masked"));
    });
    bindPlayButtons(ws);
    bindRecorderEvents(ws, () => renderDialogueMode(ws, les));

    ws.querySelectorAll("[data-open-drec]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute("data-open-drec");
        state.activeDialogueRecId = state.activeDialogueRecId === id ? "" : id;
        renderDialogueMode(ws, les);
      };
    });

    document.getElementById("btnHideA").onclick = () => {
      state.hideRole = state.hideRole === "A" ? "" : "A";
      renderDialogueMode(ws, les);
    };
    document.getElementById("btnHideB").onclick = () => {
      state.hideRole = state.hideRole === "B" ? "" : "B";
      renderDialogueMode(ws, les);
    };
    const showAllBtn = document.getElementById("btnShowAllRoles");
    if (showAllBtn) {
      showAllBtn.onclick = () => {
        state.hideRole = "";
        renderDialogueMode(ws, les);
      };
    }

    document.getElementById("btnPlayAllDialogue").onclick = () => {
      if (state.dialoguePlaying) {
        stopAllPlayback();
        renderDialogueMode(ws, les);
        return;
      }
      state.dialoguePlaying = true;
      const token = ++state.dialogueCancelToken;
      renderDialogueMode(ws, les);

      const playStep = (idx) => {
        if (token !== state.dialogueCancelToken || idx >= lines.length) {
          state.dialoguePlaying = false;
          renderDialogueMode(ws, les);
          return;
        }
        ws.querySelectorAll(".dialogue-row").forEach((r) => r.classList.remove("speaking"));
        const activeRow = document.getElementById(`dlgRow-${idx}`);
        if (activeRow) {
          activeRow.classList.add("speaking");
          activeRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        playTargetAudio(lines[idx].audio_id, getTts(lines[idx]), () => {
          if (token !== state.dialogueCancelToken) return;
          setTimeout(() => playStep(idx + 1), 1800);
        });
      };
      playStep(0);
    };
  }

  /* ==================== Mode 4: Auto-Graded Quiz ==================== */

  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function buildQuizSession(scope) {
    const ch = getActiveChapter();
    const les = getActiveLesson();
    const poolRaw =
      scope === "chapter"
        ? ch.lessons.flatMap((l) => [...l.vocab, ...l.sentences])
        : [...les.vocab, ...les.sentences];

    // Deduplicate by target text
    const seen = new Set();
    const pool = [];
    poolRaw.forEach((it) => {
      const t = getTarget(it);
      if (t && it.vietnamese && !seen.has(t)) {
        seen.add(t);
        pool.push({
          audio_id: it.audio_id,
          target: t,
          tts: getTts(it),
          phonetic: it.phonetic || "",
          vietnamese: it.vietnamese,
        });
      }
    });

    const selected = shuffleArray(pool).slice(0, Math.min(10, pool.length));
    const questions = selected.map((item, idx) => {
      const kind = idx % 2 === 0 ? "listen" : "recall";
      const distractors = shuffleArray(pool.filter((x) => x.target !== item.target)).slice(0, 3);
      const allChoices = shuffleArray([item, ...distractors]);
      return {
        num: idx + 1,
        kind,
        item,
        choices: allChoices,
        correctIdx: allChoices.findIndex((c) => c.target === item.target),
        pickedIdx: -1,
      };
    });

    return {
      unitId: scope === "chapter" ? ch.id : les.id,
      scope,
      idx: 0,
      questions,
      finished: false,
    };
  }

  function renderQuizMode(ws, les) {
    const ch = getActiveChapter();
    if (!state.quiz || (state.quiz.unitId !== les.id && state.quiz.unitId !== ch.id)) {
      state.quiz = buildQuizSession("lesson");
    }
    const qz = state.quiz;

    if (!qz.questions.length) {
      ws.innerHTML = '<div class="card">Bài học chưa đủ dữ liệu để tạo quiz tự động.</div>';
      return;
    }

    const scopeBar = `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <strong>🎯 Quiz Phản Xạ &amp; Nghe Hiểu (Tự Chấm Điểm)</strong>
          <div style="font-size:0.82rem;color:var(--text-muted);">
            ${qz.scope === "chapter" ? `Tổng hợp Chương ${ch.number}` : `Bài ${les.number}`} • ${qz.questions.length} câu trắc nghiệm
            ${state.progress.quizScores[les.id] !== undefined ? ` • Kỷ lục bài: <b>${state.progress.quizScores[les.id]}%</b>` : ""}
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm ${qz.scope === "lesson" ? "btn-primary" : ""}" id="btnQuizLesson">Quiz Bài ${les.number}</button>
          <button class="btn btn-sm ${qz.scope === "chapter" ? "btn-primary" : ""}" id="btnQuizChapter">Quiz Cả Chương ${ch.number}</button>
          <button class="btn btn-sm" id="btnQuizRestart">🔄 Đề mới</button>
        </div>
      </div>
    `;

    if (qz.finished) {
      const correctCount = qz.questions.filter((q) => q.pickedIdx === qz.correctIdx).length;
      const pct = Math.round((correctCount / qz.questions.length) * 100);
      if (qz.scope === "lesson") {
        const prev = state.progress.quizScores[les.id] || 0;
        if (pct > prev) {
          state.progress.quizScores[les.id] = pct;
          saveProgress();
          renderSidebar();
        }
      }

      const reviewHtml = qz.questions
        .map((q) => {
          const isOk = q.pickedIdx === q.correctIdx;
          return `
            <div class="exam-item" style="border-left:4px solid var(${isOk ? "--success" : "--danger"});">
              <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                <strong>Câu ${q.num}: ${isOk ? "✅ Đúng" : "❌ Sai"}</strong>
                <button class="btn btn-sm btn-primary" data-play-id="${q.item.audio_id}" data-play-target="${escapeHtml(q.item.tts)}">🔊 Nghe lại</button>
              </div>
              <div style="margin-top:6px;"><b>${escapeHtml(q.item.vietnamese)}</b> → <span class="target-text" style="color:var(--primary);font-weight:700;">${escapeHtml(q.item.target)}</span> <em>(${escapeHtml(q.item.phonetic)})</em></div>
            </div>
          `;
        })
        .join("");

      ws.innerHTML = `
        ${scopeBar}
        <div class="quiz-card">
          <h3 style="margin-top:0;">${pct >= 80 ? "🎉 Xuất sắc!" : pct >= 60 ? "👍 Khá tốt!" : "💪 Cần ôn thêm chút nữa!"}</h3>
          <div style="font-size:2rem;font-weight:800;color:var(--primary);margin:8px 0;">${correctCount} / ${qz.questions.length} (${pct}%)</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
            <button class="btn btn-primary" id="btnQuizNewAfter">🔄 Làm đề ngẫu nhiên mới</button>
            ${correctCount < qz.questions.length ? '<button class="btn btn-accent" id="btnQuizRetryMissed">⚡ Ôn lại các câu sai</button>' : ""}
          </div>
        </div>
        <h3 style="margin:18px 0 10px;">Chi tiết từng câu</h3>
        ${reviewHtml}
      `;

      bindQuizHeaderEvents(ws, qz);
      bindPlayButtons(ws);
      document.getElementById("btnQuizNewAfter").onclick = () => {
        state.quiz = buildQuizSession(qz.scope);
        renderQuizMode(ws, les);
      };
      const retryBtn = document.getElementById("btnQuizRetryMissed");
      if (retryBtn) {
        retryBtn.onclick = () => {
          const missed = qz.questions.filter((q) => q.pickedIdx !== q.correctIdx).map((q, i) => ({ ...q, num: i + 1, pickedIdx: -1 }));
          state.quiz = { ...qz, idx: 0, questions: missed, finished: false };
          renderQuizMode(ws, les);
        };
      }
      return;
    }

    const q = qz.questions[qz.idx];
    const answered = q.pickedIdx !== -1;
    const isRight = answered && q.pickedIdx === q.correctIdx;

    const promptHtml =
      q.kind === "listen"
        ? `
          <div class="slide-tag">Nghe âm thanh &amp; chọn nghĩa đúng</div>
          <div class="quiz-prompt">
            <button class="btn btn-primary" id="btnQuizPlay">🔊 Bấm để nghe câu</button>
          </div>
        `
        : `
          <div class="slide-tag">Nhìn nghĩa tiếng Việt &amp; chọn câu đúng</div>
          <div class="quiz-prompt">${escapeHtml(q.item.vietnamese)}</div>
        `;

    const optsHtml = q.choices
      .map((c, cIdx) => {
        let cls = "option-btn";
        if (answered) {
          if (cIdx === q.correctIdx) cls += " correct";
          else if (cIdx === q.pickedIdx) cls += " wrong";
        }
        const label =
          q.kind === "listen"
            ? escapeHtml(c.vietnamese)
            : `<span class="target-text" style="font-size:1.15rem;">${escapeHtml(c.target)}</span> <span style="color:var(--accent);font-style:italic;">(${escapeHtml(c.phonetic)})</span>`;
        return `<button class="${cls}" data-qchoice="${cIdx}" ${answered ? "disabled" : ""}>${label}</button>`;
      })
      .join("");

    ws.innerHTML = `
      ${scopeBar}
      <div class="quiz-card">
        <div class="quiz-header">
          <span>Câu <b>${qz.idx + 1}</b> / ${qz.questions.length}</span>
          <span class="exam-score-pill">Đúng: ${qz.questions.filter((x) => x.pickedIdx === x.correctIdx).length}</span>
        </div>
        ${promptHtml}
        <div>${optsHtml}</div>
        ${
          answered
            ? `<div class="quiz-feedback ${isRight ? "ok" : "err"}">
                 ${isRight ? "✅ Chính xác!" : "❌ Chưa đúng."} Đáp án: <span class="target-text">${escapeHtml(q.item.target)}</span> (${escapeHtml(q.item.phonetic)}) — ${escapeHtml(q.item.vietnamese)}
               </div>
               <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
                 <button class="btn btn-sm" id="btnQuizPlayAns">🔊 Nghe lại đáp án</button>
                 <button class="btn btn-primary" id="btnQuizNext">${qz.idx + 1 < qz.questions.length ? "Câu tiếp theo →" : "Xem tổng kết 🏆"}</button>
               </div>`
            : ""
        }
      </div>
    `;

    bindQuizHeaderEvents(ws, qz);

    const playBtn = document.getElementById("btnQuizPlay");
    if (playBtn) {
      playBtn.onclick = () => playTargetAudio(q.item.audio_id, q.item.tts);
      if (!answered) playTargetAudio(q.item.audio_id, q.item.tts);
    }
    const playAnsBtn = document.getElementById("btnQuizPlayAns");
    if (playAnsBtn) {
      playAnsBtn.onclick = () => playTargetAudio(q.item.audio_id, q.item.tts);
    }

    ws.querySelectorAll("[data-qchoice]").forEach((btn) => {
      btn.onclick = () => {
        if (q.pickedIdx !== -1) return;
        q.pickedIdx = Number(btn.getAttribute("data-qchoice"));
        if (q.pickedIdx === q.correctIdx) {
          state.progress.learnedCards[q.item.audio_id] = true;
          saveProgress();
        }
        playTargetAudio(q.item.audio_id, q.item.tts);
        renderQuizMode(ws, les);
      };
    });

    const nextBtn = document.getElementById("btnQuizNext");
    if (nextBtn) {
      nextBtn.onclick = () => {
        if (qz.idx + 1 < qz.questions.length) qz.idx++;
        else qz.finished = true;
        renderQuizMode(ws, les);
      };
    }
  }

  function bindQuizHeaderEvents(ws, qz) {
    const les = getActiveLesson();
    document.getElementById("btnQuizLesson").onclick = () => {
      state.quiz = buildQuizSession("lesson");
      renderQuizMode(ws, les);
    };
    document.getElementById("btnQuizChapter").onclick = () => {
      state.quiz = buildQuizSession("chapter");
      renderQuizMode(ws, les);
    };
    document.getElementById("btnQuizRestart").onclick = () => {
      state.quiz = buildQuizSession(qz.scope);
      renderQuizMode(ws, les);
    };
  }

  /* ==================== Mode 5: Practice 15 Min ==================== */

  function renderPracticeMode(ws, les) {
    const items = les.practice;
    if (!items.length) {
      ws.innerHTML = '<div class="card">Hãy mở tài liệu Markdown gốc của bài học để xem bài tập chi tiết.</div>';
      return;
    }
    const listHtml = items
      .map(
        (p, idx) => `
        <div class="exam-item">
          <strong>Nhiệm vụ ${idx + 1}:</strong> ${escapeHtml(p)}
        </div>
      `
      )
      .join("");

    const hint =
      META.practice_hint ||
      "Đọc từng tình huống bên dưới, đếm thầm 1 - 2 - 3 rồi nói thật to câu trả lời.";

    ws.innerHTML = `
      <div class="card">
        <h3>⚡ Quy tắc thực hành 15 phút</h3>
        <p style="margin:4px 0 0;color:var(--text-muted);">${escapeHtml(hint)}</p>
      </div>
      ${listHtml}
      <div style="margin-top:16px;">
        <button class="btn btn-primary" id="btnNextLessonOrExam">Hoàn thành bài này &amp; Chuyển bài tiếp theo →</button>
      </div>
    `;

    document.getElementById("btnNextLessonOrExam").onclick = () => {
      state.progress.completedUnits[les.id] = true;
      saveProgress();
      const ch = getActiveChapter();
      if (state.lessonIdx + 1 < ch.lessons.length) {
        state.lessonIdx++;
        state.mode = "slides";
        state.slideIdx = 0;
      } else if (ch.exam) {
        state.viewType = "exam";
      }
      renderApp();
    };
  }

  /* ==================== Exam View (Auto-Grading + Self-Grading + Voice Recording) ==================== */

  function getExamDraft(exam) {
    if (!state.progress.examDrafts[exam.id]) {
      state.progress.examDrafts[exam.id] = {
        aChoices: {},
        aText: {},
        aGraded: false,
        bGrades: {},
        cGrades: {},
        dScore: null,
      };
    }
    return state.progress.examDrafts[exam.id];
  }

  function isPartATextCorrect(userText, expectedNormalized) {
    const clean = String(userText || "").replace(/\s+/g, "").toLowerCase();
    return Boolean(clean) && clean === String(expectedNormalized || "").toLowerCase();
  }

  function computeExamTotals(exam, draft) {
    let scA = 0;
    exam.part_a.items.forEach((it) => {
      const pts = Number(it.points) || 5;
      if (it.question_type === "text") {
        if (isPartATextCorrect(draft.aText[it.num], it.expected_answer)) scA += pts;
      } else if (Number(draft.aChoices[it.num]) === it.correct_index) {
        scA += pts;
      }
    });

    let scB = 0;
    exam.part_b.items.forEach((it) => {
      const val = draft.bGrades[it.num];
      if (val !== undefined) scB += Number(val);
    });

    let scC = 0;
    exam.part_c.items.forEach((it) => {
      const val = draft.cGrades[it.num];
      if (val !== undefined) scC += Number(val);
    });

    const scD =
      draft.dScore === null || draft.dScore === undefined
        ? 0
        : Math.min(25, Math.max(0, Number(draft.dScore)));
    return {
      scA: Math.round(scA * 10) / 10,
      scB: Math.round(scB * 10) / 10,
      scC: Math.round(scC * 10) / 10,
      scD: Math.round(scD * 10) / 10,
    };
  }

  function maskPromptInText(text, prompt) {
    if (!state.examHidePromptScript || !prompt) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const pEsc = escapeHtml(prompt);
    if (escaped.includes(pEsc)) {
      return escaped.replace(
        pEsc,
        `<span class="target-text maskable masked" data-unmask="1" title="Chạm để hé lộ chữ gốc">${pEsc}</span>`
      );
    }
    return escaped;
  }

  function renderExamView(ws) {
    const ch = getActiveChapter();
    const exam = ch.exam;
    if (!exam) {
      ws.innerHTML = '<div class="card">Chương này chưa có bài kiểm tra.</div>';
      return;
    }

    const draft = getExamDraft(exam);
    const savedScore = state.progress.examScores[exam.id];
    const totals = computeExamTotals(exam, draft);
    const passThreshold = ch.number === DATA.chapters.length ? 80 : 75;

    const partAHtml = exam.part_a.items
      .map((it) => {
        const tts = getTts(it);
        const picked = draft.aChoices[it.num];
        const isGraded = !!draft.aGraded;
        const pts = Number(it.points) || 5;

        let inputHtml = "";
        let itemCorrect = false;
        if (it.question_type === "text") {
          const val = draft.aText[it.num] || "";
          itemCorrect = isPartATextCorrect(val, it.expected_answer);
          inputHtml = `
            <div style="margin-top:8px;">
              <input class="search-input" style="margin-bottom:0;max-width:340px;" data-exam-text="${it.num}" value="${escapeHtml(val)}" placeholder="Nhập đáp án bạn nghe được..." ${isGraded ? "disabled" : ""} />
            </div>
          `;
        } else {
          itemCorrect = Number(picked) === it.correct_index;
          inputHtml = it.options
            .map((op, opIdx) => {
              let cls = "option-btn";
              if (isGraded) {
                if (opIdx === it.correct_index) cls += " correct";
                else if (Number(picked) === opIdx) cls += " wrong";
              } else if (Number(picked) === opIdx) {
                cls += " selected";
              }
              return `<button class="${cls}" data-exam-opt="${it.num}" data-opt-idx="${opIdx}">${escapeHtml(op)}</button>`;
            })
            .join("");
        }

        const statusBadge = isGraded
          ? `<span class="exam-score-pill" style="background:var(${itemCorrect ? "--success-soft" : "--danger-soft"});color:var(${itemCorrect ? "--success" : "--danger"});">${itemCorrect ? `✅ +${pts}đ` : "❌ 0đ"}</span>`
          : "";

        return `
          <div class="exam-item">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
              <div><strong>Câu ${it.num}:</strong> ${maskPromptInText(it.text, it.target_prompt || it.lao_prompt)}</div>
              <div style="display:flex;gap:6px;align-items:center;">
                ${statusBadge}
                ${
                  tts
                    ? `<button class="btn btn-sm btn-primary" data-play-id="${it.audio_id}" data-play-target="${escapeHtml(tts)}">🔊 Nghe câu</button>
                       <a class="btn btn-sm" href="${translateUrl(tts)}" target="_blank" rel="noopener noreferrer">🌐</a>`
                    : ""
                }
              </div>
            </div>
            ${inputHtml}
            <div class="answer-box ${isGraded ? "" : "hidden"}" id="ansA-${it.num}">
              <strong>Đáp án chuẩn:</strong> ${escapeHtml(it.answer)}
            </div>
          </div>
        `;
      })
      .join("");

    const partBHtml = exam.part_b.items
      .map((it) => {
        const tts = getTts(it);
        const ansTarget = it.answer_target || it.answer_lao || it.answer_full;
        const pts = Number(it.points) || 3;
        const halfPts = Math.round((pts / 2) * 10) / 10;
        const curGrade = draft.bGrades[it.num];
        const recId = `exam_${exam.id}_b${it.num}`;

        return `
          <div class="exam-item">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
              <div><strong>Câu ${it.num} (${pts}đ):</strong> ${escapeHtml(it.text)}</div>
              <button class="btn btn-sm" data-reveal="ansB-${it.num}">👁 Xem &amp; Nghe đáp án</button>
            </div>
            ${renderRecorderHtml(recId, it.audio_id, tts, "Thu âm trả lời")}
            <div class="self-grade-row">
              <span style="font-size:0.78rem;color:var(--text-muted);">Tự chấm:</span>
              <button class="grade-chip ${curGrade === pts ? "active-good" : ""}" data-grade-b="${it.num}" data-val="${pts}">✓ Chuẩn (+${pts}đ)</button>
              <button class="grade-chip ${curGrade === halfPts ? "active-mid" : ""}" data-grade-b="${it.num}" data-val="${halfPts}">◐ Gần đúng (+${halfPts}đ)</button>
              <button class="grade-chip ${curGrade === 0 ? "active-bad" : ""}" data-grade-b="${it.num}" data-val="0">✗ Sai (0đ)</button>
            </div>
            <div class="answer-box hidden" id="ansB-${it.num}">
              <div class="target-text" style="font-size:1.3rem;font-weight:700;color:var(--primary);">${escapeHtml(ansTarget)}</div>
              ${it.answer_phonetic ? `<div style="color:var(--accent);font-style:italic;">${escapeHtml(it.answer_phonetic)}</div>` : ""}
              <div style="font-size:0.86rem;color:var(--text-muted);margin-top:4px;">${escapeHtml(it.answer_full)}</div>
              ${
                tts
                  ? `<div style="margin-top:8px;display:flex;gap:6px;">
                       <button class="btn btn-sm btn-primary" data-play-id="${it.audio_id}" data-play-target="${escapeHtml(tts)}">🔊 Nghe mẫu chuẩn</button>
                       <a class="btn btn-sm" href="${translateUrl(tts)}" target="_blank" rel="noopener noreferrer">🌐 Google Dịch</a>
                     </div>`
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");

    const partCHtml = exam.part_c.items
      .map((it) => {
        const pts = Number(it.points) || 5;
        const curGrade = draft.cGrades[it.num];
        return `
          <div class="exam-item">
            <div><strong>Câu ${it.num} (${pts}đ):</strong> ${escapeHtml(it.text)}</div>
            ${it.options.map((o) => `<div style="margin-left:14px;font-size:0.9rem;">• ${escapeHtml(o)}</div>`).join("")}
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
              <button class="btn btn-sm" data-reveal="ansC-${it.num}">👁 Xem đáp án</button>
              <button class="grade-chip ${curGrade === pts ? "active-good" : ""}" data-grade-c="${it.num}" data-val="${pts}">✓ Đúng (+${pts}đ)</button>
              <button class="grade-chip ${curGrade === 0 ? "active-bad" : ""}" data-grade-c="${it.num}" data-val="0">✗ Sai (0đ)</button>
            </div>
            <div class="answer-box hidden" id="ansC-${it.num}">${escapeHtml(it.answer)}</div>
          </div>
        `;
      })
      .join("");

    const totalAuto = Math.round((totals.scA + totals.scB + totals.scC + totals.scD) * 10) / 10;

    ws.innerHTML = `
      <div class="card" style="border-left:5px solid var(--accent);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <h3 style="margin:0 0 4px;">${escapeHtml(exam.title)}</h3>
          <p style="margin:0;color:var(--text-muted);">
            Tổng điểm 100đ • Cần đạt <strong>≥ ${passThreshold}đ</strong> để qua chương.
            ${savedScore !== undefined ? `<span class="badge-done" style="margin-left:8px;">Đã lưu: ${savedScore}/100</span>` : ""}
          </p>
        </div>
        <div class="exam-score-pill" id="liveTotalBadge">Tổng hiện tại: ${totalAuto} / 100đ</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <h3>${escapeHtml(exam.part_a.title || "Phần A (25đ)")}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm ${state.examHidePromptScript ? "btn-accent" : ""}" id="btnToggleMaskExam">${state.examHidePromptScript ? "🙈 Đang ẩn chữ gốc (Thi nghe)" : "👁 Đang hiện chữ gốc"}</button>
          <button class="btn btn-sm btn-primary" id="btnAutoGradeA">✅ Chấm điểm Phần A</button>
          <button class="btn btn-sm" id="btnResetPartA">🔄 Làm lại Phần A</button>
        </div>
      </div>
      ${partAHtml}

      <h3>${escapeHtml(exam.part_b.title || "Phần B: Phản xạ nói + Tự ghi âm (30đ)")}</h3>
      ${partBHtml}

      <h3>${escapeHtml(exam.part_c.title || "Phần C (20đ)")}</h3>
      ${partCHtml}

      <h3>${escapeHtml(exam.part_d.title || "Phần D: Đóng vai thực tế (25đ)")}</h3>
      <div class="exam-item">
        <div style="white-space:pre-line;">${escapeHtml(exam.part_d.prompt)}</div>
        ${renderRecorderHtml(`exam_${exam.id}_d`, "", "", "Thu âm bài đóng vai (1–2 phút)")}
        <div class="self-grade-row">
          <span style="font-size:0.78rem;color:var(--text-muted);">Mức tự chấm Phần D:</span>
          <button class="grade-chip ${totals.scD === 23 ? "active-good" : ""}" data-grade-d="23">Xuất sắc (23đ)</button>
          <button class="grade-chip ${totals.scD === 20 ? "active-good" : ""}" data-grade-d="20">Tốt (20đ)</button>
          <button class="grade-chip ${totals.scD === 16 ? "active-mid" : ""}" data-grade-d="16">Đạt (16đ)</button>
          <button class="grade-chip ${totals.scD === 10 ? "active-bad" : ""}" data-grade-d="10">Cần luyện (10đ)</button>
        </div>
        <div style="margin-top:10px;"><button class="btn btn-sm" data-reveal="ansD">👁 Xem hướng dẫn chấm điểm Phần D</button></div>
        <div class="answer-box hidden" id="ansD" style="white-space:pre-line;">${escapeHtml(exam.part_d.rubric)}</div>
      </div>

      <div class="card" style="margin-top:20px;">
        <h3 style="margin-top:0;">🏆 Tổng Kết &amp; Lưu Điểm Chương ${ch.number}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
          <label>Phần A (/25đ): <input type="number" id="scA" min="0" max="25" step="0.5" value="${totals.scA}" class="search-input" style="margin:4px 0 0;" /></label>
          <label>Phần B (/30đ): <input type="number" id="scB" min="0" max="30" step="0.5" value="${totals.scB}" class="search-input" style="margin:4px 0 0;" /></label>
          <label>Phần C (/20đ): <input type="number" id="scC" min="0" max="20" step="0.5" value="${totals.scC}" class="search-input" style="margin:4px 0 0;" /></label>
          <label>Phần D (/25đ): <input type="number" id="scD" min="0" max="25" step="0.5" value="${totals.scD}" class="search-input" style="margin:4px 0 0;" /></label>
        </div>
        <div style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <button class="btn btn-primary" id="btnSaveExamScore">💾 Lưu điểm bài kiểm tra</button>
          <span id="scoreResultText" style="font-weight:700;"></span>
        </div>
      </div>
    `;

    ws.querySelectorAll("[data-unmask]").forEach((el) => {
      el.addEventListener("click", () => el.classList.toggle("masked"));
    });

    ws.querySelectorAll("[data-reveal]").forEach((btn) => {
      btn.onclick = () => {
        const target = document.getElementById(btn.getAttribute("data-reveal"));
        if (target) target.classList.toggle("hidden");
      };
    });

    ws.querySelectorAll("[data-exam-opt]").forEach((btn) => {
      btn.onclick = () => {
        if (draft.aGraded) return;
        const num = Number(btn.getAttribute("data-exam-opt"));
        draft.aChoices[num] = Number(btn.getAttribute("data-opt-idx"));
        saveProgress();
        renderExamView(ws);
      };
    });

    ws.querySelectorAll("[data-exam-text]").forEach((inp) => {
      inp.addEventListener("input", (e) => {
        const num = Number(inp.getAttribute("data-exam-text"));
        draft.aText[num] = e.target.value;
        saveProgress();
      });
    });

    document.getElementById("btnToggleMaskExam").onclick = () => {
      state.examHidePromptScript = !state.examHidePromptScript;
      renderExamView(ws);
    };

    document.getElementById("btnAutoGradeA").onclick = () => {
      draft.aGraded = true;
      saveProgress();
      renderExamView(ws);
    };

    document.getElementById("btnResetPartA").onclick = () => {
      draft.aChoices = {};
      draft.aText = {};
      draft.aGraded = false;
      saveProgress();
      renderExamView(ws);
    };

    ws.querySelectorAll("[data-grade-b]").forEach((btn) => {
      btn.onclick = () => {
        const num = Number(btn.getAttribute("data-grade-b"));
        draft.bGrades[num] = Number(btn.getAttribute("data-val"));
        saveProgress();
        renderExamView(ws);
      };
    });

    ws.querySelectorAll("[data-grade-c]").forEach((btn) => {
      btn.onclick = () => {
        const num = Number(btn.getAttribute("data-grade-c"));
        draft.cGrades[num] = Number(btn.getAttribute("data-val"));
        saveProgress();
        renderExamView(ws);
      };
    });

    ws.querySelectorAll("[data-grade-d]").forEach((btn) => {
      btn.onclick = () => {
        draft.dScore = Number(btn.getAttribute("data-grade-d"));
        saveProgress();
        renderExamView(ws);
      };
    });

    bindPlayButtons(ws);
    bindRecorderEvents(ws, () => renderExamView(ws));

    const computeManualTotal = () => {
      const a = Math.min(25, Math.max(0, Number(document.getElementById("scA").value) || 0));
      const b = Math.min(30, Math.max(0, Number(document.getElementById("scB").value) || 0));
      const c = Math.min(20, Math.max(0, Number(document.getElementById("scC").value) || 0));
      const d = Math.min(25, Math.max(0, Number(document.getElementById("scD").value) || 0));
      return Math.round((a + b + c + d) * 10) / 10;
    };

    ["scA", "scB", "scC", "scD"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener("input", () => {
          if (id === "scD") {
            draft.dScore = Math.min(25, Math.max(0, Number(el.value) || 0));
            saveProgress();
          }
          const badge = document.getElementById("liveTotalBadge");
          if (badge) badge.textContent = `Tổng hiện tại: ${computeManualTotal()} / 100đ`;
        });
      }
    });

    document.getElementById("btnSaveExamScore").onclick = () => {
      const total = computeManualTotal();
      state.progress.examScores[exam.id] = total;
      if (total >= passThreshold) {
        state.progress.completedUnits[exam.id] = true;
      }
      saveProgress();
      renderSidebar();
      const out = document.getElementById("scoreResultText");
      out.textContent =
        total >= passThreshold
          ? `🎉 Tổng ${total}/100đ — ĐẠT CHUẨN QUA CHƯƠNG!`
          : `📌 Tổng ${total}/100đ — Cần ôn lại phần chưa vững (< ${passThreshold}đ).`;
      out.style.color = total >= passThreshold ? "var(--success)" : "var(--warn)";
    };
  }

  /* ==================== Dictionary Search ==================== */

  function renderDictView(ws) {
    const allItems = [];
    (DATA.pocket_dict || []).forEach((d) =>
      allItems.push({ ...d, source: `Sổ tay • ${d.category}` })
    );
    DATA.chapters.forEach((ch) => {
      ch.lessons.forEach((les) => {
        les.vocab.forEach((v) =>
          allItems.push({ ...v, source: `Ch.${ch.number} Bài ${les.number}` })
        );
      });
    });

    const ph =
      PWA_CFG.dict_placeholder || "Gõ tiếng Việt, phiên âm hoặc chữ gốc để tra cứu...";

    ws.innerHTML = `
      <div class="card">
        <input class="search-input" id="dictSearchInput" placeholder="${escapeHtml(ph)}" />
        <div id="dictCountLabel" style="font-size:0.84rem;color:var(--text-muted);">Hiển thị ${allItems.length} mục từ vựng</div>
      </div>
      <div class="vocab-grid" id="dictGrid"></div>
    `;

    const grid = document.getElementById("dictGrid");
    const countLabel = document.getElementById("dictCountLabel");
    const renderFiltered = (query) => {
      const q = (query || "").trim().toLowerCase();
      const matched = q
        ? allItems.filter(
            (x) =>
              x.vietnamese.toLowerCase().includes(q) ||
              (x.phonetic && x.phonetic.toLowerCase().includes(q)) ||
              getTarget(x).toLowerCase().includes(q) ||
              (x.note && x.note.toLowerCase().includes(q))
          )
        : allItems.slice(0, 90);

      countLabel.textContent = q
        ? `Tìm thấy ${matched.length} kết quả cho "${query}"`
        : `Hiển thị 90 mục sinh tồn đầu tiên (trên tổng ${allItems.length} mục — hãy gõ từ khóa để tìm tất cả)`;

      grid.innerHTML = matched
        .map((it) => {
          const tgt = getTarget(it);
          const tts = getTts(it);
          return `
            <div class="vocab-card">
              <div>
                <div class="vc-top">
                  <div class="vc-vi">${escapeHtml(it.vietnamese)}</div>
                  <span style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(it.source)}</span>
                </div>
                <div class="vc-target target-text">${escapeHtml(tgt)}</div>
                <div class="vc-phonetic">${escapeHtml(it.phonetic)}</div>
                ${it.note ? `<div class="vc-note">${escapeHtml(it.note)}</div>` : ""}
              </div>
              <div class="vc-actions">
                <button class="btn btn-sm btn-primary" data-play-id="${it.audio_id}" data-play-target="${escapeHtml(tts)}">🔊 Nghe</button>
                <a class="btn btn-sm" href="${translateUrl(tts)}" target="_blank" rel="noopener noreferrer">🌐 Dịch</a>
              </div>
            </div>
          `;
        })
        .join("");

      bindPlayButtons(grid);
    };

    renderFiltered("");
    document.getElementById("dictSearchInput").addEventListener("input", (e) => {
      renderFiltered(e.target.value);
    });
  }

  /* ==================== Online Auth, Activation Gate & Cloud Sync ==================== */

  function renderLockedChapterView(ws) {
    const ch = state.lockedChapter;
    if (!ch) return;
    const titlesHtml = (ch.preview_lesson_titles || [])
      .map((t) => `<div class="slide-tip-item">🔒 ${escapeHtml(t)}</div>`)
      .join("");
    const webCfg = META.web || {};
    ws.innerHTML = `
      <div class="quiz-card" style="border-left:5px solid var(--accent);">
        <div class="slide-tag">Nội dung bản trả phí</div>
        <h2 style="margin:10px 0 6px;">🔒 Chương ${ch.number}: ${escapeHtml(ch.title)}</h2>
        <p style="color:var(--text-muted);margin:0 0 12px;">
          Bao gồm <strong>${ch.lesson_count || 0} bài học</strong> •
          <strong>${ch.vocab_count || 0} từ vựng</strong> •
          <strong>${ch.sentence_count || 0} mẫu câu</strong> •
          <strong>${ch.dialogue_count || 0} lượt hội thoại</strong>${ch.has_exam ? " • 1 bài kiểm tra 100đ" : ""}.
        </p>
        ${titlesHtml ? `<div class="slide-tips-list" style="margin:12px 0;">${titlesHtml}</div>` : ""}
        <p style="font-size:0.88rem;color:var(--text-muted);">${escapeHtml(webCfg.contact_hint || "")}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;">
          <button class="btn btn-primary" id="btnOpenUnlockModal">🔓 Đăng nhập / Nhập mã kích hoạt</button>
          <button class="btn" id="btnBackToFree">← Về Chương 1 học thử miễn phí</button>
        </div>
      </div>
    `;
    document.getElementById("btnOpenUnlockModal").onclick = () => openAuthModal("activate");
    document.getElementById("btnBackToFree").onclick = () => {
      state.viewType = "lesson";
      state.chapterIdx = 0;
      state.lessonIdx = 0;
      state.slideIdx = 0;
      renderApp();
    };
  }

  let accountExpanded = false;
  function renderAccountBox() {
    const box = document.getElementById("accountBox");
    if (!box) return;
    const isPreview = META.access_mode === "preview";
    if (!authState.serverAvailable && !isPreview) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");

    if (authState.authenticated && authState.user && authState.unlocked) {
      const u = authState.user;
      const isPro = authState.tier === "pro";
      const tierBadge = isPro
        ? `<span class="badge-tier badge-pro">👑 PRO VIP</span>`
        : `<span class="badge-tier badge-std">⭐ STANDARD</span>`;
      const tierDesc = isPro
        ? "Đã mở khóa trọn gói PRO VIP (Kèm AI Lab)"
        : "Đã mở khóa trọn gói Standard (8 Chương trọn đời)";
      box.innerHTML = `
        <button class="acc-head" id="btnAccToggle" type="button" aria-expanded="${accountExpanded ? "true" : "false"}" title="Tài khoản">
          <span class="acc-email">${escapeHtml(u.email)}</span>
          ${tierBadge}
          <span class="acc-caret">${accountExpanded ? "▴" : "▾"}</span>
        </button>
        <div class="acc-more ${accountExpanded ? "" : "hidden"}">
          <div style="color:var(--text-muted);">${tierDesc} (${u.active_devices || 1}/${u.max_devices || 3} thiết bị)</div>
          <div class="acc-actions">
            ${!isPro ? `<button class="btn btn-sm btn-gold" id="btnUpgradePro" type="button" title="Nhập mã LAO-PRO để nâng cấp">👑 Lên PRO</button>` : ""}
            <button class="btn btn-sm" id="btnSyncNow" type="button">☁️ Đồng bộ</button>
            <button class="btn btn-sm" id="btnLogout" type="button">Đăng xuất</button>
            <button class="btn btn-sm" id="btnLogoutAll" type="button" title="Thu hồi phiên trên mọi thiết bị">🔒 Thoát hết</button>
          </div>
        </div>
      `;
      document.getElementById("btnAccToggle").onclick = () => {
        accountExpanded = !accountExpanded;
        renderAccountBox();
      };
      if (!isPro) {
        const upBtn = document.getElementById("btnUpgradePro");
        if (upBtn) upBtn.onclick = () => openAuthModal("activate");
      }
      document.getElementById("btnSyncNow").onclick = () => syncProgressInteractive();
      document.getElementById("btnLogout").onclick = () => logoutSession(false);
      document.getElementById("btnLogoutAll").onclick = () => logoutSession(true);
      return;
    }

    if (authState.authenticated && authState.user && !authState.unlocked) {
      box.innerHTML = `
        <div class="acc-email">👤 ${escapeHtml(authState.user.email)}</div>
        <div style="color:var(--warn);">Tài khoản chưa kích hoạt khóa này</div>
        <div class="acc-actions">
          <button class="btn btn-sm btn-primary" id="btnOpenAuthBox" type="button">🎟️ Nhập mã kích hoạt</button>
          <a class="btn btn-sm" href="../#bang-gia" title="Xem bảng giá khóa học" style="text-decoration:none;">ℹ️ Bảng giá</a>
          <button class="btn btn-sm" id="btnLogout" type="button">Đăng xuất</button>
        </div>
      `;
      document.getElementById("btnOpenAuthBox").onclick = () => openAuthModal("activate");
      document.getElementById("btnLogout").onclick = () => logoutSession(false);
      return;
    }

    const freeList = (META.free_chapters || [1]).join(", ");
    box.innerHTML = `
      <div><strong>🎁 Học thử miễn phí: Chương ${escapeHtml(freeList)}</strong></div>
      <div style="color:var(--text-muted);margin-top:2px;">${escapeHtml((META.web && META.web.price_note) || "Nhập mã kích hoạt để mở toàn bộ khóa học.")}</div>
      <div class="acc-actions">
        <button class="btn btn-sm btn-primary" id="btnOpenAuthBox" type="button">🔑 Đăng nhập / Kích hoạt</button>
        <a class="btn btn-sm" href="../#bang-gia" title="Xem bảng giá và quyền lợi 2 gói" style="text-decoration:none;">ℹ️ Bảng giá</a>
      </div>
    `;
    document.getElementById("btnOpenAuthBox").onclick = () => openAuthModal("activate");
  }

  /* ==================== Policy & Legal (Nghị định 13/2023/NĐ-CP) ==================== */
  let activePolicyTab = "terms";

  const POLICY_SECTIONS = {
    terms: `
      <div class="policy-section">
        <h4>1. Phạm vi &amp; Đối tượng áp dụng</h4>
        <p>Điều khoản này áp dụng cho mọi cá nhân truy cập, học thử hoặc kích hoạt bản quyền khóa học <strong>"Tự Học Nghe – Nói Tiếng Lào Cho Người Việt"</strong> trên nền tảng Web/PWA.</p>
      </div>
      <div class="policy-section">
        <h4>2. Quyền sở hữu trí tuệ giáo trình</h4>
        <p>Toàn bộ nội dung khóa học bao gồm 8 chương (27 bài học), 840 thẻ từ vựng audio người bản xứ, hệ thống video shadowing, bài kiểm tra sát hạch và cấu trúc dữ liệu thuộc quyền sở hữu trí tuệ độc quyền của ban phát triển dự án. Người học được cấp quyền sử dụng cá nhân (Personal Non-commercial License), <strong>nghiêm cấm mọi hành vi trích xuất, sao chép, chia sẻ công khai hoặc bán lại dưới mọi hình thức</strong>.</p>
      </div>
      <div class="policy-section">
        <h4>3. Quy định Kích hoạt &amp; Mã bản quyền (License Key)</h4>
        <ul>
          <li>Mỗi mã kích hoạt chỉ được gắn cố định với <strong>01 địa chỉ email duy nhất</strong> của học viên.</li>
          <li>Học viên được phép đăng nhập và đồng bộ tiến độ học trên tối đa <strong>03 thiết bị cá nhân</strong> (Điện thoại, Máy tính bảng, Máy tính xách tay/PC).</li>
          <li>Hệ thống tự động phát hiện và khóa vĩnh viễn các mã kích hoạt bị phát tán công khai hoặc có dấu hiệu chia sẻ bất thường.</li>
        </ul>
      </div>
      <div class="policy-section">
        <h4>4. Phân tầng Gói dịch vụ (Standard vs. Pro)</h4>
        <p><strong>Gói Tiêu Chuẩn (Standard):</strong> Mở toàn bộ 8 chương học, 840 flashcard audio bản xứ, tính năng tự ghi âm đối chiếu cơ bản và đồng bộ tiến trình học.</p>
        <p><strong>Gói Chuyên Sâu (Pro AI Lab):</strong> Bao gồm toàn bộ quyền lợi Standard, tích hợp thêm Phòng Luyện Nói AI (so sánh sóng âm, chấm điểm % độ chuẩn xác thanh điệu, phân tích phát âm chi tiết) và kết nối Bot nhắc học, đố vui 1-1.</p>
      </div>
    `,
    privacy: `
      <div class="policy-section">
        <h4>1. Tuân thủ Nghị định 13/2023/NĐ-CP</h4>
        <p>Chúng tôi cam kết bảo vệ dữ liệu cá nhân của học viên theo đúng quy định tại <strong>Nghị định số 13/2023/NĐ-CP</strong> của Chính phủ nước Cộng hòa Xã hội Chủ nghĩa Việt Nam về Bảo vệ dữ liệu cá nhân.</p>
      </div>
      <div class="policy-section">
        <h4>2. Dữ liệu cá nhân chúng tôi thu thập</h4>
        <ul>
          <li><strong>Thông tin tài khoản:</strong> Địa chỉ Email (dùng làm định danh duy nhất), Tên hiển thị, Mật khẩu được mã hóa an toàn một chiều qua thuật toán <code>scrypt</code>.</li>
          <li><strong>Dữ liệu tiến trình học tập:</strong> Các bài học đã hoàn thành, điểm kiểm tra trắc nghiệm, danh sách từ vựng yêu thích, chuỗi ngày học liên tục (streak).</li>
          <li><strong>Dữ liệu âm thanh phát âm:</strong> Các đoạn ghi âm giọng đọc do người học tự thực hiện khi luyện tập.</li>
        </ul>
      </div>
      <div class="policy-section">
        <h4>3. Mục đích xử lý dữ liệu</h4>
        <p>Dữ liệu cá nhân chỉ được sử dụng cho các mục đích hợp pháp sau:</p>
        <ul>
          <li>Xác thực bản quyền khóa học và bảo vệ tài khoản của bạn.</li>
          <li>Đồng bộ hóa dữ liệu tiến trình học tập liên tục giữa các thiết bị của bạn.</li>
          <li>Phân tích tín hiệu âm học nhằm đưa ra điểm số và gợi ý phát âm chuẩn cho cá nhân bạn.</li>
        </ul>
      </div>
      <div class="policy-section">
        <h4>4. Cam kết bảo mật &amp; Không chia sẻ với bên thứ ba</h4>
        <p>Chúng tôi <strong>tuyệt đối KHÔNG bán, cho thuê, trao đổi</strong> thông tin cá nhân hoặc dữ liệu học tập của bạn cho bất kỳ bên thứ ba nào vì mục đích thương mại hoặc quảng cáo. Mọi kết nối truyền tải đều được mã hóa bằng giao thức HTTPS/TLS.</p>
      </div>
      <div class="policy-section">
        <h4>5. Quyền của chủ thể dữ liệu (Data Subject Rights)</h4>
        <p>Theo quy định của pháp luật Việt Nam, bạn có các quyền đầy đủ sau:</p>
        <ul>
          <li><strong>Quyền được biết &amp; đồng ý:</strong> Được thông báo minh bạch trước khi thu thập dữ liệu (thông qua văn bản này).</li>
          <li><strong>Quyền trích xuất &amp; tải về:</strong> Bạn có thể xuất toàn bộ lịch sử học tập ra file JSON bất kỳ lúc nào qua nút <em>"💾 Lưu"</em>.</li>
          <li><strong>Quyền yêu cầu xóa dữ liệu:</strong> Bạn có quyền yêu cầu xóa vĩnh viễn tài khoản và toàn bộ dữ liệu liên quan khỏi hệ thống máy chủ.</li>
        </ul>
      </div>
    `,
    audio: `
      <div class="policy-section">
        <h4>1. Bảo mật dữ liệu giọng nói học viên</h4>
        <p>Khi sử dụng chức năng <strong>Tự ghi âm so sánh</strong> hoặc <strong>Phòng Luyện Phát Âm Pro</strong>, trình duyệt sẽ yêu cầu quyền truy cập Micro của bạn.</p>
      </div>
      <div class="policy-section">
        <h4>2. Cơ chế lưu trữ âm thanh</h4>
        <ul>
          <li>Bản ghi âm giọng nói của bạn được xử lý cục bộ trên thiết bị của bạn (thông qua Web Audio API &amp; Blob/IndexedDB).</li>
          <li>Khi gửi dữ liệu so khớp lên máy chủ (cho gói Pro), file âm thanh chỉ được dùng để tính toán chỉ số tương đồng với giọng mẫu và trả về điểm số phần trăm (%).</li>
          <li>Chúng tôi <strong>không lưu trữ vĩnh viễn và không công khai bản ghi âm giọng nói của bạn</strong> cho người dùng khác.</li>
          <li>Giọng nói của bạn tuyệt đối không được sử dụng để huấn luyện các mô hình AI thương mại công cộng nếu chưa có sự cho phép bằng văn bản riêng.</li>
        </ul>
      </div>
      <div class="policy-section">
        <h4>3. Quyền kiểm soát micro</h4>
        <p>Bạn có toàn quyền thu âm lại, xóa bản thu cũ ngay trên giao diện hoặc tắt quyền micro trong phần cài đặt trình duyệt bất cứ lúc nào.</p>
      </div>
    `
  };

  function openPolicyModal(tab = "terms") {
    activePolicyTab = tab;
    const modal = document.getElementById("policyModal");
    if (!modal) return;
    renderPolicyModalBody();
    modal.classList.remove("hidden");
  }

  function closePolicyModal() {
    const modal = document.getElementById("policyModal");
    if (modal) modal.classList.add("hidden");
  }

  function renderPolicyModalBody() {
    const tabsEl = document.getElementById("policyModalTabs");
    if (tabsEl) {
      tabsEl.querySelectorAll("button[data-policy-tab]").forEach((btn) => {
        const t = btn.getAttribute("data-policy-tab");
        if (t === activePolicyTab) {
          btn.classList.add("btn-primary");
        } else {
          btn.classList.remove("btn-primary");
        }
      });
    }
    const bodyEl = document.getElementById("policyModalBody");
    if (bodyEl) {
      bodyEl.innerHTML = POLICY_SECTIONS[activePolicyTab] || POLICY_SECTIONS.terms;
    }
  }

  function openAuthModal(tab) {
    const modal = document.getElementById("authModal");
    if (!modal) return;
    authState.tab = tab || "activate";
    modal.classList.remove("hidden");
    renderAuthModalBody();
  }

  function closeAuthModal() {
    const modal = document.getElementById("authModal");
    if (modal) modal.classList.add("hidden");
  }

  function setAuthMessage(msg, isOk) {
    const el = document.getElementById("authFormMsg");
    if (!el) return;
    el.textContent = msg;
    el.className = `auth-msg ${isOk ? "ok" : "err"}`;
    el.classList.remove("hidden");
  }

  function renderAuthModalBody() {
    const tabsEl = document.getElementById("authModalTabs");
    const bodyEl = document.getElementById("authModalBody");
    const subEl = document.getElementById("authModalSub");
    if (!tabsEl || !bodyEl) return;

    if (!authState.serverAvailable) {
      tabsEl.classList.add("hidden");
      bodyEl.innerHTML = `
        <div class="auth-msg err">
          Chế độ đăng nhập &amp; kiểm tra mã kích hoạt cần chạy qua máy chủ Web (<code>node Web-Server/server.js</code>) hoặc bản triển khai trực tuyến HTTPS.
        </div>
      `;
      return;
    }

    tabsEl.classList.remove("hidden");
    tabsEl.querySelectorAll("[data-auth-tab]").forEach((btn) => {
      const active = btn.getAttribute("data-auth-tab") === authState.tab;
      btn.classList.toggle("btn-primary", active);
      btn.onclick = () => {
        authState.tab = btn.getAttribute("data-auth-tab");
        renderAuthModalBody();
      };
    });

    if (authState.authenticated && authState.user && !authState.unlocked) {
      tabsEl.classList.add("hidden");
      if (subEl) {
        subEl.textContent = `Đang đăng nhập: ${authState.user.email}. Nhập mã kích hoạt để mở khóa toàn bộ chương.`;
      }
      bodyEl.innerHTML = `
        <form class="auth-form" id="formActivateOnly">
          <label>Mã kích hoạt khóa học
            <input type="text" id="actKeyOnly" required placeholder="VD: LAO-STD-XXXX-XXXX hoặc LAO-PRO-XXXX-XXXX" autocomplete="off" />
          </label>
          <div class="auth-msg hidden" id="authFormMsg"></div>
          <button class="btn btn-primary" type="submit">🎟️ Xác nhận kích hoạt</button>
        </form>
      `;
      document.getElementById("formActivateOnly").onsubmit = async (e) => {
        e.preventDefault();
        await submitAuthForm("/api/auth/activate", {
          license_key: document.getElementById("actKeyOnly").value.trim(),
        });
      };
      return;
    }

    if (authState.tab === "login") {
      bodyEl.innerHTML = `
        <form class="auth-form" id="formAuthLogin">
          <label>Email đã đăng ký
            <input type="email" id="loginEmail" required placeholder="ban@email.com" autocomplete="email" />
          </label>
          <label>Mật khẩu
            <input type="password" id="loginPassword" required minlength="8" placeholder="Tối thiểu 8 ký tự" autocomplete="current-password" />
          </label>
          <div class="auth-msg hidden" id="authFormMsg"></div>
          <button class="btn btn-primary" type="submit">🔓 Đăng nhập ngay</button>
        </form>
      `;
      document.getElementById("formAuthLogin").onsubmit = async (e) => {
        e.preventDefault();
        await submitAuthForm("/api/auth/login", {
          email: document.getElementById("loginEmail").value.trim(),
          password: document.getElementById("loginPassword").value,
        });
      };
    } else {
      bodyEl.innerHTML = `
        <form class="auth-form" id="formAuthActivate">
          <label>Email của bạn (gắn vĩnh viễn với mã kích hoạt)
            <input type="email" id="regEmail" required placeholder="ban@email.com" autocomplete="email" />
          </label>
          <label>Tạo mật khẩu (để đăng nhập trên thiết bị khác)
            <input type="password" id="regPassword" required minlength="8" placeholder="Tối thiểu 8 ký tự" autocomplete="new-password" />
          </label>
          <label>Mã kích hoạt (License Key)
            <input type="text" id="regLicense" required placeholder="VD: LAO-STD-XXXX-XXXX hoặc LAO-PRO-XXXX-XXXX" autocomplete="off" />
          </label>
          <div class="auth-policy-group">
            <label class="auth-policy-label">
              <input type="checkbox" id="regConsentPolicy" required />
              <span>Tôi đã đọc và đồng ý với <button type="button" class="btn-link-policy" id="btnOpenPolicyFromReg">Điều khoản dịch vụ &amp; Chính sách bảo mật</button> (theo Nghị định 13/2023/NĐ-CP).</span>
            </label>
          </div>
          <div class="auth-msg hidden" id="authFormMsg"></div>
          <button class="btn btn-primary" type="submit">✨ Kích hoạt &amp; Mở toàn khóa</button>
        </form>
      `;
      const linkPolicy = document.getElementById("btnOpenPolicyFromReg");
      if (linkPolicy) linkPolicy.onclick = () => openPolicyModal("privacy");

      document.getElementById("formAuthActivate").onsubmit = async (e) => {
        e.preventDefault();
        const consent = document.getElementById("regConsentPolicy")?.checked;
        if (!consent) {
          setAuthMessage("Vui lòng tích chọn đồng ý với Điều khoản dịch vụ và Chính sách bảo vệ dữ liệu cá nhân.", false);
          return;
        }
        await submitAuthForm("/api/auth/register", {
          email: document.getElementById("regEmail").value.trim(),
          password: document.getElementById("regPassword").value,
          license_key: document.getElementById("regLicense").value.trim(),
          consent: true,
        });
      };
    }
  }

  async function submitAuthForm(endpoint, payload) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setAuthMessage(data.error || `Lỗi xác thực (${resp.status}).`, false);
        return;
      }
      authState.authenticated = true;
      authState.unlocked = !!data.unlocked;
      authState.tier = data.tier || (data.user && data.user.tier) || null;
      authState.user = data.user || null;

      if (authState.unlocked) {
        setAuthMessage("✅ Xác thực thành công! Đang tải giáo trình đầy đủ...", true);
        await loadUnlockedCurriculumAndProgress();
        closeAuthModal();
      } else {
        setAuthMessage("Đã đăng nhập! Vui lòng nhập mã kích hoạt để mở toàn bộ chương.", true);
        renderAuthModalBody();
      }
      renderApp();
    } catch (_) {
      setAuthMessage("Không kết nối được tới máy chủ xác thực.", false);
    }
  }

  async function syncProgressInteractive() {
    if (!authState.serverAvailable || !authState.authenticated) return;
    try {
      const resp = await fetch("/api/progress", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.progress),
      });
      if (resp.ok) setPwaStatus("☁️ Đã đồng bộ tiến trình lên tài khoản.");
    } catch (_) {
      setPwaStatus("Không đồng bộ được khi đang mất mạng.");
    }
  }

  async function loadUnlockedCurriculumAndProgress() {
    try {
      const curResp = await fetch("/api/curriculum", { credentials: "same-origin", cache: "no-store" });
      if (curResp.ok) {
        const fullData = await curResp.json();
        if (fullData && fullData.chapters) {
          hydrateCurriculumData(fullData);
          applyDynamicBrandingAndFonts();
          if (state.viewType === "locked" && state.lockedChapter) {
            const idx = DATA.chapters.findIndex((c) => c.number === state.lockedChapter.number);
            if (idx >= 0) {
              state.viewType = "lesson";
              state.chapterIdx = idx;
              state.lessonIdx = 0;
              state.slideIdx = 0;
              state.lockedChapter = null;
            }
          }
        }
      }
      const progResp = await fetch("/api/progress", { credentials: "same-origin", cache: "no-store" });
      if (progResp.ok) {
        const pData = await progResp.json();
        if (pData && pData.progress) {
          state.progress = mergeProgress(state.progress, pData.progress);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
        }
      }
    } catch (_) {
      // Ignore network hiccup
    }
  }

  async function logoutSession(allDevices) {
    try {
      await fetch(allDevices ? "/api/auth/logout-all" : "/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch (_) {
      // Continue clearing client state
    }
    if ("caches" in window) {
      await caches.delete(MEDIA_CACHE_NAME).catch(() => {});
    }
    location.reload();
  }

  async function initOnlineAuth() {
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    try {
      const resp = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      if (!resp.ok) return;
      const ctype = resp.headers.get("content-type") || "";
      if (!ctype.includes("application/json")) return;
      const data = await resp.json();
      authState.serverAvailable = true;
      authState.authenticated = !!data.authenticated;
      authState.unlocked = !!data.unlocked;
      authState.tier = data.tier || (data.user && data.user.tier) || null;
      authState.user = data.user || null;
      if (authState.unlocked && META.access_mode === "preview") {
        await loadUnlockedCurriculumAndProgress();
      } else if (authState.authenticated) {
        const progResp = await fetch("/api/progress", { credentials: "same-origin", cache: "no-store" });
        if (progResp.ok) {
          const pData = await progResp.json();
          if (pData && pData.progress) {
            state.progress = mergeProgress(state.progress, pData.progress);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
          }
        }
      }
      renderApp();
    } catch (_) {
      // Running on static server without /api/ — keep standalone mode
    }
  }

  /* ==================== App Render & Global Events ==================== */

  function renderWorkspace() {
    clearRecallTimer();
    const ws = document.getElementById("workspace");
    if (state.viewType === "locked") {
      renderLockedChapterView(ws);
      return;
    }
    if (state.viewType === "dict") {
      renderDictView(ws);
      return;
    }
    if (state.viewType === "exam") {
      renderExamView(ws);
      return;
    }
    const les = getActiveLesson();
    if (state.mode === "slides") renderSlideMode(ws, les);
    else if (state.mode === "vocab") renderVocabMode(ws, les);
    else if (state.mode === "dialogue") renderDialogueMode(ws, les);
    else if (state.mode === "quiz") renderQuizMode(ws, les);
    else renderPracticeMode(ws, les);
  }

  function renderApp() {
    document.documentElement.setAttribute("data-theme", state.theme);
    updateOverallBar();
    renderAccountBox();
    renderSidebar();
    renderTopbar();
    renderWorkspace();
    setTimeout(() => {
      document.querySelectorAll("[data-waveform-canvas]").forEach((canvas) => {
        const recId = canvas.getAttribute("data-waveform-canvas");
        const saved = recordings.get(recId);
        if (saved && saved.assessment && saved.assessment.refEnv && saved.assessment.userEnv) {
          drawWaveform(canvas, saved.assessment.refEnv, saved.assessment.userEnv);
        }
      });
    }, 40);
  }

  function bindGlobalEvents() {
    const closeModalBtn = document.getElementById("btnCloseAuthModal");
    if (closeModalBtn) closeModalBtn.onclick = closeAuthModal;
    const authModal = document.getElementById("authModal");
    if (authModal) {
      authModal.addEventListener("click", (e) => {
        if (e.target === authModal) closeAuthModal();
      });
    }

    const closeProBtn = document.getElementById("btnCloseProModal");
    if (closeProBtn) closeProBtn.onclick = closeProModal;
    const proModal = document.getElementById("proModal");
    if (proModal) {
      proModal.addEventListener("click", (e) => {
        if (e.target === proModal) closeProModal();
      });
    }

    const formProUpgrade = document.getElementById("formProUpgrade");
    if (formProUpgrade) {
      formProUpgrade.onsubmit = async (e) => {
        e.preventDefault();
        const key = document.getElementById("proUpgradeKey").value.trim();
        const msgEl = document.getElementById("proUpgradeMsg");
        if (!key) return;
        try {
          const resp = await fetch("/api/auth/activate", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ license_key: key }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            if (msgEl) {
              msgEl.textContent = data.error || "Mã kích hoạt không hợp lệ.";
              msgEl.className = "auth-msg auth-err";
              msgEl.classList.remove("hidden");
            }
            return;
          }
          authState.authenticated = true;
          authState.unlocked = !!data.unlocked;
          authState.tier = data.tier || "pro";
          authState.user = data.user || null;
          if (msgEl) {
            msgEl.textContent = "🎉 Nâng cấp Gói PRO VIP thành công!";
            msgEl.className = "auth-msg auth-ok";
            msgEl.classList.remove("hidden");
          }
          setTimeout(() => {
            closeProModal();
            renderApp();
          }, 800);
        } catch (_) {
          if (msgEl) {
            msgEl.textContent = "Không kết nối được tới máy chủ.";
            msgEl.className = "auth-msg auth-err";
            msgEl.classList.remove("hidden");
          }
        }
      };
    }

    const btnShowPolicy = document.getElementById("btnShowPolicy");
    if (btnShowPolicy) btnShowPolicy.onclick = () => openPolicyModal("terms");

    const closePolicyBtn = document.getElementById("btnClosePolicyModal");
    if (closePolicyBtn) closePolicyBtn.onclick = closePolicyModal;
    const acceptPolicyBtn = document.getElementById("btnAcceptPolicyClose");
    if (acceptPolicyBtn) acceptPolicyBtn.onclick = closePolicyModal;

    const policyModal = document.getElementById("policyModal");
    if (policyModal) {
      policyModal.addEventListener("click", (e) => {
        if (e.target === policyModal) closePolicyModal();
      });
    }

    const policyTabs = document.getElementById("policyModalTabs");
    if (policyTabs) {
      policyTabs.querySelectorAll("button[data-policy-tab]").forEach((btn) => {
        btn.onclick = () => {
          activePolicyTab = btn.getAttribute("data-policy-tab") || "terms";
          renderPolicyModalBody();
        };
      });
    }

    const sidebarEl = document.getElementById("sidebar");
    const closeSidebar = () => sidebarEl.classList.remove("open");
    document.getElementById("btnMobileMenu").onclick = () => sidebarEl.classList.toggle("open");
    const closeSidebarBtn = document.getElementById("btnCloseSidebar");
    if (closeSidebarBtn) closeSidebarBtn.onclick = closeSidebar;
    const sidebarBackdrop = document.getElementById("sidebarBackdrop");
    if (sidebarBackdrop) sidebarBackdrop.onclick = closeSidebar;

    const moreToolsBtn = document.getElementById("btnMoreTools");
    if (moreToolsBtn) {
      moreToolsBtn.onclick = () => {
        const panel = document.getElementById("moreTools");
        const open = panel.classList.toggle("hidden") === false;
        moreToolsBtn.setAttribute("aria-expanded", open ? "true" : "false");
        moreToolsBtn.textContent = open ? "▴" : "▾";
      };
    }

    document.getElementById("btnShowDict").onclick = () => {
      stopAllPlayback();
      state.viewType = "dict";
      document.getElementById("sidebar").classList.remove("open");
      renderApp();
    };

    document.getElementById("btnToggleTheme").onclick = () => {
      state.theme = state.theme === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, state.theme);
      document.documentElement.setAttribute("data-theme", state.theme);
    };

    document.getElementById("btnExportProgress").onclick = () => {
      const blob = new Blob([JSON.stringify(state.progress, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = PWA_CFG.export_filename || "tien-trinh-hoc.json";
      a.click();
    };

    document.getElementById("btnInstallPwa").onclick = async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      document.getElementById("btnInstallPwa").classList.add("hidden");
    };

    document.getElementById("btnCacheOffline").onclick = () => {
      cacheCurrentCourseAudioOffline();
    };

    document.getElementById("toggleTarget").onclick = () => {
      state.showTarget = !state.showTarget;
      renderTopbar();
      renderWorkspace();
    };
    document.getElementById("togglePhonetic").onclick = () => {
      state.showPhonetic = !state.showPhonetic;
      renderTopbar();
      renderWorkspace();
    };
    document.getElementById("toggleMeaning").onclick = () => {
      state.showMeaning = !state.showMeaning;
      renderTopbar();
      renderWorkspace();
    };
    document.getElementById("toggleSlowSpeed").onclick = () => {
      state.slowSpeed = !state.slowSpeed;
      renderTopbar();
    };
    document.getElementById("btnMarkUnitDone").onclick = () => {
      const id = getActiveUnitId();
      if (!id) return;
      state.progress.completedUnits[id] = !state.progress.completedUnits[id];
      saveProgress();
      renderSidebar();
      renderTopbar();
    };

    document.getElementById("modeTabs").querySelectorAll(".mode-tab").forEach((tab) => {
      tab.onclick = () => {
        stopAllPlayback();
        state.mode = tab.getAttribute("data-mode");
        renderTopbar();
        renderWorkspace();
      };
    });

    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      if (state.viewType !== "lesson" || state.mode !== "slides") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        clearRecallTimer();
        stopActiveRecording();
        state.slideIdx++;
        renderWorkspace();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        clearRecallTimer();
        stopActiveRecording();
        state.slideIdx--;
        renderWorkspace();
      } else if (e.key === " ") {
        e.preventDefault();
        document.querySelectorAll(".slide-stage .maskable").forEach((el) => el.classList.remove("masked"));
      } else if (e.key.toLowerCase() === "r") {
        const audioBtn = document.getElementById("btnSlideAudio");
        if (audioBtn) audioBtn.click();
      }
    });
  }

  applyDynamicBrandingAndFonts();
  bindGlobalEvents();
  registerPWA();
  renderApp();
  initOnlineAuth();
})();

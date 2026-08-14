"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Screen = "script" | "studio" | "preview";
type FacingMode = "user" | "environment";
type Quality = "720" | "1080";
type VideoRatio = "original" | "9:16" | "3:4" | "1:1";

type Preferences = {
  fontSize: number;
  scrollSpeed: number;
  promptTop: number;
  promptWidth: number;
  previewMirror: boolean;
  recordMirror: boolean;
  quality: Quality;
  videoRatio: VideoRatio;
};

const DEFAULT_SCRIPT = "";
const DEFAULT_PREFERENCES: Preferences = {
  fontSize: 34,
  scrollSpeed: 34,
  promptTop: 18,
  promptWidth: 82,
  previewMirror: true,
  recordMirror: false,
  quality: "1080",
  videoRatio: "original",
};

const VIDEO_RATIO_OPTIONS: { value: VideoRatio; label: string }[] = [
  { value: "original", label: "完整" },
  { value: "9:16", label: "9:16" },
  { value: "3:4", label: "3:4" },
  { value: "1:1", label: "1:1" },
];

const sourceCaptureWidth = (quality: Quality) =>
  quality === "1080" ? 1080 : 720;

const fixedOutputSize = (quality: Quality, ratio: Exclude<VideoRatio, "original">) => {
  const shortEdge = quality === "1080" ? 1080 : 720;

  if (ratio === "9:16") {
    return { width: shortEdge, height: quality === "1080" ? 1920 : 1280 };
  }
  if (ratio === "3:4") {
    return { width: shortEdge, height: quality === "1080" ? 1440 : 960 };
  }
  return { width: shortEdge, height: shortEdge };
};

const evenPixel = (value: number) => Math.max(2, Math.round(value / 2) * 2);

const STORAGE_KEYS = {
  script: "qimu:last-script",
  preferences: "qimu:preferences",
};

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
};

const pickMimeType = () => {
  if (typeof MediaRecorder === "undefined") return "";

  const candidates = [
    "video/mp4;codecs=h264,aac",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return "video/mp4";
  }

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
};

const filenameForMimeType = (mimeType: string) => {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    `${now.getMonth() + 1}`.padStart(2, "0"),
    `${now.getDate()}`.padStart(2, "0"),
    "-",
    `${now.getHours()}`.padStart(2, "0"),
    `${now.getMinutes()}`.padStart(2, "0"),
  ].join("");
  return `QIMU-${stamp}.${mimeType.includes("webm") ? "webm" : "mp4"}`;
};

export default function Home() {
  const [screen, setScreen] = useState<Screen>("script");
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [preferences, setPreferences] =
    useState<Preferences>(DEFAULT_PREFERENCES);
  const [facingMode, setFacingMode] = useState<FacingMode>("user");
  const [cameraReady, setCameraReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [teleprompterRunning, setTeleprompterRunning] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = useState("");
  const [recordingMimeType, setRecordingMimeType] = useState("video/mp4");
  const [isDraggingPrompt, setIsDraggingPrompt] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const promptViewportRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const lastScrollTimeRef = useRef(0);
  const countdownTokenRef = useRef(0);
  const promptDragRef = useRef<{ startY: number; startTop: number } | null>(
    null,
  );
  const promptScrollGestureRef = useRef<{ startY: number; moved: boolean } | null>(
    null,
  );
  const mirrorFrameRef = useRef<number | null>(null);
  const mirrorStreamRef = useRef<MediaStream | null>(null);
  const teleprompterRunningRef = useRef(false);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const savedScript = window.localStorage.getItem(STORAGE_KEYS.script);
        const savedPreferences = window.localStorage.getItem(
          STORAGE_KEYS.preferences,
        );

        if (savedScript) setScript(savedScript);
        if (savedPreferences) {
          setPreferences({
            ...DEFAULT_PREFERENCES,
            ...(JSON.parse(savedPreferences) as Partial<Preferences>),
          });
        }
      } catch {
        // Private browsing can make storage unavailable. The app still works.
      }
    }, 0);

    if (
      "serviceWorker" in navigator &&
      !["localhost", "127.0.0.1"].includes(window.location.hostname)
    ) {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {
        // Offline installation is optional; recording must remain available.
      });
    }

    return () => window.clearTimeout(restoreTimer);
  }, []);

  useEffect(() => {
    const saveTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEYS.script, script);
      } catch {
        // Ignore unavailable storage.
      }
    }, 180);
    return () => window.clearTimeout(saveTimer);
  }, [script]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEYS.preferences,
        JSON.stringify(preferences),
      );
    } catch {
      // Ignore unavailable storage.
    }
  }, [preferences]);

  useEffect(() => {
    teleprompterRunningRef.current = teleprompterRunning;
  }, [teleprompterRunning]);

  const stopScrollAnimation = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    stopScrollAnimation();
    if (!teleprompterRunning) return;

    lastScrollTimeRef.current = performance.now();

    const step = (now: number) => {
      const viewport = promptViewportRef.current;
      if (!viewport || !teleprompterRunningRef.current) return;

      const delta = Math.min(now - lastScrollTimeRef.current, 50);
      lastScrollTimeRef.current = now;
      viewport.scrollTop += (preferences.scrollSpeed * delta) / 1000;

      const atEnd =
        viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
      if (atEnd) {
        setTeleprompterRunning(false);
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(step);
    };

    scrollFrameRef.current = window.requestAnimationFrame(step);
    return stopScrollAnimation;
  }, [preferences.scrollSpeed, stopScrollAnimation, teleprompterRunning]);

  const clearRecordingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopMirrorStream = useCallback(() => {
    if (mirrorFrameRef.current !== null) {
      window.cancelAnimationFrame(mirrorFrameRef.current);
      mirrorFrameRef.current = null;
    }
    mirrorStreamRef.current?.getVideoTracks().forEach((track) => track.stop());
    mirrorStreamRef.current = null;
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  }, []);

  useEffect(() => {
    return () => {
      countdownTokenRef.current += 1;
      stopScrollAnimation();
      clearRecordingTimer();
      stopMirrorStream();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
  }, [clearRecordingTimer, recordingUrl, stopMirrorStream, stopScrollAnimation]);

  const videoConstraints = useCallback(
    (mode: FacingMode): MediaTrackConstraints => {
      return {
        facingMode: { ideal: mode },
        width: { ideal: sourceCaptureWidth(preferences.quality) },
        frameRate: { ideal: 30, max: 30 },
      };
    },
    [preferences.quality],
  );

  const attachStream = useCallback(async (stream: MediaStream) => {
    streamRef.current = stream;
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    videoRef.current.muted = true;
    videoRef.current.setAttribute("playsinline", "true");
    try {
      await videoRef.current.play();
    } catch {
      // A user tap on the screen will resume the muted preview if required.
    }
  }, []);

  const openCamera = useCallback(async () => {
    setNotice("");
    setScreen("studio");
    setConnecting(true);
    setCameraReady(false);
    setShowSettings(false);

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setConnecting(false);
      setNotice("当前浏览器暂不支持录像，请使用最新版 Safari 或 Chrome。");
      return;
    }

    let videoStream: MediaStream | null = null;
    let audioStream: MediaStream | null = null;

    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints("user"),
        audio: false,
      });
    } catch {
      setConnecting(false);
      setNotice("请允许访问摄像头才能录像。可在浏览器的网站设置中重新开启。");
      return;
    }

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch {
      videoStream.getTracks().forEach((track) => track.stop());
      setConnecting(false);
      setNotice("请允许访问麦克风才能录制声音。可在浏览器的网站设置中重新开启。");
      return;
    }

    const combinedStream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioStream.getAudioTracks(),
    ]);
    combinedStream.getTracks().forEach((track) => {
      track.addEventListener("ended", () => {
        if (recorderRef.current?.state === "recording") {
          setNotice("摄像头或麦克风已中断，请停止后重新尝试。");
        }
      });
    });

    await attachStream(combinedStream);
    setFacingMode("user");
    setConnecting(false);
    setCameraReady(true);
    window.setTimeout(() => promptViewportRef.current?.scrollTo(0, 0), 0);
  }, [attachStream, videoConstraints]);

  const leaveStudio = useCallback(() => {
    if (recording || countdown !== null) return;
    countdownTokenRef.current += 1;
    setTeleprompterRunning(false);
    stopCamera();
    setScreen("script");
    setNotice("");
  }, [countdown, recording, stopCamera]);

  const switchCamera = useCallback(async () => {
    if (recording || countdown !== null || connecting) return;
    setNotice("");
    const nextMode: FacingMode = facingMode === "user" ? "environment" : "user";
    const previousAudioTracks = streamRef.current?.getAudioTracks() ?? [];
    streamRef.current?.getVideoTracks().forEach((track) => track.stop());

    try {
      const nextVideoStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints(nextMode),
        audio: false,
      });
      const combinedStream = new MediaStream([
        ...nextVideoStream.getVideoTracks(),
        ...previousAudioTracks,
      ]);
      await attachStream(combinedStream);
      setFacingMode(nextMode);
    } catch {
      setNotice("切换摄像头失败，请重新尝试。");
      try {
        const recoveryStream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints(facingMode),
          audio: false,
        });
        await attachStream(
          new MediaStream([
            ...recoveryStream.getVideoTracks(),
            ...previousAudioTracks,
          ]),
        );
      } catch {
        setCameraReady(false);
      }
    }
  }, [
    attachStream,
    connecting,
    countdown,
    facingMode,
    recording,
    videoConstraints,
  ]);

  const createProcessedRecordingStream = useCallback(() => {
    const sourceVideo = videoRef.current;
    const sourceStream = streamRef.current;
    if (!sourceVideo || !sourceStream) {
      throw new Error("Camera stream is not ready");
    }

    const canvas = document.createElement("canvas");
    const videoTrack = sourceStream.getVideoTracks()[0];
    const trackSettings = videoTrack?.getSettings();
    const sourceWidth = sourceVideo.videoWidth || trackSettings?.width || 1280;
    const sourceHeight = sourceVideo.videoHeight || trackSettings?.height || 720;
    const maxEdge = preferences.quality === "1080" ? 1920 : 1280;
    const originalScale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const outputSize =
      preferences.videoRatio === "original"
        ? {
            width: evenPixel(sourceWidth * originalScale),
            height: evenPixel(sourceHeight * originalScale),
          }
        : fixedOutputSize(preferences.quality, preferences.videoRatio);
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;

    const captureCanvas = canvas as HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream;
    };
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || !captureCanvas.captureStream) {
      throw new Error("Processed recording is not supported");
    }

    const drawFrame = () => {
      if (sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const currentSourceWidth = sourceVideo.videoWidth || sourceWidth;
        const currentSourceHeight = sourceVideo.videoHeight || sourceHeight;
        const targetAspect = canvas.width / canvas.height;
        const sourceAspect = currentSourceWidth / currentSourceHeight;
        let sx = 0;
        let sy = 0;
        let sw = currentSourceWidth;
        let sh = currentSourceHeight;

        if (preferences.videoRatio !== "original") {
          if (sourceAspect > targetAspect) {
            sw = currentSourceHeight * targetAspect;
            sx = (currentSourceWidth - sw) / 2;
          } else {
            sh = currentSourceWidth / targetAspect;
            sy = (currentSourceHeight - sh) / 2;
          }
        }

        context.save();
        if (preferences.recordMirror) {
          context.translate(canvas.width, 0);
          context.scale(-1, 1);
        }
        context.drawImage(
          sourceVideo,
          sx,
          sy,
          sw,
          sh,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        context.restore();
      }
      mirrorFrameRef.current = window.requestAnimationFrame(drawFrame);
    };

    drawFrame();
    const canvasStream = captureCanvas.captureStream(30);
    const outputStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...sourceStream.getAudioTracks(),
    ]);
    mirrorStreamRef.current = outputStream;
    return outputStream;
  }, [preferences.quality, preferences.recordMirror, preferences.videoRatio]);

  const finishRecording = useCallback(
    (recorder: MediaRecorder) => {
      clearRecordingTimer();
      stopMirrorStream();
      setRecording(false);
      setTeleprompterRunning(false);
      setElapsed(0);

      const mimeType =
        recorder.mimeType || recordingChunksRef.current[0]?.type || "video/mp4";
      const blob = new Blob(recordingChunksRef.current, { type: mimeType });

      if (!blob.size) {
        setNotice("没有生成有效视频，请重新尝试。");
        stopCamera();
        setScreen("studio");
        return;
      }

      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      const nextUrl = URL.createObjectURL(blob);
      setRecordingBlob(blob);
      setRecordingUrl(nextUrl);
      setRecordingMimeType(mimeType);
      stopCamera();
      setScreen("preview");
      setNotice("");
    },
    [clearRecordingTimer, recordingUrl, stopCamera, stopMirrorStream],
  );

  const beginRecorder = useCallback(() => {
    const sourceStream = streamRef.current;
    if (!sourceStream) throw new Error("Camera stream is not ready");

    const needsProcessing =
      preferences.recordMirror || preferences.videoRatio !== "original";
    const recordingStream = needsProcessing
      ? createProcessedRecordingStream()
      : sourceStream;
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;

    try {
      recorder = mimeType
        ? new MediaRecorder(recordingStream, { mimeType })
        : new MediaRecorder(recordingStream);
    } catch {
      recorder = new MediaRecorder(recordingStream);
    }

    recordingChunksRef.current = [];
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data?.size) recordingChunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      clearRecordingTimer();
      setRecording(false);
      setTeleprompterRunning(false);
      setNotice("录制失败，请停止后重新尝试。");
    };
    recorder.onstop = () => finishRecording(recorder);

    recorder.start(1000);
    const startedAt = Date.now();
    setRecording(true);
    setElapsed(0);
    setTeleprompterRunning(true);
    timerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);
  }, [
    clearRecordingTimer,
    createProcessedRecordingStream,
    finishRecording,
    preferences.recordMirror,
    preferences.videoRatio,
  ]);

  const startRecording = useCallback(async () => {
    if (!cameraReady || connecting || recording || countdown !== null) return;
    setNotice("");
    setTeleprompterRunning(false);

    const token = countdownTokenRef.current + 1;
    countdownTokenRef.current = token;

    for (const count of [3, 2, 1]) {
      setCountdown(count);
      await wait(1000);
      if (countdownTokenRef.current !== token) return;
    }

    setCountdown(null);
    try {
      beginRecorder();
    } catch {
      stopMirrorStream();
      setNotice(
        preferences.recordMirror || preferences.videoRatio !== "original"
          ? "此设备无法处理所选比例，请选择“完整”并关闭“录制镜像”后重试。"
          : "录制启动失败，请重新尝试。",
      );
    }
  }, [
    beginRecorder,
    cameraReady,
    connecting,
    countdown,
    preferences.recordMirror,
    preferences.videoRatio,
    recording,
    stopMirrorStream,
  ]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setTeleprompterRunning(false);
    clearRecordingTimer();
    recorder.stop();
  }, [clearRecordingTimer]);

  const retryCamera = useCallback(() => {
    stopCamera();
    void openCamera();
  }, [openCamera, stopCamera]);

  const startOver = useCallback(async () => {
    setNotice("");
    setRecordingBlob(null);
    if (promptViewportRef.current) promptViewportRef.current.scrollTop = 0;
    await openCamera();
  }, [openCamera]);

  const downloadRecording = useCallback(() => {
    if (!recordingBlob || !recordingUrl) return;
    const link = document.createElement("a");
    link.href = recordingUrl;
    link.download = filenameForMimeType(recordingMimeType);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [recordingBlob, recordingMimeType, recordingUrl]);

  const shareRecording = useCallback(async () => {
    if (!recordingBlob) return;
    const filename = filenameForMimeType(recordingMimeType);
    const file = new File([recordingBlob], filename, {
      type: recordingMimeType,
    });

    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "QIMU 口播录像",
        });
      } else {
        downloadRecording();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice("未能打开分享菜单，请改用“下载视频”。");
    }
  }, [downloadRecording, recordingBlob, recordingMimeType]);

  const updatePreference = <Key extends keyof Preferences>(
    key: Key,
    value: Preferences[Key],
  ) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  };

  const updateQuality = async (quality: Quality) => {
    updatePreference("quality", quality);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track?.applyConstraints) return;

    try {
      await track.applyConstraints({
        width: { ideal: sourceCaptureWidth(quality) },
        frameRate: { ideal: 30, max: 30 },
      });
    } catch {
      setNotice("当前设备会自动使用最接近的清晰度。");
    }
  };

  const beginPromptDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (recording) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    promptDragRef.current = {
      startY: event.clientY,
      startTop: preferences.promptTop,
    };
    setIsDraggingPrompt(true);
  };

  const movePrompt = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!promptDragRef.current) return;
    const deltaPercent =
      ((event.clientY - promptDragRef.current.startY) / window.innerHeight) * 100;
    updatePreference(
      "promptTop",
      Math.min(58, Math.max(8, promptDragRef.current.startTop + deltaPercent)),
    );
  };

  const endPromptDrag = () => {
    promptDragRef.current = null;
    setIsDraggingPrompt(false);
  };

  const toggleTeleprompter = () => {
    if (!cameraReady || countdown !== null) return;
    setTeleprompterRunning((current) => !current);
  };

  const resetPrompt = () => {
    if (promptViewportRef.current) promptViewportRef.current.scrollTop = 0;
    setTeleprompterRunning(false);
  };

  const hasScript = script.trim().length > 0;

  return (
    <main className={`app-shell app-shell--${screen}`}>
      {screen === "script" && (
        <section className="script-screen" aria-labelledby="app-title">
          <header className="brand-bar">
            <div className="brand-mark" aria-hidden="true">
              Q<span />
            </div>
            <div>
              <p className="eyebrow">QIMU TELEPROMPTER</p>
              <h1 id="app-title">极简提词录像</h1>
            </div>
            <span className="local-badge">仅本机</span>
          </header>

          <div className="intro-copy">
            <p className="intro-kicker">打开，粘贴，开拍。</p>
            <p>让目光留在镜头附近，成片里只有你和声音。</p>
          </div>

          <div className="editor-card">
            <div className="editor-heading">
              <label htmlFor="script-input">口播稿</label>
              <span>{script.length.toLocaleString("zh-CN")} 字</span>
            </div>
            <textarea
              id="script-input"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              placeholder="在这里输入或粘贴口播稿…"
              spellCheck="true"
            />
            <div className="editor-foot">
              <span>支持长文本、中文、英文和换行</span>
              {script && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setScript("")}
                >
                  清空
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            className="primary-action"
            disabled={!hasScript}
            onClick={() => void openCamera()}
          >
            <span>进入提词模式</span>
            <span aria-hidden="true">→</span>
          </button>

          <aside className="privacy-note">
            <span className="privacy-lock" aria-hidden="true" />
            <p>
              <strong>你的内容留在手机里</strong>
              摄像头、麦克风、文稿和录像仅在当前设备中使用，不上传服务器。
            </p>
          </aside>

          <p className="home-tip">首次使用时，Safari 会询问摄像头和麦克风权限。</p>
        </section>
      )}

      {screen === "studio" && (
        <section className="studio-screen" aria-label="提词录像">
          <div className="camera-stage">
            <div className="camera-layer">
              <div
                className={`camera-viewport camera-viewport--${preferences.videoRatio.replace(":", "-")}`}
              >
                <video
                  ref={videoRef}
                  className={`camera-preview ${
                    preferences.previewMirror && facingMode === "user"
                      ? "camera-preview--mirrored"
                      : ""
                  }`}
                  autoPlay
                  muted
                  playsInline
                  onClick={() => void videoRef.current?.play()}
                />
              </div>
            </div>

            <div className="studio-scrim" aria-hidden="true" />

            <header className="studio-topbar">
              <button
                type="button"
                className="icon-button"
                aria-label="返回文稿"
                onClick={leaveStudio}
                disabled={recording || countdown !== null}
              >
                ←
              </button>

              <div
                className={`recording-status ${recording ? "is-live" : ""}`}
                aria-live="polite"
              >
                <span />
                {recording ? formatTime(elapsed) : cameraReady ? "准备就绪" : "正在连接"}
              </div>

              <div className="top-actions">
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  aria-label="切换前后摄像头"
                  onClick={() => void switchCamera()}
                  disabled={recording || countdown !== null || !cameraReady}
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  aria-label="打开设置"
                  onClick={() => setShowSettings(true)}
                  disabled={recording || countdown !== null}
                >
                  ···
                </button>
              </div>
            </header>

            {cameraReady && (
              <div
                className={`prompt-window ${
                  isDraggingPrompt ? "prompt-window--dragging" : ""
                }`}
                style={{
                  top: `${preferences.promptTop}%`,
                  width: `${preferences.promptWidth}%`,
                  fontSize: `${preferences.fontSize}px`,
                }}
              >
                <button
                  type="button"
                  className="prompt-position-handle"
                  onPointerDown={beginPromptDrag}
                  onPointerMove={movePrompt}
                  onPointerUp={endPromptDrag}
                  onPointerCancel={endPromptDrag}
                  aria-label="上下拖动提词区域"
                  disabled={recording}
                >
                  <span />
                  {recording ? "提词中" : "上下拖动位置"}
                </button>
                <div
                  ref={promptViewportRef}
                  className="prompt-viewport"
                  onPointerDown={(event) => {
                    promptScrollGestureRef.current = {
                      startY: event.clientY,
                      moved: false,
                    };
                  }}
                  onPointerMove={(event) => {
                    const gesture = promptScrollGestureRef.current;
                    if (gesture && Math.abs(event.clientY - gesture.startY) > 8) {
                      gesture.moved = true;
                    }
                  }}
                  onClick={() => {
                    const gesture = promptScrollGestureRef.current;
                    promptScrollGestureRef.current = null;
                    if (!gesture?.moved) toggleTeleprompter();
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={teleprompterRunning ? "暂停提词" : "继续提词"}
                  onKeyDown={(event) => {
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      toggleTeleprompter();
                    }
                  }}
                >
                  <div className="prompt-copy">{script}</div>
                </div>
                <button
                  type="button"
                  className="prompt-play-button"
                  onClick={toggleTeleprompter}
                  aria-label={teleprompterRunning ? "暂停提词" : "继续提词"}
                >
                  {teleprompterRunning ? "Ⅱ" : "▶"}
                </button>
              </div>
            )}

            {countdown !== null && (
              <div className="countdown" role="status" aria-live="assertive">
                <span>{countdown}</span>
                <p>准备开拍</p>
              </div>
            )}

            {(notice || connecting) && (
              <div className="studio-message" role="status">
                {connecting ? (
                  <>
                    <span className="loading-dot" />
                    正在连接摄像头和麦克风…
                  </>
                ) : (
                  <>
                    <p>{notice}</p>
                    <button type="button" onClick={retryCamera}>
                      重新尝试
                    </button>
                  </>
                )}
              </div>
            )}

            <div className={`studio-controls ${recording ? "is-recording" : ""}`}>
              {!recording && (
                <div className="prompt-controls" aria-label="提词设置">
                  <div className="font-stepper">
                    <button
                      type="button"
                      aria-label="减小字号"
                      onClick={() =>
                        updatePreference(
                          "fontSize",
                          Math.max(22, preferences.fontSize - 2),
                        )
                      }
                    >
                      A−
                    </button>
                    <span>{preferences.fontSize}</span>
                    <button
                      type="button"
                      aria-label="增大字号"
                      onClick={() =>
                        updatePreference(
                          "fontSize",
                          Math.min(54, preferences.fontSize + 2),
                        )
                      }
                    >
                      A+
                    </button>
                  </div>
                  <label className="speed-control">
                    <span>慢</span>
                    <input
                      type="range"
                      min="12"
                      max="78"
                      step="1"
                      value={preferences.scrollSpeed}
                      onChange={(event) =>
                        updatePreference("scrollSpeed", Number(event.target.value))
                      }
                      aria-label="提词滚动速度"
                    />
                    <span>快</span>
                  </label>
                  <button
                    type="button"
                    className="reset-button"
                    onClick={resetPrompt}
                  >
                    回到开头
                  </button>
                </div>
              )}

              {recording && (
                <button
                  type="button"
                  className="teleprompter-toggle"
                  onClick={toggleTeleprompter}
                >
                  {teleprompterRunning ? "暂停提词" : "继续提词"}
                </button>
              )}

              <button
                type="button"
                className={`record-button ${recording ? "is-recording" : ""}`}
                onClick={recording ? stopRecording : startRecording}
                disabled={!cameraReady || connecting || countdown !== null}
                aria-label={recording ? "停止录像" : "开始录像"}
              >
                <span />
              </button>
              <p className="record-label">{recording ? "停止录像" : "开始录像"}</p>
            </div>
          </div>

          {showSettings && (
            <div
              className="sheet-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setShowSettings(false);
              }}
            >
              <section
                className="settings-sheet"
                role="dialog"
                aria-modal="true"
                aria-labelledby="settings-title"
              >
                <div className="sheet-grabber" aria-hidden="true" />
                <div className="sheet-titlebar">
                  <div>
                    <p className="eyebrow">拍摄偏好</p>
                    <h2 id="settings-title">设置</h2>
                  </div>
                  <button
                    type="button"
                    className="close-button"
                    onClick={() => setShowSettings(false)}
                    aria-label="关闭设置"
                  >
                    完成
                  </button>
                </div>

                <div className="setting-row">
                  <div>
                    <strong>自拍预览镜像</strong>
                    <span>只改变你看到的画面</span>
                  </div>
                  <button
                    type="button"
                    className={`switch ${
                      preferences.previewMirror ? "is-on" : ""
                    }`}
                    aria-pressed={preferences.previewMirror}
                    onClick={() =>
                      updatePreference(
                        "previewMirror",
                        !preferences.previewMirror,
                      )
                    }
                  >
                    <span />
                  </button>
                </div>

                <div className="setting-row">
                  <div>
                    <strong>录制镜像</strong>
                    <span>关闭时最稳定，成片为真实方向</span>
                  </div>
                  <button
                    type="button"
                    className={`switch ${
                      preferences.recordMirror ? "is-on" : ""
                    }`}
                    aria-pressed={preferences.recordMirror}
                    onClick={() =>
                      updatePreference("recordMirror", !preferences.recordMirror)
                    }
                  >
                    <span />
                  </button>
                </div>

                <div className="setting-block">
                  <div className="setting-label">
                    <strong>视频比例</strong>
                    <span>“完整”不裁切，可避免镜头看起来放大</span>
                  </div>
                  <div className="segmented-control segmented-control--ratios">
                    {VIDEO_RATIO_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={
                          preferences.videoRatio === option.value ? "is-active" : ""
                        }
                        aria-pressed={preferences.videoRatio === option.value}
                        onClick={() => updatePreference("videoRatio", option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setting-block">
                  <div className="setting-label">
                    <strong>清晰度</strong>
                    <span>优先 30fps，设备会自动降级</span>
                  </div>
                  <div className="segmented-control">
                    {(["720", "1080"] as Quality[]).map((quality) => (
                      <button
                        key={quality}
                        type="button"
                        className={preferences.quality === quality ? "is-active" : ""}
                        onClick={() => void updateQuality(quality)}
                      >
                        {quality}P
                      </button>
                    ))}
                  </div>
                </div>

                <div className="setting-block range-setting">
                  <span className="setting-label">
                    <strong>提词宽度</strong>
                    <span>{preferences.promptWidth}%</span>
                  </span>
                  <input
                    id="prompt-width"
                    type="range"
                    aria-label="提词宽度"
                    min="70"
                    max="90"
                    step="1"
                    value={preferences.promptWidth}
                    onChange={(event) =>
                      updatePreference("promptWidth", Number(event.target.value))
                    }
                  />
                </div>

                <div className="setting-block range-setting">
                  <span className="setting-label">
                    <strong>提词位置</strong>
                    <span>{Math.round(preferences.promptTop)}%</span>
                  </span>
                  <input
                    id="prompt-position"
                    type="range"
                    aria-label="提词位置"
                    min="8"
                    max="58"
                    step="1"
                    value={preferences.promptTop}
                    onChange={(event) =>
                      updatePreference("promptTop", Number(event.target.value))
                    }
                  />
                </div>

                <p className="settings-footnote">
                  提词和按钮只是屏幕辅助层，不会出现在最终录像中。
                </p>
              </section>
            </div>
          )}
        </section>
      )}

      {screen === "preview" && recordingUrl && (
        <section className="preview-screen" aria-labelledby="preview-title">
          <header className="preview-header">
            <button
              type="button"
              className="back-text-button"
              onClick={() => setScreen("script")}
            >
              ← 文稿
            </button>
            <div>
              <p className="eyebrow">录制完成</p>
              <h1 id="preview-title">检查一下成片</h1>
            </div>
          </header>

          <div
            className={`video-review video-review--${preferences.videoRatio.replace(":", "-")}`}
          >
            <video src={recordingUrl} controls playsInline preload="metadata">
              <track kind="captions" srcLang="zh-CN" label="未提供字幕" />
            </video>
            <span className="clean-video-badge">纯净画面 · 无提词层</span>
          </div>

          {notice && <p className="preview-notice">{notice}</p>}

          <div className="preview-actions">
            <button
              type="button"
              className="primary-action primary-action--light"
              onClick={() => void shareRecording()}
            >
              分享 / 保存视频
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={downloadRecording}
            >
              下载视频文件
            </button>
            <button
              type="button"
              className="retake-button"
              onClick={() => void startOver()}
            >
              重新录制
            </button>
          </div>

          <p className="save-tip">
            在 iPhone 上，优先使用“分享 / 保存视频”，再选择“存储视频”或“存储到文件”。
          </p>
        </section>
      )}
    </main>
  );
}

import React, { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Sparkles, RefreshCw, Loader2, Target, CheckCircle2, Zap } from "lucide-react";
import { playTone } from "../lib/audio";

interface CameraStreamProps {
  onCapture: (base64: string, mimeType: string) => void;
  disabled?: boolean;
  autoScanEnabled: boolean;
  onToggleAutoScan: (enabled: boolean) => void;
  batchModeEnabled: boolean;
  onToggleBatchMode: (enabled: boolean) => void;
  isExtracting?: boolean;
  lastScanSuccessTime?: number; // Prop to receive live data registration success triggers
  onCameraError?: (error: any) => void;
}

export const CameraStream: React.FC<CameraStreamProps> = ({ 
  onCapture, 
  disabled = false,
  autoScanEnabled,
  onToggleAutoScan,
  batchModeEnabled,
  onToggleBatchMode,
  isExtracting = false,
  lastScanSuccessTime = 0,
  onCameraError
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const [hasCamera, setHasCamera] = useState<boolean | null>(null);
  const [activeStream, setActiveStream] = useState<boolean>(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // New states for real-time camera position stabilization and success transitions
  const [stablePercent, setStablePercent] = useState<number>(0);
  const [scanStatusMsg, setScanStatusMsg] = useState<string>("タグを枠内に映してください");
  const [isFlashingSuccess, setIsFlashingSuccess] = useState<boolean>(false);
  
  const lastFrameDataRef = useRef<Float32Array | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastScanSuccessTimeRef = useRef<number>(0);
  // Stability gauge kept in a ref as well, so the capture decision can be made
  // synchronously in the interval instead of inside a state updater.
  const stableRef = useRef<number>(0);
  const isTriggeringRef = useRef<boolean>(false);
  const awaitingSceneChangeRef = useRef<boolean>(false);

  // Play crisp synthesizer dual-beep on successful tag scan
  const playBeepSound = () => {
    playTone(950, 0.08, { gain: 0.05 });
    playTone(1250, 0.12, { delay: 0.075, gain: 0.05 });
  };

  // Monitor scan success timestamps from parent component to fire successful scan triggers
  useEffect(() => {
    if (lastScanSuccessTime && lastScanSuccessTime > lastScanSuccessTimeRef.current) {
      lastScanSuccessTimeRef.current = lastScanSuccessTime;
      
      // Fire visual success marquee & positive beep noise
      setIsFlashingSuccess(true);
      playBeepSound();
      
      const timer = setTimeout(() => {
        setIsFlashingSuccess(false);
      }, 1600);
      return () => clearTimeout(timer);
    }
  }, [lastScanSuccessTime]);

  // Init webcams list
  useEffect(() => {
    const listDevices = async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const videoDevs = devs.filter((d) => d.kind === "videoinput");
        setDevices(videoDevs);
        
        // Select an environment (back) camera by default if available
        const backCamera = videoDevs.find(
          (d) => d.label.toLowerCase().includes("back") || d.label.toLowerCase().includes("environment")
        );
        if (backCamera) {
          setSelectedDeviceId(backCamera.deviceId);
        } else if (videoDevs.length > 0) {
          setSelectedDeviceId(videoDevs[0].deviceId);
        }
      } catch (err) {
        console.warn("Unable to enumerate devices:", err);
      }
    };

    listDevices();
  }, []);

  const startCamera = async (deviceId?: string) => {
    stopCamera();
    setLoading(true);
    
    const constraints: MediaStreamConstraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: "environment" }, width: { ideal: 720 }, height: { ideal: 1280 } },
      audio: false,
    };

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API is not fully supported in this environment. Please switch to file upload.");
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setHasCamera(true);
      setActiveStream(true);
    } catch (err: any) {
      console.error("Camera access failed:", err);
      setHasCamera(false);
      setActiveStream(false);
      if (onCameraError) {
        onCameraError(err);
      }
    } finally {
      setLoading(false);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setActiveStream(false);
  };

  useEffect(() => {
    startCamera(selectedDeviceId);
    return () => {
      stopCamera();
    };
  }, [selectedDeviceId]);

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const devId = e.target.value;
    setSelectedDeviceId(devId);
  };

  const handleCapture = () => {
    if (!videoRef.current || !activeStream || disabled) return;

    try {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      
      const vWidth = video.videoWidth || 640;
      const vHeight = video.videoHeight || 480;

      const maxSize = 640; // Reduced resolution for faster network propagation and fast Gemini processing
      let targetWidth = vWidth;
      let targetHeight = vHeight;

      if (vWidth > vHeight) {
        if (vWidth > maxSize) {
          targetHeight = Math.round((vHeight * maxSize) / vWidth);
          targetWidth = maxSize;
        }
      } else {
        if (vHeight > maxSize) {
          targetWidth = Math.round((vWidth * maxSize) / vHeight);
          targetHeight = maxSize;
        }
      }

      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
        const jpegUrl = canvas.toDataURL("image/jpeg", 0.75); // Slightly compressed to reduce base64 size
        onCapture(jpegUrl, "image/jpeg");
      }
    } catch (err) {
      console.error("Capture failed:", err);
    }
  };

  // High-Sensitivity Realtime Camera Motion Stabilization Analyzer Loop (Stabilizer Gauge)
  // Instead of auto-firing blindly, it measures sub-pixel movement changes from the video stream feed.
  useEffect(() => {
    if (!activeStream || !autoScanEnabled || disabled || isExtracting) {
      setStablePercent(0);
      return;
    }

    if (!analysisCanvasRef.current) {
      analysisCanvasRef.current = document.createElement("canvas");
      analysisCanvasRef.current.width = 80;
      analysisCanvasRef.current.height = 60;
    }
    const canvas = analysisCanvasRef.current;
    const ctx = canvas.getContext("2d");

    // Re-arm whenever the loop restarts (a scan finishing flips isExtracting).
    isTriggeringRef.current = false;

    const intervalId = setInterval(() => {
      if (!videoRef.current || !ctx || isExtracting || disabled || isTriggeringRef.current) {
        return;
      }

      try {
        ctx.drawImage(videoRef.current, 0, 0, 80, 60);
        const imgData = ctx.getImageData(0, 0, 80, 60);
        const pixels = imgData.data;

        const pixelCount = pixels.length / 4;
        const currentBrightness = new Float32Array(pixelCount);
        const prevBrightnessArray = lastFrameDataRef.current;

        let diffSum = 0;
        let totalBrightness = 0;
        let sumBrightnessSq = 0;

        // Perform absolute frame-differencing for motion detection and contrast checks
        // Optimized: Only calculate brightness once per pixel and store it.
        for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
          
          currentBrightness[j] = brightness;
          totalBrightness += brightness;
          sumBrightnessSq += brightness * brightness;

          if (prevBrightnessArray) {
            diffSum += Math.abs(brightness - prevBrightnessArray[j]);
          }
        }

        // Store current frame values for next difference interval check
        lastFrameDataRef.current = currentBrightness;

        if (!prevBrightnessArray) {
          return;
        }

        const averageDiff = diffSum / pixelCount;
        const averageBrightness = totalBrightness / pixelCount;
        
        // Calculate variance (standard deviation squared) to detect if a tag/text is in frame.
        // A blank wall has very low variance (noise only, ~10-50). Contrast text has higher variance (> 150).
        const variance = (sumBrightnessSq / pixelCount) - (averageBrightness * averageBrightness);

        // Verify environmental lighting is adequate (avoid blank dark surfaces or overblown whites)
        const isLightingAdequate = averageBrightness > 25 && averageBrightness < 242;
        
        // Ensure there is significant contrast/detail (tag) present in the frame
        const hasTagDetail = variance > 120;

        // Lower diff values imply absolute steady spatial composition (camera operator stopped moving)
        const isCameraSteady = averageDiff < 4.8 && isLightingAdequate && hasTagDetail;

        // Determine message state for the UI
        let statusMessage = "カメラを固定してください";
        if (!isLightingAdequate) statusMessage = "明るさが不適切です";
        else if (!hasTagDetail) statusMessage = "タグを枠内に映してください";
        else if (!isCameraSteady) statusMessage = "動かさないでください...";
        
        setScanStatusMsg((prev) => prev !== statusMessage ? statusMessage : prev);

        // After a capture, wait for the scene to actually change before letting the
        // gauge climb again. Without this the gauge re-fills in three ticks while
        // the camera is still pointed at the tag that was just read, which is what
        // forced the parent into a long part-number-based duplicate block.
        if (awaitingSceneChangeRef.current) {
          if (!isCameraSteady) {
            awaitingSceneChangeRef.current = false;
          }
          stableRef.current = 0;
          setStablePercent(0);
          setScanStatusMsg((prev) =>
            prev !== "次のタグに移してください" ? "次のタグに移してください" : prev,
          );
          return;
        }

        // The capture decision is made here rather than inside a setState updater.
        // React only runs an updater eagerly when no other update is pending on the
        // fiber; otherwise it is deferred to the render phase, which left the
        // trigger flag latched true with no capture ever fired — auto-scan died
        // until the operator toggled it off and on.
        const nextPercent = isCameraSteady
          ? Math.min(stableRef.current + 34, 100)
          : Math.max(stableRef.current - 35, 0);

        if (isCameraSteady && nextPercent >= 100) {
          isTriggeringRef.current = true;
          awaitingSceneChangeRef.current = true;
          stableRef.current = 0;
          setStablePercent(0);
          handleCapture();
          return;
        }

        stableRef.current = nextPercent;
        setStablePercent((prev) => (prev === nextPercent ? prev : nextPercent));
      } catch (err) {
        console.warn("Stabilization computation failed:", err);
      }
    }, 280); // Refresh analysis data every 280ms

    return () => {
      clearInterval(intervalId);
      stableRef.current = 0;
      setStablePercent(0);
    };
  }, [activeStream, autoScanEnabled, disabled, isExtracting]);

  return (
    <div className="w-full flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 border border-slate-150 rounded-xl p-3">
        <div className="text-xs font-bold text-slate-705 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-blue-500 animate-pulse" /> ライブカメラ映像 / CAMERA VIEWPORT
        </div>
        
        {devices.length > 1 && (
          <div className="flex items-center gap-1.5 self-end sm:self-auto">
            <span className="text-[10px] text-slate-550 uppercase font-black tracking-wider">カメラ切替:</span>
            <select
              value={selectedDeviceId}
              onChange={handleDeviceChange}
              className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-700 outline-none focus:border-slate-400 font-bold"
              disabled={loading || disabled}
            >
              {devices.map((dev, idx) => (
                <option key={dev.deviceId || idx} value={dev.deviceId}>
                  {dev.label || `カメラ ${idx + 1}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Main Streaming Window Card viewport frame */}
      <div 
        className={`relative rounded-xl overflow-hidden border-4 bg-slate-950 aspect-[3/4] flex items-center justify-center max-h-[60vh] transition-all duration-300 ${
          isFlashingSuccess 
            ? "border-emerald-500 shadow-[0_0_30px_rgba(16,185,129,0.9)] ring-4 ring-emerald-500/20 scale-[1.01]" 
            : "border-white shadow-xl"
        }`}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950/80 text-white gap-2">
            <Loader2 className="w-8 h-8 text-neutral-400 animate-spin" />
            <p className="text-xs font-bold tracking-wide">Starting Camera Stream...</p>
          </div>
        )}

        {!activeStream && !loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-950 text-slate-400 p-6 text-center gap-3">
            <div className="p-3 bg-slate-900 rounded-full text-slate-500">
              <CameraOff className="w-8 h-8" />
            </div>
            <div>
              <p className="font-bold text-sm text-slate-300">Camera Access Blocked</p>
              <p className="text-xs text-slate-500 max-w-xs mt-1 leading-relaxed">
                Grant camera permission or switch to manual tab for drag &amp; drop uploading.
              </p>
            </div>
            <button
              onClick={() => startCamera(selectedDeviceId)}
              className="px-4 py-2 mt-2 text-xs bg-slate-800 hover:bg-slate-700 font-bold uppercase tracking-wider rounded-lg text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Re-enable Camera
            </button>
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
        />

        {/* Dynamic Scan Target Reticle Graphic (With Quad corner anchors) */}
        {activeStream && !isExtracting && !isFlashingSuccess && (
          <div className="absolute inset-0 z-5 pointer-events-none flex items-center justify-center">
            {/* Guide Square Area */}
            <div className="relative w-3/4 h-4/5 border border-white/20 rounded-xl flex items-center justify-center select-none">
              
              {/* Corner brackets */}
              <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-blue-400"></div>
              <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-blue-400"></div>
              <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-blue-400"></div>
              <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-blue-400"></div>

              {/* Continuous sweep linear beam */}
              <div className={`absolute left-0 w-full h-0.5 bg-blue-500/40 shadow-[0_0_12px_rgba(59,130,246,0.6)] ${autoScanEnabled ? "animate-pulse" : ""}`}></div>

              {/* Helper Sub title tag guide */}
              <div className="absolute -top-6 bg-slate-900/80 text-[10px] font-bold text-blue-300 px-2 py-0.5 rounded font-sans tracking-tight leading-none text-center">
                タグを枠内に水平に収めてください
              </div>
            </div>
          </div>
        )}

        {/* stabilization lock-on micro overlay panel */}
        {activeStream && autoScanEnabled && !isExtracting && !isFlashingSuccess && (
          <div className="absolute top-4 left-4 z-10 pointer-events-none max-w-xs">
            <div className="bg-slate-900/85 backdrop-blur-xs border border-white/10 p-2 rounded-lg flex items-center gap-2.5 shadow-md">
              <Target className={`w-4.5 h-4.5 ${stablePercent > 0 ? "text-amber-400 animate-spin" : "text-slate-400"}`} style={{ animationDuration: '3s' }} />
              <div className="space-y-0.5">
                <span className="text-[9px] font-black uppercase text-slate-350 tracking-wider block">
                  {stablePercent >= 100 ? "ロックオン! / LOCKED" : scanStatusMsg}
                </span>
                
                {/* stabilization meter bar */}
                <div className="flex items-center gap-1.5">
                  <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden border border-white/5">
                    <div 
                      className={`h-full transition-all duration-300 ${
                        stablePercent >= 100 ? "bg-emerald-500" : stablePercent >= 50 ? "bg-amber-500" : "bg-blue-400"
                      }`}
                      style={{ width: `${stablePercent}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono font-bold text-white leading-none">{stablePercent}%</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* AI Loading Overlay: Translucent shield with twin-wheel spinning sparkles */}
        {isExtracting && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/85 text-white p-4 text-center gap-2.5 backdrop-blur-[2px]">
            <div className="relative flex items-center justify-center">
              <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
              <div className="absolute">
                <Sparkles className="w-5 h-5 text-indigo-400 animate-bounce" />
              </div>
            </div>
            <div>
              <p className="font-bold text-xs sm:text-sm tracking-wide text-blue-400">AIタグ解析中 / Analyzing Tag...</p>
              <p className="text-[10px] sm:text-[11px] text-slate-350 mt-1 max-w-xs leading-relaxed">
                Geminiが衣服タグの文字から品番、サイズ、カラー情報を自動抽出しています
              </p>
            </div>
          </div>
        )}

        {/* Successful read flash popup card - Visible for 1.5 seconds */}
        {isFlashingSuccess && (
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-emerald-950/90 text-white p-4 text-center gap-3 animate-fade-in backdrop-blur-[1px]">
            <div className="w-14 h-14 bg-emerald-500/20 border-2 border-emerald-400 text-emerald-400 rounded-full flex items-center justify-center animate-bounce shadow-[0_0_20px_rgba(16,185,129,0.5)]">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <p className="font-extrabold text-base text-emerald-400 tracking-wider">✓ 読取完了 / SUCCESS</p>
              <p className="text-xs text-slate-250">データの抽出に成功し、スキャン記録に追加されました！</p>
            </div>
          </div>
        )}

        {activeStream && (
          <>
            <div className="absolute bottom-4 left-4 pointer-events-none">
              <div className="px-2.5 py-1 rounded-full bg-black/60 text-white text-[9px] uppercase font-black tracking-widest flex items-center gap-1.5 shadow-sm backdrop-blur-xs">
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${autoScanEnabled ? "bg-amber-400" : "bg-emerald-500"}`} /> 
                {autoScanEnabled ? "自動読取 / AUTO-SCAN" : "カメラ接続中 / CAMERA"}
              </div>
            </div>

            <div className="absolute bottom-4 right-4 font-mono text-[9px] text-white/70 bg-black/60 px-2.5 py-1 rounded select-none pointer-events-none backdrop-blur-xs border border-white/5 uppercase">
              DIFF SENSOR: ACTIVE | RES: 640PX
            </div>
          </>
        )}
      </div>

      {activeStream && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="flex items-center justify-between bg-blue-50 hover:bg-blue-100 transition-colors border border-blue-200 rounded-xl p-3 shadow-3xs">
              <div className="flex items-center gap-2.5">
                <Target className="w-5 h-5 text-blue-600 animate-pulse shrink-0" />
                <div>
                  <span className="text-xs font-bold text-slate-850 uppercase block tracking-tight">静止検知スキャン / AUTO-SCAN</span>
                  <span className="text-[9px] text-slate-500 font-medium block leading-normal mt-0.5">
                    ピタッと止まると自動撮影
                  </span>
                </div>
              </div>
              
              <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-2">
                <input
                  type="checkbox"
                  checked={autoScanEnabled}
                  onChange={(e) => onToggleAutoScan(e.target.checked)}
                  className="sr-only peer"
                  disabled={loading}
                />
                <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className={`flex items-center justify-between transition-colors border rounded-xl p-3 shadow-3xs ${batchModeEnabled ? "bg-purple-50 border-purple-200 hover:bg-purple-100" : "bg-slate-50 border-slate-200 hover:bg-slate-100"}`}>
              <div className="flex items-center gap-2.5">
                <Zap className={`w-5 h-5 shrink-0 ${batchModeEnabled ? "text-purple-600" : "text-slate-400"}`} />
                <div>
                  <span className="text-xs font-bold text-slate-850 uppercase block tracking-tight">連続バッチ処理 / BATCH MODE</span>
                  <span className="text-[9px] text-slate-500 font-medium block leading-normal mt-0.5">
                    確認スキップで即時自動保存
                  </span>
                </div>
              </div>
              
              <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-2">
                <input
                  type="checkbox"
                  checked={batchModeEnabled}
                  onChange={(e) => onToggleBatchMode(e.target.checked)}
                  className="sr-only peer"
                  disabled={loading}
                />
                <div className="w-10 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
              </label>
            </div>
          </div>

          <button
            onClick={handleCapture}
            disabled={disabled || loading}
            className={`w-full py-3.5 text-white disabled:bg-slate-100 disabled:text-slate-400 font-bold uppercase tracking-wider rounded-xl text-xs md:text-sm shadow-md transition-all active:scale-[0.99] cursor-pointer flex items-center justify-center gap-2 ${
              autoScanEnabled 
                ? "bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800" 
                : "bg-blue-600 hover:bg-blue-700 active:bg-blue-800"
            }`}
          >
            {autoScanEnabled ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-white" />
                自動読取中 (カメラをタグに合わせてピタッと止めてください)
              </>
            ) : (
              <>
                <Camera className="w-4.5 h-4.5" />
                タグを撮影して読み取る / CAPTURE TAG
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

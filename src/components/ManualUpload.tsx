import React, { useState, useRef } from "react";
import { UploadCloud, Image as ImageIcon, X, Loader2 } from "lucide-react";
import { resizeAndCompressImage } from "../lib/imageUtils";

interface ManualUploadProps {
  onImageSelected: (base64: string, mimeType: string) => void;
  selectedPreview: string | null;
  onClear: () => void;
  disabled?: boolean;
  isExtracting?: boolean;
}

export const ManualUpload: React.FC<ManualUploadProps> = ({
  onImageSelected,
  selectedPreview,
  onClear,
  disabled = false,
  isExtracting = false,
}) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = (file: File) => {
    if (!file.type.startsWith("image/")) {
      alert("Please upload an image file.");
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target?.result as string;
      try {
        const optimized = await resizeAndCompressImage(base64, 640, 0.75);
        onImageSelected(optimized.base64, optimized.mimeType);
      } catch (err) {
        console.warn("Dampened fallback: failed optimizing upload, falling back to raw binary", err);
        onImageSelected(base64, file.type);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;

    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (disabled) return;

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (disabled) return;

    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const onButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="w-full">
      {selectedPreview ? (
        <div className="relative rounded-xl overflow-hidden border-4 border-white shadow-xl bg-slate-950 flex items-center justify-center p-2 group h-72">
          <img
            src={selectedPreview}
            alt="Tag Preview"
            className="max-w-full max-h-full object-contain rounded-lg"
            referrerPolicy="no-referrer"
          />

          {/* AI Loader overlay on manual upload preview */}
          {isExtracting && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-slate-950/85 text-white p-4 text-center gap-2.5 backdrop-blur-[2px]">
              <div className="relative flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
                <div className="absolute">
                  <UploadCloud className="w-5 h-5 text-indigo-400 animate-pulse" />
                </div>
              </div>
              <div>
                <p className="font-bold text-sm tracking-wide text-blue-400">AIタグ解析中 / Analyzing Tag...</p>
                <p className="text-[11px] text-slate-350 mt-1.5 max-w-xs leading-normal font-medium">
                  Geminiが衣服タグの画像から品番、サイズ、カラーなどの文字情報をリアルタイムで抽出しています。
                </p>
              </div>
            </div>
          )}

          {!isExtracting && (
            <button
              onClick={onClear}
              disabled={disabled}
              className="absolute top-4 right-4 p-2 bg-slate-900/80 hover:bg-slate-900 text-white rounded-full transition-colors cursor-pointer disabled:bg-slate-200 disabled:text-slate-400"
              title="Clear Image"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      ) : (
        <div
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={onButtonClick}
          className={`w-full h-72 border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 p-6 text-center cursor-pointer transition-all ${
            disabled
              ? "border-slate-200 bg-slate-50 cursor-not-allowed text-slate-400"
              : isDragActive
              ? "border-blue-500 bg-blue-50/20"
              : "border-slate-200 hover:border-blue-400 hover:bg-slate-50"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/*"
            onChange={handleChange}
            disabled={disabled}
          />
          <div className={`p-4 rounded-full ${disabled ? "bg-slate-100 text-slate-300" : "bg-blue-50 text-blue-500"}`}>
            <UploadCloud className="w-8 h-8" />
          </div>
          <div>
            <p className={`font-bold text-sm ${disabled ? "text-slate-400" : "text-slate-800"}`}>
              タグ画像をドラッグ＆ドロップ、またはタップ
            </p>
            <p className="text-xs text-slate-400 mt-1">
              スマートフォン・タブレットでは直接カメラ撮影、写真ライブラリから選択も可能
            </p>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 text-slate-500 text-[10px] uppercase font-bold tracking-wider rounded-md mt-2">
            <ImageIcon className="w-3.5 h-3.5 text-blue-550" /> 高性能画像解析 / HIGH-SPEED ANALYZER
          </div>
        </div>
      )}
    </div>
  );
};

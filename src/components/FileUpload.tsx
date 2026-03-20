import { useRef, useState, useCallback } from "react";
import {
  ACCEPTED_FILE_TYPES,
  detectSupportedFileType,
  getUnsupportedFileMessage,
} from "../lib/file-types";

const LARGE_FILE_THRESHOLD = 500 * 1024 * 1024;

interface FileUploadProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export function FileUpload({ onFileSelected, disabled }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [showLargeFileWarning, setShowLargeFileWarning] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (!detectSupportedFileType(file.name)) {
        alert(getUnsupportedFileMessage(file.name));
        return;
      }
      if (file.size > LARGE_FILE_THRESHOLD) {
        setShowLargeFileWarning(true);
      }
      setSelectedFile(file);
      onFileSelected(file);
    },
    [onFileSelected],
  );

  const handleClick = () => {
    if (!disabled) {
      inputRef.current?.click();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!disabled) {
      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-100 overflow-hidden">
      <div className="p-8">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/25">
            <svg
              className="w-8 h-8 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-slate-800 mb-2">
            Upload your data file
          </h2>
          <p className="text-slate-500">
            Supports CSV, Parquet, and .xlsx files up to 2GB
          </p>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          onChange={handleChange}
          className="hidden"
          disabled={disabled}
        />

        <div
          className={`
            relative rounded-xl border-2 border-dashed transition-all duration-300 cursor-pointer
            ${
              isDragging
                ? "border-indigo-500 bg-indigo-50/50 scale-[1.02]"
                : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50"
            }
            ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          `}
          onClick={handleClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {selectedFile && (
            <div className="p-8 flex items-center justify-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-100 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-indigo-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div className="text-left">
                <p className="font-semibold text-slate-800">
                  {selectedFile.name}
                </p>
                <p className="text-sm text-slate-500">
                  {formatFileSize(selectedFile.size)}
                </p>
              </div>
              <div className="ml-auto px-3 py-1 bg-indigo-100 text-indigo-700 text-sm font-medium rounded-full">
                Ready to load
              </div>
            </div>
          )}

          {showLargeFileWarning && (
            <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 flex items-center gap-2">
              <span className="text-xl">🦆</span>
              <p className="text-sm text-amber-800">
                Looks like the file is large. DuckDB is preparing...
              </p>
            </div>
          )}

          {!selectedFile && (
            <div className="p-12 flex flex-col items-center">
              <p className="text-lg font-medium text-slate-600">
                {disabled ? "Initializing..." : "Drag & drop your file here"}
              </p>
              <p className="text-sm text-slate-400 mt-2">
                or click to browse CSV, Parquet, or .xlsx
              </p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-400 mt-4">
          Powered by DuckDB • Client-side processing • Your data never leaves
          your browser
        </p>
      </div>
    </div>
  );
}

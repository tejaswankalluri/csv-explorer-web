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
    <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-elevated)] overflow-hidden text-[var(--text-primary)]">
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
          <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
            Upload your data file
          </h2>
          <p className="text-[var(--text-muted)]">
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
                ? "border-indigo-500 bg-indigo-500/8 scale-[1.02]"
                : "border-[var(--panel-border)] hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-hover)]"
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
              <div className="w-12 h-12 rounded-xl bg-[var(--accent-soft)] flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-[var(--accent-strong)]"
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
                <p className="font-semibold text-[var(--text-primary)]">
                  {selectedFile.name}
                </p>
                <p className="text-sm text-[var(--text-muted)]">
                  {formatFileSize(selectedFile.size)}
                </p>
              </div>
              <div className="ml-auto rounded-full bg-[var(--success-bg)] px-3 py-1 text-sm font-medium text-[var(--success-text)]">
                Ready to load
              </div>
            </div>
          )}

          {showLargeFileWarning && (
            <div className="flex items-center gap-2 border-t border-[var(--warning-border)] bg-[var(--warning-bg)] px-4 py-3">
              <span className="text-xl">🦆</span>
              <p className="text-sm text-[var(--warning-text)]">
                Looks like the file is large. DuckDB is preparing...
              </p>
            </div>
          )}

          {!selectedFile && (
            <div className="p-12 flex flex-col items-center">
              <p className="text-lg font-medium text-[var(--text-secondary)]">
                {disabled ? "Initializing..." : "Drag & drop your file here"}
              </p>
              <p className="text-sm text-[var(--text-faint)] mt-2">
                or click to browse CSV, Parquet, or .xlsx
              </p>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-[var(--text-faint)] mt-4">
          Powered by DuckDB • Client-side processing • Your data never leaves
          your browser
        </p>
      </div>
    </div>
  );
}

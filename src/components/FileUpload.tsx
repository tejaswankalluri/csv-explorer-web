import { useRef, useState, useCallback } from 'react';

interface FileUploadProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

export function FileUpload({ onFileSelected, disabled }: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith('.csv')) {
        alert('Please select a CSV file');
        return;
      }
      setSelectedFile(file);
      onFileSelected(file);
    },
    [onFileSelected]
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
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="file-upload">
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        onChange={handleChange}
        style={{ display: 'none' }}
        disabled={disabled}
      />

      <div
        className={`file-drop-zone ${isDragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {selectedFile ? (
          <div className="selected-file">
            <span className="file-icon">📄</span>
            <div className="file-info">
              <span className="file-name">{selectedFile.name}</span>
              <span className="file-size">{formatFileSize(selectedFile.size)}</span>
            </div>
          </div>
        ) : (
          <div className="upload-prompt">
            <span className="upload-icon">📁</span>
            <span className="upload-text">
              {disabled ? 'Initializing...' : 'Click or drag CSV file here'}
            </span>
            <span className="upload-hint">Supports CSV files up to 500MB</span>
          </div>
        )}
      </div>
    </div>
  );
}

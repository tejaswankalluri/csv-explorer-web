interface ProgressBarProps {
  fileName: string;
  fileSize: number;
  bytesProcessed: number;
  totalBytes: number;
  rowsLoaded: number;
  currentPhase: 'parsing' | 'inserting';
  onCancel?: () => void;
}

export function ProgressBar({
  fileName,
  fileSize,
  bytesProcessed,
  totalBytes,
  rowsLoaded,
  currentPhase,
  onCancel,
}: ProgressBarProps) {
  const percentage = totalBytes > 0 ? Math.round((bytesProcessed / totalBytes) * 100) : 0;

  const phaseLabel =
    currentPhase === 'parsing' ? 'Registering file...' : 'Creating table from CSV...';

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="progress-container">
      <div className="progress-header">
        <span className="progress-filename">{fileName}</span>
        <span className="progress-filesize">{formatFileSize(fileSize)}</span>
      </div>

      <div className="progress-phase">{phaseLabel}</div>

      <div className="progress-bar-wrapper">
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <span className="progress-percentage">{percentage}%</span>
      </div>

      {rowsLoaded > 0 && (
        <div className="progress-rows">
          {rowsLoaded.toLocaleString()} rows processed
        </div>
      )}

      {onCancel && (
        <button className="cancel-button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

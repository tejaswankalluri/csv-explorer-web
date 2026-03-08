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
    <div className="bg-white rounded-2xl shadow-xl shadow-slate-200/50 border border-slate-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
            <svg className="w-5 h-5 text-indigo-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-slate-800 truncate max-w-md">{fileName}</p>
            <p className="text-sm text-slate-500">{formatFileSize(fileSize)}</p>
          </div>
        </div>
        <span className="text-2xl font-bold text-indigo-600">{percentage}%</span>
      </div>

      <div className="mb-3">
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
          <span className="text-slate-600">{phaseLabel}</span>
        </div>
        {rowsLoaded > 0 && (
          <span className="text-slate-500 font-mono">{rowsLoaded.toLocaleString()} rows</span>
        )}
      </div>

      {onCancel && (
        <div className="mt-6 flex justify-center">
          <button 
            className="px-6 py-2 bg-slate-100 hover:bg-red-50 text-slate-600 hover:text-red-600 rounded-lg transition-all duration-200 text-sm font-medium"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

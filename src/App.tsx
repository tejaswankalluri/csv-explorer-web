import { useCallback, useEffect, useState } from "react";
import { useWorker } from "./hooks/useWorker";
import { FileUpload } from "./components/FileUpload";
import { ProgressBar } from "./components/ProgressBar";
import { CsvGridView } from "./components/CsvGridView";
import { ThemeToggle } from "./components/ThemeToggle";
import type { IngestState } from "./types/ingest-state";
import type {
  LoadDatasetComplete,
  LoadDatasetProgress,
} from "./types/worker-protocol";
import { WorkerRequestError } from "./lib/worker-client";
import {
  detectSupportedFileType,
  getUnsupportedFileMessage,
} from "./lib/file-types";
import {
  getPreferredTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "./lib/theme";

function App() {
  const { status, error: workerError, client } = useWorker();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") {
      return "light";
    }

    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : getPreferredTheme();
  });
  const [ingestState, setIngestState] = useState<IngestState>({
    phase: "idle",
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", themeMode);
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  const toggleTheme = useCallback(() => {
    setThemeMode((current) => (current === "light" ? "dark" : "light"));
  }, []);

  const handleFileSelected = useCallback(
    async (file: File) => {
      if (!client) return;

      const fileType = detectSupportedFileType(file.name);

      if (!fileType) {
        setIngestState({
          phase: "error",
          message: getUnsupportedFileMessage(file.name),
        });
        return;
      }

      setIngestState({
        phase: "reading",
        fileName: file.name,
        fileSize: file.size,
      });

      try {
        const buffer = await file.arrayBuffer();

        setIngestState({
          phase: "loading",
          fileName: file.name,
          fileSize: file.size,
          rowsLoaded: 0,
          bytesProcessed: 0,
          totalBytes: buffer.byteLength,
          currentPhase: "registering",
        });

        const result = await client.request<LoadDatasetComplete>(
          "LOAD_DATASET",
          {
            fileName: file.name,
            fileContent: buffer,
            fileType,
          },
          {
            transfer: [buffer],
            timeoutMs: 300_000,
            onStream: (msg) => {
              if (msg.type === "LOAD_DATASET_PROGRESS") {
                const progress = msg as LoadDatasetProgress;
                setIngestState({
                  phase: "loading",
                  fileName: file.name,
                  fileSize: file.size,
                  rowsLoaded: progress.payload.rowsLoaded,
                  bytesProcessed: progress.payload.bytesProcessed,
                  totalBytes: progress.payload.totalBytes,
                  currentPhase: progress.payload.phase,
                });
              }
            },
          },
        );

        setIngestState({
          phase: "complete",
          fileName: file.name,
          tableName: result.payload.tableName,
          totalRows: result.payload.totalRows,
          columns: result.payload.columns,
          elapsedMs: result.payload.elapsedMs,
        });
      } catch (err) {
        if (err instanceof WorkerRequestError && err.code === "CANCELLED") {
          setIngestState({ phase: "cancelled" });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          setIngestState({ phase: "error", message });
        }
      }
    },
    [client],
  );

  const handleCancel = useCallback(() => {
    if (client) {
      const requestId = client.getLastRequestId();
      if (requestId) {
        client.cancel(requestId);
      }
    }
  }, [client]);

  const handleReset = () => {
    setIngestState({ phase: "idle" });
  };

  if (ingestState.phase === "complete") {
    return (
        <CsvGridView
          client={client!}
          fileName={ingestState.fileName}
          tableName={ingestState.tableName}
          columns={ingestState.columns}
          totalRows={ingestState.totalRows}
          onReset={handleReset}
          themeMode={themeMode}
          onToggleTheme={toggleTheme}
        />
      );
  }

  const isDisabled = status !== "ready";

  return (
    <div
      data-theme={themeMode}
      className="min-h-screen bg-[radial-gradient(circle_at_top,var(--app-bg-accent),transparent_38%),linear-gradient(180deg,var(--app-bg-soft),var(--app-bg))] text-[var(--text-primary)] transition-colors"
    >
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="relative mb-12">
          <div className="absolute right-0 top-0">
            <ThemeToggle themeMode={themeMode} onToggle={toggleTheme} />
          </div>
          <div className="mx-auto max-w-3xl text-center">
          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-6 shadow-xl shadow-indigo-500/25">
            <svg
              className="w-10 h-10 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </div>
          <h1 className="text-4xl font-bold text-[var(--text-primary)] mb-3">
            Data Explorer
          </h1>
          <p className="text-lg text-[var(--text-muted)] max-w-xl mx-auto">
            Fast, powerful file viewer powered by DuckDB. Explore CSV,
            Parquet, and Excel data instantly with sorting, filtering, and
            more.
          </p>
          </div>
        </div>

        {status === "loading" && (
          <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-elevated)] p-8 mb-8 shadow-[0_24px_60px_-36px_var(--shadow-color)]">
            <div className="flex flex-col items-center justify-center">
              <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-500 rounded-full animate-spin"></div>
              <p className="mt-5 text-[var(--text-secondary)] font-medium">Loading...</p>
              <p className="text-sm text-[var(--text-faint)] mt-1">
                Initializing DuckDB engine
              </p>
            </div>
          </div>
        )}

        {status === "initializing" && (
          <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-elevated)] p-8 mb-8 shadow-[0_24px_60px_-36px_var(--shadow-color)]">
            <div className="flex flex-col items-center justify-center">
              <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-500 rounded-full animate-spin"></div>
              <p className="mt-5 text-[var(--text-secondary)] font-medium">Initializing...</p>
              <p className="text-sm text-[var(--text-faint)] mt-1">Setting up DuckDB</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="rounded-2xl border border-[var(--error-border)] bg-[var(--error-bg)] p-6 mb-8">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--panel-elevated)] flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-[var(--error-text)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <p className="font-semibold text-[var(--error-text)]">Failed to initialize</p>
            </div>
            <p className="text-[var(--error-text)] text-sm">{workerError}</p>
          </div>
        )}

        {status === "ready" && (
          <>
            <div className="rounded-3xl border border-[var(--panel-border)] bg-[var(--panel-bg)] overflow-hidden shadow-[0_24px_60px_-36px_var(--shadow-color)] backdrop-blur-sm">
              <FileUpload
                onFileSelected={handleFileSelected}
                disabled={isDisabled}
              />
            </div>
          </>
        )}

        {ingestState.phase === "reading" && (
          <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-elevated)] p-6 shadow-[0_20px_60px_-36px_var(--shadow-color)]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-[var(--accent-strong)] animate-pulse"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
              </div>
              <p className="text-[var(--text-secondary)] font-medium">
                Reading {ingestState.fileName}...
              </p>
            </div>
          </div>
        )}

        {ingestState.phase === "loading" && (
          <ProgressBar
            fileName={ingestState.fileName}
            fileSize={ingestState.fileSize}
            bytesProcessed={ingestState.bytesProcessed}
            totalBytes={ingestState.totalBytes}
            rowsLoaded={ingestState.rowsLoaded}
            currentPhase={ingestState.currentPhase}
            onCancel={handleCancel}
          />
        )}
        {status === "ready" && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
              <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-[0_20px_50px_-36px_var(--shadow-color)] backdrop-blur-sm transition hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-elevated)]">
                <div className="w-12 h-12 rounded-xl bg-sky-500/12 flex items-center justify-center mb-4">
                  <svg
                    className="w-6 h-6 text-sky-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M13 10V3L4 14h7v7l9-11h-7z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
                  Lightning Fast
                </h3>
                <p className="text-[var(--text-muted)]">
                  Process millions of rows instantly with DuckDB's powerful
                  in-memory engine.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-[0_20px_50px_-36px_var(--shadow-color)] backdrop-blur-sm transition hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-elevated)]">
                <div className="w-12 h-12 rounded-xl bg-violet-500/12 flex items-center justify-center mb-4">
                  <svg
                    className="w-6 h-6 text-violet-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
                  Private & Secure
                </h3>
                <p className="text-[var(--text-muted)]">
                  Your data never leaves your browser. Everything runs locally
                  with WebAssembly.
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--panel-border)] bg-[var(--panel-bg)] p-6 shadow-[0_20px_50px_-36px_var(--shadow-color)] backdrop-blur-sm transition hover:border-[var(--panel-border-strong)] hover:bg-[var(--panel-elevated)]">
                <div className="w-12 h-12 rounded-xl bg-emerald-500/12 flex items-center justify-center mb-4">
                  <svg
                    className="w-6 h-6 text-emerald-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-bold text-[var(--text-primary)] mb-2">
                  Advanced Filtering
                </h3>
                <p className="text-[var(--text-muted)]">
                  Sort, filter, and search through your data.
                </p>
              </div>
            </div>
          </>
        )}
        {ingestState.phase === "cancelled" && (
          <div className="rounded-2xl border border-[var(--warning-border)] bg-[var(--warning-bg)] p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-[var(--panel-elevated)] flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-[var(--warning-text)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
              </div>
              <p className="font-semibold text-[var(--warning-text)]">Load cancelled</p>
            </div>
            <button
              onClick={handleReset}
              className="w-full rounded-xl border border-[var(--warning-border)] bg-[var(--panel-elevated)] px-4 py-3 font-medium text-[var(--warning-text)] transition hover:bg-[var(--panel-hover)]"
            >
              Try Again
            </button>
          </div>
        )}

        {ingestState.phase === "error" && (
          <div className="rounded-2xl border border-[var(--error-border)] bg-[var(--error-bg)] p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-[var(--panel-elevated)] flex items-center justify-center">
                <svg
                  className="w-5 h-5 text-[var(--error-text)]"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </div>
              <p className="font-semibold text-[var(--error-text)]">Error loading file</p>
            </div>
            <p className="text-[var(--error-text)] text-sm mb-4">{ingestState.message}</p>
            <button
              onClick={handleReset}
              className="w-full rounded-xl border border-[var(--error-border)] bg-[var(--panel-elevated)] px-4 py-3 font-medium text-[var(--error-text)] transition hover:bg-[var(--panel-hover)]"
            >
              Try Again
            </button>
          </div>
        )}

        <div className="mt-12 text-center">
          <p className="text-sm text-[var(--text-faint)]">
            Open source • Free to use • No signup required
          </p>
        </div>
      </div>
    </div>
  );
}

export default App;

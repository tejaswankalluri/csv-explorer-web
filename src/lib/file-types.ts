import type { SupportedFileType } from '../types/worker-protocol';

const FILE_TYPE_BY_EXTENSION: Record<string, SupportedFileType> = {
  '.csv': 'csv',
  '.parq': 'parquet',
  '.parquet': 'parquet',
  '.xlsx': 'xlsx',
};

export const ACCEPTED_FILE_TYPES = Object.keys(FILE_TYPE_BY_EXTENSION).join(',');

function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex === -1) {
    return '';
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}

export function detectSupportedFileType(
  fileName: string,
): SupportedFileType | null {
  return FILE_TYPE_BY_EXTENSION[getFileExtension(fileName)] ?? null;
}

export function getUnsupportedFileMessage(fileName: string): string {
  const extension = getFileExtension(fileName);

  if (extension === '.xls') {
    return 'Please select a .xlsx file. Legacy .xls files are not supported.';
  }

  return 'Please select a CSV, Parquet, or .xlsx file.';
}

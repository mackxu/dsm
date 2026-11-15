import type { ReaderKind, ReaderSource } from './config.ts';

export interface ReaderProbeResult {
  fileName: string;
  preferredReader: ReaderKind;
  usedReader: ReaderKind;
  fallbackUsed: boolean;
  readerPath: string;
  readerVersion: string;
  readerSource: ReaderSource;
  directSize: number;
  readerSize: number;
  directSha256: string;
  readerSha256: string;
  directHead: string;
  readerHead: string;
  identical: boolean;
}

export interface ReaderCheckResult {
  readerKind: ReaderKind;
  readerPath: string;
  readerVersion: string;
  readerSource: ReaderSource;
  fallbackUsed: boolean;
}

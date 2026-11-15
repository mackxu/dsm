import type { Readable, Writable } from 'node:stream';

export interface FileReadStream {
  /** 读取代理 stdout，消费端必须处理 backpressure。 */
  stream: Readable;
  /** 退出码为 0 时返回总字节数；失败时以 DsmError reject。 */
  completed: Promise<number>;
  abort(): void;
}

export interface FileStreamReadOptions {
  maxBytes: number;
  timeoutMs: number;
}

export type FileStreamReader = (
  filePath: string,
  options: FileStreamReadOptions,
) => Promise<FileReadStream>;

export interface FileWriteResult {
  bytesWritten: number;
  sha256: string;
  tempPath: string;
}

export interface FileWriteSession {
  stdin: Writable;
  /** 写入代理退出后返回临时文件大小与哈希。 */
  completed: Promise<FileWriteResult>;
  abort(): void;
}

export interface FileStreamWriteOptions {
  timeoutMs: number;
}

export type FileStreamWriter = (
  targetDirectory: string,
  fileName: string,
  tempName: string,
  options: FileStreamWriteOptions,
) => Promise<FileWriteSession>;

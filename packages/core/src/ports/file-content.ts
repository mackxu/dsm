export interface FileContentReadOptions {
  /**
   * 允许读取的最大明文字节数。实现应在超限时中止读取，
   * 并抛出 code 为 FILE_TOO_LARGE 的 DsmError。
   */
  maxBytes: number;
}

/**
 * 读取待上传文件的明文字节。
 *
 * 默认实现直接使用 fs.readFile。企业 DSM 透明加密环境下，
 * Electron 主进程读取会得到密文，需要注入一个由白名单进程
 * （例如外部 node）实现的读取器。
 */
export type FileContentReader = (
  filePath: string,
  options: FileContentReadOptions,
) => Promise<Buffer>;

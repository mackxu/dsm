'use strict';

/**
 * DSM 读取代理。
 *
 * 由 Electron 主进程通过白名单中的 Node 启动：
 *   node dsm-file-reader.cjs <filePath> <maxBytes>
 *
 * - stdout 只输出文件原始字节，不写任何日志
 * - stderr 输出结构化错误 JSON
 * - 退出码：0 成功，1 读取失败，2 超过大小上限
 *
 * 不要在此脚本中使用 console.log，否则会破坏二进制内容。
 */

const fs = require('node:fs');

function main() {
  const filePath = process.argv[2];
  const maxBytes = Number(process.argv[3]);

  let finished = false;
  let total = 0;

  function fail(code, message, exitCode) {
    if (finished) return;
    finished = true;
    try {
      process.stderr.write(JSON.stringify({ code, message }));
    } catch {
      // stderr 不可用时只能通过退出码报告。
    }
    process.exitCode = exitCode;
  }

  if (!filePath) {
    fail('FILE_READ_FAILED', '缺少文件路径', 1);
    return;
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail('FILE_READ_FAILED', '读取上限无效', 1);
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail('FILE_READ_FAILED', `无法访问文件：${error.message}`, 1);
    return;
  }
  if (!stat.isFile()) {
    fail('FILE_READ_FAILED', '目标不是普通文件', 1);
    return;
  }
  if (stat.size <= 0) {
    fail('FILE_READ_FAILED', '文件为空', 1);
    return;
  }

  const stream = fs.createReadStream(filePath);

  stream.on('data', (chunk) => {
    if (finished) {
      stream.destroy();
      return;
    }
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      fail('FILE_TOO_LARGE', '文件超过上传大小上限', 2);
      return;
    }
    if (!process.stdout.write(chunk)) {
      stream.pause();
    }
  });

  process.stdout.on('drain', () => {
    if (!finished) stream.resume();
  });

  stream.on('error', (error) => {
    fail('FILE_READ_FAILED', `读取文件失败：${error.message}`, 1);
  });

  stream.on('end', () => {
    if (finished) return;
    if (total === 0) {
      fail('FILE_READ_FAILED', '文件为空', 1);
      return;
    }
    finished = true;
    process.exitCode = 0;
  });

  process.stdout.on('error', (error) => {
    if (error && error.code === 'EPIPE') {
      finished = true;
      stream.destroy();
      process.exitCode = 1;
    }
  });
}

main();

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * 以固定东八区（UTC+8）生成任务时间戳，不依赖系统时区。
 * 格式：YYYYMMDD-HHmmss-SSS。
 */
export function createUtc8Timestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
  return (
    [
      shifted.getUTCFullYear(),
      pad(shifted.getUTCMonth() + 1),
      pad(shifted.getUTCDate()),
    ].join('') +
    `-${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(
      shifted.getUTCSeconds(),
    )}-${pad(shifted.getUTCMilliseconds(), 3)}`
  );
}

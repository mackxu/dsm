function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

export function createLocalTimestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(
      date.getMilliseconds(),
      3,
    )}`;
}

import { DsmError, type ReaderKind, type ReaderSelection } from '@dsm/core';

import type { ReaderResolver, ResolvedReader } from './reader-executable.ts';

export interface ReaderChainResult {
  reader: ResolvedReader;
  fallbackUsed: boolean;
}

export function readerLabel(kind: ReaderKind): string {
  return kind === 'node' ? 'Node' : 'Python';
}

/**
 * 按优先读取器 → 备用读取器顺序解析。
 *
 * 解析器的显式配置错误会原样抛出，不在这里吞掉；只有优先读取器返回
 * null（未配置且自动探测失败）时才继续尝试备用读取器。
 */
export async function resolveReaderChain(
  selection: ReaderSelection,
  resolvers: Record<ReaderKind, ReaderResolver>,
): Promise<ReaderChainResult> {
  const order: ReaderKind[] =
    selection.preferredReader === 'node'
      ? ['node', 'python']
      : ['python', 'node'];
  const paths: Record<ReaderKind, string | null> = {
    node: selection.nodeReaderPath,
    python: selection.pythonReaderPath,
  };

  for (let index = 0; index < order.length; index += 1) {
    const kind = order[index];
    const reader = await resolvers[kind].resolve(paths[kind]);
    if (reader) {
      return { reader, fallbackUsed: index === 1 };
    }
  }

  throw new DsmError(
    'READER_UNAVAILABLE',
    `未找到可用的 Node 或 Python（优先：${readerLabel(selection.preferredReader)}），请在设置中填写白名单解释器的绝对路径`,
    'CHECK',
  );
}

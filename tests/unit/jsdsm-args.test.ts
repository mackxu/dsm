import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  resolvePaths,
} from 'jsdsm';

function runResult(argv: string[]) {
  const result = parseArgs(argv);
  if (result.kind !== 'run') {
    throw new Error(`期望 run，实际为 ${result.kind}`);
  }
  return result;
}

function usageMessage(argv: string[]): string {
  const result = parseArgs(argv);
  if (result.kind !== 'usage-error') {
    throw new Error(`期望 usage-error，实际为 ${result.kind}`);
  }
  return result.message;
}

describe('jsdsm parseArgs', () => {
  it('解析仅包含源文件路径的命令', () => {
    expect(runResult(['a.txt'])).toEqual({
      kind: 'run',
      source: 'a.txt',
      output: null,
      writerPath: null,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it('支持第二个位置参数作为输出目录', () => {
    const result = runResult(['a.txt', 'out']);
    expect(result.output).toBe('out');
  });

  it('支持 -o、--out 与 --out=', () => {
    expect(runResult(['a.txt', '-o', 'out']).output).toBe('out');
    expect(runResult(['a.txt', '--out', 'out']).output).toBe('out');
    expect(runResult(['a.txt', '--out=out']).output).toBe('out');
  });

  it('拒绝重复指定输出目录', () => {
    expect(usageMessage(['a.txt', '-o', 'x', '--out', 'y'])).toContain(
      '只能指定一次',
    );
    expect(usageMessage(['a.txt', '-o', 'x', 'out'])).toContain(
      '指定了多次',
    );
  });

  it('拒绝缺少值的选项', () => {
    expect(usageMessage(['a.txt', '-o'])).toContain('缺少输出目录');
    expect(usageMessage(['a.txt', '--out='])).toContain('缺少输出目录');
    expect(usageMessage(['a.txt', '--writer-path'])).toContain('缺少值');
    expect(usageMessage(['a.txt', '--timeout'])).toContain('缺少值');
  });

  it('支持 --writer-path 与 --timeout', () => {
    const result = runResult([
      'a.txt',
      '--writer-path',
      '/opt/pwsh',
      '--timeout',
      '30',
    ]);
    expect(result.writerPath).toBe('/opt/pwsh');
    expect(result.timeoutMs).toBe(30_000);

    expect(
      runResult(['a.txt', '--writer-path=/opt/pwsh']).writerPath,
    ).toBe('/opt/pwsh');
    expect(runResult(['a.txt', '--timeout=0']).timeoutMs).toBe(0);
  });

  it('拒绝重复的写入组件路径与超时选项', () => {
    expect(
      usageMessage([
        'a.txt',
        '--writer-path',
        '/a',
        '--writer-path',
        '/b',
      ]),
    ).toContain('只能指定一次');
    expect(
      usageMessage(['a.txt', '--timeout', '1', '--timeout', '2']),
    ).toContain('只能指定一次');
  });

  it('拒绝非法的超时值', () => {
    for (const value of ['-1', '1.5', 'abc', '86401']) {
      expect(usageMessage(['a.txt', '--timeout', value])).toContain(
        '0–86400',
      );
    }
  });

  it('支持帮助与版本，并优先返回', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['a.txt', '--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });

  it('拒绝未知选项', () => {
    expect(usageMessage(['a.txt', '--bogus'])).toContain('未知选项');
  });

  it('拒绝缺少源文件、空路径与多余参数', () => {
    expect(usageMessage([])).toContain('缺少源文件路径');
    expect(usageMessage([''])).toContain('源文件路径不能为空');
    expect(usageMessage(['a', 'b', 'c'])).toContain('参数过多');
  });

  it('-- 之后的参数按位置参数处理', () => {
    const result = runResult(['--', '-weird.txt', '-o']);
    expect(result.source).toBe('-weird.txt');
    expect(result.output).toBe('-o');
  });

  it('单独的 - 视为普通文件名', () => {
    expect(runResult(['-']).source).toBe('-');
  });

  it('保留中文与空格路径原样', () => {
    const result = runResult(['报告 2026.txt', '导出 目录']);
    expect(result.source).toBe('报告 2026.txt');
    expect(result.output).toBe('导出 目录');
  });
});

describe('jsdsm resolvePaths', () => {
  it('默认使用源文件所在目录', () => {
    const result = resolvePaths('sub/a.txt', null, '/tmp/base');
    expect(result.sourcePath).toBe('/tmp/base/sub/a.txt');
    expect(result.outputDirectory).toBe('/tmp/base/sub');
    expect(result.usedDefaultOutput).toBe(true);
  });

  it('显式输出目录相对 cwd 解析', () => {
    const result = resolvePaths('a.txt', 'out', '/tmp/base');
    expect(result.outputDirectory).toBe('/tmp/base/out');
    expect(result.usedDefaultOutput).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { MAX_NAME_ATTEMPTS, candidateName } from 'jsdsm';

describe('jsdsm candidateName', () => {
  it('第一次尝试返回原名', () => {
    expect(candidateName('a.txt', 0)).toBe('a.txt');
  });

  it('普通扩展名', () => {
    expect(candidateName('a.txt', 1)).toBe('a (1).txt');
    expect(candidateName('a.txt', 2)).toBe('a (2).txt');
  });

  it('无扩展名', () => {
    expect(candidateName('README', 1)).toBe('README (1)');
  });

  it('点文件', () => {
    expect(candidateName('.bashrc', 1)).toBe('.bashrc (1)');
    expect(candidateName('.env.local', 1)).toBe('.env (1).local');
  });

  it('多段扩展名只保留最后一段', () => {
    expect(candidateName('archive.tar.gz', 1)).toBe('archive.tar (1).gz');
  });

  it('中文与空格', () => {
    expect(candidateName('报告 2026.txt', 1)).toBe('报告 2026 (1).txt');
  });

  it('最大尝试次数为 10000', () => {
    expect(MAX_NAME_ATTEMPTS).toBe(10_000);
  });
});

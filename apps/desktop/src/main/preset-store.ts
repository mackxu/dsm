import { promises as fs } from 'node:fs';

import { EMPTY_PRESET, parsePresetConfig, type PresetConfig } from '@dsm/core';

/**
 * 读取安装包资源目录中的预置配置。文件不存在（例如开发环境未执行
 * prepare 脚本）时按空预置处理；内容损坏时报告一次并忽略。
 */
export class PresetStore {
  private cached: PresetConfig | null = null;

  constructor(
    private readonly presetPath: string,
    private readonly onError?: (error: unknown) => void,
  ) {}

  async load(): Promise<PresetConfig> {
    if (this.cached) {
      return structuredClone(this.cached);
    }

    try {
      const contents = await fs.readFile(this.presetPath, 'utf8');
      this.cached = parsePresetConfig(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.onError?.(error);
      }
      this.cached = { ...EMPTY_PRESET };
    }
    return structuredClone(this.cached);
  }

  getPath(): string {
    return this.presetPath;
  }
}

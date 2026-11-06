import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createConfigFromPreset,
  validateAppConfig,
  type AppConfig,
} from '@dsm/core';

import type { PresetStore } from './preset-store.ts';

export class ConfigStore {
  private readonly settingsPath: string;
  private cached: AppConfig | null = null;

  constructor(
    private readonly userDataDirectory: string,
    private readonly presetStore: PresetStore,
  ) {
    this.settingsPath = path.join(userDataDirectory, 'settings.json');
  }

  async load(): Promise<AppConfig> {
    if (this.cached) {
      return structuredClone(this.cached);
    }

    try {
      const contents = await fs.readFile(this.settingsPath, 'utf8');
      this.cached = validateAppConfig(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs
          .rename(this.settingsPath, `${this.settingsPath}.bad`)
          .catch(() => {});
      }
      // 用户配置不存在或已损坏时，安装包预置值作为首次使用默认值。
      this.cached = createConfigFromPreset(await this.presetStore.load());
    }
    return structuredClone(this.cached);
  }

  async save(input: unknown, documentsDirectory: string): Promise<AppConfig> {
    const config = validateAppConfig(input);
    const saveDirectory =
      config.saveDirectory ?? path.join(documentsDirectory, 'DSM');
    if (!path.isAbsolute(saveDirectory)) {
      throw new Error('保存目录必须是绝对路径');
    }

    await fs.mkdir(this.userDataDirectory, { recursive: true });
    await fs.mkdir(saveDirectory, { recursive: true });
    await fs.access(saveDirectory, fs.constants.W_OK);

    const temporaryPath = path.join(
      this.userDataDirectory,
      `.settings-${process.pid}-${Date.now()}.tmp`,
    );
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.rename(temporaryPath, this.settingsPath);
    this.cached = config;
    return structuredClone(config);
  }

  getPath(): string {
    return this.settingsPath;
  }
}

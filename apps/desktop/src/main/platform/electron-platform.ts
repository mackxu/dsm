import { app, shell } from 'electron';
import path from 'node:path';

import type { HttpTransport, PlatformAdapter, PlatformPaths } from '@dsm/core';

export class ElectronPlatform implements PlatformAdapter {
  paths(): PlatformPaths {
    return {
      userData: app.getPath('userData'),
      logs: path.join(app.getPath('userData'), 'logs'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      temporary: app.getPath('temp'),
    };
  }

  async revealInFileManager(targetPath: string): Promise<void> {
    shell.showItemInFolder(targetPath);
  }
}

export class ElectronHttpTransport implements HttpTransport {
  request(url: string, options?: RequestInit): Promise<Response> {
    return fetch(url, options);
  }
}

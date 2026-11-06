import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import MakerNSIS from 'electron-forge-maker-nsis';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    extraResource: [
      path.resolve('../../resources/preset.json'),
      path.resolve('../../resources/dsm-file-reader.cjs'),
    ],
    appBundleId: 'com.dsm-tool.desktop',
    ...(process.env.ELECTRON_ZIP_DIR
      ? { electronZipDir: process.env.ELECTRON_ZIP_DIR }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerNSIS(
      {
        artifactName: 'DSM-File-Sync-${version}-${arch}-Setup.${ext}',
        oneClick: false,
        perMachine: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'DSM 文件同步助手',
        uninstallDisplayName: 'DSM 文件同步助手',
        deleteAppDataOnUninstall: false,
        runAfterFinish: true,
      },
      ['win32'],
    ),
    new MakerZIP({}, ['darwin', 'win32']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;

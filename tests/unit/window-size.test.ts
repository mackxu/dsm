import { describe, expect, it } from 'vitest';

import { fitWindowToWorkArea } from '@dsm/desktop-runtime';

describe('window sizing', () => {
  it('keeps the preferred size on a 1080p display at 100% scaling', () => {
    expect(fitWindowToWorkArea({ width: 1920, height: 1040 })).toEqual({
      width: 480,
      height: 680,
    });
  });

  it('fits a 1080p display at 125% scaling', () => {
    expect(fitWindowToWorkArea({ width: 1536, height: 824 })).toEqual({
      width: 480,
      height: 680,
    });
  });

  it('fits a 1080p display at 150% scaling', () => {
    expect(fitWindowToWorkArea({ width: 1280, height: 680 })).toEqual({
      width: 480,
      height: 600,
    });
  });

  it('keeps the minimum size on a small work area', () => {
    expect(fitWindowToWorkArea({ width: 800, height: 600 })).toEqual({
      width: 480,
      height: 540,
    });
  });
});

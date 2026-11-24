const injected = (globalThis as { __JSDSM_VERSION__?: unknown })
  .__JSDSM_VERSION__;

export const VERSION =
  typeof injected === 'string' && injected.length > 0 ? injected : '0.1.0-dev';

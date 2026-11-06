import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  applyAuthenticationFailure,
  parseTokenRecord,
  resolveTokenRecord,
  userTokenRecord,
  type ResolvedToken,
  type TokenRecord,
  type TokenStatus,
} from '@dsm/core';

export class TokenStore {
  private readonly tokenPath: string;
  private cached: ResolvedToken | null = null;

  constructor(
    private readonly userDataDirectory: string,
    private readonly presetTokenPath: string,
  ) {
    this.tokenPath = path.join(userDataDirectory, 'token.json');
  }

  async getToken(): Promise<string> {
    return (await this.resolve()).token;
  }

  async getStatus(): Promise<TokenStatus> {
    return { ...(await this.resolve()).status };
  }

  async setUserToken(token: string): Promise<TokenStatus> {
    const normalized = token.trim();
    const record = userTokenRecord(normalized);
    await this.writeRecord(record);
    this.cached = resolveTokenRecord(record, '');
    return { ...this.cached.status };
  }

  async clear(): Promise<TokenStatus> {
    return this.setUserToken('');
  }

  async handleAuthenticationFailure(status: number): Promise<void> {
    const current = await this.resolve();
    const updated = applyAuthenticationFailure(current.record, status);
    if (updated === current.record) {
      return;
    }
    if (updated) {
      await this.writeRecord(updated);
    }
    this.cached = null;
  }

  private async resolve(): Promise<ResolvedToken> {
    if (this.cached) {
      return this.cached;
    }

    const existing = await this.readRecord();
    const preset = await fs
      .readFile(this.presetTokenPath, 'utf8')
      .then((value) => value.trim())
      .catch(() => '');
    const resolved = resolveTokenRecord(existing, preset);
    if (
      resolved.record &&
      (existing === null ||
        (resolved.record.source === 'preset' &&
          resolved.record.token !== existing.token))
    ) {
      await this.writeRecord(resolved.record);
    }
    this.cached = resolved;
    return resolved;
  }

  private async readRecord(): Promise<TokenRecord | null> {
    try {
      const contents = await fs.readFile(this.tokenPath, 'utf8');
      return parseTokenRecord(JSON.parse(contents));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      await fs.rename(this.tokenPath, `${this.tokenPath}.bad`).catch(() => {});
      return null;
    }
  }

  private async writeRecord(record: TokenRecord): Promise<void> {
    await fs.mkdir(this.userDataDirectory, { recursive: true });
    const temporaryPath = path.join(
      this.userDataDirectory,
      `.token-${process.pid}-${Date.now()}.tmp`,
    );
    await fs.writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, this.tokenPath);
  }
}

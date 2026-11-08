import { createHash } from 'node:crypto';

import { DsmError } from './errors.ts';

/** 任务分支统一从这个固定的空模板分支创建。 */
export const BASE_BRANCH_NAME = 'main';

const MAX_SEGMENT_LENGTH = 32;
const MAX_NAMESPACE_LENGTH = 48;

export interface ClientIdentity {
  username: string;
  hostname: string;
}

function hashSuffix(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

/**
 * 清洗用户名/主机名为合法的 Git 分支片段。
 * 清洗后为空时使用确定性哈希，保证中文用户名等场景不会互相碰撞。
 */
export function sanitizeClientBranchSegment(
  value: string,
  fallbackPrefix: string,
): string {
  const original = value.trim();
  const cleaned = original
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/[-_]+$/g, '');

  if (cleaned) {
    return cleaned;
  }
  return `${fallbackPrefix}-${hashSuffix(original)}`;
}

/** 生成客户端分支命名空间，例如 `zhangsan-pc01`。 */
export function resolveClientBranchNamespace(identity: ClientIdentity): string {
  const username = sanitizeClientBranchSegment(identity.username, 'user');
  const hostname = sanitizeClientBranchSegment(identity.hostname, 'host');
  const namespace = `${username}-${hostname}`
    .slice(0, MAX_NAMESPACE_LENGTH)
    .replace(/[-_]+$/g, '');
  return (
    namespace ||
    `client-${hashSuffix(`${identity.username}\u0000${identity.hostname}`)}`
  );
}

/** 每次任务使用的完整分支名：`<命名空间>/<时间戳>`。 */
export function buildTaskBranchName(
  namespace: string,
  timestamp: string,
): string {
  const normalizedNamespace = namespace.trim();
  if (!normalizedNamespace) {
    throw new DsmError(
      'CONFIG_INVALID',
      '客户端分支命名空间不能为空',
      'CHECK',
    );
  }
  return `${normalizedNamespace}/${timestamp}`;
}

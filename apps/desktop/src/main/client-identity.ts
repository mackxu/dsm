import os from 'node:os';

import { resolveClientBranchNamespace } from '@dsm/core';

/** 读取本机用户名与主机名，生成客户端分支命名空间。 */
export function resolveLocalClientBranchNamespace(): string {
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? process.env.USERNAME ?? '';
  }

  let hostname = '';
  try {
    hostname = os.hostname();
  } catch {
    hostname = '';
  }

  return resolveClientBranchNamespace({ username, hostname });
}

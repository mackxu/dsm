import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { LogEntry, LogPage } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';

interface LogsPageProps {
  onNotice: (message: string | null) => void;
}

export function LogsPage({ onNotice }: LogsPageProps): React.JSX.Element {
  const [page, setPage] = useState<LogPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  async function refresh(search = activeQuery): Promise<void> {
    setLoading(true);
    try {
      setPage(await unwrap(window.dsm.getLogs(0, 100, search)));
      listRef.current?.scrollTo(0, 0);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh('');
  }, []);

  function search(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextQuery = query.trim();
    setActiveQuery(nextQuery);
    void refresh(nextQuery);
  }

  function clearSearch(): void {
    setQuery('');
    setActiveQuery('');
    void refresh('');
  }

  async function loadMore(): Promise<void> {
    if (!page) return;
    try {
      const next = await unwrap(
        window.dsm.getLogs(page.entries.length, 100, activeQuery),
      );
      setPage({
        entries: [...page.entries, ...next.entries],
        total: next.total,
        hasMore: next.hasMore,
      });
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  async function copy(): Promise<void> {
    if (!page) return;
    await navigator.clipboard.writeText(
      page.entries.map(formatLogLineForCopy).join('\n'),
    );
    onNotice('当前日志已复制');
  }

  async function clear(): Promise<void> {
    if (!window.confirm('确定清空全部日志？此操作无法撤销。')) return;
    try {
      await unwrap(window.dsm.clearLogs());
      await refresh();
      onNotice('日志已清空');
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  return (
    <section className="logs-page">
      <div className="logs-header">
        <p className="lead">
          记录最近 7 天的同步过程，最多占用 5
          MB。可以按关键词搜索；访问令牌、认证信息和文件内容不会写入日志。
        </p>
        <div className="action-row compact-row">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void refresh()}
          >
            {loading ? '刷新中…' : '刷新'}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => void copy()}
          >
            复制
          </button>
          <button
            type="button"
            className="danger-text"
            onClick={() => void clear()}
          >
            清空
          </button>
        </div>
      </div>
      <form className="log-search" onSubmit={search}>
        <input
          value={query}
          placeholder="搜索关键词"
          aria-label="搜索日志"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="primary-button">
          搜索
        </button>
        {(query || activeQuery) && (
          <button type="button" className="text-button" onClick={clearSearch}>
            清除
          </button>
        )}
      </form>
      {activeQuery && (
        <p className="log-search-summary">
          搜索“{activeQuery}”：找到 {page?.total ?? 0} 条日志
        </p>
      )}
      <div className="log-plain-text" aria-label="运行日志" ref={listRef}>
        {page?.entries.length ? (
          page.entries.map((entry, index) => (
            <LogPlainTextLine
              key={`${entry.time}-${index}`}
              entry={entry}
              query={activeQuery}
            />
          ))
        ) : (
          <div className="empty-state">
            <strong>{activeQuery ? '没有匹配日志' : '暂无日志'}</strong>
            <span>
              {activeQuery
                ? '尝试缩短关键词或检查大小写。'
                : '同步过程会记录在这里。'}
            </span>
          </div>
        )}
      </div>
      {page?.hasMore && (
        <button
          type="button"
          className="load-more"
          onClick={() => void loadMore()}
        >
          加载更多（{page.entries.length} / {page.total}）
        </button>
      )}
    </section>
  );
}

function formatLogLineForCopy(entry: LogEntry): string {
  const values = {
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.commitId ? { commitId: entry.commitId } : {}),
    ...(entry.details ? { details: entry.details } : {}),
  };
  const metadata =
    Object.keys(values).length > 0 ? ` | ${JSON.stringify(values)}` : '';
  return `${entry.time} [${entry.level}] [${entry.stage ?? 'LOG'}] ${
    entry.message
  }${metadata}`;
}

function LogPlainTextLine({
  entry,
  query,
}: {
  entry: LogEntry;
  query: string;
}): React.JSX.Element {
  const values = {
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.commitId ? { commitId: entry.commitId } : {}),
    ...(entry.details ? { details: entry.details } : {}),
  };
  const metadata =
    Object.keys(values).length > 0 ? ` | ${JSON.stringify(values)}` : '';
  const header = `${new Date(entry.time).toLocaleString()} [${entry.level}] [${
    entry.stage ?? 'LOG'
  }]`;
  return (
    <div className="log-plain-line">
      <strong>{highlightText(header, query)}</strong>{' '}
      <span>{highlightText(singleLine(entry.message), query)}</span>
      {metadata && <span>{highlightText(metadata, query)}</span>}
    </div>
  );
}

function highlightText(text: string, query: string): React.ReactNode {
  const keyword = query.trim();
  if (!keyword) return text;

  const pattern = new RegExp(`(${escapeRegExp(keyword)})`, 'gi');
  const parts = text.split(pattern);
  if (parts.length === 1) return text;

  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="log-highlight">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ');
}

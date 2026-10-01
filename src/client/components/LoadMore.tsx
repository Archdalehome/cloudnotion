import { useEffect, useRef, useState } from 'react';

interface LoadMoreProps {
  /** 服务端还有下一页（表格详情的 `hasMore`）时才继续观察 */
  hasMore: boolean;
  /** 下一页正在路上：加载中不再重复触发 */
  loading: boolean;
  /** 取下一页（DatabasePage.loadMore）；返回 false = 这次没取到，哨兵会退避后再试 */
  onLoadMore: () => Promise<boolean>;
}

/**
 * 「滚动到底自动加载下一页」的哨兵：放在表格 / 看板 / 画廊各自滚动容器的末尾，
 * 它被滚进视口（提前 200px）时自动去取下一页 —— 取代原来表格右上角的「加载更多」按钮，
 * 所以三种视图都能一直往下取数据，不用再去找那个按钮。
 *
 * 观察器在 `hasMore` / `loading` 变化时重建，而重建时会立刻回调一次当前的可见状态：
 * 因此一页填不满视口（哨兵还在视口里）时会接着取下一页，直到填满或者取完
 * （`hasMore` 变 false 时组件自己收起来）。
 *
 * 取失败时不会立刻再试：退避 3s → 6s → 12s（最多 15s）之后再观察一次。
 * 否则「哨兵一直在视口里 + 请求一直失败」会变成请求风暴。
 */
export function LoadMore({ hasMore, loading, onLoadMore }: LoadMoreProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  /** 回调每次渲染都是新的：用 ref 转一手，观察器就只需要依赖 hasMore / loading */
  const callbackRef = useRef(onLoadMore);
  useEffect(() => {
    callbackRef.current = onLoadMore;
  }, [onLoadMore]);

  /** 连续失败次数：用来算退避时长 */
  const failuresRef = useRef(0);
  /** 正在退避：这期间不观察，也就不发请求 */
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!paused) return;
    const delay = Math.min(3000 * 2 ** (failuresRef.current - 1), 15000);
    const timer = window.setTimeout(() => setPaused(false), delay);
    return () => window.clearTimeout(timer);
  }, [paused]);

  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !hasMore || loading || paused) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void (async () => {
          const ok = await callbackRef.current();
          if (ok) {
            failuresRef.current = 0;
            return;
          }
          failuresRef.current += 1;
          setPaused(true);
        })();
      },
      // 提前 200px 触发：快滚到底时下一页已经在路上
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, paused]);

  if (!hasMore) return null;

  return (
    <div ref={nodeRef} className="load-more">
      {loading ? '正在加载更多记录…' : paused ? '加载失败，稍后自动重试…' : '向下滚动加载更多'}
    </div>
  );
}
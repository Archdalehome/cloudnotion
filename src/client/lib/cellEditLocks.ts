/**
 * 单元格级「限制编辑」的客户端状态。
 *
 * 勾选了「限制编辑」的分享（公开链接 / 视图定向分享）对每一格的输入**次数不限**，
 * 但每次保存成功后都要等 **10 秒**才会锁上：窗口内想改多少遍都行；窗口一到，只要
 * 这一格仍然有内容就只读（只能请表格所有者代改）；而在这 10 秒内把内容清空则等于
 * 「没输入过」—— 计时取消、这一格恢复可编辑。窗口从**最近一次保存成功**起算，
 * 与 Worker 的判断完全一致。
 *
 * 服务端是权威，它每次下发数据时都给出两样东西（见 `shared/types.ts` 的
 * `CellEditLocks`）：
 *   - `lockedCells`：已经过了窗口、彻底只读的格子；
 *   - `cellEditGrace`：还在窗口内的格子 → 窗口截止时刻（epoch ms）。
 * 这里把两者存成 React 状态，并负责在窗口到点时自动重渲染（该格当场变成只读），
 * 这样即使不做任何请求，界面上的 10 秒倒计时也是准的。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CELL_EDIT_GRACE_MS, cellLockKey } from '../../shared/fields';
import type { CellEditLocks } from '../../shared/types';

/** 界面只关心「这一格现在能不能点开改」和「窗口还剩几秒」 */
export interface CellEditGuard {
  /** 现在这一刻这一格是否已经只读（保存过、10 秒计时窗口已经关了、值还在） */
  isSpent(recordId: string, propertyId: string): boolean;
  /** 这一格的计时窗口还剩多少毫秒（0 = 不在窗口里 / 已经到期） */
  graceLeftMs(recordId: string, propertyId: string): number;
  /** 把服务端下发的锁定状态并进本地（只增不减，服务端说了算） */
  merge(locks: Partial<CellEditLocks> | null | undefined): void;
  /** 整表重载 / 换表格：用服务端刚下发的状态覆盖本地 */
  reset(locks: Partial<CellEditLocks> | null | undefined): void;
  /** 本地乐观登记：刚保存成功的格子（每次保存都重新起算 10 秒） */
  markEdited(keys: string | string[]): void;
  /** 本地乐观清除：刚被清空的格子（视为没输入过，窗口与只读状态一起撤销） */
  clearCells(keys: string | string[]): void;
}

function toGraceMap(grace: Record<string, number> | undefined | null): Map<string, number> {
  return new Map(Object.entries(grace ?? {}));
}

/** 两份锁定集合内容是否一致（避免 reset 用等值的新对象引起多余渲染） */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/** 两份计时窗口内容是否一致（key 与截止时刻都相同才算一致） */
function sameGrace(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, until] of a) if (b.get(key) !== until) return false;
  return true;
}

export function useCellEditLocks(initial?: Partial<CellEditLocks> | null): CellEditGuard {
  const [lockedCells, setLockedCells] = useState<ReadonlySet<string>>(
    () => new Set(initial?.lockedCells ?? []),
  );
  const [graceUntil, setGraceUntil] = useState<ReadonlyMap<string, number>>(() =>
    toGraceMap(initial?.cellEditGrace),
  );
  /** 判断用的「现在」：窗口到点 / 倒计时的时候由下面的定时器推进 */
  const [clock, setClock] = useState(() => Date.now());

  /**
   * 有格子还在计时窗口里时，每秒推进一次 `clock`：
   * 一是让「还剩 N 秒」的提示是活的，二是窗口一到就把该格判成只读。
   * 没有窗口记录时这个 effect 什么都不做，不会带来任何额外渲染。
   */
  useEffect(() => {
    if (!graceUntil.size) return;
    const now = Date.now();
    const coming = [...graceUntil.values()].filter((until) => until > now);
    if (!coming.length) {
      // 全部过期：丢掉窗口记录（这些格子已经由 `isSpent` 判为只读）
      setGraceUntil((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const [key, until] of prev) {
          if (until > now) next.set(key, until);
          else changed = true;
        }
        return changed ? next : prev;
      });
      return;
    }
    setClock(now);
    const timer = window.setInterval(() => {
      const tick = Date.now();
      setClock(tick);
      // 已经有格子到期：当场把过期的窗口记录清掉，界面立刻按只读渲染
      if (coming.some((until) => until <= tick)) {
        window.clearInterval(timer);
        setGraceUntil((prev) => {
          let changed = false;
          const next = new Map<string, number>();
          for (const [key, until] of prev) {
            if (until > tick) next.set(key, until);
            else changed = true;
          }
          return changed ? next : prev;
        });
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [graceUntil]);

  const merge = useCallback((locks: Partial<CellEditLocks> | null | undefined) => {
    if (!locks) return;
    const keys = locks.lockedCells ?? [];
    if (keys.length) {
      setLockedCells((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const key of keys) {
          if (next.has(key)) continue;
          next.add(key);
          changed = true;
        }
        return changed ? next : prev;
      });
    }
    const entries = Object.entries(locks.cellEditGrace ?? {});
    if (entries.length) {
      setGraceUntil((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [key, until] of entries) {
          if (next.get(key) === until) continue;
          next.set(key, until);
          changed = true;
        }
        return changed ? next : prev;
      });
    }
  }, []);

  const reset = useCallback((locks: Partial<CellEditLocks> | null | undefined) => {
    // 只在内容真的变了才换新对象：整表重载（换表 / reload）每次都会调 reset，
    // 无条件换新引用会让 `cellGuard` 的引用跟着抖，依赖它的 effect 被反复触发
    // （症状：刚加载进来的下一页立刻被整表重置顶掉、分页游标退回第一页）。
    const nextLocked = new Set(locks?.lockedCells ?? []);
    const nextGrace = toGraceMap(locks?.cellEditGrace);
    setLockedCells((prev) => (sameSet(prev, nextLocked) ? prev : nextLocked));
    setGraceUntil((prev) => (sameGrace(prev, nextGrace) ? prev : nextGrace));
    // 没有窗口记录时不用动时钟：`isSpent` 只看锁定集合，倒计时也没得算
    if (nextGrace.size) setClock(Date.now());
  }, []);

  const markEdited = useCallback((keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    if (!list.length) return;
    const until = Date.now() + CELL_EDIT_GRACE_MS;
    setGraceUntil((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of list) {
        // 每次保存都重新开始计时：窗口从最近一次输入的那一刻算起
        if (next.get(key) === until) continue;
        next.set(key, until);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  /**
   * 刚把这一格清空：撤销它的窗口与只读状态（等于没输入过）。
   * 服务端把记账删掉了，所以之后再输入会重新开始计时。
   */
  const clearCells = useCallback((keys: string | string[]) => {
    const list = Array.isArray(keys) ? keys : [keys];
    if (!list.length) return;
    setGraceUntil((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of list) if (next.delete(key)) changed = true;
      return changed ? next : prev;
    });
    setLockedCells((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const key of list) if (next.delete(key)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  const isSpent = useCallback(
    (recordId: string, propertyId: string): boolean => {
      const key = cellLockKey(recordId, propertyId);
      const until = graceUntil.get(key);
      // 还在计时窗口内：可以继续重新输入 / 修改
      if (until !== undefined && until > clock) return false;
      return lockedCells.has(key) || until !== undefined;
    },
    [clock, graceUntil, lockedCells],
  );

  const graceLeftMs = useCallback(
    (recordId: string, propertyId: string): number => {
      const until = graceUntil.get(cellLockKey(recordId, propertyId));
      return until === undefined ? 0 : Math.max(0, until - clock);
    },
    [clock, graceUntil],
  );

  return useMemo<CellEditGuard>(
    () => ({ isSpent, graceLeftMs, merge, reset, markEdited, clearCells }),
    [clearCells, graceLeftMs, isSpent, markEdited, merge, reset],
  );
}

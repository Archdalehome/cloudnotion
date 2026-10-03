/**
 * 表格名额（「还能再添加几张表格」）的规则与计算：Worker 与前端共用。
 *
 * 这里只放纯函数（不读环境变量、不碰数据库）：服务端拿它算 `/api/quota`，
 * 前端拿它兜底显示与文案。数据结构见 `types.ts` 的 `TableQuota`。
 */
import type { TableQuota } from './types';

/** 新注册账号的表格名额：1 个 */
export const BASE_TABLE_QUOTA = 1;

/** 一次购买最多能选的数量（购买功能还没上线，这里只用于说明弹窗的下拉框） */
export const MAX_PURCHASE_COUNT = 10;

/** 名额规则的三句话：侧边栏的说明弹窗原样展示，改口径时只改这里 */
export const TABLE_QUOTA_RULES: string[] = [
  `新注册账号默认可以添加 ${BASE_TABLE_QUOTA} 个表格。`,
  '每分享一次表格（视图定向分享 / 公开链接 / 协作者），可以添加的数量就 +1。',
  '也可以直接购买表格名额：买几个就多几个可添加的表格。',
];

function countOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** 按「已用 / 已分享 / 已购买」算总名额与剩余可添加数量 */
export function tableQuotaOf(input: { used: number; shared: number; purchased?: number }): TableQuota {
  const used = countOf(input.used);
  const shared = countOf(input.shared);
  const purchased = countOf(input.purchased);
  const total = BASE_TABLE_QUOTA + shared + purchased;
  return { used, shared, purchased, total, remaining: Math.max(0, total - used) };
}

/** 说明弹窗里的现状行：`已添加 2 个 · 共 3 个名额 · 还剩 1 个` */
export function tableQuotaSummary(quota: TableQuota): string {
  return `已添加 ${quota.used} 个 · 共 ${quota.total} 个名额 · 还剩 ${quota.remaining} 个`;
}

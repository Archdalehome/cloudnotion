import type { ViewConfig, ViewType } from './types';

export const VIEW_TYPE_LABEL: Record<ViewType, string> = {
  table: '表格',
  board: '看板',
  gallery: '画廊',
};

export function defaultViewConfig(type: ViewType): ViewConfig {
  return {
    filters: { conjunction: 'and', conditions: [] },
    sorts: [],
    groupBy: null,
    visibleProperties: null,
    rowHeight: type === 'gallery' ? 'tall' : 'short',
    cardSize: 'medium',
    cardPreviewPropertyId: null,
  };
}

/** Merge a stored (possibly older / partial) config with the defaults. */
export function mergeViewConfig(type: ViewType, stored: Partial<ViewConfig> | null | undefined): ViewConfig {
  const base = defaultViewConfig(type);
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    filters: {
      conjunction: stored.filters?.conjunction === 'or' ? 'or' : 'and',
      conditions: Array.isArray(stored.filters?.conditions) ? stored.filters.conditions : [],
    },
    sorts: Array.isArray(stored.sorts) ? stored.sorts : [],
  };
}

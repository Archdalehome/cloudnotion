import { FIELD_META, formatValueForDisplay } from '../../shared/fields';
import type { FileValue, Property, RowRecord, SelectOption, ViewDef } from '../../shared/types';
import { api } from '../api';
import type { UserNames } from './Cell';
import { computedText } from './Cell';
import type { RowGroup } from '../lib/viewEngine';
import { LoadMore } from './LoadMore';
import { Popover } from './Popover';

function textOf(property: Property, row: RowRecord, users: UserNames): string {
  if (FIELD_META[property.type].computed) return computedText(property, row, users);
  return formatValueForDisplay(property.type, row.values[property.id], property.config, { users });
}

/** First text field acts as the card title, mirroring Notion's name column. */
export function titlePropertyOf(properties: Property[]): Property | undefined {
  return properties.find((property) => property.type === 'text') ?? properties.find((property) => !FIELD_META[property.type].computed) ?? properties[0];
}

function cardFieldsOf(properties: Property[], view: ViewDef, titleId: string | undefined): Property[] {
  const visible = view.config.visibleProperties;
  const shown = visible ? properties.filter((property) => visible.includes(property.id)) : properties;
  return shown.filter((property) => property.id !== titleId && property.type !== 'files').slice(0, 4);
}

interface BoardProps {
  properties: Property[];
  groups: RowGroup[];
  users: UserNames;
  view: ViewDef;
  canEdit: boolean;
  onOpen: (row: RowRecord) => void;
  onCreateRow: (option: SelectOption | null) => void;
  onMoveRow: (row: RowRecord, groupKey: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** 取下一页；返回 false 表示这次没取到（由 LoadMore 决定何时重试） */
  onLoadMore: () => Promise<boolean>;
}

export function BoardView({ properties, groups, users, view, canEdit, onOpen, onCreateRow, onMoveRow, hasMore, loadingMore, onLoadMore }: BoardProps) {
  const title = titlePropertyOf(properties);
  const fields = cardFieldsOf(properties, view, title?.id);

  return (
    <div className="board">
      {groups.map((group) => (
        <div className="board-column" key={group.key}>
          <div className="board-column-head">
            {group.option ? <span className={`pill pill-${group.option.color}`}>{group.label}</span> : <span>{group.label}</span>}
            <span className="spacer" />
            <span>{group.rows.length}</span>
            {canEdit ? (
              <button type="button" className="icon-btn" title="在此分组新建" onClick={() => onCreateRow(group.option)}>
                ＋
              </button>
            ) : null}
          </div>

          {group.rows.map((row) => (
            <div key={row.id} className="card" onClick={() => onOpen(row)}>
              <div className="card-title">{title ? textOf(title, row, users) || '未命名' : '未命名'}</div>
              <div className="card-meta">
                {fields.map((property) => {
                  const text = textOf(property, row, users);
                  if (!text) return null;
                  return (
                    <span key={property.id}>
                      {property.name}：{text}
                    </span>
                  );
                })}
              </div>
              {canEdit && groups.length > 1 ? (
                <div className="row gap" onClick={(event) => event.stopPropagation()}>
                  <Popover label="移动到" title="移动到分组">
                    {(close) => (
                      <div>
                        {groups
                          .filter((item) => item.key !== group.key)
                          .map((item) => (
                            <button
                              key={item.key}
                              type="button"
                              className="menu-item"
                              onClick={() => {
                                onMoveRow(row, item.key);
                                close();
                              }}
                            >
                              {item.option ? <span className={`pill pill-${item.option.color}`}>{item.label}</span> : item.label}
                            </button>
                          ))}
                      </div>
                    )}
                  </Popover>
                </div>
              ) : null}
            </div>
          ))}

          {!group.rows.length ? <p className="small muted">暂无卡片</p> : null}
        </div>
      ))}
      {!groups.length ? (
        <div className="empty-state">
          <p>该视图还没有分组，请在「设置 → 分组依据」里选择一个字段。</p>
        </div>
      ) : null}

      <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
    </div>
  );
}


interface GalleryProps {
  properties: Property[];
  rows: RowRecord[];
  users: UserNames;
  view: ViewDef;
  canEdit: boolean;
  onOpen: (row: RowRecord) => void;
  onCreateRow: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  /** 取下一页；返回 false 表示这次没取到（由 LoadMore 决定何时重试） */
  onLoadMore: () => Promise<boolean>;
}

function imageOf(row: RowRecord, propertyId: string | null | undefined): FileValue | null {
  if (!propertyId) return null;
  const value = row.values[propertyId];
  if (!Array.isArray(value)) return null;
  const files = value as FileValue[];
  return files.find((file) => typeof file?.mime === 'string' && file.mime.startsWith('image/')) ?? null;
}

export function GalleryView({ properties, rows, users, view, canEdit, onOpen, onCreateRow, hasMore, loadingMore, onLoadMore }: GalleryProps) {
  const title = titlePropertyOf(properties);
  const fields = cardFieldsOf(properties, view, title?.id).filter((property) => !FIELD_META[property.type].computed);
  const size = view.config.cardSize ?? 'medium';
  const previewId = view.config.cardPreviewPropertyId ?? null;
  const previewProperty = previewId ? properties.find((property) => property.id === previewId) : undefined;

  return (
    <div className="gallery-wrap">
      <div className="gallery" data-size={size}>
        {rows.map((row) => {
          const image = imageOf(row, previewId);
          return (
            <div key={row.id} className="gallery-card">
              {previewProperty ? (
                <div className="gallery-preview" onClick={() => onOpen(row)}>
                  {image ? (
                    <img src={api.fileUrl(image.id)} alt={image.name} loading="lazy" />
                  ) : (
                    <span className="small muted">
                      {formatValueForDisplay(
                        previewProperty.type,
                        row.values[previewProperty.id],
                        previewProperty.config,
                        { users },
                      ) || '无预览内容'}
                    </span>
                  )}
                </div>
              ) : null}
              <div className="gallery-body" onClick={() => onOpen(row)}>
                <div className="card-title">{title ? textOf(title, row, users) || '未命名' : '未命名'}</div>
                <div className="card-meta">
                  {fields.map((property) => {
                    const text = textOf(property, row, users);
                    if (!text) return null;
                    return (
                      <span key={property.id}>
                        {property.name}：{text}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}

        {canEdit ? (
          <button type="button" className="gallery-add" onClick={onCreateRow}>
            ＋ 新建
          </button>
        ) : null}

        <LoadMore hasMore={hasMore} loading={loadingMore} onLoadMore={onLoadMore} />
      </div>

      {!rows.length ? (
        <div className="empty-state">
          <p>还没有记录</p>
          {canEdit ? (
            <button type="button" className="btn primary" onClick={onCreateRow}>
              创建第一条记录
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

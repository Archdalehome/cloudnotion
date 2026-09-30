import { useState } from 'react';
import { FIELD_META, cellLockHint, cellLockKey } from '../../shared/fields';
import type { CellValue, FileValue, Property, RowRecord } from '../../shared/types';
import { CellEditor, CellView, computedText, useCloseOnOutsideClick, type UserNames } from './Cell';
import { Modal } from './Modal';

interface RecordDialogProps {
  properties: Property[];
  row: RowRecord;
  users: UserNames;
  canEdit: boolean;
  onClose: () => void;
  onCommitCell: (property: Property, value: CellValue | undefined) => void;
  uploadFile: (property: Property, file: File) => Promise<FileValue>;
  onDuplicate: () => void;
  onDelete: () => void;
  /** 当前访问者已经改过一次的格子（`记录 id:字段 id`），只读并给出提示 */
  lockedCells: ReadonlySet<string>;
}

/** Full-record editor shown from board / gallery cards. */
export function RecordDialog({
  properties,
  row,
  users,
  canEdit,
  onClose,
  onCommitCell,
  uploadFile,
  onDuplicate,
  onDelete,
  lockedCells,
}: RecordDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const title = properties.find((property) => property.type === 'text')?.name ?? '记录';
  // 点击单元格以外的任意位置即退出输入（日期 / 文件字段自动保存，没有「确认」按钮）
  useCloseOnOutsideClick(editingId !== null, () => setEditingId(null));

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="center-list">
        {properties.map((property) => {
          // 字段级锁定：锁定字段只读，内容照常显示
          const editable = canEdit && !FIELD_META[property.type].computed && !property.locked;
          /** 共享的可编辑用户每个格子只有一次机会，已经用掉的格子只读 */
          const spent = lockedCells.has(cellLockKey(row.id, property.id));
          const editing = editingId === property.id;
          return (
            <div className="row gap" key={property.id}>
              <span
                className="small muted"
                style={{ width: 120, flex: '0 0 120px' }}
                title={spent ? cellLockHint(property.name) : undefined}
              >
                {property.locked || spent ? '🔒 ' : ''}
                {property.name}
              </span>
              <div style={{ flex: 1, minWidth: 0 }} data-editing-cell={editing ? 'true' : undefined}>
                {editing ? (
                  <CellEditor
                    property={property}
                    value={row.values[property.id]}
                    uploadFile={(file) => uploadFile(property, file)}
                    onCommit={(value) => {
                      setEditingId(null);
                      onCommitCell(property, value);
                    }}
                    onAutoSave={(value) => onCommitCell(property, value)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : FIELD_META[property.type].computed ? (
                  <span className="cell-static">{computedText(property, row, users)}</span>
                ) : (
                  <CellView
                    property={property}
                    row={row}
                    users={users}
                    editable={editable}
                    spent={spent}
                    onEdit={() => setEditingId(property.id)}
                    onQuickChange={(value) => onCommitCell(property, value)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        {canEdit ? (
          <>
            <button type="button" className="btn ghost small" onClick={onDuplicate}>
              复制记录
            </button>
            <button
              type="button"
              className="btn ghost small danger"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              删除记录
            </button>
          </>
        ) : null}
        <button type="button" className="btn primary small" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

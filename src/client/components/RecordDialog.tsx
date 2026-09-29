import { useState } from 'react';
import { FIELD_META } from '../../shared/fields';
import type { CellValue, FileValue, Property, RowRecord } from '../../shared/types';
import { CellEditor, CellView, computedText, type UserNames } from './Cell';
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
}: RecordDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const title = properties.find((property) => property.type === 'text')?.name ?? '记录';

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="center-list">
        {properties.map((property) => {
          // 字段级锁定：锁定字段只读，内容照常显示
          const editable = canEdit && !FIELD_META[property.type].computed && !property.locked;
          const editing = editingId === property.id;
          return (
            <div className="row gap" key={property.id}>
              <span className="small muted" style={{ width: 120, flex: '0 0 120px' }}>
                {property.locked ? '🔒 ' : ''}
                {property.name}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {editing ? (
                  <CellEditor
                    property={property}
                    value={row.values[property.id]}
                    uploadFile={(file) => uploadFile(property, file)}
                    onCommit={(value) => {
                      setEditingId(null);
                      onCommitCell(property, value);
                    }}
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

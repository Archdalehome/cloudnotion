import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { ApiError } from '../api';
import { FIELD_META, cellLockHint, cellLockKey } from '../../shared/fields';
import type { CellValue, FileValue, Member, Property, RecordNote, RowRecord } from '../../shared/types';
import { formatDateTime, formatRelativeTime } from '../lib/time';
import { CellEditor, CellView, computedText, useCloseOnOutsideClick, type UserNames } from './Cell';
import { Modal } from './Modal';

interface RecordDialogProps {
  properties: Property[];
  row: RowRecord;
  users: UserNames;
  canEdit: boolean;
  /** 记录上的备注：只能新增，不能修改 / 删除 */
  notes: RecordNote[];
  /** 可以被 @ 提醒的人（表格所有者 + 成员 + 定向分享的访客），不含当前用户 */
  mentionCandidates: Member[];
  /** 从私信点进来时要定位（滚动 + 高亮）的备注 id */
  focusNoteId?: string | null;
  onClose: () => void;
  onCommitCell: (property: Property, value: CellValue | undefined) => void;
  uploadFile: (property: Property, file: File) => Promise<FileValue>;
  /** 添加一条备注；`mentions` 是被 @ 到的用户 id，用来给他们发私信 */
  onAddNote: (body: string, mentions: string[]) => Promise<void>;
  /** 当前访问者已经改过一次的格子（`记录 id:字段 id`），只读并给出提示 */
  lockedCells: ReadonlySet<string>;
}

/** Full-record card opened from 打开 / board / gallery cards. */
export function RecordDialog({
  properties,
  row,
  users,
  canEdit,
  notes,
  mentionCandidates,
  focusNoteId,
  onClose,
  onCommitCell,
  uploadFile,
  onAddNote,
  lockedCells,
}: RecordDialogProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const title = properties.find((property) => property.type === 'text')?.name ?? '记录';
  // 点击单元格以外的任意位置即退出输入（日期 / 文件字段自动保存，没有「确认」按钮）
  useCloseOnOutsideClick(editingId !== null, () => setEditingId(null));

  // 从私信点进来：滚到那条备注并高亮，方便一眼看到别人 @ 你的内容
  useEffect(() => {
    if (!focusNoteId) return;
    const node = notesRef.current?.querySelector(`[data-note-id="${focusNoteId}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusNoteId, notes.length]);

  return (
    <Modal title={title} onClose={onClose} wide>
      {/* record-fields：字段行比弹窗默认的 .center-list 更紧凑 */}
      <div className="center-list record-fields">
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
                {/* 「字段锁定」用 🔒 标注；「限制编辑」用掉的格子不加图标，鼠标悬停看提示 */}
                {property.locked ? '🔒 ' : ''}
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

      <div className="notes" ref={notesRef}>
        <div className="row gap">
          <strong className="small">备注</strong>
          <span className="spacer" />
          <span className="small muted">{notes.length ? `${notes.length} 条` : '添加后不可删除'}</span>
        </div>
        {notes.length ? (
          notes.map((note) => (
            <article
              className={`note${note.id === focusNoteId ? ' focused' : ''}`}
              key={note.id}
              data-note-id={note.id}
            >
              <div className="note-head">
                <span className="note-author">{note.authorName || '未知用户'}</span>
                <span className="small muted" title={formatDateTime(note.createdAt)}>
                  {formatRelativeTime(note.createdAt)}
                </span>
              </div>
              <div className="note-body">
                <NoteBody note={note} />
              </div>
            </article>
          ))
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            还没有备注。备注只能新增，添加后不可修改 / 删除。
          </p>
        )}
        <NoteComposer candidates={mentionCandidates} onSubmit={onAddNote} />
      </div>

      <div className="row gap" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn primary small" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}



/* --------------------------------------------------------------- 备注 */

/** 备注正文：把 `@名字` 渲染成高亮的 @提醒。 */
function NoteBody({ note }: { note: RecordNote }) {
  const names = note.mentions.map((mention) => mention.name).filter(Boolean);
  if (!names.length) return <>{note.body}</>;

  // 名字长的优先匹配（「Ann」和「Anna」并存时不会把 Anna 切错）
  const pattern = new RegExp(`@(${names.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})`, 'g');
  return (
    <>
      {note.body.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          // eslint-disable-next-line react/no-array-index-key
          <span className="mention" key={`${part}-${index}`}>
            @{part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface NoteComposerProps {
  candidates: Member[];
  onSubmit: (body: string, mentions: string[]) => Promise<void>;
}

/**
 * 备注输入框：输入 `@` 弹出可选的人，选中后会在正文里插入 `@名字`，
 * 提交时把仍然留在正文里的 @对象 一起发给服务端（他们会在收件箱里收到私信）。
 */
function NoteComposer({ candidates, onSubmit }: NoteComposerProps) {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** 从下拉列表里选过的人：userId → 名字（提交时再核对正文里是否还有 @名字） */
  const picked = useRef(new Map<string, string>());

  const matched = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return candidates.filter(
      (member) =>
        !needle || member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle),
    );
  }, [candidates, query]);

  const onDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const caret = event.target.selectionStart ?? value.length;
    setDraft(value);
    setCursor(0);
    // 只在「刚打出 @」或「@ 后面还在打字」时弹列表
    const found = /(?:^|\s)@([^\s@]{0,20})$/.exec(value.slice(0, caret));
    setQuery(found ? found[1] : null);
    if (error) setError('');
  };

  const insert = (member: Member) => {
    const element = textarea.current;
    const caret = element?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const at = before.lastIndexOf('@');
    const head = at >= 0 ? draft.slice(0, at) : draft;
    const next = `${head}@${member.name} ${draft.slice(caret)}`;
    picked.current.set(member.userId, member.name);
    setDraft(next);
    setQuery(null);
    const position = head.length + member.name.length + 2;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(position, position);
    });
  };

  const submit = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    const mentions = [...picked.current.entries()]
      .filter(([, name]) => body.includes(`@${name}`))
      .map(([userId]) => userId);
    setSending(true);
    setError('');
    try {
      await onSubmit(body, mentions);
      picked.current.clear();
      setDraft('');
      setQuery(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '备注添加失败，请重试');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (query !== null && matched.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((value) => (value + 1) % matched.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((value) => (value - 1 + matched.length) % matched.length);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        insert(matched[cursor] ?? matched[0]);
        return;
      }
      if (event.key === 'Escape') {
        setQuery(null);
        return;
      }
    }
    // ⌘/Ctrl + Enter 快速提交；单独 Enter 正常换行
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="note-composer" data-mention-open={query !== null ? 'true' : undefined}>
      <textarea
        ref={textarea}
        className="input"
        rows={2}
        value={draft}
        placeholder="添加备注，输入 @ 可以提醒他人（备注添加后不可删除）"
        onChange={onDraftChange}
        onKeyDown={onKeyDown}
      />
      {query !== null ? (
        <div className="mention-list">
          {matched.length ? (
            matched.map((member, index) => (
              <button
                type="button"
                key={member.userId}
                className={`mention-item${index === cursor ? ' active' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => insert(member)}
              >
                <span className="mention-name">{member.name || member.email}</span>
                <span className="small muted">{member.email}</span>
              </button>
            ))
          ) : (
            <div className="mention-item muted">没有匹配的人</div>
          )}
        </div>
      ) : null}
      <div className="row gap">
        <span className="small muted">
          {candidates.length ? `${candidates.length} 人可以被 @ 提醒` : '还没有其他协作者，先在「分享与成员」里邀请'}
        </span>
        <span className="spacer" />
        {error ? <span className="small error">{error}</span> : null}
        <button type="button" className="btn primary small" disabled={!draft.trim() || sending} onClick={() => void submit()}>
          {sending ? '添加中…' : '添加备注'}
        </button>
      </div>
    </div>
  );
}

/**
 * Cell rendering + inline editors for every field type.
 * `created_time` / `updated_time` / `created_by` / `updated_by` are derived from
 * the row metadata, never from `row.values`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatDateValue,
  formatTimestamp,
  formatValueForDisplay,
  isEmptyValue,
} from '../../shared/fields';
import type { CellValue, DateValue, FileValue, Property, RowRecord, SelectOption } from '../../shared/types';
import { api } from '../api';

export type UserNames = Record<string, string>;

export function computedText(property: Property, row: RowRecord, users: UserNames): string {
  switch (property.type) {
    case 'created_time':
      return formatTimestamp(row.createdAt, property.config);
    case 'updated_time':
      return formatTimestamp(row.updatedAt, property.config);
    case 'created_by':
      return (row.createdBy && users[row.createdBy]) || '';
    case 'updated_by':
      return (row.updatedBy && users[row.updatedBy]) || '';
    default:
      return '';
  }
}

export function Pill({ option }: { option: SelectOption }) {
  return <span className={`pill pill-${option.color}`}>{option.name}</span>;
}

function fileSizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

interface CellViewProps {
  property: Property;
  row: RowRecord;
  users: UserNames;
  editable: boolean;
  onEdit: () => void;
  /** checkbox cells commit on a single click instead of opening an editor */
  onQuickChange?: (next: CellValue | undefined) => void;
}

export function CellView({ property, row, users, editable, onEdit, onQuickChange }: CellViewProps) {
  const value = row.values[property.id];

  if (property.type === 'created_time' || property.type === 'updated_time' || property.type === 'created_by' || property.type === 'updated_by') {
    return <span className="cell-static muted">{computedText(property, row, users)}</span>;
  }

  const empty = isEmptyValue(value);
  const start = () => {
    if (!editable) return;
    if (property.type === 'checkbox' && onQuickChange) {
      onQuickChange(value === true ? undefined : true);
      return;
    }
    onEdit();
  };

  let content: React.ReactNode = null;
  switch (property.type) {
    case 'checkbox':
      content = <span className={value === true ? 'checkbox on' : 'checkbox'}>{value === true ? '✔' : ''}</span>;
      break;
    case 'select':
    case 'status':
      content = value ? <Pill option={value as SelectOption} /> : null;
      break;
    case 'multi_select':
      content = (
        <span className="pills">
          {((value as SelectOption[] | undefined) ?? []).map((option) => (
            <Pill key={option.id} option={option} />
          ))}
        </span>
      );
      break;
    case 'date':
      content = <span>{formatDateValue(value as DateValue | undefined, property.config)}</span>;
      break;
    case 'files':
      content = (
        <span className="file-list">
          {((value as FileValue[] | undefined) ?? []).map((file) => (
            <a
              key={file.id}
              className="file-chip"
              href={api.fileUrl(file.id)}
              target="_blank"
              rel="noreferrer"
              title={`${file.name} · ${fileSizeLabel(file.size)}`}
              onClick={(event) => event.stopPropagation()}
            >
              📎 {file.name}
            </a>
          ))}
        </span>
      );
      break;
    case 'url': {
      const href = typeof value === 'string' ? value : '';
      content = href ? (
        <a className="link" href={href} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
          {href}
        </a>
      ) : null;
      break;
    }
    default:
      content = <span>{formatValueForDisplay(property.type, value, property.config, { users })}</span>;
  }

  return (
    <button type="button" className={`cell-view${empty ? ' empty' : ''}`} onClick={start} disabled={!editable}>
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ editors */

export interface CellEditorProps {
  property: Property;
  value: CellValue | undefined;
  /** uploads an attachment and resolves with its stored metadata */
  uploadFile?: (file: File) => Promise<FileValue>;
  onCommit: (value: CellValue | undefined) => void;
  onCancel: () => void;
}

/** Wrap a handler so it only ever fires once (blur + Enter both commit). */
function useOnce<Args extends unknown[]>(handler: (...args: Args) => void): (...args: Args) => void {
  const fired = useRef(false);
  return (...args: Args) => {
    if (fired.current) return;
    fired.current = true;
    handler(...args);
  };
}

function TextEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = useOnce(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      onCommit(undefined);
      return;
    }
    if (property.type === 'number') {
      const parsed = Number(trimmed);
      onCommit(Number.isFinite(parsed) ? parsed : undefined);
      return;
    }
    onCommit(trimmed);
  });

  return (
    <input
      ref={ref}
      className="cell-input"
      value={text}
      inputMode={property.type === 'number' ? 'decimal' : property.type === 'phone' ? 'tel' : undefined}
      type={property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : 'text'}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}

function SelectEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const current = (value as SelectOption | undefined)?.name ?? '';
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = useOnce((next: string) => {
    const option = (property.config.options ?? []).find((item) => item.name === next);
    onCommit(option ? { ...option } : undefined);
  });

  return (
    <select
      ref={ref}
      className="cell-input"
      value={current}
      onChange={(event) => commit(event.target.value)}
      onBlur={() => commit(current)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <option value="">—</option>
      {(property.config.options ?? []).map((option) => (
        <option key={option.id} value={option.name}>
          {option.name}
        </option>
      ))}
    </select>
  );
}


function MultiSelectEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const selected = useMemo(() => (value as SelectOption[] | undefined) ?? [], [value]);
  const [ids, setIds] = useState<string[]>(selected.map((option) => option.id));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const toggle = (option: SelectOption) => {
    const next = ids.includes(option.id) ? ids.filter((id) => id !== option.id) : [...ids, option.id];
    setIds(next);
    const picked = (property.config.options ?? []).filter((item) => next.includes(item.id));
    onCommit(picked.length ? picked.map((item) => ({ ...item })) : undefined);
  };

  return (
    <div
      ref={ref}
      className="cell-dropdown"
      tabIndex={0}
      onBlur={() => onCancel()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      {(property.config.options ?? []).map((option) => (
        <label key={option.id} className="cell-option">
          <input type="checkbox" checked={ids.includes(option.id)} onChange={() => toggle(option)} />
          <Pill option={option} />
        </label>
      ))}
      {!(property.config.options ?? []).length ? <span className="muted">该字段还没有选项</span> : null}
    </div>
  );
}

function DateEditor({ property, value, onCommit, onCancel }: CellEditorProps) {
  const current = (value as DateValue | undefined) ?? null;
  const date = current?.start ? current.start.slice(0, 10) : '';
  const time = current?.start && current.start.includes('T') ? current.start.slice(11, 16) : '';
  const includeTime = current?.includeTime ?? property.config.includeTime ?? false;
  const [day, setDay] = useState(date);
  const [clock, setClock] = useState(time);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const commit = useOnce(() => {
    if (!day) {
      onCommit(undefined);
      return;
    }
    const start = includeTime && clock ? `${day}T${clock}:00.000Z` : day;
    onCommit({ start, end: null, includeTime: includeTime && Boolean(clock) });
  });

  return (
    <span className="cell-date">
      <input
        ref={ref}
        className="cell-input"
        type="date"
        value={day}
        onChange={(event) => setDay(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') onCancel();
        }}
      />
      {includeTime ? (
        <input
          className="cell-input"
          type="time"
          value={clock}
          onChange={(event) => setClock(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') onCancel();
          }}
        />
      ) : null}
      <button type="button" className="btn small" onClick={commit}>
        确定
      </button>
      <button type="button" className="btn small ghost" onClick={onCancel}>
        取消
      </button>
    </span>
  );
}

function FilesEditor({ value, uploadFile, onCommit, onCancel }: CellEditorProps) {
  const files = (value as FileValue[] | undefined) ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = async (list: FileList | null) => {
    if (!list?.length || !uploadFile) return;
    setBusy(true);
    setError('');
    try {
      const uploaded: FileValue[] = [];
      for (const file of Array.from(list)) uploaded.push(await uploadFile(file));
      onCommit([...files, ...uploaded]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cell-dropdown">
      {files.map((file) => (
        <span key={file.id} className="file-chip">
          <a href={api.fileUrl(file.id)} target="_blank" rel="noreferrer">
            {file.name}
          </a>
          <button
            type="button"
            className="icon-btn"
            title="移除"
            onClick={() => onCommit(files.filter((item) => item.id !== file.id))}
          >
            ✕
          </button>
        </span>
      ))}
      <div className="row gap">
        <button type="button" className="btn small" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? '上传中…' : '添加文件'}
        </button>
        <button type="button" className="btn small ghost" onClick={onCancel}>
          完成
        </button>
      </div>
      {error ? <span className="error small">{error}</span> : null}
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void pick(event.target.files);
          event.target.value = '';
        }}
      />
    </div>
  );
}

export function CellEditor(props: CellEditorProps) {
  switch (props.property.type) {
    case 'select':
    case 'status':
      return <SelectEditor {...props} />;
    case 'multi_select':
      return <MultiSelectEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'files':
      return <FilesEditor {...props} />;
    case 'checkbox':
      return (
        <button
          type="button"
          className="btn small"
          onClick={() => props.onCommit(props.value === true ? undefined : true)}
        >
          {props.value === true ? '取消勾选' : '勾选'}
        </button>
      );
    default:
      return <TextEditor {...props} />;
  }
}


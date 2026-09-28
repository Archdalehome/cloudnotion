import { useState } from 'react';
import {
  COLOR_LABEL,
  FIELD_META,
  FIELD_TYPE_ORDER,
  OPTION_COLORS,
  createId,
  defaultOptionColor,
  defaultPropertyConfig,
} from '../../shared/fields';
import type {
  DateFormat,
  FieldType,
  NumberFormat,
  OptionColor,
  Property,
  PropertyConfig,
  SelectOption,
} from '../../shared/types';
import { ApiError } from '../api';
import { Pill } from './Cell';
import { Modal } from './Modal';

interface PropertyDialogProps {
  /** omit to create a new field */
  property?: Property | null;
  onClose: () => void;
  onSubmit: (input: { name: string; type: FieldType; config: PropertyConfig }) => Promise<void>;
}

const DATE_FORMATS: DateFormat[] = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MMM D, YYYY', 'YYYY年M月D日'];
const NUMBER_FORMATS: { value: NumberFormat; label: string }[] = [
  { value: 'plain', label: '整数/小数' },
  { value: 'comma', label: '千分位' },
  { value: 'percent', label: '百分比' },
  { value: 'currency', label: '货币' },
];

export function PropertyDialog({ property, onClose, onSubmit }: PropertyDialogProps) {
  const editing = Boolean(property?.id);
  const [name, setName] = useState(property?.name ?? '');
  const [type, setType] = useState<FieldType>(property?.type ?? 'text');
  const [config, setConfig] = useState<PropertyConfig>(property?.config ?? defaultPropertyConfig('text'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const hasOptions = FIELD_META[type].hasOptions;
  const options = config.options ?? [];

  const changeType = (next: FieldType) => {
    // keep user-entered options when swapping between option based types
    const keepOptions =
      FIELD_META[next].hasOptions && FIELD_META[type].hasOptions ? { options } : defaultPropertyConfig(next);
    setType(next);
    setConfig({ ...keepOptions });
  };

  const updateOption = (id: string, patch: Partial<SelectOption>) => {
    setConfig({ ...config, options: options.map((option) => (option.id === id ? { ...option, ...patch } : option)) });
  };

  const addOption = () => {
    const option: SelectOption = {
      id: createId(),
      name: `选项 ${options.length + 1}`,
      color: defaultOptionColor(options.length),
    };
    setConfig({ ...config, options: [...options, option] });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit({ name: name.trim(), type, config });
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? '编辑字段' : '新建字段'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span>名称</span>
          <input
            className="input"
            value={name}
            autoFocus
            required
            maxLength={120}
            placeholder="字段名称"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className="field">
          <span>类型</span>
          <select
            className="input"
            value={type}
            disabled={FIELD_META[type].computed}
            onChange={(event) => changeType(event.target.value as FieldType)}
          >
            {FIELD_TYPE_ORDER.map((item) => (
              <option key={item} value={item}>
                {FIELD_META[item].label}
              </option>
            ))}
          </select>
        </label>

        {hasOptions ? (
          <div className="field">
            <span>选项</span>
            {options.map((option) => (
              <div key={option.id} className="row gap" style={{ marginBottom: 4 }}>
                <Pill option={option} />
                <input
                  className="input"
                  value={option.name}
                  onChange={(event) => updateOption(option.id, { name: event.target.value })}
                />
                <select
                  className="input"
                  style={{ width: 84 }}
                  value={option.color}
                  onChange={(event) => updateOption(option.id, { color: event.target.value as OptionColor })}
                >
                  {OPTION_COLORS.map((color) => (
                    <option key={color} value={color}>
                      {COLOR_LABEL[color]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  title="删除选项"
                  onClick={() => setConfig({ ...config, options: options.filter((item) => item.id !== option.id) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost small" onClick={addOption}>
              ＋ 添加选项
            </button>
          </div>
        ) : null}

        {type === 'number' ? (
          <>
            <label className="field">
              <span>数字格式</span>
              <select
                className="input"
                value={config.format ?? 'plain'}
                onChange={(event) => setConfig({ ...config, format: event.target.value as NumberFormat })}
              >
                {NUMBER_FORMATS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>小数位数</span>
              <input
                className="input"
                type="number"
                min={0}
                max={8}
                value={config.precision ?? 0}
                onChange={(event) => setConfig({ ...config, precision: Number(event.target.value) })}
              />
            </label>
            {config.format === 'currency' ? (
              <label className="field">
                <span>货币代码</span>
                <input
                  className="input"
                  value={config.currency ?? 'CNY'}
                  onChange={(event) => setConfig({ ...config, currency: event.target.value.toUpperCase() })}
                />
              </label>
            ) : null}
          </>
        ) : null}

        {type === 'date' || type === 'created_time' || type === 'updated_time' ? (
          <>
            <label className="field">
              <span>日期格式</span>
              <select
                className="input"
                value={config.dateFormat ?? 'YYYY-MM-DD'}
                onChange={(event) => setConfig({ ...config, dateFormat: event.target.value as DateFormat })}
              >
                {DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
            <label className="row gap" style={{ marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={Boolean(config.includeTime)}
                onChange={(event) => setConfig({ ...config, includeTime: event.target.checked })}
              />
              <span>显示时间</span>
            </label>
          </>
        ) : null}

        {error ? <p className="error small">{error}</p> : null}

        <div className="row gap" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

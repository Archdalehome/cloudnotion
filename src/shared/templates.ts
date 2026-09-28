/** Starter table templates offered when creating a new database. */
import { defaultPropertyConfig, defaultOptionColor } from './fields';
import type { FieldType, PropertyConfig, SelectOption } from './types';

export interface TemplatePropertyDef {
  name: string;
  type: FieldType;
  config?: PropertyConfig;
  width?: number;
}

export interface TemplateDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  properties: TemplatePropertyDef[];
}

function optionsOf(names: string[], startIndex = 0): SelectOption[] {
  return names.map((name, index) => ({
    id: `tpl_${name}_${index}`,
    name,
    color: defaultOptionColor(index + startIndex),
  }));
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'blank',
    name: '空白表格',
    icon: '📋',
    description: '只有一个「名称」字段，其余字段自行添加',
    properties: [{ name: '名称', type: 'text', width: 260 }],
  },
  {
    id: 'task',
    name: '任务管理',
    icon: '✅',
    description: '状态、优先级、截止日期与完成勾选',
    properties: [
      { name: '任务名称', type: 'text', width: 280 },
      {
        name: '状态',
        type: 'status',
        width: 140,
        config: { options: optionsOf(['未开始', '进行中', '待审核', '已完成']) },
      },
      { name: '优先级', type: 'select', width: 120, config: { options: optionsOf(['高', '中', '低'], 8) } },
      { name: '截止日期', type: 'date', width: 150, config: { dateFormat: 'YYYY-MM-DD', includeTime: false } },
      { name: '负责人', type: 'text', width: 130 },
      { name: '已完成', type: 'checkbox', width: 100 },
      { name: '备注', type: 'text', width: 240 },
    ],
  },
  {
    id: 'crm',
    name: '客户管理',
    icon: '🤝',
    description: '销售阶段、联系方式与成交金额',
    properties: [
      { name: '客户名称', type: 'text', width: 240 },
      {
        name: '阶段',
        type: 'status',
        width: 140,
        config: { options: optionsOf(['线索', '沟通中', '已报价', '已成交', '已流失']) },
      },
      { name: '联系人', type: 'text', width: 130 },
      { name: '邮箱', type: 'email', width: 220 },
      { name: '电话', type: 'phone', width: 160 },
      {
        name: '金额',
        type: 'number',
        width: 140,
        config: { format: 'currency', currency: 'CNY', precision: 2 },
      },
      { name: '下次联系', type: 'date', width: 150, config: { dateFormat: 'YYYY-MM-DD' } },
      { name: '合同附件', type: 'files', width: 220 },
    ],
  },
  {
    id: 'content',
    name: '内容日历',
    icon: '📅',
    description: '选题、平台、排期与素材',
    properties: [
      { name: '标题', type: 'text', width: 280 },
      { name: '平台', type: 'select', width: 130, config: { options: optionsOf(['公众号', '小红书', '知乎', 'B站'], 4) } },
      {
        name: '状态',
        type: 'status',
        width: 140,
        config: { options: optionsOf(['选题', '撰写中', '待发布', '已发布']) },
      },
      { name: '发布日期', type: 'date', width: 150, config: { dateFormat: 'YYYY-MM-DD' } },
      { name: '链接', type: 'url', width: 220 },
      { name: '素材', type: 'files', width: 220 },
    ],
  },
  {
    id: 'inventory',
    name: '库存管理',
    icon: '📦',
    description: '商品信息、数量与入库日期',
    properties: [
      { name: '商品名称', type: 'text', width: 260 },
      { name: 'SKU', type: 'text', width: 140 },
      { name: '分类', type: 'select', width: 140, config: { options: optionsOf(['电子', '配件', '耗材'], 4) } },
      { name: '库存数量', type: 'number', width: 120, config: { format: 'plain', precision: 0 } },
      { name: '单价', type: 'number', width: 140, config: { format: 'currency', currency: 'CNY', precision: 2 } },
      { name: '供应商', type: 'text', width: 160 },
      { name: '入库日期', type: 'date', width: 150, config: { dateFormat: 'YYYY-MM-DD' } },
    ],
  },
];

/**
 * Materialise a template into concrete property records.
 * Option ids are regenerated so that every database owns its own options.
 */
export function materializeTemplateProperties(
  templateId: string,
  makeId: () => string,
): { name: string; type: FieldType; config: PropertyConfig; width: number }[] {
  const template = TEMPLATES.find((item) => item.id === templateId) ?? TEMPLATES[0];
  return template.properties.map((def) => {
    const base = defaultPropertyConfig(def.type);
    const config: PropertyConfig = { ...base, ...(def.config ?? {}) };
    if (config.options) {
      config.options = config.options.map((option, index) => ({
        id: makeId(),
        name: option.name,
        color: option.color ?? defaultOptionColor(index),
      }));
    }
    return {
      name: def.name,
      type: def.type,
      config,
      width: def.width ?? 200,
    };
  });
}

export function templateName(id: string): string {
  return TEMPLATES.find((item) => item.id === id)?.name ?? id;
}

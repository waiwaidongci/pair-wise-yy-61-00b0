import type { FieldMeta, MaintenanceCard, ServerCard } from './types';
import { FIELD_NAMES } from './types';

export function makeField(serverValue: string, updatedAt: string, updatedBy: string): FieldMeta {
  return {
    value: serverValue,
    baseValue: serverValue,
    serverValue,
    localValue: null,
    source: 'server',
    updatedAt,
    updatedBy
  };
}

/** 用服务器正式记录构造客户端工卡，内容字段初始来源均为 server。 */
export function clientCardFromServer(card: ServerCard): MaintenanceCard {
  const { authorized, measurement, finding, evidenceNote, ...staticFields } = card;
  void authorized;
  const fields = {
    measurement: makeField(measurement, card.updatedAt, card.updatedBy),
    finding: makeField(finding, card.updatedAt, card.updatedBy),
    evidenceNote: makeField(evidenceNote, card.updatedAt, card.updatedBy)
  };
  return { ...staticFields, fields, needsReconfirm: false };
}

/** 用服务器正式记录刷新工卡的静态/权威字段，保留内容字段元数据（由合并引擎负责）。 */
export function staticFieldsFromServer(card: ServerCard): Omit<MaintenanceCard, 'fields' | 'needsReconfirm'> {
  const { authorized, measurement, finding, evidenceNote, ...staticFields } = card;
  void authorized;
  void measurement;
  void finding;
  void evidenceNote;
  return staticFields;
}

export function hasLocalDraft(card: MaintenanceCard): boolean {
  return FIELD_NAMES.some((name) => card.fields[name].localValue !== null);
}

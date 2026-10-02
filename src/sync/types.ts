// 离线合并领域模型：字段来源、发件箱操作、冲突、结论失效、审计。

export type CardStatus = '未开始' | '执行中' | '待授权' | '已完成';

export type FieldName = 'measurement' | 'finding' | 'evidenceNote';

export const FIELD_LABELS: Record<FieldName, string> = {
  measurement: '测量值',
  finding: '发现与处置',
  evidenceNote: '证据说明'
};

export const FIELD_NAMES: FieldName[] = ['measurement', 'finding', 'evidenceNote'];

/** 字段值来源：用于决定合并策略，而不是简单按后到覆盖。 */
export type FieldSource = 'server' | 'local' | 'both' | 'conflict';

export type FieldMeta = {
  /** 当前展示/使用的值（冲突未解决时保留本地草稿值）。 */
  value: string;
  /** 上次成功同步时的值，作为三路合并的 base。 */
  baseValue: string;
  /** 最近一次从服务器拉取到的值。 */
  serverValue: string;
  /** 尚未被服务器正式记录接收的本地值；null 表示无本地改动。 */
  localValue: string | null;
  source: FieldSource;
  /** 用户在冲突中明确选择保留本地，直到推送有结论前不再重复提示。 */
  resolved?: boolean;
  updatedAt: string;
  updatedBy: string;
};

/** 服务器端工卡（正式记录），内容性字段以服务器为准。 */
export type ServerCard = {
  id: string;
  title: string;
  zone: string;
  revision: string;
  estimated: number;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  stage: string;
  status: CardStatus;
  authorized: boolean;
  measurement: string;
  finding: string;
  evidenceNote: string;
  updatedAt: string;
  updatedBy: string;
};

/** 客户端工卡：静态描述字段随服务器，执行字段带来源元数据。 */
export type MaintenanceCard = Omit<ServerCard, 'authorized' | 'measurement' | 'finding' | 'evidenceNote'> & {
  fields: Record<FieldName, FieldMeta>;
  /** 离线期间被授权/版本升级/放行波及，结论需重新确认。 */
  needsReconfirm: boolean;
};

export type ServerSignature = {
  stage: string;
  signed: boolean;
  actor: string;
  time: string;
};

export type ServerEventType = 'authorize' | 'sign' | 'release' | 'revise' | 'edit' | 'reconfirm';

export type ServerEvent = {
  /** 稳定 ID，审计与失效判定按它去重。 */
  id: string;
  rev: number;
  time: string;
  type: ServerEventType;
  actor: string;
  detail: string;
  cardId?: string;
  stage?: string;
  fromRev?: string;
  toRev?: string;
};

export type ServerSnapshot = {
  revision: number;
  released: boolean;
  cards: ServerCard[];
  signatures: ServerSignature[];
  events: ServerEvent[];
};

export type OutboxOpType = 'card-edit' | 'sign' | 'release' | 'reconfirm';

export type OutboxOp = {
  /** 客户端生成的幂等键，服务器按它去重，重试不产生重复正式记录。 */
  opId: string;
  type: OutboxOpType;
  createdAt: string;
  attempts: number;
  state: 'pending' | 'rejected';
  lastError?: string;
  /** 操作所依据的服务器版本。 */
  baseRevision: number;
  /** card-edit：目标工卡及所依据的工卡版本，完成动作标记。 */
  cardId?: string;
  cardRevision?: string;
  complete?: boolean;
  /** sign：目标阶段。 */
  stage?: string;
};

export type ConflictKind = 'field-diverge' | 'op-rejected';

export type ConflictItem = {
  id: string;
  kind: ConflictKind;
  cardId?: string;
  field?: FieldName;
  opId?: string;
  title: string;
  detail: string;
  localValue?: string;
  serverValue?: string;
  reason?: string;
  createdAt: string;
};

export type InvalidationScope = 'card' | 'stage' | 'package';

/** 离线期间服务器发生授权/签字/放行后，被判定失效、需重新确认的结论。 */
export type Invalidation = {
  id: string;
  eventId: string;
  scope: InvalidationScope;
  cardId?: string;
  stage?: string;
  title: string;
  reason: string;
  detail: string;
  time: string;
  resolved: boolean;
};

export type ClientSignature = {
  stage: string;
  actor: string;
  time: string;
  /** 已被服务器正式记录。 */
  serverSigned: boolean;
  /** 本地已签但尚未被服务器接收。 */
  pending: boolean;
  /** 离线期间服务器已有签署，本地签署结论失效，需重新签署。 */
  needsResign: boolean;
};

export type AuditEntry = {
  /** 稳定去重键：同一服务器事件 / 同一操作重试只写一条。 */
  key: string;
  time: string;
  actor: string;
  action: string;
  detail: string;
};

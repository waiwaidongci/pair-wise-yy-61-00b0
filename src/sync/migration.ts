import type {
  AuditEntry,
  ClientSignature,
  ConflictItem,
  FieldName,
  Invalidation,
  MaintenanceCard,
  OutboxOp,
  ServerCard,
  ServerSnapshot
} from './types';
import { FIELD_NAMES } from './types';

export const SCHEMA_VERSION = 2;
export const STORAGE_KEY = 'yy61-work-package';

/** v1（旧版）localStorage 结构。 */
type LegacyCard = {
  id: string;
  title?: string;
  zone?: string;
  revision?: string;
  estimated?: number;
  dependencies?: string[];
  tolerance?: string;
  evidence?: string;
  witness?: string;
  status?: MaintenanceCard['status'];
  measurement?: string;
  finding?: string;
  stage?: string;
};

type LegacyState = {
  schemaVersion?: number;
  cards?: LegacyCard[];
  activeCardId?: string;
  syncVersion?: number;
  serverVersion?: number;
  offline?: boolean;
  lastSaved?: string;
  conflictMessage?: string;
  signatures?: { stage: string; status: '待签署' | '已签署'; actor: string; time: string }[];
  released?: boolean;
  audit?: { time: string; actor: string; action: string; detail: string }[];
};

export type MigratedState = {
  schemaVersion: number;
  cards: MaintenanceCard[];
  activeCardId: string;
  serverRevision: number;
  baseRevision: number;
  base: ServerSnapshot;
  offline: boolean;
  lastSaved: string;
  signatures: ClientSignature[];
  released: boolean;
  outbox: OutboxOp[];
  conflicts: ConflictItem[];
  invalidations: Invalidation[];
  seenEventIds: string[];
  pendingAcks: unknown[];
  syncState: 'idle' | 'syncing' | 'error' | 'offline';
  syncMessage: string;
  audit: AuditEntry[];
  hydrated?: boolean;
};

const toServerCardShape = (card: LegacyCard, index: number): ServerCard => ({
  id: card.id,
  title: card.title ?? `工卡 ${index + 1}`,
  zone: card.zone ?? '-',
  revision: card.revision ?? 'R0',
  estimated: card.estimated ?? 0,
  dependencies: card.dependencies ?? [],
  tolerance: card.tolerance ?? '-',
  evidence: card.evidence ?? '-',
  witness: card.witness ?? '-',
  stage: (card.stage ?? '未分阶段').replace('签署', ''),
  status: card.status ?? '未开始',
  authorized: false,
  measurement: card.measurement ?? '',
  finding: card.finding ?? '',
  evidenceNote: '',
  updatedAt: '迁移',
  updatedBy: '本地旧数据'
});

/**
 * 将旧版扁平工卡迁移为带来源元数据的客户端工卡：
 * 旧值同时作为 base/server 值，来源 server，本地草稿为空，
 * 启动后再与真实服务器快照走一次正常三路合并，旧数据继续可用。
 */
function migrateCard(card: LegacyCard, index: number): MaintenanceCard {
  const server = toServerCardShape(card, index);
  const fields = {} as MaintenanceCard['fields'];
  (['measurement', 'finding', 'evidenceNote'] as FieldName[]).forEach((field) => {
    const value = field === 'evidenceNote' ? '' : server[field];
    fields[field] = {
      value,
      baseValue: value,
      serverValue: value,
      localValue: null,
      source: 'server',
      updatedAt: server.updatedAt,
      updatedBy: server.updatedBy
    };
  });
  const { authorized: _authorized, measurement: _m, finding: _f, evidenceNote: _e, ...staticFields } = server;
  return { ...staticFields, fields, needsReconfirm: false };
}

export function isV2(value: unknown): value is MigratedState {
  return typeof value === 'object' && value !== null &&
    (value as { schemaVersion?: number }).schemaVersion === SCHEMA_VERSION &&
    Array.isArray((value as { cards?: unknown }).cards);
}

/**
 * 迁移入口：解析 localStorage 原文。
 * - v2 数据原样返回（后续版本在此处继续挂迁移链）；
 * - v1/无版本号数据迁移为 v2；
 * - 损坏或不可信的数据返回 null，由启动流程用服务器快照重建，不影响使用。
 */
export function migratePersisted(raw: string | null): MigratedState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const legacy = parsed as LegacyState;

  if (legacy.schemaVersion === SCHEMA_VERSION && isV2(parsed)) {
    return parsed as MigratedState;
  }
  if (!Array.isArray(legacy.cards) || legacy.cards.length === 0) return null;

  const cards = legacy.cards.map((card, index) => migrateCard(card, index));
  const baseCards: ServerCard[] = cards.map((card) => {
    const fields: Record<FieldName, string> = {
      measurement: card.fields.measurement.baseValue,
      finding: card.fields.finding.baseValue,
      evidenceNote: card.fields.evidenceNote.baseValue
    };
    return {
      id: card.id,
      title: card.title,
      zone: card.zone,
      revision: card.revision,
      estimated: card.estimated,
      dependencies: card.dependencies,
      tolerance: card.tolerance,
      evidence: card.evidence,
      witness: card.witness,
      stage: card.stage,
      status: card.status,
      authorized: false,
      measurement: fields.measurement,
      finding: fields.finding,
      evidenceNote: fields.evidenceNote,
      updatedAt: '迁移',
      updatedBy: '本地旧数据'
    };
  });

  const revision = legacy.serverVersion ?? legacy.syncVersion ?? 7;
  const base: ServerSnapshot = { revision, released: Boolean(legacy.released), cards: baseCards, signatures: [], events: [] };

  const signatures: ClientSignature[] = (legacy.signatures ?? []).map((sig) => ({
    stage: sig.stage,
    actor: sig.actor,
    time: sig.time,
    serverSigned: sig.status === '已签署',
    pending: false,
    needsResign: false
  }));

  // 旧审计全部补稳定键，迁移后不重复、不丢失。
  const audit: AuditEntry[] = (legacy.audit ?? []).map((entry) => ({
    key: `legacy:${entry.time}:${entry.action}:${entry.detail}`,
    time: entry.time,
    actor: entry.actor,
    action: entry.action,
    detail: entry.detail
  }));

  return {
    schemaVersion: SCHEMA_VERSION,
    cards,
    activeCardId: legacy.activeCardId ?? cards[0]?.id ?? 'CARD-01',
    serverRevision: revision,
    baseRevision: revision,
    base,
    offline: Boolean(legacy.offline),
    lastSaved: legacy.lastSaved ?? '-',
    signatures,
    released: Boolean(legacy.released),
    outbox: [],
    conflicts: [],
    invalidations: [],
    seenEventIds: [],
    pendingAcks: [],
    syncState: 'idle',
    syncMessage: '旧版本地数据已迁移，等待与服务器正式记录核对',
    audit
  };
}

export { FIELD_NAMES };

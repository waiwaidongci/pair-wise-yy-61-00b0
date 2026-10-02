import type {
  ClientSignature,
  ConflictItem,
  FieldMeta,
  FieldName,
  Invalidation,
  MaintenanceCard,
  OutboxOp,
  ServerCard,
  ServerEvent,
  ServerSignature,
  ServerSnapshot
} from './types';
import { FIELD_LABELS, FIELD_NAMES } from './types';
import { staticFieldsFromServer } from './cards';

export type MergeInput = {
  /** 当前本地工卡（含字段来源元数据与本地草稿）。 */
  cards: MaintenanceCard[];
  signatures: ClientSignature[];
  /** 本地发件箱（未确认的离线操作）。 */
  outbox: OutboxOp[];
  /** 上次成功同步后的服务器快照基线。 */
  base: ServerSnapshot;
  /** 刚拉取到的最新服务器快照。 */
  remote: ServerSnapshot;
  /** 已知处理过的事件（基线之前 + 已经解决的）。 */
  seenEventIds: string[];
  /** 尚未解决的冲突，合并时按稳定 ID 去重，不重复生成。 */
  existingConflicts: ConflictItem[];
};

export type MergeResult = {
  cards: MaintenanceCard[];
  signatures: ClientSignature[];
  invalidations: Invalidation[];
  conflicts: ConflictItem[];
  /** 本轮新观察到、尚未处理的服务器事件（供审计落账）。 */
  newEvents: ServerEvent[];
};

const conflictFieldId = (cardId: string, field: FieldName) => `conflict:field:${cardId}:${field}`;
const invalidationId = (eventId: string, scope: string, key: string) => `invalid:${eventId}:${scope}:${key}`;

function cardHasLocalActivity(card: MaintenanceCard, outbox: OutboxOp[]): boolean {
  const fieldDraft = FIELD_NAMES.some((field) => card.fields[field].localValue !== null);
  const op = outbox.some((item) => item.cardId === card.id && !['reconfirm'].includes(item.type));
  return fieldDraft || op;
}

function stageHasLocalActivity(stage: string, signatures: ClientSignature[], outbox: OutboxOp[]): boolean {
  const local = signatures.find((item) => item.stage === stage);
  return Boolean(local?.pending) || outbox.some((item) => item.type === 'sign' && item.stage === stage);
}

/**
 * 按工卡版本与字段来源执行三路合并（base / local / server），
 * 绝不用“后到覆盖”。同时把离线期间服务器上的授权、阶段签字、放行
 * 转换为受影响结论的失效项，要求重新确认。
 */
export function mergeSnapshot(input: MergeInput): MergeResult {
  const { signatures, outbox, base, remote, seenEventIds, existingConflicts } = input;
  // 纯函数：不修改入参（Redux 开发模式下 state 被冻结），在副本上做合并。
  const cards: MaintenanceCard[] = input.cards.map((card) => ({
    ...card,
    dependencies: [...card.dependencies],
    fields: {
      measurement: { ...card.fields.measurement },
      finding: { ...card.fields.finding },
      evidenceNote: { ...card.fields.evidenceNote }
    }
  }));

  const seen = new Set<string>(seenEventIds);
  // 只考虑两次同步之间（base.revision 之后）服务器新发生的事件。
  const newEvents = remote.events.filter((event) => event.rev > base.revision && !seen.has(event.id));

  const conflicts = [...existingConflicts];
  const invalidations: Invalidation[] = [];
  const conflictIds = new Set(existingConflicts.map((item) => item.id));

  const addConflict = (conflict: ConflictItem) => {
    if (!conflictIds.has(conflict.id)) {
      conflictIds.add(conflict.id);
      conflicts.push(conflict);
    }
  };
  const addInvalidation = (invalid: Invalidation) => {
    if (!invalidations.some((item) => item.id === invalid.id)) invalidations.push(invalid);
  };

  const eventsByCard = new Map<string, ServerEvent[]>();
  const eventsByStage = new Map<string, ServerEvent[]>();
  const releaseEvents: ServerEvent[] = [];
  for (const event of newEvents) {
    if (event.cardId) {
      const list = eventsByCard.get(event.cardId) ?? [];
      list.push(event);
      eventsByCard.set(event.cardId, list);
    }
    if (event.stage) {
      const list = eventsByStage.get(event.stage) ?? [];
      list.push(event);
      eventsByStage.set(event.stage, list);
    }
    if (event.type === 'release') releaseEvents.push(event);
  }

  // ---------- 工卡逐张、字段逐个合并 ----------
  const mergedCards: MaintenanceCard[] = remote.cards.map((serverCard: ServerCard) => {
    const localCard = cards.find((item) => item.id === serverCard.id);
    const card: MaintenanceCard = { ...(localCard ?? emptyClientCard(serverCard)), ...staticFieldsFromServer(serverCard) };
    card.needsReconfirm = false;

    for (const field of FIELD_NAMES) {
      const meta = localCard?.fields[field] ?? freshMeta(serverCard, field);
      const baseValue = base.cards.find((item) => item.id === serverCard.id)?.[field] ?? '';
      const serverValue = serverCard[field];
      const localValue = meta.localValue;

      meta.baseValue = baseValue;
      meta.serverValue = serverValue;

      const serverChanged = serverValue !== baseValue;
      const localChanged = localValue !== null && localValue !== baseValue;

      // 自己的草稿刚被正式记录接收（含响应丢失后回流）：服务器值与本地一致 → 收口，不再挂草稿。
      if (localValue !== null && serverValue === localValue && serverValue !== baseValue) {
        meta.value = serverValue;
        meta.localValue = null;
        meta.resolved = undefined;
        meta.source = 'server';
        continue;
      }

      // 本地已在冲突中明确选择“保留本地”：推送有结论前保留草稿，不再弹冲突。
      if (meta.resolved && localValue !== null) {
        meta.value = localValue;
        meta.source = 'local';
        continue;
      }

      if (serverChanged && localChanged && serverValue !== localValue) {
        // 双方改了同一字段且值不同 → 字段冲突，必须人工选择，不自动覆盖。
        meta.value = localValue;
        meta.source = 'conflict';
        meta.localValue = localValue;
        addConflict({
          id: conflictFieldId(card.id, field),
          kind: 'field-diverge',
          cardId: card.id,
          field,
          title: `${card.id} ${FIELD_LABELS[field]}冲突`,
          detail: `本地与服务器都修改了「${FIELD_LABELS[field]}」，需要按字段来源人工决定保留哪一方。`,
          localValue,
          serverValue,
          reason: changedBy(serverCard, base, card.id),
          createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        });
      } else if (localChanged) {
        // 仅本地变更：保留草稿，等待推送正式记录。
        meta.value = localValue as string;
        meta.source = serverChanged ? 'both' : 'local';
      } else {
        // 仅服务器变更或双方都没改：以正式记录为准（不是后到覆盖，是字段来源裁决）。
        meta.value = serverValue;
        meta.source = serverChanged ? 'server' : meta.source === 'conflict' ? 'server' : meta.source;
        if (!serverChanged && localValue === null) meta.source = 'server';
        meta.localValue = null;
        meta.resolved = undefined;
      }
    }

    // 工卡版本升级：按版本判定，有本地工作成果时既有结论失效，需重新确认。
    const baseCard = base.cards.find((item) => item.id === card.id);
    const revisionChanged = Boolean(baseCard && baseCard.revision !== serverCard.revision);
    const revisionEvent = (eventsByCard.get(card.id) ?? []).find((event) => event.type === 'revise');
    if (revisionChanged && revisionEvent && cardHasLocalActivity(card, outbox)) {
      addCardInvalidation(addInvalidation, revisionEvent, card,
        `${card.id} 工卡版本 ${baseCard?.revision} → ${serverCard.revision}`,
        `施工要求已变更（${revisionEvent.detail}），请核对新版本要求后重新确认测量值、发现与证据。`,
        baseCard?.revision, serverCard.revision);
      card.needsReconfirm = true;
    }
    if ((eventsByCard.get(card.id) ?? []).some((event) => event.type === 'authorize') ||
      (releaseEvents.length > 0 && cardHasLocalActivity(card, outbox))) {
      card.needsReconfirm = true;
    }

    // 离线期间服务器发生授权：执行侧受影响结论失效，要求重新确认。
    const authorizeEvent = (eventsByCard.get(card.id) ?? []).find((event) => event.type === 'authorize');
    if (authorizeEvent) {
      addInvalidation({
        id: invalidationId(authorizeEvent.id, 'card', card.id),
        eventId: authorizeEvent.id,
        scope: 'card',
        cardId: card.id,
        title: `${card.id} 超差已获授权，离线结论失效`,
        reason: '离线期间授权人员在服务器批准了超差',
        detail: `${authorizeEvent.detail} 本机离线填写的测量值、发现与证据草稿已保留，但完成结论必须按授权结论复测并重新确认。`,
        time: authorizeEvent.time,
        resolved: false
      });
    }

    // 工作包已在服务器放行：所有本地待同步结论失效。
    if (releaseEvents.length > 0 && cardHasLocalActivity(card, outbox)) {
      const event = releaseEvents[releaseEvents.length - 1];
      addInvalidation({
        id: invalidationId(event.id, 'card', card.id),
        eventId: event.id,
        scope: 'card',
        cardId: card.id,
        title: `${card.id} 本地结论因服务器放行而失效`,
        reason: '离线期间工作包已在服务器锁定放行',
        detail: '正式记录已成为只读放行基线，本机草稿保留备查；如需变更须发起新的工作任务。',
        time: event.time,
        resolved: false
      });
    }

    return card;
  });

  // ---------- 阶段签字合并 ----------
  const mergedSignatures: ClientSignature[] = remote.signatures.map((serverSig: ServerSignature) => {
    const local = signatures.find((item) => item.stage === serverSig.stage);
    const baseSigned = base.signatures.find((item) => item.stage === serverSig.stage)?.signed ?? false;

    if (serverSig.signed) {
      // 只有当离线期间存在“非本机产生的”服务器签署事件，且本机也有待同步签署时，才算双方签署。
      // 本机签署自己被接收的事件已在 seenEventIds 中，不会出现在 eventsByStage 里。
      const event = (eventsByStage.get(serverSig.stage) ?? []).find((item) => item.type === 'sign');
      const collision = Boolean(event) && !baseSigned && stageHasLocalActivity(serverSig.stage, signatures, outbox);
      if (collision && event) {
        addInvalidation({
          id: invalidationId(event.id, 'stage', serverSig.stage),
          eventId: event.id,
          scope: 'stage',
          stage: serverSig.stage,
          title: `${serverSig.stage}阶段离线签署失效`,
          reason: '离线期间该阶段已在服务器完成正式签署',
          detail: `${event.detail} 请本人核对正式签署记录后重新签署确认。`,
          time: event.time,
          resolved: false
        });
        return { stage: serverSig.stage, actor: serverSig.actor, time: serverSig.time, serverSigned: true, pending: false, needsResign: true };
      }
      return { stage: serverSig.stage, actor: serverSig.actor, time: serverSig.time, serverSigned: true, pending: false, needsResign: local?.needsResign ?? false };
    }

    // 服务器尚未签署：沿用本地待签署/待同步状态。
    return local
      ? { ...local, serverSigned: false }
      : { stage: serverSig.stage, actor: '待指定', time: '-', serverSigned: false, pending: false, needsResign: false };
  });

  // ---------- 包级放行失效 ----------
  if (remote.released) {
    const event = releaseEvents[releaseEvents.length - 1];
    if (event) {
      addInvalidation({
        id: invalidationId(event.id, 'package', 'release'),
        eventId: event.id,
        scope: 'package',
        title: '工作包已在服务器放行，本机放行操作失效',
        reason: '离线期间服务器已锁定只读放行基线',
        detail: event.detail,
        time: event.time,
        resolved: false
      });
    }
  }

  // ---------- 发件箱：清理已被服务器接收的操作 ----------
  // （由 slice 在推送成功后处理；此处不删除，仅按服务器状态标记。）
  void outbox;

  return {
    cards: mergedCards,
    signatures: mergedSignatures,
    invalidations,
    conflicts,
    newEvents
  };
}

function changedBy(serverCard: ServerCard, base: ServerSnapshot, cardId: string): string {
  const baseCard = base.cards.find((item) => item.id === cardId);
  if (!baseCard) return '服务器正式记录';
  return `服务器值由 ${serverCard.updatedBy || '他人'} 于 ${serverCard.updatedAt} 更新`;
}

function addCardInvalidation(
  add: (invalid: Invalidation) => void,
  event: ServerEvent | undefined,
  card: MaintenanceCard,
  title: string,
  detail: string,
  fromRev?: string,
  toRev?: string
): void {
  if (!event) return;
  add({
    id: invalidationId(event.id, 'card', `${card.id}:rev`),
    eventId: event.id,
    scope: 'card',
    cardId: card.id,
    title,
    reason: `工卡版本 ${fromRev ?? '?'} → ${toRev ?? '?'}`,
    detail,
    time: event.time,
    resolved: false
  });
}

function freshMeta(serverCard: ServerCard, field: FieldName): FieldMeta {
  return {
    value: serverCard[field],
    baseValue: serverCard[field],
    serverValue: serverCard[field],
    localValue: null,
    source: 'server',
    updatedAt: serverCard.updatedAt,
    updatedBy: serverCard.updatedBy
  };
}

function emptyClientCard(serverCard: ServerCard): MaintenanceCard {
  return {
    ...staticFieldsFromServer(serverCard),
    fields: {
      measurement: freshMeta(serverCard, 'measurement'),
      finding: freshMeta(serverCard, 'finding'),
      evidenceNote: freshMeta(serverCard, 'evidenceNote')
    },
    needsReconfirm: false
  };
}

/** 该操作当前是否允许推送到服务器（存在需重新确认的结论时挂起）。 */
export function isOpBlockedByInvalidation(op: OutboxOp, invalidations: Invalidation[]): boolean {
  if (op.type === 'reconfirm') return false;
  if (op.cardId) {
    return invalidations.some((item) => !item.resolved && item.cardId === op.cardId);
  }
  if (op.stage) {
    return invalidations.some((item) => !item.resolved && (item.stage === op.stage || item.scope === 'package'));
  }
  if (op.type === 'release') {
    return invalidations.some((item) => !item.resolved);
  }
  return false;
}

/** 是否存在与该工卡相关、需要重新确认的未决失效项。 */
export function cardNeedsReconfirm(cardId: string, invalidations: Invalidation[]): boolean {
  return invalidations.some((item) => !item.resolved && item.cardId === cardId);
}

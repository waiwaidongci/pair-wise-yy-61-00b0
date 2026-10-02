import { createAsyncThunk, configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import {
  fetchSnapshot,
  pushOps,
  resetServer,
  setFailNextPush,
  simulateAuthorize,
  simulateConcurrentEdit,
  simulateRelease,
  simulateRevise,
  simulateSign,
  type PushResponse
} from './sync/server';
import { mergeSnapshot, isOpBlockedByInvalidation } from './sync/merge';
import { clientCardFromServer } from './sync/cards';
import { migratePersisted, SCHEMA_VERSION, STORAGE_KEY, type MigratedState } from './sync/migration';
import type {
  AuditEntry,
  ClientSignature,
  ConflictItem,
  FieldName,
  MaintenanceCard,
  OutboxOp,
  ServerEvent,
  ServerSnapshot
} from './sync/types';

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline';

type MaintenanceState = Omit<MigratedState, 'syncState' | 'hydrated'> & {
  syncState: SyncState;
  hydrated: boolean;
};

const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const newOpId = () => `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const signaturesFromServer = (snapshot: ServerSnapshot): ClientSignature[] =>
  snapshot.signatures.map((sig) => ({
    stage: sig.stage,
    actor: sig.signed ? sig.actor : '待指定',
    time: sig.signed ? sig.time : '-',
    serverSigned: sig.signed,
    pending: false,
    needsResign: false
  }));

const stateFromSnapshot = (snapshot: ServerSnapshot): MaintenanceState => ({
  schemaVersion: SCHEMA_VERSION,
  cards: snapshot.cards.map(clientCardFromServer),
  activeCardId: 'CARD-03',
  serverRevision: snapshot.revision,
  baseRevision: snapshot.revision,
  base: snapshot,
  offline: false,
  lastSaved: nowTime(),
  signatures: signaturesFromServer(snapshot),
  released: snapshot.released,
  outbox: [],
  conflicts: [],
  invalidations: [],
  seenEventIds: snapshot.events.map((event) => event.id),
  pendingAcks: [],
  syncState: 'idle',
  syncMessage: '已与服务器正式记录对齐',
  hydrated: true,
  audit: []
});

// ---------- 本地持久化与迁移（旧数据迁移后继续能用） ----------
const persisted = migratePersisted(typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);

const upsertAudit = (audit: AuditEntry[], entry: AuditEntry) => {
  const index = audit.findIndex((item) => item.key === entry.key);
  if (index >= 0) audit[index] = entry;
  else audit.unshift(entry);
};

// 推送时携带的草稿值：取本地暂存、且未被字段冲突挂起的值。
const draftValuesFor = (cards: MaintenanceCard[], outbox: OutboxOp[], conflicts: ConflictItem[]) => {
  const values: Record<string, Partial<Record<FieldName, string>>> = {};
  outbox.filter((op) => op.type === 'card-edit').forEach((op) => {
    const card = cards.find((item) => item.id === op.cardId);
    if (!card || !op.cardId) return;
    const entry: Partial<Record<FieldName, string>> = {};
    (Object.keys(card.fields) as FieldName[]).forEach((field) => {
      const meta = card.fields[field];
      if (meta.localValue === null) return;
      const blocked = conflicts.some((item) => item.kind === 'field-diverge' && item.cardId === card.id && item.field === field);
      if (!blocked) entry[field] = meta.localValue ?? undefined;
    });
    if (Object.keys(entry).length > 0) values[op.cardId] = entry;
  });
  return values;
};

// 把一次三路合并结果提交到本地（合并失败时根本不会走到这里）。
const applyMerge = (state: MaintenanceState, snapshot: ServerSnapshot, previousSeen: string[]) => {
  // 自己推送产生的服务器事件直接标记为已知，避免再生成一条“服务器事件”审计。
  previousSeen.forEach((id) => {
    if (!state.seenEventIds.includes(id)) state.seenEventIds.push(id);
  });
  const result = mergeSnapshot({
    cards: state.cards,
    signatures: state.signatures,
    outbox: state.outbox,
    base: state.base,
    remote: snapshot,
    seenEventIds: [...state.seenEventIds, ...previousSeen],
    existingConflicts: state.conflicts
  });

  state.cards = result.cards;
  state.signatures = result.signatures;
  state.released = snapshot.released;

  // 失效项按稳定 ID 叠加；本轮已解决的不再复活。
  result.invalidations.forEach((invalid) => {
    const existing = state.invalidations.find((item) => item.id === invalid.id);
    if (!existing) state.invalidations.unshift(invalid);
  });
  state.invalidations.forEach((invalid) => {
    const card = invalid.cardId ? state.cards.find((item) => item.id === invalid.cardId) : undefined;
    if (card) card.needsReconfirm = state.invalidations.some((item) => !item.resolved && item.cardId === card.id);
  });
  state.conflicts = result.conflicts;

  result.newEvents.forEach((event) => {
    if (!state.seenEventIds.includes(event.id)) state.seenEventIds.push(event.id);
    const actionMap: Partial<Record<ServerEvent['type'], string>> = {
      authorize: '离线授权合并',
      sign: '服务器签字合并',
      release: '服务器放行合并',
      revise: '工卡版本合并',
      reconfirm: '重新确认合并'
    };
    if (actionMap[event.type]) {
      upsertAudit(state.audit, { key: `event:${event.id}`, time: event.time, actor: event.actor, action: actionMap[event.type]!, detail: event.detail });
    }
  });
  return result;
};

// ---------- 异步动作：启动引导 / 同步 ----------
export const bootstrap = createAsyncThunk('maintenance/bootstrap', async (_: void, { getState }) => {
  const snapshot = await fetchSnapshot();
  const state = (getState() as { maintenance: MaintenanceState }).maintenance;
  return { snapshot, hadLocal: state.hydrated };
});

type SyncOutcome =
  | { ok: true; pulled: number; accepted: number; rejected: number }
  | { ok: false; status: 500; message: string }
  | { ok: false; status: 'offline' };

export const runSync = createAsyncThunk<SyncOutcome, void, { state: { maintenance: MaintenanceState } }>(
  'maintenance/runSync',
  async (_: void, thunkApi) => {
    const { getState, dispatch } = thunkApi;
    const current = getState().maintenance;
    if (current.offline) return { ok: false, status: 'offline' };

    // 1) 拉取正式记录
    const remote = await fetchSnapshot();

    // 2) 先按工卡版本与字段来源做三路合并（纯计算，不改服务器）
    const first = mergeSnapshot({
      cards: current.cards,
      signatures: current.signatures,
      outbox: current.outbox,
      base: current.base,
      remote,
      seenEventIds: current.seenEventIds,
      existingConflicts: current.conflicts
    });

    // 3) 挑出允许推送的发件箱操作：未被失效项挂起、没有未决字段冲突
    const blockedByConflict = new Set(
      first.conflicts.filter((item) => item.kind === 'field-diverge').map((item) => item.cardId)
    );
    const pushable = current.outbox.filter((op) =>
      op.state === 'pending' &&
      !isOpBlockedByInvalidation(op, first.invalidations.length ? [...current.invalidations, ...first.invalidations] : current.invalidations) &&
      !(op.cardId && blockedByConflict.has(op.cardId))
    );

    let response: PushResponse | null = null;
    if (pushable.length > 0) {
      response = await pushOps(pushable, draftValuesFor(first.cards, pushable, first.conflicts));
    }

    // 500 / 网络失败：保留本地草稿与冲突项，不写审计，等待重试。
    if (response && response.ok === false && response.status === 500) {
      return { ok: false, status: 500, message: response.message };
    }

    const accepted: OutboxOp[] = [];
    const rejected: { op: OutboxOp; reason: string }[] = [];
    if (response && response.ok === false && response.status === 409) {
      response.results.forEach((result) => {
        const op = pushable.find((item) => item.opId === result.opId);
        if (!op) return;
        if (result.accepted) accepted.push(op);
        else rejected.push({ op, reason: result.reason ?? '服务器拒绝了该操作。' });
      });
    } else if (response && response.ok) {
      response.results.forEach((result) => {
        const op = pushable.find((item) => item.opId === result.opId);
        if (op && result.accepted) accepted.push(op);
      });
    }
    const ownEventIds = (response && response.ok
      ? response.results.map((result) => result.eventId).filter((id): id is string => Boolean(id))
      : []);

    // 4) 再拉一次，让正式记录（含刚被接收的操作）回流，本地草稿在一致时收口。
    const finalRemote = await fetchSnapshot();

    dispatch(commitSync({
      remote: finalRemote,
      acceptedIds: accepted.map((op) => op.opId),
      acceptedOps: accepted,
      rejected,
      ownEventIds
    }));
    return { ok: true, pulled: finalRemote.revision, accepted: accepted.length, rejected: rejected.length };
  }
);

// 服务器侧模拟（演示断网期间他人在正式记录上的动作）。
export const demoScenario = createAsyncThunk('maintenance/demoScenario', async (payload:
  | { kind: 'authorize'; cardId: string }
  | { kind: 'sign'; stage: string }
  | { kind: 'release' }
  | { kind: 'revise'; cardId: string }
  | { kind: 'concurrent'; cardId: string; field: FieldName; value: string }
  | { kind: 'failNext' }
) => {
  switch (payload.kind) {
    case 'authorize': simulateAuthorize(payload.cardId); break;
    case 'sign': simulateSign(payload.stage); break;
    case 'release': simulateRelease(); break;
    case 'revise': simulateRevise(payload.cardId, 'R8', '≥ 2900 psi / 10 min'); break;
    case 'concurrent': simulateConcurrentEdit(payload.cardId, payload.field, payload.value); break;
    case 'failNext': setFailNextPush(true); break;
  }
  return payload.kind;
});

export const resetDemo = createAsyncThunk('maintenance/resetDemo', async () => {
  resetServer();
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
});

// ---------- Slice ----------
type CommitPayload = {
  remote: ServerSnapshot;
  acceptedIds: string[];
  acceptedOps: OutboxOp[];
  rejected: { op: OutboxOp; reason: string }[];
  ownEventIds: string[];
};

const slice = createSlice({
  name: 'maintenance',
  initialState: (): MaintenanceState =>
    persisted
      ? { ...persisted, syncState: persisted.offline ? 'offline' : 'idle', hydrated: true, syncMessage: persisted.syncMessage }
      : {
          // 首次进入先用空骨架，bootstrap 拉取后替换。
          schemaVersion: SCHEMA_VERSION,
          cards: [],
          activeCardId: 'CARD-03',
          serverRevision: 0,
          baseRevision: 0,
          base: { revision: 0, released: false, cards: [], signatures: [], events: [] },
          offline: false,
          lastSaved: '-',
          signatures: [],
          released: false,
          outbox: [],
          conflicts: [],
          invalidations: [],
          seenEventIds: [],
          pendingAcks: [],
          syncState: 'idle',
          syncMessage: '正在连接服务器…',
          hydrated: false,
          audit: []
        },
  reducers: {
    selectCard(state, action: PayloadAction<string>) {
      state.activeCardId = action.payload;
    },
    /** 执行人员断网后继续填写：值只进本地草稿与发件箱，绝不直接覆盖正式记录。 */
    saveDraft(state, action: PayloadAction<{ cardId: string; field: FieldName; value: string }>) {
      const { cardId, field, value } = action.payload;
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return;
      const meta = card.fields[field];
      meta.localValue = value;
      meta.value = value;
      meta.source = meta.source === 'conflict' ? 'conflict' : 'local';
      meta.updatedAt = nowTime();
      meta.updatedBy = '宋杰';
      state.lastSaved = nowTime();

      let op = state.outbox.find((item) => item.type === 'card-edit' && item.cardId === cardId && item.state === 'pending');
      if (!op) {
        op = {
          opId: newOpId(),
          type: 'card-edit',
          createdAt: nowTime(),
          attempts: 0,
          state: 'pending',
          baseRevision: state.serverRevision,
          cardId,
          cardRevision: card.revision,
          complete: false
        };
        state.outbox.unshift(op);
      }
      upsertAudit(state.audit, {
        key: `draft:${op.opId}`,
        time: state.lastSaved,
        actor: '宋杰',
        action: state.offline ? '离线暂存' : '本地暂存',
        detail: `${cardId} ${field} 已保存本地草稿，等待同步正式记录`
      });
    },
    /** 完成工卡：带上本地草稿与完成结论入发件箱。 */
    completeCard(state, action: PayloadAction<{ cardId: string }>) {
      const { cardId } = action.payload;
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return;
      let op = state.outbox.find((item) => item.type === 'card-edit' && item.cardId === cardId && item.state === 'pending');
      if (!op) {
        op = {
          opId: newOpId(),
          type: 'card-edit',
          createdAt: nowTime(),
          attempts: 0,
          state: 'pending',
          baseRevision: state.serverRevision,
          cardId,
          cardRevision: card.revision,
          complete: true
        };
        state.outbox.unshift(op);
      } else {
        op.complete = true;
      }
      state.lastSaved = nowTime();
      upsertAudit(state.audit, {
        key: `draft:${op.opId}`,
        time: state.lastSaved,
        actor: '宋杰',
        action: '完成待同步',
        detail: `${cardId} 完成结论已暂存，将在同步时提交正式记录`
      });
    },
    toggleOffline(state, action: PayloadAction<boolean | undefined>) {
      state.offline = action.payload !== undefined ? action.payload : !state.offline;
      if (state.offline) {
        state.syncState = 'offline';
        state.syncMessage = '已断网：填写内容保存在本地草稿，网络恢复后按版本与字段来源合并';
      } else {
        state.syncState = 'idle';
        state.syncMessage = '网络已恢复，可以同步并合并正式记录';
      }
    },
    /** 字段冲突人工裁决。 */
    resolveFieldConflict(state, action: PayloadAction<{ conflictId: string; choice: 'local' | 'server' }>) {
      const { conflictId, choice } = action.payload;
      const conflict = state.conflicts.find((item) => item.id === conflictId && item.kind === 'field-diverge');
      if (!conflict || !conflict.cardId || !conflict.field) return;
      const card = state.cards.find((item) => item.id === conflict.cardId);
      if (!card) return;
      const meta = card.fields[conflict.field];

      if (choice === 'server') {
        meta.localValue = null;
        meta.resolved = undefined;
        meta.value = meta.serverValue;
        meta.source = 'server';
      } else {
        meta.resolved = true;
        meta.value = meta.localValue ?? meta.serverValue;
        meta.source = 'local';
      }

      // 若该工卡已无任何本地草稿，发件箱操作随之撤销；否则按当前版本重定基线（新幂等键）。
      const stillDraft = (Object.keys(card.fields) as FieldName[]).some((field) => card.fields[field].localValue !== null);
      const opIndex = state.outbox.findIndex((op) => op.type === 'card-edit' && op.cardId === card.id);
      if (opIndex >= 0) {
        if (!stillDraft) state.outbox.splice(opIndex, 1);
        else {
          state.outbox[opIndex] = {
            ...state.outbox[opIndex],
            opId: newOpId(),
            baseRevision: state.serverRevision,
            cardRevision: card.revision,
            state: 'pending',
            lastError: undefined
          };
        }
      }
      state.conflicts = state.conflicts.filter((item) => item.id !== conflictId);
      upsertAudit(state.audit, {
        key: conflictId,
        time: nowTime(),
        actor: '宋杰',
        action: '冲突裁决',
        detail: `${conflict.cardId} ${conflict.field} 选择${choice === 'server' ? '采用服务器正式记录' : '保留本地草稿并重试提交'}`
      });
    },
    /** 放弃被服务器拒绝的操作及其本地草稿。 */
    discardOp(state, action: PayloadAction<{ opId: string }>) {
      const op = state.outbox.find((item) => item.opId === action.payload.opId);
      if (op?.type === 'card-edit' && op.cardId) {
        const card = state.cards.find((item) => item.id === op.cardId);
        if (card) {
          (Object.keys(card.fields) as FieldName[]).forEach((field) => {
            card.fields[field].localValue = null;
            card.fields[field].resolved = undefined;
            card.fields[field].value = card.fields[field].serverValue;
            card.fields[field].source = 'server';
          });
        }
      }
      state.outbox = state.outbox.filter((item) => item.opId !== action.payload.opId);
      state.conflicts = state.conflicts.filter((item) => item.opId !== action.payload.opId);
      upsertAudit(state.audit, {
        key: `discard:${action.payload.opId}`,
        time: nowTime(),
        actor: '宋杰',
        action: '放弃本地操作',
        detail: `操作 ${action.payload.opId} 及其草稿已移除（正式记录未受影响）`
      });
    },
    /** 重试被拒绝的操作：生成新幂等键并按当前版本重定基线，避免重复审计与重复落账。 */
    retryRejectedOp(state, action: PayloadAction<{ opId: string }>) {
      const op = state.outbox.find((item) => item.opId === action.payload.opId);
      if (!op) return;
      const card = op.cardId ? state.cards.find((item) => item.id === op.cardId) : undefined;
      op.opId = newOpId();
      op.baseRevision = state.serverRevision;
      op.attempts = 0;
      op.state = 'pending';
      op.lastError = undefined;
      if (card) op.cardRevision = card.revision;
      state.conflicts = state.conflicts.filter((item) => item.opId !== action.payload.opId);
      upsertAudit(state.audit, {
        key: `retry:${op.opId}`,
        time: nowTime(),
        actor: '宋杰',
        action: '重试同步',
        detail: `操作以新幂等键 ${op.opId} 重新提交，旧请求不产生重复记录`
      });
    },
    /** 承认失效项：工卡结论重新确认 / 阶段重新签署的入口在业务页面，这里仅支持清除已处理项。 */
    resolveInvalidation(state, action: PayloadAction<{ id: string }>) {
      const invalid = state.invalidations.find((item) => item.id === action.payload.id);
      if (invalid) invalid.resolved = true;
      if (invalid?.stage) {
        const signature = state.signatures.find((item) => item.stage === invalid.stage);
        if (signature) signature.needsResign = false;
      }
      state.cards.forEach((card) => {
        card.needsReconfirm = state.invalidations.some((item) => !item.resolved && item.cardId === card.id);
      });
    },
    /** 对失效工卡执行“重新确认”：入 reconfirm 发件箱，并按新基线保留本地复测结论。 */
    requestReconfirm(state, action: PayloadAction<{ cardId: string }>) {
      const card = state.cards.find((item) => item.id === action.payload.cardId);
      if (!card) return;
      // 授权/修订可能同时改了同一字段：重新确认意味着执行人基于最新正式记录确认自己的结论，
      // 字段冲突一律裁决为保留本地（值保留、冲突移除），随后随编辑操作推送。
      state.conflicts = state.conflicts.filter((conflict) => {
        if (conflict.kind === 'field-diverge' && conflict.cardId === card.id && conflict.field) {
          const meta = card.fields[conflict.field];
          meta.resolved = true;
          meta.source = 'local';
          meta.value = meta.localValue ?? meta.serverValue;
          return false;
        }
        return true;
      });
      // 挂起的编辑操作按当前版本与工卡版本重定基线（新幂等键，避免重复落账）。
      const editOp = state.outbox.find((op) => op.type === 'card-edit' && op.cardId === card.id && op.state === 'pending');
      if (editOp) {
        editOp.opId = newOpId();
        editOp.baseRevision = state.serverRevision;
        editOp.cardRevision = card.revision;
        editOp.lastError = undefined;
      } else {
        state.outbox.unshift({
          opId: newOpId(),
          type: 'card-edit',
          createdAt: nowTime(),
          attempts: 0,
          state: 'pending',
          baseRevision: state.serverRevision,
          cardId: card.id,
          cardRevision: card.revision,
          complete: card.status === '已完成'
        });
      }
      state.outbox.unshift({
        opId: newOpId(),
        type: 'reconfirm',
        createdAt: nowTime(),
        attempts: 0,
        state: 'pending',
        baseRevision: state.serverRevision,
        cardId: card.id
      });
      state.lastSaved = nowTime();
      upsertAudit(state.audit, {
        key: `reconfirm-request:${card.id}:${state.lastSaved}`,
        time: state.lastSaved,
        actor: '宋杰',
        action: '重新确认',
        detail: `${card.id} 已按最新正式记录核对，本地复测结论保留并随重新确认提交`
      });
    },
    /** 阶段签字：离线时本地待签并入发件箱；若该阶段被判定失效，则进入重签。 */
    signStage(state, action: PayloadAction<{ stage: string }>) {
      const signature = state.signatures.find((item) => item.stage === action.payload.stage);
      if (!signature || signature.serverSigned) return;
      signature.actor = `${action.payload.stage}负责人`;
      signature.time = nowTime();
      signature.pending = true;
      signature.needsResign = false;
      state.outbox.unshift({
        opId: newOpId(),
        type: 'sign',
        createdAt: nowTime(),
        attempts: 0,
        state: 'pending',
        baseRevision: state.serverRevision,
        stage: action.payload.stage
      });
    },
    releasePackage(state) {
      if (state.cards.some((card) => card.status === '待授权')) return;
      if (!state.signatures.every((item) => item.serverSigned || item.pending)) return;
      state.outbox.unshift({
        opId: newOpId(),
        type: 'release',
        createdAt: nowTime(),
        attempts: 0,
        state: 'pending',
        baseRevision: state.serverRevision
      });
    },
    dismissMessage(state) {
      if (state.syncState !== 'syncing') state.syncMessage = '';
    },
    /** 测试专用：用服务器快照把本机状态恢复为干净基线。 */
    resetLocalState(state, action: PayloadAction<ServerSnapshot>) {
      const fresh = stateFromSnapshot(action.payload);
      Object.assign(state, fresh);
    },
    /** 同步推送有结果后一次性落账（500/断网失败路径不调用，草稿与冲突原样保留）。 */
    commitSync(state, action: PayloadAction<CommitPayload>) {
      const { remote, acceptedIds, acceptedOps, rejected, ownEventIds } = action.payload;

      // 最终快照与本地做三路合并（失效/冲突/服务器事件在纯引擎中裁决）。
      applyMerge(state, remote, ownEventIds);

      // 已被正式记录接收的操作移出队列，并为它们各写一条幂等审计。
      acceptedOps.forEach((op) => {
        upsertAudit(state.audit, {
          key: `op:${op.opId}`,
          time: nowTime(),
          actor: '宋杰',
          action: op.type === 'card-edit' ? (op.complete ? '工卡完成已正式记录' : '字段更新已正式记录')
            : op.type === 'sign' ? '阶段签署已正式记录'
              : op.type === 'release' ? '放行已正式记录' : '重新确认已正式记录',
          detail: op.type === 'card-edit'
            ? `${op.cardId} 本地草稿（opId ${op.opId}）已合并入服务器正式记录`
            : op.type === 'sign' ? `${op.stage}阶段签署（opId ${op.opId}）`
              : `opId ${op.opId}`
        });
      });
      state.outbox = state.outbox.filter((op) => !acceptedIds.includes(op.opId));

      // 被服务器明确拒绝的操作：保留草稿，生成稳定冲突项，等待人工处理或重试。
      rejected.forEach(({ op, reason }) => {
        const id = `conflict:op:${op.opId}`;
        op.state = 'rejected';
        op.lastError = reason;
        if (!state.conflicts.some((item) => item.id === id)) {
          state.conflicts.push({
            id,
            kind: 'op-rejected',
            opId: op.opId,
            cardId: op.cardId,
            title: op.type === 'card-edit' ? `${op.cardId} 提交被服务器拒绝` : '操作被服务器拒绝',
            detail: reason,
            reason,
            createdAt: nowTime()
          });
        }
        upsertAudit(state.audit, { key: id, time: nowTime(), actor: '服务器', action: '合并冲突', detail: reason });
      });

      // 推进基线，之后的事件不再被误判为“离线期间事件”。
      state.base = remote;
      state.baseRevision = remote.revision;
      state.serverRevision = remote.revision;
      state.released = remote.released;
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(bootstrap.fulfilled, (state, action) => {
        const { snapshot } = action.payload;
        if (!state.hydrated || state.cards.length === 0 || state.baseRevision === 0) {
          Object.assign(state, stateFromSnapshot(snapshot));
          state.syncMessage = '已载入服务器正式记录';
        } else {
          state.syncState = 'idle';
        }
        state.hydrated = true;
      })
      .addCase(runSync.pending, (state) => {
        if (!state.offline) {
          state.syncState = 'syncing';
          state.syncMessage = '正在与服务器正式记录合并…';
        }
      })
      .addCase(runSync.fulfilled, (state, action) => {
        if (action.payload.ok) {
          state.syncState = 'idle';
          const { accepted, rejected, pulled } = action.payload;
          state.syncMessage = `同步完成：正式记录 R${pulled}，接收本地操作 ${accepted} 项${rejected ? `，${rejected} 项被拒绝并保留为冲突` : ''}`;
        } else if (action.payload.status === 500) {
          state.syncState = 'error';
          state.syncMessage = action.payload.message;
          state.outbox.forEach((op) => { op.attempts += 1; });
        } else {
          state.syncState = 'offline';
        }
      })
      .addCase(runSync.rejected, (state) => {
        state.syncState = 'error';
        state.syncMessage = '同步失败：本地草稿与冲突项已完整保留，可随时重试（不会产生重复审计）。';
      });
  }
});

export const {
  selectCard,
  saveDraft,
  completeCard,
  toggleOffline,
  resolveFieldConflict,
  discardOp,
  retryRejectedOp,
  resolveInvalidation,
  requestReconfirm,
  signStage,
  releasePackage,
  dismissMessage,
  commitSync,
  resetLocalState
} = slice.actions;

export const store = configureStore({
  reducer: { maintenance: slice.reducer },
  middleware: (getDefault) => getDefault()
});

store.subscribe(() => {
  if (typeof localStorage === 'undefined') return;
  const state = store.getState().maintenance;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, syncState: state.offline ? 'offline' : 'idle', hydrated: true }));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

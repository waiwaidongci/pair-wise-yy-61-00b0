import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { maintenanceApi, notifyOffline, type CommitMergeResult } from './api';
import { planMerge, FIELD_KEYS, type CardMergePlan, type DraftConflict, type DraftInvalidation, type FieldKey, type FieldSource, type ServerCard } from './merge';

export type StageSignature = { stage: string; status: '待签署' | '已签署'; actor: string; time: string };

export type CardDraft = {
  baseRev: number;
  baseAt: string;
  baseFields: Record<FieldKey, string>;
  values: Partial<Record<FieldKey, string>>;
  status: 'draft' | 'stale' | 'conflict' | 'failed' | 'merged';
  conflicts: DraftConflict[];
  invalidations: DraftInvalidation[];
  serverFields?: Record<FieldKey, string>;
  serverRev?: number;
  autoFields?: Partial<Record<FieldKey, FieldSource>>;
  mergeId?: string;
  error?: string;
};

export type OfflineCard = {
  id: string;
  title: string;
  estimated: number;
  zone: string;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: '未开始' | '执行中' | '待授权' | '已完成';
  rev: number;
  measurement: string;
  finding: string;
  evidenceNote: string;
  stage: string;
  draft?: CardDraft;
};

type AuditEntry = { time: string; actor: string; action: string; detail: string; mergeId?: string };

type MaintenanceState = {
  schemaVersion: number;
  cards: OfflineCard[];
  activeCardId: string;
  syncVersion: number;
  serverVersion: number;
  offline: boolean;
  lastSaved: string;
  conflictMessage: string;
  signatures: StageSignature[];
  released: boolean;
  audit: AuditEntry[];
};

const SCHEMA_VERSION = 2;

const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const nowIso = () => new Date().toISOString();

const buildDefaultState = (): MaintenanceState => ({
  schemaVersion: SCHEMA_VERSION,
  cards: [
    { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', rev: 1, measurement: '1.62 mm', finding: '正常', evidenceNote: '', stage: '机械签署' },
    { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', rev: 1, measurement: '', finding: '', evidenceNote: '', stage: '发动机签署' },
    { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', rev: 1, measurement: '2762 psi', finding: '低于容差，等待授权', evidenceNote: '', stage: '系统签署' },
    { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', rev: 1, measurement: '剩余 836 循环', finding: '正常', evidenceNote: '', stage: '适航签署' },
    { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', rev: 1, measurement: '', finding: '', evidenceNote: '', stage: '适航签署' },
    { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', rev: 1, measurement: '', finding: '', evidenceNote: '', stage: '客舱签署' },
    { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', rev: 1, measurement: '', finding: '', evidenceNote: '', stage: '动力签署' },
    { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', rev: 1, measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', evidenceNote: '', stage: '放行签署' }
  ],
  activeCardId: 'CARD-03',
  syncVersion: 7,
  serverVersion: 7,
  offline: false,
  lastSaved: '09:46',
  conflictMessage: '',
  signatures: [
    { stage: '机械', status: '已签署', actor: '赵明 · 机械师', time: '09:18' },
    { stage: '系统', status: '待签署', actor: '待指定', time: '-' },
    { stage: '动力', status: '待签署', actor: '待指定', time: '-' },
    { stage: '放行', status: '待签署', actor: '质量经理', time: '-' }
  ],
  released: false,
  audit: [
    { time: '08:54', actor: '赵明', action: '完成工卡', detail: 'CARD-01 间隙测量 1.62 mm' },
    { time: '09:05', actor: '宋杰', action: '提交测量', detail: 'CARD-03 压力 2762 psi，低于容差' },
    { time: '09:20', actor: '系统', action: '阻断', detail: 'CARD-03 等待授权处理' }
  ]
});

// 旧数据迁移：v1（无 rev / evidenceNote / draft）→ v2。任何异常都回退到默认状态，保证旧数据继续可用。
function migrateState(raw: unknown): MaintenanceState {
  const fallback = buildDefaultState();
  if (!raw || typeof raw !== 'object') return fallback;
  const saved = raw as Record<string, unknown>;
  if (!Array.isArray(saved.cards)) return fallback;
  const cards: OfflineCard[] = (saved.cards as Record<string, unknown>[]).map((card) => {
    const draft = card.draft as Partial<CardDraft> | undefined;
    return {
      ...(card as object),
      rev: typeof card.rev === 'number' ? card.rev : 1,
      evidenceNote: typeof card.evidenceNote === 'string' ? card.evidenceNote : '',
      draft: draft && typeof draft === 'object' ? { ...draft } as CardDraft : undefined
    } as OfflineCard;
  });
  return {
    ...fallback,
    ...(saved as object),
    schemaVersion: SCHEMA_VERSION,
    cards,
    signatures: Array.isArray(saved.signatures) ? (saved.signatures as StageSignature[]) : fallback.signatures,
    audit: Array.isArray(saved.audit)
      ? (saved.audit as Record<string, unknown>[]).map((entry) => ({
          time: String(entry.time ?? ''),
          actor: String(entry.actor ?? ''),
          action: String(entry.action ?? ''),
          detail: String(entry.detail ?? ''),
          mergeId: typeof entry.mergeId === 'string' ? entry.mergeId : undefined
        }))
      : fallback.audit,
    syncVersion: typeof saved.syncVersion === 'number' ? saved.syncVersion : 7,
    serverVersion: typeof saved.serverVersion === 'number' ? saved.serverVersion : 7,
    conflictMessage: typeof saved.conflictMessage === 'string' ? saved.conflictMessage : ''
  };
}

function loadState(): MaintenanceState {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy61-work-package') : null;
    if (!raw) return buildDefaultState();
    return migrateState(JSON.parse(raw));
  } catch {
    return buildDefaultState();
  }
}

// 审计记录按 mergeId 幂等：同一次合并重试只保留一条，失败后重试不重复写。
function upsertAudit(state: MaintenanceState, mergeId: string | undefined, action: string, detail: string, actor = '当前用户') {
  const time = nowTime();
  if (mergeId) {
    const existing = state.audit.find((entry) => entry.mergeId === mergeId);
    if (existing) {
      existing.action = action;
      existing.detail = detail;
      existing.time = time;
      return;
    }
  }
  state.audit.unshift({ time, actor, action, detail, mergeId });
}

function recomputeDraftStatus(draft: CardDraft) {
  if (draft.invalidations.length > 0) {
    draft.status = 'stale';
  } else if (draft.conflicts.some((conflict) => !conflict.resolution)) {
    draft.status = 'conflict';
  } else {
    draft.status = 'draft';
  }
}

const slice = createSlice({
  name: 'maintenance',
  initialState: loadState(),
  reducers: {
    selectCard(state, action: PayloadAction<string>) {
      state.activeCardId = action.payload;
    },
    updateCard(state, action: PayloadAction<Partial<OfflineCard>>) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      Object.assign(card, action.payload);
      state.syncVersion += 1;
      state.lastSaved = nowTime();
      state.audit.unshift({ time: state.lastSaved, actor: '当前用户', action: '离线暂存', detail: `${card.id} 已保存本地草稿` });
    },
    // 离线字段编辑：首次编辑时快照服务器版本与字段值作为草稿基线。
    editCardField(state, action: PayloadAction<{ cardId: string; field: FieldKey; value: string }>) {
      const card = state.cards.find((item) => item.id === action.payload.cardId);
      if (!card) return;
      const { field, value } = action.payload;
      if (!card.draft) {
        card.draft = {
          baseRev: card.rev,
          baseAt: nowIso(),
          baseFields: { measurement: card.measurement, finding: card.finding, evidenceNote: card.evidenceNote },
          values: {},
          status: 'draft',
          conflicts: [],
          invalidations: []
        };
      }
      card.draft.values[field] = value;
      card[field] = value;
      // 编辑后若该冲突字段已与服务器一致，自动消解冲突项。
      if (card.draft.serverFields) {
        card.draft.conflicts = card.draft.conflicts.filter((conflict) => conflict.field !== field || value !== card.draft!.serverFields![field]);
      }
      recomputeDraftStatus(card.draft);
      state.lastSaved = nowTime();
    },
    // 合并规划落库：冲突项、失效项、服务器字段快照。
    plansRecorded(state, action: PayloadAction<{ mergeId: string; plans: CardMergePlan[] }>) {
      for (const plan of action.payload.plans) {
        const card = state.cards.find((item) => item.id === plan.cardId);
        if (!card?.draft) continue;
        const draft = card.draft;
        draft.serverFields = plan.serverFields;
        draft.serverRev = plan.serverRev;
        draft.autoFields = plan.autoFields;
        draft.mergeId = action.payload.mergeId;
        draft.error = undefined;
        draft.conflicts = plan.conflicts.map((planned) => {
          const existing = draft.conflicts.find((item) => item.id === planned.id);
          return existing?.resolution ? { ...planned, resolution: existing.resolution } : planned;
        });
        draft.invalidations = plan.invalidations;
        recomputeDraftStatus(draft);
      }
      const autoCount = action.payload.plans.reduce((total, plan) => total + Object.keys(plan.autoFields).length, 0);
      const conflictCount = action.payload.plans.reduce((total, plan) => total + plan.conflicts.length, 0);
      const staleCount = action.payload.plans.filter((plan) => plan.invalidations.length > 0 || plan.status === 'locked').length;
      upsertAudit(
        state,
        action.payload.mergeId,
        '合并草稿',
        `${action.payload.plans.length} 项本地草稿待合并：${autoCount} 项字段自动合并，${conflictCount} 项冲突待裁决，${staleCount} 项结论已失效`
      );
    },
    resolveConflict(state, action: PayloadAction<{ cardId: string; conflictId: string; resolution: FieldSource }>) {
      const card = state.cards.find((item) => item.id === action.payload.cardId);
      const draft = card?.draft;
      const conflict = draft?.conflicts.find((item) => item.id === action.payload.conflictId);
      if (!card || !draft || !conflict) return;
      conflict.resolution = action.payload.resolution;
      if (action.payload.resolution === 'server' && draft.serverFields) {
        card[conflict.field] = draft.serverFields[conflict.field];
        delete draft.values[conflict.field];
      }
      recomputeDraftStatus(draft);
    },
    // 失效结论重新确认：accept 以服务器正式记录为准（本地作废）；keep 保留为冲突项待裁决。
    reconfirmDraft(state, action: PayloadAction<{ cardId: string; mode: 'accept' | 'keep' }>) {
      const card = state.cards.find((item) => item.id === action.payload.cardId);
      const draft = card?.draft;
      if (!card || !draft) return;
      if (action.payload.mode === 'accept') {
        for (const field of FIELD_KEYS) {
          if (draft.values[field] !== undefined && draft.serverFields) card[field] = draft.serverFields[field];
        }
        const refs = draft.invalidations.map((item) => `${item.type === 'authorize' ? '授权' : item.type === 'sign' ? '阶段签署' : '放行'}·${item.ref}`).join('、');
        card.draft = undefined;
        upsertAudit(state, undefined, '重新确认', `${card.id} 已接受服务器正式记录（${refs}），离线结论作废`);
      } else {
        for (const field of FIELD_KEYS) {
          if (draft.values[field] !== undefined) {
            draft.conflicts.push({
              id: `${card.id}-${field}-stale`,
              field,
              label: field === 'measurement' ? '测量值' : field === 'finding' ? '发现与处置' : '证据说明',
              localValue: draft.values[field] as string,
              serverValue: draft.serverFields?.[field] ?? draft.baseFields[field],
              reason: '离线期间工卡因授权/阶段签署/放行导致结论失效，本地结论保留待裁决'
            });
          }
        }
        draft.invalidations = [];
        recomputeDraftStatus(draft);
        upsertAudit(state, undefined, '重新确认', `${card.id} 保留离线结论作为冲突项，裁决前不得写入正式记录`);
      }
    },
    discardDraft(state, action: PayloadAction<string>) {
      const card = state.cards.find((item) => item.id === action.payload);
      if (!card?.draft) return;
      for (const field of FIELD_KEYS) card[field] = card.draft.baseFields[field];
      card.draft = undefined;
      upsertAudit(state, undefined, '丢弃草稿', `${card.id} 本地草稿已丢弃，字段恢复服务器正式记录值`);
    },
    mergeSucceeded(state, action: PayloadAction<{ mergeId: string; results: { cardId: string; rev: number }[] }>) {
      for (const result of action.payload.results) {
        const card = state.cards.find((item) => item.id === result.cardId);
        if (!card?.draft) continue;
        const draft = card.draft;
        for (const field of FIELD_KEYS) {
          if (draft.values[field] === undefined && draft.serverFields) card[field] = draft.serverFields[field];
        }
        card.rev = result.rev;
        card.draft = undefined;
      }
      state.syncVersion = state.serverVersion;
      state.conflictMessage = '';
      upsertAudit(state, action.payload.mergeId, '合并完成', `${action.payload.results.map((item) => item.cardId).join('、')} 离线草稿已写入正式记录，工卡版本已更新`);
    },
    mergeFailed(state, action: PayloadAction<{ mergeId: string; message: string }>) {
      for (const card of state.cards) {
        if (card.draft?.mergeId === action.payload.mergeId) {
          card.draft.status = 'failed';
          card.draft.error = action.payload.message;
        }
      }
      upsertAudit(state, action.payload.mergeId, '合并失败', action.payload.message);
    },
    setConflict(state, action: PayloadAction<string>) {
      state.conflictMessage = action.payload;
    },
    refreshVersion(state) {
      state.syncVersion = state.serverVersion;
      state.conflictMessage = '';
    },
    toggleOffline(state) {
      state.offline = !state.offline;
      // 仅在进入离线时通知服务器；离线标记由下次拉取正式记录时消费（避免回到在线即被清空）。
      if (state.offline) notifyOffline(nowIso());
    },
    authorizeOverride(state) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      card.status = '执行中';
      card.finding = '超差已由授权人员批准，按工程指令继续';
      state.audit.unshift({ time: nowTime(), actor: '放行授权人', action: '授权继续', detail: `${card.id} 超差放行审批` });
    },
    signStage(state, action: PayloadAction<string>) {
      const signature = state.signatures.find((item) => item.stage === action.payload);
      if (!signature) return;
      signature.status = '已签署';
      signature.actor = `${action.payload}负责人`;
      signature.time = nowTime();
      state.audit.unshift({ time: signature.time, actor: signature.actor, action: '阶段签署', detail: `${action.payload}阶段确认完成` });
    },
    releasePackage(state) {
      const hasBlockers = state.cards.some((card) => card.status === '待授权');
      const allSigned = state.signatures.every((item) => item.status === '已签署');
      if (!hasBlockers && allSigned) {
        state.released = true;
        state.audit.unshift({ time: nowTime(), actor: '质量经理', action: '锁定放行', detail: '工作包 R7 已锁定并形成放行基线' });
      }
    }
  }
});

export const {
  selectCard,
  updateCard,
  editCardField,
  plansRecorded,
  resolveConflict,
  reconfirmDraft,
  discardDraft,
  mergeSucceeded,
  mergeFailed,
  setConflict,
  refreshVersion,
  toggleOffline,
  authorizeOverride,
  signStage,
  releasePackage
} = slice.actions;

// 恢复网络后合并：先强制重拉正式记录（触发离线期间服务器事件补记），再按版本与字段来源规划并提交。
export const mergeDrafts = createAsyncThunk<{ mergeId: string; committed: number }, void, { state: RootState; dispatch: AppDispatch }>(
  'maintenance/mergeDrafts',
  async (_void, { getState, dispatch }) => {
    const rootStateBefore = getState();
    // 重试复用上次合并的 mergeId，保证同一次合并的审计记录只写一条（失败后重试不重复）。
    const mergeId =
      rootStateBefore.maintenance.cards.find((card) => card.draft?.mergeId)?.draft?.mergeId ??
      `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await dispatch(maintenanceApi.endpoints.getWorkPackage.initiate(undefined, { forceRefetch: true }));
    const rootState = getState();
    const pkg = maintenanceApi.endpoints.getWorkPackage.select(undefined)(rootState);
    const serverCards: ServerCard[] = (pkg.data?.tasks ?? []).map((task) => ({
      id: task.id,
      rev: pkg.data?.cardRevs[task.id] ?? 1,
      stage: task.stage,
      fields: { measurement: task.measurement, finding: task.finding, evidenceNote: task.evidenceNote }
    }));
    const plans = planMerge(rootState.maintenance.cards, serverCards, pkg.data?.authoritative ?? []).plans;
    dispatch(plansRecorded({ mergeId, plans }));

    const committable = plans.filter((plan) => plan.status === 'draft' && Object.keys(plan.localFields).length > 0);
    const localOnly = plans.filter((plan) => plan.status === 'draft' && Object.keys(plan.localFields).length === 0);
    if (localOnly.length > 0) {
      dispatch(mergeSucceeded({ mergeId, results: localOnly.map((plan) => ({ cardId: plan.cardId, rev: plan.serverRev })) }));
    }
    if (committable.length === 0) return { mergeId, committed: localOnly.length };

    const response = await dispatch(
      maintenanceApi.endpoints.commitMerge.initiate({
        mergeId,
        cards: committable.map((plan) => {
          const card = rootState.maintenance.cards.find((item) => item.id === plan.cardId);
          return { cardId: plan.cardId, expectedRev: plan.serverRev, baseAt: card?.draft?.baseAt ?? new Date().toISOString(), fields: plan.localFields };
        })
      })
    );
    if ('error' in response) {
      const error = response.error as { data?: { message?: string } };
      const message = error.data?.message ?? '合并失败，请重试。';
      dispatch(mergeFailed({ mergeId, message }));
      throw new Error(message);
    }
    const data = response.data as CommitMergeResult;
    dispatch(mergeSucceeded({ mergeId, results: data.results }));
    return { mergeId, committed: data.results.length + localOnly.length };
  }
);

export const store = configureStore({
  reducer: { maintenance: slice.reducer, [maintenanceApi.reducerPath]: maintenanceApi.reducer },
  middleware: (getDefault) => getDefault().concat(maintenanceApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy61-work-package', JSON.stringify(store.getState().maintenance));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

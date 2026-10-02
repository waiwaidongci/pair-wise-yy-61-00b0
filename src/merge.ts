// 离线草稿合并规划：按工卡版本与字段来源判断，而不是后到覆盖。
// 纯函数，不依赖 React / Redux，便于测试与迁移复用。

export type FieldKey = 'measurement' | 'finding' | 'evidenceNote';

export const FIELD_LABELS: Record<FieldKey, string> = {
  measurement: '测量值',
  finding: '发现与处置',
  evidenceNote: '证据说明'
};

export const FIELD_KEYS: FieldKey[] = ['measurement', 'finding', 'evidenceNote'];

export type FieldSource = 'server' | 'local';

export type ServerCard = {
  id: string;
  rev: number;
  stage: string;
  fields: Record<FieldKey, string>;
};

export type AuthoritativeAction = {
  id: string;
  type: 'authorize' | 'sign' | 'release';
  cardId?: string;
  stage?: string;
  at: string;
  by: string;
  detail: string;
};

export type DraftConflict = {
  id: string;
  field: FieldKey;
  label: string;
  localValue: string;
  serverValue: string;
  reason: string;
  resolution?: FieldSource;
};

export type DraftInvalidation = {
  id: string;
  type: 'authorize' | 'sign' | 'release';
  ref: string;
  at: string;
  by: string;
  detail: string;
};

export type CardDraftLike = {
  baseRev: number;
  baseAt: string;
  baseFields: Record<FieldKey, string>;
  values: Partial<Record<FieldKey, string>>;
};

export type CardWithDraft = {
  id: string;
  stage: string;
  draft?: CardDraftLike | null;
};

export type CardMergePlan = {
  cardId: string;
  baseRev: number;
  serverRev: number;
  serverFields: Record<FieldKey, string>;
  localFields: Partial<Record<FieldKey, string>>;
  // 自动合并结果：local 表示离线期间仅本地修改，server 表示仅服务器修改。
  autoFields: Partial<Record<FieldKey, FieldSource>>;
  conflicts: DraftConflict[];
  invalidations: DraftInvalidation[];
  // locked: 工作包已被放行锁定；stale: 离线期间存在授权/签署/放行，结论失效；conflict: 同字段两边都改；draft: 可提交。
  status: 'draft' | 'conflict' | 'stale' | 'locked';
};

export type MergePlan = {
  plans: CardMergePlan[];
  released: boolean;
};

const STAGE_LABELS: Record<AuthoritativeAction['type'], string> = {
  authorize: '授权',
  sign: '阶段签署',
  release: '放行'
};

export function invalidationLabel(type: AuthoritativeAction['type']): string {
  return STAGE_LABELS[type];
}

// 阶段签署只影响该阶段下的工卡（stage 形如“系统签署”，签署事件 stage 形如“系统”）。
function stageMatches(cardStage: string, signStage: string | undefined): boolean {
  if (!signStage) return false;
  return cardStage.startsWith(signStage);
}

/**
 * 规划合并：逐字段比较本地草稿与服务器正式记录。
 * - 仅本地修改 → 采用本地；仅服务器修改 → 采用服务器（不覆盖本地未触碰的字段）；
 * - 同字段两边都改 → 冲突项，保留两边值，等待人工裁决；
 * - 离线期间（baseAt 之后）该工卡被授权、阶段签署或工作包放行 → 本地结论失效，必须重新确认。
 */
export function planMerge(cards: CardWithDraft[], serverCards: ServerCard[], authoritative: AuthoritativeAction[]): MergePlan {
  const released = authoritative.some((action) => action.type === 'release');
  const plans: CardMergePlan[] = cards
    .filter((card) => card.draft)
    .map((card) => {
      const draft = card.draft as CardDraftLike;
      const server = serverCards.find((item) => item.id === card.id);
      const serverFields: Record<FieldKey, string> = server
        ? { ...server.fields }
        : { ...draft.baseFields };
      const serverRev = server?.rev ?? draft.baseRev;

      const invalidations: DraftInvalidation[] = authoritative
        .filter((action) => action.at > draft.baseAt)
        .filter((action) => {
          if (action.type === 'release') return true;
          if (action.type === 'authorize') return action.cardId === card.id;
          if (action.type === 'sign') return stageMatches(card.stage, action.stage);
          return false;
        })
        .map((action) => ({
          id: action.id,
          type: action.type,
          ref: action.cardId ?? action.stage ?? '工作包',
          at: action.at,
          by: action.by,
          detail: action.detail
        }));

      const conflicts: DraftConflict[] = [];
      const autoFields: Partial<Record<FieldKey, FieldSource>> = {};
      const localFields: Partial<Record<FieldKey, string>> = {};

      for (const field of FIELD_KEYS) {
        const localValue = draft.values[field];
        const localChanged = localValue !== undefined && localValue !== draft.baseFields[field];
        const serverChanged = serverFields[field] !== draft.baseFields[field];
        if (localChanged) localFields[field] = localValue;
        if (localChanged && serverChanged && localValue !== serverFields[field]) {
          conflicts.push({
            id: `${card.id}-${field}`,
            field,
            label: FIELD_LABELS[field],
            localValue: localValue as string,
            serverValue: serverFields[field],
            reason: `离线期间本地与服务器均修改了「${FIELD_LABELS[field]}」，不能按后到覆盖`
          });
        } else if (localChanged) {
          autoFields[field] = 'local';
        } else if (serverChanged) {
          autoFields[field] = 'server';
        }
      }

      const status: CardMergePlan['status'] = released
        ? 'locked'
        : invalidations.length > 0
          ? 'stale'
          : conflicts.length > 0
            ? 'conflict'
            : 'draft';

      return {
        cardId: card.id,
        baseRev: draft.baseRev,
        serverRev,
        serverFields,
        localFields,
        autoFields,
        conflicts,
        invalidations,
        status
      };
    });

  return { plans, released };
}

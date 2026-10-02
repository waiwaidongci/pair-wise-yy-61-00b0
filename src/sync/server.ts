import type { OutboxOp, ServerCard, ServerEvent, ServerSignature, ServerSnapshot } from './types';

// 可推进的模拟服务器：正式记录、正式签字/放行与历史事件都在这里。
// 断网期间“他人在服务器上的操作”通过 simulate* 方法推进，恢复后客户端拉取即可观察到。

let revision = 7;
let released = false;
let nextEventSeq = 1;
/** 已接收操作幂等键，重试不重复落账。 */
const appliedOpIds = new Map<string, { revision: number }>();
let failNextPush = false;

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const cardsBase: ServerCard[] = [
  { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', revision: 'R7', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', stage: '机械', status: '已完成', authorized: false, measurement: '1.62 mm', finding: '正常', evidenceNote: '动作记录已归档', updatedAt: '09:12', updatedBy: '赵明' },
  { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', revision: 'R7', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', stage: '发动机', status: '执行中', authorized: false, measurement: '', finding: '', evidenceNote: '', updatedAt: '09:30', updatedBy: '-' },
  { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', revision: 'R6', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', stage: '系统', status: '待授权', authorized: false, measurement: '2762 psi', finding: '低于容差，等待授权', evidenceNote: '压力仪原始记录已上传', updatedAt: '09:05', updatedBy: '宋杰' },
  { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', revision: 'R7', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', stage: '适航', status: '已完成', authorized: false, measurement: '剩余 836 循环', finding: '正常', evidenceNote: '履历页照片 2 张', updatedAt: '08:58', updatedBy: '赵明' },
  { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', revision: 'R7', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', stage: '适航', status: '未开始', authorized: false, measurement: '', finding: '', evidenceNote: '', updatedAt: '-', updatedBy: '-' },
  { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', revision: 'R7', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', stage: '客舱', status: '未开始', authorized: false, measurement: '', finding: '', evidenceNote: '', updatedAt: '-', updatedBy: '-' },
  { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', revision: 'R5', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', stage: '动力', status: '未开始', authorized: false, measurement: '', finding: '', evidenceNote: '', updatedAt: '-', updatedBy: '-' },
  { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', revision: 'R7', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', stage: '放行', status: '执行中', authorized: false, measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', evidenceNote: '', updatedAt: '09:40', updatedBy: '宋杰' }
];

const signaturesBase: ServerSignature[] = [
  { stage: '机械', signed: true, actor: '赵明 · 机械师', time: '09:18' },
  { stage: '系统', signed: false, actor: '', time: '' },
  { stage: '动力', signed: false, actor: '', time: '' },
  { stage: '放行', signed: false, actor: '', time: '' }
];

const eventsBase: ServerEvent[] = [
  { id: 'EV-0', rev: 7, time: '09:05', type: 'edit', actor: '宋杰', detail: 'CARD-03 提交压力测量 2762 psi', cardId: 'CARD-03' },
  { id: 'EV-1', rev: 7, time: '09:18', type: 'sign', actor: '赵明 · 机械师', detail: '机械阶段完成电子签署', stage: '机械' }
];

// 深拷贝，保证“正式记录”不会被客户端直接改动。
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// 可变的“当前正式记录”，由 base 拷贝而来。
const cardsSeed: ServerCard[] = clone(cardsBase);
const signaturesSeed: ServerSignature[] = clone(signaturesBase);
const eventsSeed: ServerEvent[] = clone(eventsBase);

export function fetchSnapshot(): Promise<ServerSnapshot> {
  return new Promise((resolve) => setTimeout(() => resolve({
    revision,
    released,
    cards: clone(cardsSeed),
    signatures: clone(signaturesSeed),
    events: clone(eventsSeed)
  }), 160));
}

function bumpEvent(event: Omit<ServerEvent, 'id' | 'rev' | 'time'> & { time?: string }): ServerEvent {
  revision += 1;
  const full: ServerEvent = {
    ...event,
    id: `EV-${nextEventSeq++}`,
    rev: revision,
    time: event.time ?? now()
  };
  eventsSeed.push(full);
  return full;
}

export function findServerCard(cardId: string): ServerCard | undefined {
  return cardsSeed.find((card) => card.id === cardId);
}

/** 模拟断网期间授权人员在服务器上批准超差。 */
export function simulateAuthorize(cardId: string, actor = '质量经理 何斌'): ServerEvent {
  const card = findServerCard(cardId);
  if (card) {
    card.status = '执行中';
    card.authorized = true;
    card.finding = `超差已由 ${actor} 按 EO-2026-1147 授权，执行人员须复测并重新确认结论`;
    card.updatedAt = now();
    card.updatedBy = actor;
  }
  return bumpEvent({
    type: 'authorize',
    actor,
    cardId,
    detail: `${cardId} 超差经授权批准（EO-2026-1147），执行侧相关结论失效，需重新确认`
  });
}

/** 模拟断网期间某阶段在服务器完成正式签字。 */
export function simulateSign(stage: string, actor = `${stage}负责人`): ServerEvent {
  const signature = signaturesSeed.find((item) => item.stage === stage);
  if (signature && !signature.signed) {
    signature.signed = true;
    signature.actor = actor;
    signature.time = now();
  }
  return bumpEvent({ type: 'sign', actor, stage, detail: `${stage}阶段在服务器完成正式签署，本机离线签署需重新确认` });
}

/** 模拟断网期间工作包在服务器被锁定放行。 */
export function simulateRelease(actor = '质量经理 何斌'): ServerEvent {
  released = true;
  return bumpEvent({ type: 'release', actor, detail: '工作包在服务器完成锁定放行并形成只读基线，本机待同步结论全部失效' });
}

/** 模拟断网期间工卡内容被修订（版本升级）。 */
export function simulateRevise(cardId: string, toRev: string, tolerance: string): ServerEvent {
  const card = findServerCard(cardId);
  const fromRev = card?.revision ?? '?';
  if (card) {
    card.revision = toRev;
    card.tolerance = tolerance;
    card.updatedAt = now();
    card.updatedBy = '工程部门';
  }
  return bumpEvent({
    type: 'revise',
    actor: '工程部门',
    cardId,
    fromRev,
    toRev,
    detail: `${cardId} 工卡版本 ${fromRev} → ${toRev}，施工要求变更，既有结论需按新版本重新确认`
  });
}

/** 模拟断网期间另一名执行人员在服务器改了同一字段。 */
export function simulateConcurrentEdit(cardId: string, field: 'measurement' | 'finding' | 'evidenceNote', value: string, actor = '执行人员 周磊'): ServerEvent {
  const card = findServerCard(cardId);
  if (card) {
    card[field] = value;
    card.updatedAt = now();
    card.updatedBy = actor;
  }
  return bumpEvent({ type: 'edit', actor, cardId, detail: `${cardId} ${field} 由 ${actor} 更新为「${value}」` });
}

/** 让下一次推送失败（500），用于验证失败保留与重试幂等。 */
export function setFailNextPush(value = true): void {
  failNextPush = value;
}

export function isReleased(): boolean {
  return released;
}

export type PushResultItem = {
  opId: string;
  accepted: boolean;
  reason?: string;
  /** 该操作在服务器上产生的正式事件 ID，客户端据此避免重复记审计。 */
  eventId?: string;
};

export type PushResponse =
  | { ok: true; revision: number; results: PushResultItem[] }
  | { ok: false; status: 500; message: string }
  | { ok: false; status: 409; message: string; results: PushResultItem[] };

/**
 * 推送发件箱。服务器按 opId 幂等落账；逐条做乐观并发校验，
 * 失败的操作返回明确原因，供客户端保留为冲突项。
 */
export async function pushOps(ops: OutboxOp[], draftValues: Record<string, Partial<Record<'measurement' | 'finding' | 'evidenceNote', string>>>): Promise<PushResponse> {
  await new Promise((resolve) => setTimeout(resolve, 220));
  if (failNextPush) {
    failNextPush = false;
    return { ok: false, status: 500, message: '服务器暂时不可用（模拟 500），本地草稿与冲突项已保留，请稍后重试。' };
  }

  const results: PushResultItem[] = [];
  // 整批按同一基线版本做乐观并发校验，批内 bump 不导致后续操作误判过期。
  const batchRevision = revision;
  for (const op of ops) {
    if (appliedOpIds.has(op.opId)) {
      // 重复请求（如响应丢失后重试）：回放成功，不重复落账、不重复写审计。
      results.push({ opId: op.opId, accepted: true });
      continue;
    }
    if (op.baseRevision !== batchRevision) {
      results.push({ opId: op.opId, accepted: false, reason: '版本已过期：服务器正式记录在本机离线期间发生变化，需先完成差异合并。' });
      continue;
    }
    if (op.type === 'card-edit') {
      const card = cardsSeed.find((item) => item.id === op.cardId);
      if (!card) {
        results.push({ opId: op.opId, accepted: false, reason: `工卡 ${op.cardId} 不存在。` });
        continue;
      }
      if (op.cardRevision && card.revision !== op.cardRevision) {
        results.push({ opId: op.opId, accepted: false, reason: `工卡版本已从 ${op.cardRevision} 变更为 ${card.revision}，需按新版本重新确认。` });
        continue;
      }
      if (released) {
        results.push({ opId: op.opId, accepted: false, reason: '工作包已在服务器锁定放行，正式记录只读，内容修改被拒绝。' });
        continue;
      }
      const values = draftValues[card.id] ?? {};
      (Object.keys(values) as Array<'measurement' | 'finding' | 'evidenceNote'>).forEach((field) => {
        card[field] = values[field] as string;
      });
      if (op.complete) {
        if (card.status === '待授权' && !card.authorized) {
          results.push({ opId: op.opId, accepted: false, reason: `${card.id} 仍处于超差待授权状态，不能完成。` });
          continue;
        }
        card.status = '已完成';
      }
      card.updatedAt = now();
      card.updatedBy = '宋杰';
      appliedOpIds.set(op.opId, { revision });
      const event = bumpEvent({
        type: 'edit',
        actor: '宋杰',
        cardId: card.id,
        detail: op.complete ? `${card.id} 完成并提交（${describeValues(values)}）` : `${card.id} 字段更新（${describeValues(values)}）`
      });
      results.push({ opId: op.opId, accepted: true, eventId: event.id });
      continue;
    }
    if (op.type === 'reconfirm') {
      const card = cardsSeed.find((item) => item.id === op.cardId);
      if (card) {
        card.updatedAt = now();
        card.updatedBy = '宋杰';
      }
      appliedOpIds.set(op.opId, { revision });
      const reconfirmEvent = bumpEvent({ type: 'reconfirm', actor: '宋杰', cardId: op.cardId, detail: `${op.cardId} 已按当前正式记录与工卡版本重新确认结论` });
      results.push({ opId: op.opId, accepted: true, eventId: reconfirmEvent.id });
      continue;
    }
    if (op.type === 'sign') {
      const signature = signaturesSeed.find((item) => item.stage === op.stage);
      if (!signature) {
        results.push({ opId: op.opId, accepted: false, reason: `阶段 ${op.stage} 不存在。` });
        continue;
      }
      if (released) {
        results.push({ opId: op.opId, accepted: false, reason: '工作包已锁定放行，签署操作被拒绝。' });
        continue;
      }
      if (!signature.signed) {
        signature.signed = true;
        signature.actor = `${op.stage}负责人`;
        signature.time = now();
      }
      appliedOpIds.set(op.opId, { revision });
      const signEvent = bumpEvent({ type: 'sign', actor: `${op.stage}负责人`, stage: op.stage, detail: `${op.stage}阶段签署已正式记录` });
      results.push({ opId: op.opId, accepted: true, eventId: signEvent.id });
      continue;
    }
    if (op.type === 'release') {
      const openBlocker = cardsSeed.some((card) => card.status === '待授权');
      const allSigned = signaturesSeed.every((item) => item.signed);
      if (openBlocker || !allSigned) {
        results.push({ opId: op.opId, accepted: false, reason: '放行门禁未满足（仍有待授权超差或未签署阶段）。' });
        continue;
      }
      released = true;
      appliedOpIds.set(op.opId, { revision });
      const releaseEvent = bumpEvent({ type: 'release', actor: '质量经理', detail: '工作包锁定放行，形成只读基线' });
      results.push({ opId: op.opId, accepted: true, eventId: releaseEvent.id });
    }
  }

  return { ok: true, revision, results };
}

function describeValues(values: Record<string, string>): string {
  const labels: Record<string, string> = { measurement: '测量值', finding: '发现与处置', evidenceNote: '证据说明' };
  return Object.entries(values).map(([key, value]) => `${labels[key] ?? key}=${value}`).join('，') || '无字段变更';
}

/** 重置服务器（仅供测试使用）。 */
export function resetServer(options: { revision?: number } = {}): void {
  revision = options.revision ?? 7;
  released = false;
  nextEventSeq = 100;
  appliedOpIds.clear();
  failNextPush = false;
  cardsSeed.splice(0, cardsSeed.length, ...clone(cardsBase));
  signaturesSeed.splice(0, signaturesSeed.length, ...clone(signaturesBase));
  eventsSeed.splice(0, eventsSeed.length, ...clone(eventsBase));
}

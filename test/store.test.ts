import { store } from '../src/store';
import {
  completeCard,
  demoScenario,
  requestReconfirm,
  resetLocalState,
  resolveInvalidation,
  retryRejectedOp,
  runSync,
  saveDraft,
  toggleOffline
} from '../src/store';
import { fetchSnapshot, resetServer, setFailNextPush } from '../src/sync/server';
import type { RootState } from '../src/store';

let passed = 0;
let failed = 0;
const assert = (condition: unknown, message: string) => {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
};
const state = (): RootState['maintenance'] => store.getState().maintenance;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每个场景前把服务器与本机状态都恢复为干净基线。 */
async function resetWorld() {
  resetServer();
  const snapshot = await fetchSnapshot();
  store.dispatch(resetLocalState(snapshot));
}

async function scenarioFullOfflineCycle() {
  console.log('集成1：断网编辑 → 授权发生在离线期间 → 联网合并：完成结论挂起、草稿保留、重确认后收口');
  await resetWorld();

  // 断网，继续填测量值、发现、证据说明
  store.dispatch(toggleOffline(true));
  store.dispatch(saveDraft({ cardId: 'CARD-03', field: 'measurement', value: '2888 psi' }));
  store.dispatch(saveDraft({ cardId: 'CARD-03', field: 'finding', value: '复测 10 分钟压降合格' }));
  store.dispatch(saveDraft({ cardId: 'CARD-03', field: 'evidenceNote', value: '压力仪曲线 #P-2291' }));
  store.dispatch(completeCard({ cardId: 'CARD-03' }));
  assert(state().offline, '处于离线状态');
  assert(state().outbox.length >= 1, '离线操作进入发件箱');
  assert(state().outbox[0].complete === true, '完成结论随草稿排队');

  // 断网期间授权人员在服务器授权
  await store.dispatch(demoScenario({ kind: 'authorize', cardId: 'CARD-03' }));

  // 恢复网络并同步
  store.dispatch(toggleOffline(false));
  await store.dispatch(runSync());

  const s1 = state();
  const invalid = s1.invalidations.filter((i) => !i.resolved && i.cardId === 'CARD-03');
  assert(invalid.length >= 1, '合并后出现 CARD-03 失效项');
  assert(s1.cards.find((c) => c.id === 'CARD-03')!.needsReconfirm, '工卡要求重新确认');
  // 完成操作应被挂起：发件箱仍保留该操作
  assert(s1.outbox.some((op) => op.type === 'card-edit' && op.cardId === 'CARD-03'), '完成操作保留在发件箱（被挂起而非丢弃）');
  assert(s1.cards.find((c) => c.id === 'CARD-03')!.fields.measurement.localValue === '2888 psi', '本地草稿值保留');
  assert(s1.syncState === 'idle', '同步本身成功完成');

  // 重新确认 → 失效解决 → 再同步，此时卡已是执行中、草稿可推送
  store.dispatch(requestReconfirm({ cardId: 'CARD-03' }));
  s1.invalidations.filter((i) => i.cardId === 'CARD-03').forEach((i) => store.dispatch(resolveInvalidation({ id: i.id })));
  // 重新基线化挂起的编辑操作
  const editOp = state().outbox.find((op) => op.type === 'card-edit' && op.cardId === 'CARD-03');
  if (editOp) store.dispatch(retryRejectedOp({ opId: editOp.opId }));
  await store.dispatch(runSync());
  await wait(0);

  const s2 = state();
  assert(!s2.cards.find((c) => c.id === 'CARD-03')!.needsReconfirm, '重新确认后标记清除');
  assert(s2.cards.find((c) => c.id === 'CARD-03')!.status === '已完成', '服务器正式记录为已完成');
  assert(s2.cards.find((c) => c.id === 'CARD-03')!.fields.measurement.source === 'server', '字段收口为正式记录来源');
  assert(!s2.outbox.some((op) => op.type === 'card-edit' && op.cardId === 'CARD-03'), '发件箱操作已清空');

  // 审计幂等检查：与该编辑操作相关的“已正式记录”只有 1 条
  const opAudits = s2.audit.filter((a) => a.action === '工卡完成已正式记录' || a.action === '字段更新已正式记录');
  assert(opAudits.length === 1, `正式记录审计恰好 1 条（实际 ${opAudits.length}）`);
  // 授权事件审计 1 条
  assert(s2.audit.filter((a) => a.action === '离线授权合并').length === 1, '授权合并审计 1 条');
}

async function scenarioServer500Retry() {
  console.log('集成2：同步遇 500 → 草稿/队列保留且无成功审计；重试成功后审计仍只 1 条');
  await resetWorld();

  store.dispatch(saveDraft({ cardId: 'CARD-02', field: 'measurement', value: '0.22 mm' }));
  setFailNextPush(true);
  await store.dispatch(runSync());

  const s1 = state();
  assertEqual(s1.syncState, 'error', '同步状态为 error');
  assert(s1.outbox.length >= 1, '失败后发件箱保留');
  assert(s1.cards.find((c) => c.id === 'CARD-02')!.fields.measurement.localValue === '0.22 mm', '失败后本地草稿保留');
  assert(!s1.audit.some((a) => a.action === '字段更新已正式记录'), '失败路径不写成功审计');

  await store.dispatch(runSync());
  const s2 = state();
  assertEqual(s2.syncState, 'idle', '重试后同步成功');
  assert(!s2.outbox.some((op) => op.type === 'card-edit' && op.cardId === 'CARD-02'), '重试后发件箱清空');
  const audits = s2.audit.filter((a) => a.action === '字段更新已正式记录');
  assertEqual(audits.length, 1, `重试不产生重复审计（实际 ${audits.length}）`);
}

async function scenarioFieldConflictUI() {
  console.log('集成3：字段冲突 → 保留本地推送，服务器拒绝（版本过期）→ 重定基线重试成功，审计不重复');
  await resetWorld();

  store.dispatch(toggleOffline(true));
  store.dispatch(saveDraft({ cardId: 'CARD-03', field: 'measurement', value: '2875 psi' }));
  await store.dispatch(demoScenario({ kind: 'concurrent', cardId: 'CARD-03', field: 'measurement', value: '2902 psi' }));
  store.dispatch(toggleOffline(false));
  await store.dispatch(runSync());

  const s1 = state();
  const conflict = s1.conflicts.find((c) => c.kind === 'field-diverge' && c.cardId === 'CARD-03' && c.field === 'measurement');
  assert(Boolean(conflict), '出现测量值字段冲突');
  // 冲突未裁决期间该操作不应推送，故发件箱保留且无 op 冲突
  assert(s1.outbox.some((op) => op.type === 'card-edit' && op.cardId === 'CARD-03'), '冲突未裁决，操作留在发件箱');
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

async function main() {
  await scenarioFullOfflineCycle();
  await scenarioServer500Retry();
  await scenarioFieldConflictUI();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

void main();

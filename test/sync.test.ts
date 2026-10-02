import { mergeSnapshot, isOpBlockedByInvalidation } from '../src/sync/merge';
import { clientCardFromServer } from '../src/sync/cards';
import { migratePersisted } from '../src/sync/migration';
import {
  fetchSnapshot,
  pushOps,
  resetServer,
  setFailNextPush,
  simulateAuthorize,
  simulateConcurrentEdit,
  simulateRelease,
  simulateRevise,
  simulateSign
} from '../src/sync/server';
import type { ClientSignature, MaintenanceCard, OutboxOp, ServerSnapshot } from '../src/sync/types';

let passed = 0;
let failed = 0;
const assert = (condition: unknown, message: string) => {
  if (condition) { passed += 1; console.log(`  ✓ ${message}`); }
  else { failed += 1; console.error(`  ✗ ${message}`); }
};
const assertEqual = (actual: unknown, expected: unknown, message: string) => {
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
};

const localSetup = (snapshot: ServerSnapshot) => ({
  cards: snapshot.cards.map(clientCardFromServer),
  signatures: snapshot.signatures.map((sig): ClientSignature => ({
    stage: sig.stage, actor: sig.actor || '待指定', time: sig.time || '-', serverSigned: sig.signed, pending: false, needsResign: false
  }))
});

const editCardDraft = (cards: MaintenanceCard[], cardId: string, field: 'measurement' | 'finding' | 'evidenceNote', value: string) => {
  const card = cards.find((item) => item.id === cardId)!;
  card.fields[field].localValue = value;
  card.fields[field].value = value;
  card.fields[field].source = 'local';
};

const draftOp = (baseRevision: number, cardId: string, cardRevision: string, complete = false): OutboxOp => ({
  opId: `op-test-${Math.random().toString(36).slice(2, 8)}`,
  type: 'card-edit',
  createdAt: '10:00',
  attempts: 0,
  state: 'pending',
  baseRevision,
  cardId,
  cardRevision,
  complete
});

async function scenarioOfflineEditMerges() {
  console.log('场景1：断网继续填工卡，服务器无变化 → 草稿推送成功、字段收口、无冲突');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  editCardDraft(local.cards, 'CARD-02', 'measurement', '0.18 mm');
  editCardDraft(local.cards, 'CARD-02', 'finding', '凹坑在限内');
  const outbox = [draftOp(base.revision, 'CARD-02', 'R7')];

  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox,
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  assertEqual(result.conflicts.length, 0, '无冲突');
  assertEqual(result.cards.find((c) => c.id === 'CARD-02')!.fields.measurement.source, 'local', '合并后保留本地草稿待推送');

  const response = await pushOps(outbox, {
    'CARD-02': { measurement: '0.18 mm', finding: '凹坑在限内' }
  });
  assert(response.ok && response.results[0].accepted, '推送被服务器接收');
  const server = await fetchSnapshot();
  assertEqual(server.cards.find((c) => c.id === 'CARD-02')!.measurement, '0.18 mm', '正式记录已写入本地测量值');
}

async function scenarioFieldConflict() {
  console.log('场景2：同一字段双方都改且值不同 → 冲突不覆盖；人工裁决后才能推送');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  editCardDraft(local.cards, 'CARD-03', 'measurement', '2860 psi');
  const outbox = [draftOp(base.revision, 'CARD-03', 'R6')];

  // 断网期间他人在服务器改了同一字段
  simulateConcurrentEdit('CARD-03', 'measurement', '2905 psi（周磊复测）');
  const remote = await fetchSnapshot();

  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox,
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  assertEqual(result.conflicts.length, 1, '产生 1 个字段冲突');
  const card = result.cards.find((c) => c.id === 'CARD-03')!;
  assertEqual(card.fields.measurement.source, 'conflict', '字段来源标记为 conflict');
  assertEqual(card.fields.measurement.value, '2860 psi', '展示保留本地值而非后到覆盖');
  assertEqual(card.fields.measurement.serverValue, '2905 psi（周磊复测）', '服务器值完整保留');
  assert(!isOpBlockedByInvalidation(outbox[0], []), '无失效项');

  // 再次合并不应重复产生冲突
  const result2 = mergeSnapshot({
    cards: result.cards, signatures: result.signatures, outbox,
    base: remote, remote: await fetchSnapshot(), seenEventIds: remote.events.map((e) => e.id), existingConflicts: result.conflicts
  });
  assertEqual(result2.conflicts.length, 1, '重复合并不产生重复冲突项');
}

async function scenarioAuthorizeInvalidates() {
  console.log('场景3：离线期间被授权 → 受影响结论失效、完成操作挂起，重新确认后才推送');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  editCardDraft(local.cards, 'CARD-03', 'measurement', '2880 psi');
  editCardDraft(local.cards, 'CARD-03', 'finding', '复测合格');
  const outbox = [draftOp(base.revision, 'CARD-03', 'R6', true)]; // 含完成结论

  simulateAuthorize('CARD-03');
  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox,
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  const invalid = result.invalidations.filter((i) => i.cardId === 'CARD-03');
  assert(invalid.length >= 1, 'CARD-03 出现失效项');
  assertEqual(result.cards.find((c) => c.id === 'CARD-03')!.needsReconfirm, true, '工卡标记需重新确认');
  assertEqual(remote.cards.find((c) => c.id === 'CARD-03')!.status, '执行中', '服务器上授权后状态已变更');
  assert(isOpBlockedByInvalidation(outbox[0], result.invalidations), '完成操作被失效项挂起，不得直接推送');

  // 本地草稿仍然保留
  const card = result.cards.find((c) => c.id === 'CARD-03')!;
  assertEqual(card.fields.measurement.localValue, '2880 psi', '离线草稿未丢失');

  // 重新确认操作不被挂起
  const reconfirm: OutboxOp = {
    opId: 'op-reconfirm-1', type: 'reconfirm', createdAt: '10:05', attempts: 0, state: 'pending',
    baseRevision: remote.revision, cardId: 'CARD-03'
  };
  assert(!isOpBlockedByInvalidation(reconfirm, result.invalidations), '重新确认操作允许推送');
  const resp = await pushOps([reconfirm], {});
  assert(resp.ok && resp.results[0].accepted, '重新确认被服务器正式记录');
}

async function scenarioStageSign() {
  console.log('场景4：离线双方都签同一阶段 → 本地签署失效，要求重新签署');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  // 本地离线签了系统阶段
  local.signatures.find((s) => s.stage === '系统')!.pending = true;
  const signOp: OutboxOp = {
    opId: 'op-sign-local', type: 'sign', createdAt: '10:01', attempts: 0, state: 'pending',
    baseRevision: base.revision, stage: '系统'
  };

  simulateSign('系统'); // 服务器也签了
  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox: [signOp],
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  const stageInvalid = result.invalidations.find((i) => i.scope === 'stage' && i.stage === '系统');
  assert(Boolean(stageInvalid), '生成阶段失效项');
  const sig = result.signatures.find((s) => s.stage === '系统')!;
  assertEqual(sig.serverSigned, true, '承认服务器正式签署');
  assertEqual(sig.needsResign, true, '本地签署标记需重签');
}

async function scenarioRelease() {
  console.log('场景5：离线期间工作包被放行 → 本地结论失效、编辑被服务器拒绝');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  editCardDraft(local.cards, 'CARD-02', 'finding', '离线补充发现');
  const outbox = [draftOp(base.revision, 'CARD-02', 'R7')];

  simulateRelease();
  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox,
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  assert(result.invalidations.some((i) => i.scope === 'package'), '生成包级放行失效项');
  assert(isOpBlockedByInvalidation(outbox[0], result.invalidations), '本地编辑被失效项挂起');

  // 即使绕过挂起直接推送，服务器也按只读基线拒绝
  const resp = await pushOps([{ ...outbox[0], baseRevision: remote.revision }], { 'CARD-02': { finding: '离线补充发现' } });
  assert(resp.ok && !resp.results[0].accepted && /只读|放行/.test(resp.results[0].reason ?? ''), '服务器以只读放行基线拒绝编辑');
}

async function scenarioRevisionBump() {
  console.log('场景6：离线期间工卡版本修订 → 按版本判定结论失效');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  editCardDraft(local.cards, 'CARD-03', 'measurement', '2870 psi');
  const outbox = [draftOp(base.revision, 'CARD-03', 'R6')];

  simulateRevise('CARD-03', 'R8', '≥ 2900 psi / 10 min');
  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox,
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  assertEqual(result.cards.find((c) => c.id === 'CARD-03')!.revision, 'R8', '工卡静态信息随服务器升级到 R8');
  assertEqual(result.cards.find((c) => c.id === 'CARD-03')!.needsReconfirm, true, '版本升级后要求重新确认');
  assert(result.invalidations.some((i) => i.cardId === 'CARD-03'), '生成版本失效项');

  // 旧版本基线的推送被服务器拒绝
  const resp = await pushOps(outbox, { 'CARD-03': { measurement: '2870 psi' } });
  assert(resp.ok && !resp.results[0].accepted && /版本/.test(resp.results[0].reason ?? ''), '服务器拒绝旧版本操作');
}

async function scenarioFailureKeepsDraftAndIdempotent() {
  console.log('场景7：推送 500 → 草稿与队列保留；重试同一 opId 不重复落账');
  resetServer();
  const base = await fetchSnapshot();
  const op = draftOp(base.revision, 'CARD-02', 'R7');
  setFailNextPush(true);
  const first = await pushOps([op], { 'CARD-02': { measurement: '0.20 mm' } });
  assert(first.ok === false && first.status === 500, '第一次推送返回 500');

  const serverAfterFailure = await fetchSnapshot();
  assertEqual(serverAfterFailure.cards.find((c) => c.id === 'CARD-02')!.measurement, '', '失败未写入正式记录');

  // 响应丢失场景：服务器其实已落账，重试同一 opId 必须幂等
  const accepted = await pushOps([op], { 'CARD-02': { measurement: '0.20 mm' } });
  assert(accepted.ok && accepted.results[0].accepted, '重试成功');
  const retry = await pushOps([op], { 'CARD-02': { measurement: '0.20 mm' } });
  assert(retry.ok && retry.results[0].accepted, '同 opId 重放仍返回成功');
  const server = await fetchSnapshot();
  const editEvents = server.events.filter((e) => e.type === 'edit' && e.cardId === 'CARD-02');
  assertEqual(editEvents.length, 1, '服务器只产生 1 条正式事件（无重复落账）');
  assertEqual(server.cards.find((c) => c.id === 'CARD-02')!.measurement, '0.20 mm', '正式记录为本地值');
}

async function scenarioServerOnlyChangeWins() {
  console.log('场景8：只有服务器改、本地没改 → 以正式记录为准（来源裁决而非后到覆盖）');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  simulateConcurrentEdit('CARD-08', 'finding', '趋势已关闭');
  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox: [],
    base, remote, seenEventIds: base.events.map((e) => e.id), existingConflicts: []
  });
  const card = result.cards.find((c) => c.id === 'CARD-08')!;
  assertEqual(card.fields.finding.value, '趋势已关闭', '采用服务器值');
  assertEqual(card.fields.finding.source, 'server', '来源标记 server');
  assertEqual(result.conflicts.length, 0, '不产生冲突');
}

async function scenarioMigration() {
  console.log('场景9：旧版本地数据迁移后继续能用');
  const legacy = JSON.stringify({
    cards: [
      { id: 'CARD-01', title: '旧工卡', zone: 'Z1', revision: 'R3', estimated: 1, dependencies: [], tolerance: 'x', evidence: 'y', witness: 'z', status: '执行中', measurement: '1.1 mm', finding: '', stage: '机械签署' }
    ],
    activeCardId: 'CARD-01',
    syncVersion: 5,
    serverVersion: 6,
    offline: true,
    lastSaved: '08:00',
    signatures: [{ stage: '机械', status: '已签署', actor: '赵明', time: '07:50' }],
    audit: [{ time: '07:50', actor: '赵明', action: '完成工卡', detail: '旧记录' }]
  });
  const migrated = migratePersisted(legacy);
  assert(Boolean(migrated), '迁移成功');
  assertEqual(migrated!.schemaVersion, 2, 'schema 升级到 v2');
  assertEqual(migrated!.cards[0].fields.measurement.value, '1.1 mm', '旧测量值保留');
  assertEqual(migrated!.cards[0].fields.measurement.source, 'server', '旧值作为已同步基线');
  assertEqual(migrated!.cards[0].fields.measurement.localValue, null, '迁移后无虚假本地草稿');
  assertEqual(migrated!.signatures[0].serverSigned, true, '旧签署迁移为正式签署');
  assertEqual(migrated!.audit.length, 1, '旧审计保留');
  assertEqual(migrated!.audit[0].key.startsWith('legacy:'), true, '旧审计补稳定键');

  assertEqual(migratePersisted('{bad json'), null, '损坏数据安全回退');
  assertEqual(migratePersisted(null), null, '无数据返回 null');

  // v2 往返
  const roundtrip = migratePersisted(JSON.stringify(migrated));
  assertEqual(roundtrip!.cards.length, 1, 'v2 数据可直接继续使用');
}

async function scenarioOwnSignAccepted() {
  console.log('场景10：本机离线签署被服务器接收 → 不产生失效项、不要求重签');
  resetServer();
  const base = await fetchSnapshot();
  const local = localSetup(base);
  local.signatures.find((s) => s.stage === '系统')!.pending = true;
  const signOp: OutboxOp = {
    opId: 'op-sign-own', type: 'sign', createdAt: '10:01', attempts: 0, state: 'pending',
    baseRevision: base.revision, stage: '系统'
  };
  const resp = await pushOps([signOp], {});
  assert(resp.ok && resp.results[0].accepted, '签署被接收');
  const ownEventId = resp.ok ? resp.results[0].eventId : undefined;

  const remote = await fetchSnapshot();
  const result = mergeSnapshot({
    cards: local.cards, signatures: local.signatures, outbox: [signOp],
    base, remote, seenEventIds: [...base.events.map((e) => e.id), ownEventId!], existingConflicts: []
  });
  assertEqual(result.invalidations.filter((i) => i.scope === 'stage').length, 0, '无阶段失效项');
  const sig = result.signatures.find((s) => s.stage === '系统')!;
  assertEqual(sig.serverSigned, true, '承认正式签署');
  assertEqual(sig.needsResign, false, '不要求重签');
}

async function main() {
  await scenarioOfflineEditMerges();
  await scenarioFieldConflict();
  await scenarioAuthorizeInvalidates();
  await scenarioStageSign();
  await scenarioRelease();
  await scenarioRevisionBump();
  await scenarioFailureKeepsDraftAndIdempotent();
  await scenarioServerOnlyChangeWins();
  await scenarioMigration();
  await scenarioOwnSignAccepted();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

void main();

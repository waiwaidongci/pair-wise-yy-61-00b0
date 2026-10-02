import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Tab,
  TabList,
  Tag,
  Textarea,
  webLightTheme
} from '@fluentui/react-components';
import {
  AlertRegular,
  ArrowDownloadRegular,
  ArrowSyncRegular,
  BookOpenRegular,
  CheckmarkCircleRegular,
  ClipboardTaskListLtrRegular,
  CloudArrowUpRegular,
  CloudOffRegular,
  DocumentBulletListRegular,
  GaugeRegular,
  HistoryRegular,
  LockClosedRegular,
  NavigationRegular,
  PeopleRegular,
  PlugConnectedRegular,
  WarningRegular
} from '@fluentui/react-icons';
import {
  bootstrap,
  completeCard,
  demoScenario,
  discardOp,
  dismissMessage,
  releasePackage,
  requestReconfirm,
  resolveFieldConflict,
  resolveInvalidation,
  retryRejectedOp,
  runSync,
  saveDraft,
  selectCard,
  signStage,
  toggleOffline,
  type RootState,
  type AppDispatch
} from './store';
import { FIELD_LABELS, type FieldName } from './sync/types';

type NavItem = { path: string; label: string; icon: ReactNode };

function Shell({ children }: { children: ReactNode }) {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const nav: NavItem[] = [
    { path: '/', label: '工作包总览', icon: <ClipboardTaskListLtrRegular /> },
    { path: '/execution', label: '工卡执行', icon: <BookOpenRegular /> },
    { path: '/sync', label: '同步中心', icon: <ArrowSyncRegular /> },
    { path: '/release', label: '放行审阅', icon: <LockClosedRegular /> },
    { path: '/audit', label: '审计与差异', icon: <HistoryRegular /> }
  ];
  const pendingCount = state.outbox.filter((op) => op.state === 'pending').length;
  const conflictCount = state.conflicts.length + state.invalidations.filter((item) => !item.resolved).length;
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon"><NavigationRegular /></div>
          <div><strong>航空定检执行台</strong><span>Maintenance Work Package</span></div>
        </div>
        <div className="aircraft-chip"><span>B-7891</span><strong>B737-800</strong><Badge appearance="tint" color="brand">48A 定检</Badge></div>
        <div className="header-spacer" />
        <button
          className={`sync-status ${state.offline ? 'offline' : state.syncState === 'error' ? 'error' : ''}`}
          onClick={() => navigate('/sync')}
          title="打开同步中心"
        >
          {state.offline ? <CloudOffRegular /> : <CloudArrowUpRegular />}
          <span>
            {state.offline
              ? `离线暂存 · ${pendingCount} 项待同步`
              : state.syncState === 'syncing'
                ? '合并中…'
                : `已同步 R${state.serverRevision} · ${pendingCount} 待发`}
          </span>
          {conflictCount > 0 && <Badge appearance="filled" color="danger">{conflictCount}</Badge>}
        </button>
        <div className="user-chip"><span>执行人员</span><strong>宋杰 · 机械</strong></div>
      </header>
      <div className="shell-grid">
        <aside className="side-nav">
          <div className="package-summary">
            <span>工作包</span><strong>WP-B7891-04</strong><small>上海浦东 · H3 机库</small>
            <div><ProgressBar value={0.58} /><span>58% 工卡完成 · 本地草稿自动留存</span></div>
          </div>
          <nav>{nav.map((item) => (
            <NavLink end={item.path === '/'} key={item.path} to={item.path}>
              {item.icon}
              <span>{item.label}</span>
              {item.path === '/sync' && pendingCount > 0 && <em className="nav-badge">{pendingCount}</em>}
              {item.path === '/sync' && conflictCount > 0 && <em className="nav-badge danger">{conflictCount}</em>}
            </NavLink>
          ))}</nav>
          <div className={`side-status ${state.syncState === 'error' ? 'danger' : ''}`}>
            {state.offline ? <CloudOffRegular /> : state.syncState === 'error' ? <WarningRegular /> : <PlugConnectedRegular />}
            <div>
              <strong>{state.offline ? '当前离线，数据保存在本机' : state.syncState === 'error' ? '上次同步失败，草稿已保留' : `${state.conflicts.length + state.invalidations.filter((i) => !i.resolved).length} 项冲突/失效待处理`}</strong>
              <span>{state.syncMessage || '合并按工卡版本与字段来源裁决，不做后到覆盖'}</span>
            </div>
          </div>
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><small>{eyebrow}</small><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>;
}

function Overview() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const completed = state.cards.filter((card) => card.status === '已完成').length;
  const blockers = state.cards.filter((card) => card.status === '待授权');
  const draftCount = state.cards.filter((card) => Object.values(card.fields).some((field) => field.localValue !== null)).length;
  const openInvalidations = state.invalidations.filter((item) => !item.resolved);
  return (
    <div className="page">
      <PageHeading
        eyebrow="WP-B7891-04 / 48A CHECK"
        title="工作包总览"
        description="监控工卡依赖、阶段签署、超差项目、离线草稿与放行门禁。"
        actions={<><Button appearance="secondary" icon={<ArrowDownloadRegular />}>导出进度</Button><Button appearance="primary" icon={<NavigationRegular />} onClick={() => navigate('/execution')}>继续执行</Button></>}
      />
      {blockers.length > 0 && <MessageBar intent="warning" className="top-message"><MessageBarBody><strong>放行阻断：</strong>{blockers.map((card) => `${card.id} ${card.title}`).join('、')} 等待授权人员处理。</MessageBarBody></MessageBar>}
      {openInvalidations.length > 0 && <MessageBar intent="error" className="top-message"><MessageBarBody><strong>离线结论失效：</strong>{openInvalidations.length} 项结论在离线期间被授权/签字/放行波及，必须重新确认后才能继续。</MessageBarBody><Button size="small" appearance="secondary" onClick={() => navigate('/sync')}>去处理</Button></MessageBar>}
      <div className="metrics-grid">
        {[
          ['工卡完成度', `${completed} / ${state.cards.length}`, `${Math.round(completed / Math.max(state.cards.length, 1) * 100)}%`, 'green'],
          ['本地草稿', String(draftCount), `${state.outbox.filter((op) => op.state === 'pending').length} 项操作待同步`, 'blue'],
          ['开放冲突', String(state.conflicts.length), '按字段来源逐项裁决', 'amber'],
          ['失效待确认', String(openInvalidations.length), openInvalidations.length ? '授权/签字/放行后必须重确认' : '暂无', 'red']
        ].map((item) => <div className="metric-card" key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small className={item[3]}>{item[2]}</small></div>)}
      </div>
      <div className="overview-grid">
        <section className="panel task-panel">
          <div className="panel-head"><div><h2>关键工卡与依赖</h2><span>按执行依赖和风险排序，版本/来源实时合并</span></div><Badge appearance="tint">WP R{state.serverRevision}</Badge></div>
          {state.cards.map((card, index) => {
            const hasDraft = Object.values(card.fields).some((field) => field.localValue !== null);
            return (
              <button key={card.id} className={`task-row ${state.activeCardId === card.id ? 'active' : ''}`} onClick={() => { dispatch(selectCard(card.id)); navigate('/execution'); }}>
                <span className={`task-index ${card.status === '已完成' ? 'done' : card.status === '待授权' ? 'blocked' : ''}`}>{card.status === '已完成' ? <CheckmarkCircleRegular /> : index + 1}</span>
                <span className="task-main">
                  <strong>{card.id} · {card.title} {card.needsReconfirm && <Tag size="extra-small" appearance="filled" color="danger">结论失效</Tag>}</strong>
                  <small>{card.zone} · 版本 {card.revision} · 依赖 {card.dependencies.length ? card.dependencies.join('、') : '无'} · 计划 {card.estimated}h {hasDraft && '· 有本地草稿'}</small>
                </span>
                <Tag appearance="outline" size="small">{card.stage}</Tag>
                <Badge appearance="tint" color={card.status === '已完成' ? 'success' : card.status === '待授权' ? 'danger' : card.status === '执行中' ? 'brand' : 'informative'}>{card.status}{hasDraft ? ' · 本地暂存' : ''}</Badge>
              </button>
            );
          })}
        </section>
        <aside className="overview-side">
          <section className="panel stage-panel">
            <div className="panel-head"><h2>阶段签字</h2><PeopleRegular /></div>
            {state.signatures.map((item) => (
              <div className="signature-row" key={item.stage}>
                <span className={item.serverSigned ? 'signed' : ''}>{item.serverSigned ? <CheckmarkCircleRegular /> : item.needsResign ? <WarningRegular /> : item.stage.slice(0, 1)}</span>
                <div><strong>{item.stage}签署{item.pending && <em className="pending-flag">待同步</em>}{item.needsResign && <em className="invalid-flag">需重签</em>}</strong><small>{item.actor} · {item.time}</small></div>
              </div>
            ))}
          </section>
          <section className="panel dependency-panel">
            <div className="panel-head"><h2>依赖路径</h2><GaugeRegular /></div>
            <div className="dependency-graph"><span>CARD-01</span><i /><span>CARD-02</span><i /><span className="critical">CARD-03</span><i /><span>CARD-07</span><i /><span>CARD-08</span></div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, { text: string; tone: 'success' | 'brand' | 'warning' | 'danger' }> = {
  server: { text: '服务器正式记录', tone: 'success' },
  local: { text: '本地草稿', tone: 'brand' },
  both: { text: '双方各有更新', tone: 'warning' },
  conflict: { text: '字段冲突待裁决', tone: 'danger' }
};

function SourceTag({ card, field }: { card: RootState['maintenance']['cards'][number]; field: FieldName }) {
  const meta = card.fields[field];
  const label = SOURCE_LABEL[meta.resolved && meta.localValue !== null ? 'local' : meta.source];
  return <Tag size="extra-small" appearance={label.tone === 'success' ? 'outline' : 'filled'} color={label.tone}>{label.text}</Tag>;
}

function Execution() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch<AppDispatch>();
  const card = state.cards.find((item) => item.id === state.activeCardId) ?? state.cards[0];
  const [consumable, setConsumable] = useState('');
  const [witness, setWitness] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  if (!card) return null;
  const needsReconfirm = card.needsReconfirm;
  const toleranceIssue = card.id === 'CARD-03' && Number.parseFloat(card.fields.measurement.value) < 2850;
  const dependenciesMet = card.dependencies.every((dependency) => state.cards.find((item) => item.id === dependency)?.status === '已完成');
  const fieldConflict = state.conflicts.find((item) => item.kind === 'field-diverge' && item.cardId === card.id);

  const editField = (field: FieldName, value: string) => dispatch(saveDraft({ cardId: card.id, field, value }));

  const complete = () => {
    if (!dependenciesMet || toleranceIssue || !witness || needsReconfirm || fieldConflict) return;
    dispatch(completeCard({ cardId: card.id }));
    if (!state.offline) void dispatch(runSync());
  };

  return (
    <div className="page">
      <PageHeading
        eyebrow={`${card.id} / ${card.stage}`}
        title={card.title}
        description={`${card.zone} · 工卡版本 ${card.revision} · 预计 ${card.estimated} 小时 · ${state.offline ? '离线填写只入本地草稿' : '在线填写将在同步时合并'}`}
        actions={
          <>
            <Button appearance="secondary" icon={state.offline ? <PlugConnectedRegular /> : <CloudOffRegular />} onClick={() => dispatch(toggleOffline())}>{state.offline ? '恢复在线' : '模拟断网'}</Button>
            <Button appearance="primary" icon={<CheckmarkCircleRegular />} onClick={complete} disabled={needsReconfirm || Boolean(fieldConflict)}>完成并提交</Button>
          </>
        }
      />
      {needsReconfirm && (
        <MessageBar intent="error" className="top-message">
          <MessageBarBody><strong>结论已失效，必须重新确认：</strong>离线期间该工卡被授权、版本修订或包被放行，服务器正式记录已变化。本地测量值/发现/证据草稿保留，请核对后重新确认。</MessageBarBody>
          <Button size="small" appearance="primary" onClick={() => { dispatch(requestReconfirm({ cardId: card.id })); state.invalidations.filter((i) => i.cardId === card.id).forEach((i) => dispatch(resolveInvalidation({ id: i.id }))); if (!state.offline) void dispatch(runSync()); }}>重新确认结论</Button>
        </MessageBar>
      )}
      {fieldConflict && (
        <MessageBar intent="warning" className="top-message">
          <MessageBarBody><strong>{FIELD_LABELS[fieldConflict.field ?? 'measurement']}存在字段冲突：</strong>服务器值「{fieldConflict.serverValue}」与本地草稿「{fieldConflict.localValue}」不同，系统未做覆盖。</MessageBarBody>
        </MessageBar>
      )}
      <div className="execution-grid">
        <section className="panel card-editor">
          <div className="panel-head">
            <div><h2>工卡执行内容</h2><span>执行人员记录关键数据及证据；断网可继续填写，恢复后按版本与字段来源合并</span></div>
            <Badge appearance="tint" color={card.status === '待授权' ? 'danger' : 'brand'}>{card.status}</Badge>
          </div>
          <div className="procedure-block">
            <h3>施工步骤</h3>
            {['确认飞机断电并设置 DO NOT OPERATE 警告牌。', '连接校准合格的测试设备，按 AMM 29-10-00 执行压力保持测试。', '记录稳定压力值，检查 10 分钟内压降。', '恢复系统构型，目视检查渗漏并上传证据。'].map((step, index) => <label key={step} className="procedure-step"><Checkbox defaultChecked={index < 2} /><span><b>{index + 1}.</b> {step}</span></label>)}
          </div>
          <Divider />
          <div className="form-grid">
            <Field label={<span>测量值 <SourceTag card={card} field="measurement" /></span>} hint={card.tolerance} validationState={toleranceIssue ? 'error' : 'none'} validationMessage={toleranceIssue ? '低于最低接受值 2850 psi' : undefined}>
              <Input value={card.fields.measurement.value} onChange={(_, data) => editField('measurement', data.value)} contentBefore={<GaugeRegular />} />
            </Field>
            <Field label="耗材 / 航材"><Input value={consumable} onChange={(_, data) => setConsumable(data.value)} placeholder="输入件号或耗材批次" /></Field>
            <Field label={<span>发现与处置 <SourceTag card={card} field="finding" /></span>} className="wide-field">
              <Textarea value={card.fields.finding.value} onChange={(_, data) => editField('finding', data.value)} resize="vertical" placeholder="正常或填写缺陷、处置措施" />
            </Field>
            <Field label={<span>证据说明 <SourceTag card={card} field="evidenceNote" /></span>} hint="断网期间可继续填写，网络恢复后与正式记录合并" className="wide-field">
              <Textarea value={card.fields.evidenceNote.value} onChange={(_, data) => editField('evidenceNote', data.value)} resize="vertical" placeholder="记录照片、测试记录、报告的编号与说明" />
            </Field>
            <Field label="证据附件" className="wide-field"><div className="upload-zone"><CloudArrowUpRegular /><strong>拖入照片、测试记录或报告</strong><span>已关联 3 个证据 · 支持 JPG / PDF / TXT · 说明离线可填</span></div></Field>
          </div>
          <label className="witness-check"><Checkbox checked={witness} onChange={(_, data) => setWitness(Boolean(data.checked))} /><span><strong>见证人已现场确认</strong><small>要求：{card.witness}</small></span></label>
          {!dependenciesMet && <div className="inline-error">前置工卡 {card.dependencies.join('、')} 尚未完成。</div>}
          {toleranceIssue && <div className="inline-error">测量值超出容差，必须由授权人员处理。</div>}
        </section>
        <aside className="execution-side">
          <section className="panel card-meta">
            <div className="panel-head"><h2>工卡信息</h2><DocumentBulletListRegular /></div>
            <dl>
              <div><dt>工卡版本</dt><dd>{card.revision}（合并按版本判定）</dd></div>
              <div><dt>容差</dt><dd>{card.tolerance}</dd></div>
              <div><dt>证据要求</dt><dd>{card.evidence}</dd></div>
              <div><dt>前置条件</dt><dd>{card.dependencies.length ? card.dependencies.join('、') : '无'}</dd></div>
              <dt>字段来源</dt>
              {(['measurement', 'finding', 'evidenceNote'] as FieldName[]).map((field) => (
                <div key={field} className="source-line"><dt>{FIELD_LABELS[field]}</dt><dd><SourceTag card={card} field={field} /></dd></div>
              ))}
            </dl>
          </section>
          {card.status === '待授权' && <section className="panel override-panel"><WarningRegular /><h3>超差项目等待授权</h3><p>原始测量值已保留。授权在服务器正式记录上进行；离线期间若被授权，本机完成结论会失效并要求重新确认。</p><Button appearance="primary" onClick={() => setOverrideOpen(true)}>授权处理（模拟授权人）</Button></section>}
          <section className="panel evidence-panel">
            <div className="panel-head"><h2>证据附件</h2><Badge appearance="tint">3 项</Badge></div>
            {['IMG_20260929_0904.jpg', '液压测试原始记录.pdf', '见证签字单_宋杰.pdf'].map((file, index) => <div className="evidence-row" key={file}><DocumentBulletListRegular /><div><strong>{file}</strong><small>{index + 1}.8 MB · 09:1{index}</small></div><Button size="small" appearance="subtle">预览</Button></div>)}
          </section>
        </aside>
      </div>
      <Dialog open={overrideOpen} onOpenChange={(_, data) => setOverrideOpen(data.open)}>
        <DialogSurface><DialogBody>
          <DialogTitle>超差授权处理</DialogTitle>
          <DialogContent>授权写在服务器正式记录上。为演示离线授权，将在服务器上批准 CARD-03，之后执行侧结论失效并需重新确认。</DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setOverrideOpen(false)}>取消</Button>
            <Button appearance="primary" onClick={() => { void dispatch(demoScenario({ kind: 'authorize', cardId: card.id })); setOverrideOpen(false); }}>确认授权（写入服务器）</Button>
          </DialogActions>
        </DialogBody></DialogSurface>
      </Dialog>
    </div>
  );
}

function Release() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch<AppDispatch>();
  const [tab, setTab] = useState('open');
  const blockers = state.cards.filter((card) => card.status !== '已完成' && card.status !== '未开始');
  const allSigned = state.signatures.every((item) => item.serverSigned);
  const openInvalidations = state.invalidations.filter((item) => !item.resolved);
  return (
    <div className="page">
      <PageHeading
        eyebrow="RELEASE REVIEW / B-7891"
        title="放行审阅"
        description="核对未关闭项目、重复缺陷、关键证据与阶段签字；离线期间被授权/签字/放行会使受影响结论失效。"
        actions={<Button appearance="primary" icon={<LockClosedRegular />} disabled={!allSigned || blockers.some((card) => card.status === '待授权') || openInvalidations.length > 0} onClick={() => { dispatch(releasePackage()); if (!state.offline) void dispatch(runSync()); }}>{state.released ? '工作包已锁定（正式只读）' : '锁定并放行'}</Button>}
      />
      {state.released && <MessageBar intent="success" className="top-message"><MessageBarBody>工作包已锁定，形成只读放行基线并纳入审计记录。</MessageBarBody></MessageBar>}
      {openInvalidations.some((item) => item.scope === 'stage' || item.scope === 'package') && (
        <MessageBar intent="error" className="top-message"><MessageBarBody><strong>签字/放行结论失效：</strong>离线期间服务器已有正式签署或放行，相关本地结论必须重新签署确认。</MessageBarBody></MessageBar>
      )}
      <div className="release-grid">
        <section className="panel release-main">
          <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(String(data.value))}>
            <Tab value="open">未关闭项目 <Badge>{blockers.length}</Badge></Tab>
            <Tab value="repeat">重复缺陷 <Badge>2</Badge></Tab>
            <Tab value="evidence">关键证据 <Badge>12</Badge></Tab>
          </TabList>
          <div className="tab-body">
            {tab === 'open' && blockers.map((card) => (
              <div className="review-item" key={card.id}>
                <span className={`risk-icon ${card.status === '待授权' ? 'danger' : ''}`}><AlertRegular /></span>
                <div>
                  <strong>{card.id} · {card.title} {card.needsReconfirm && <Tag size="extra-small" appearance="filled" color="danger">需重新确认</Tag>}</strong>
                  <p>{card.fields.finding.value || '工卡正在执行，完成后需由放行人员复核。'}</p>
                  <small>{card.zone} · 版本 {card.revision} · 负责人 宋杰 · 要求证据 {card.evidence}</small>
                </div>
                <Badge appearance="tint" color={card.status === '待授权' ? 'danger' : 'warning'}>{card.status}</Badge>
              </div>
            ))}
            {tab === 'repeat' && (
              <>
                <div className="review-item"><span className="risk-icon danger"><HistoryRegular /></span><div><strong>液压系统压力偏低 · 第 3 次记录</strong><p>2026-08-16、09-02、09-29 均在系统 A 出现压力低于目标值。</p><small>建议移交可靠性分析，并关联历史排故记录。</small></div><Badge appearance="tint" color="danger">关键</Badge></div>
                <div className="review-item"><span className="risk-icon"><HistoryRegular /></span><div><strong>APU 启动时间延长</strong><p>最近两次航线记录均略高于机队均值。</p><small>非放行阻塞项，建议后续监控。</small></div><Badge appearance="tint" color="warning">观察</Badge></div>
              </>
            )}
            {tab === 'evidence' && <div className="evidence-grid">{['液压系统测试记录.pdf', '发动机孔探照片_01.jpg', 'AD 执行签署页.pdf', '时寿件履历截图.png', '超差工程指令.pdf', '见证人签字单.pdf'].map((file) => <div className="evidence-tile" key={file}><DocumentBulletListRegular /><strong>{file}</strong><span>已绑定工卡 · 已核验</span></div>)}</div>}
          </div>
        </section>
        <aside className="release-side">
          <section className="panel signoff-card">
            <div className="panel-head"><h2>分阶段签字</h2><span>{state.signatures.filter((item) => item.serverSigned).length} / 4 正式签署</span></div>
            {state.signatures.map((item) => (
              <div className="signoff-row" key={item.stage}>
                <div><span>{item.stage}{item.needsResign && <em className="invalid-flag">离线签署失效</em>}</span><strong>{item.actor}</strong><small>{item.time}{item.pending && ' · 本地待同步'}</small></div>
                {item.serverSigned
                  ? <Badge appearance="tint" color="success">{item.needsResign ? '需重新确认' : '已正式签署'}</Badge>
                  : <Button size="small" appearance="primary" onClick={() => { dispatch(signStage({ stage: item.stage })); if (!state.offline) void dispatch(runSync()); }}>签署</Button>}
              </div>
            ))}
          </section>
          <section className="panel release-gate-card">
            <LockClosedRegular /><h3>放行门禁</h3>
            <label><Checkbox checked={!blockers.some((card) => card.status === '待授权')} readOnly /> 无待授权超差项目</label>
            <label><Checkbox checked={state.cards.filter((card) => card.status === '已完成').length >= 6} readOnly /> 关键工卡完成率 ≥ 75%</label>
            <label><Checkbox checked={allSigned} readOnly /> 四个阶段均完成正式电子签署</label>
            <label><Checkbox checked={openInvalidations.length === 0} readOnly /> 无离线授权/签字/放行导致的失效结论</label>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SyncCenter() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch<AppDispatch>();
  const [concurrentValue, setConcurrentValue] = useState('2905 psi（周磊复测）');

  const scenarioButtons: { label: string; kind: Parameters<typeof demoScenario>[0] }[] = [
    { label: '服务器授权 CARD-03', kind: { kind: 'authorize', cardId: 'CARD-03' } },
    { label: '服务器签署「系统」阶段', kind: { kind: 'sign', stage: '系统' } },
    { label: '服务器锁定放行工作包', kind: { kind: 'release' } },
    { label: 'CARD-03 工卡修订 R6 → R8', kind: { kind: 'revise', cardId: 'CARD-03' } },
    { label: '下次推送失败（500）', kind: { kind: 'failNext' } }
  ];

  const openConflicts = state.conflicts;
  const openInvalidations = state.invalidations.filter((item) => !item.resolved);

  return (
    <div className="page">
      <PageHeading
        eyebrow="SYNC CENTER / OFFLINE MERGE"
        title="同步中心"
        description="断网继续填工卡；网络恢复后按工卡版本与字段来源三路合并，授权/签字/放行使受影响结论失效并要求重新确认。"
        actions={
          <>
            <Button appearance="secondary" icon={state.offline ? <PlugConnectedRegular /> : <CloudOffRegular />} onClick={() => dispatch(toggleOffline())}>{state.offline ? '恢复网络' : '模拟断网'}</Button>
            <Button appearance="primary" icon={<ArrowSyncRegular />} disabled={state.offline || state.syncState === 'syncing'} onClick={() => void dispatch(runSync())}>{state.syncState === 'syncing' ? '合并中…' : '立即同步并合并'}</Button>
          </>
        }
      />

      <div className={`sync-banner ${state.offline ? 'offline' : state.syncState === 'error' ? 'error' : 'online'}`}>
        {state.offline ? <CloudOffRegular /> : state.syncState === 'error' ? <WarningRegular /> : <CloudArrowUpRegular />}
        <div>
          <strong>{state.offline ? '当前离线：测量值、发现、证据说明均保存在本地草稿' : state.syncState === 'error' ? '同步失败：本地草稿与冲突项完整保留' : `在线：本地基线 R${state.baseRevision} / 服务器 R${state.serverRevision}`}</strong>
          <span>{state.syncMessage || '重试使用原操作幂等键，不会重复写审计记录。'}</span>
        </div>
        {state.syncState === 'error' && <Button size="small" appearance="primary" onClick={() => void dispatch(runSync())}>重试</Button>}
        {state.syncMessage && state.syncState !== 'syncing' && <Button size="small" appearance="subtle" onClick={() => dispatch(dismissMessage())}>知道了</Button>}
      </div>

      <div className="sync-grid">
        <div className="sync-col">
          <section className="panel">
            <div className="panel-head"><div><h2>本地发件箱（{state.outbox.length}）</h2><span>离线操作按幂等键排队；失败重试不重复落账</span></div></div>
            {state.outbox.length === 0 && <div className="empty-note">没有待同步操作。断网时填写工卡会自动进入发件箱。</div>}
            {state.outbox.map((op) => (
              <div className={`outbox-row ${op.state === 'rejected' ? 'rejected' : ''}`} key={op.opId}>
                <div>
                  <strong>
                    {op.type === 'card-edit' ? `工卡更新 ${op.cardId}${op.complete ? ' · 完成' : ''}` : op.type === 'sign' ? `${op.stage}阶段签署` : op.type === 'release' ? '锁定放行' : `重新确认 ${op.cardId}`}
                    {op.state === 'rejected' && <em className="invalid-flag">被拒绝</em>}
                  </strong>
                  <small>opId {op.opId} · 依据版本 R{op.baseRevision} · 尝试 {op.attempts} 次{op.lastError ? ` · ${op.lastError}` : ''}</small>
                </div>
                {op.state === 'rejected'
                  ? <span className="row-actions"><Button size="small" appearance="primary" onClick={() => { dispatch(retryRejectedOp({ opId: op.opId })); void dispatch(runSync()); }}>按新版本重试</Button><Button size="small" appearance="subtle" onClick={() => dispatch(discardOp({ opId: op.opId }))}>放弃草稿</Button></span>
                  : <Tag size="extra-small">{state.offline ? '等待联网' : '待推送'}</Tag>}
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="panel-head"><div><h2>冲突项（{openConflicts.length}）</h2><span>不按后到覆盖，逐项按字段来源裁决</span></div></div>
            {openConflicts.length === 0 && <div className="empty-note">暂无冲突。字段双方都被修改且值不同时会在此列出。</div>}
            {openConflicts.map((conflict) => (
              <div className="conflict-row" key={conflict.id}>
                {conflict.kind === 'field-diverge' ? (
                  <>
                    <div><strong>{conflict.title}</strong><p>{conflict.detail}</p><small>{conflict.reason}</small>
                      <div className="value-compare"><span className="local">本地：{conflict.localValue}</span><span className="server">服务器：{conflict.serverValue}</span></div>
                    </div>
                    <span className="row-actions">
                      <Button size="small" appearance="primary" onClick={() => { dispatch(resolveFieldConflict({ conflictId: conflict.id, choice: 'local' })); if (!state.offline) void dispatch(runSync()); }}>保留本地并推送</Button>
                      <Button size="small" appearance="secondary" onClick={() => dispatch(resolveFieldConflict({ conflictId: conflict.id, choice: 'server' }))}>采用服务器值</Button>
                    </span>
                  </>
                ) : (
                  <>
                    <div><strong>{conflict.title}</strong><p>{conflict.detail}</p></div>
                    <span className="row-actions"><Button size="small" appearance="primary" onClick={() => { dispatch(retryRejectedOp({ opId: conflict.opId! })); void dispatch(runSync()); }}>修订后重试</Button><Button size="small" appearance="subtle" onClick={() => dispatch(discardOp({ opId: conflict.opId! }))}>放弃</Button></span>
                  </>
                )}
              </div>
            ))}
          </section>
        </div>

        <div className="sync-col">
          <section className="panel">
            <div className="panel-head"><div><h2>失效结论与重新确认（{openInvalidations.length}）</h2><span>离线期间授权、阶段签字或放行后，受影响结论先失效</span></div></div>
            {openInvalidations.length === 0 && <div className="empty-note">暂无失效结论。授权/签字/放行事件发生在离线期间时会在此列出。</div>}
            {state.invalidations.map((invalid) => (
              <div className={`invalid-row ${invalid.resolved ? 'resolved' : ''}`} key={invalid.id}>
                <WarningRegular />
                <div>
                  <strong>{invalid.title}{invalid.resolved && <em className="pending-flag">已重新确认</em>}</strong>
                  <p>{invalid.detail}</p>
                  <small>{invalid.reason} · 事件 {invalid.eventId} · {invalid.time}</small>
                </div>
                {!invalid.resolved && (
                  invalid.scope === 'card'
                    ? <Button size="small" appearance="primary" onClick={() => { dispatch(requestReconfirm({ cardId: invalid.cardId! })); dispatch(resolveInvalidation({ id: invalid.id })); if (!state.offline) void dispatch(runSync()); }}>重新确认</Button>
                    : invalid.scope === 'stage'
                      ? <Button size="small" appearance="primary" onClick={() => { dispatch(signStage({ stage: invalid.stage! })); dispatch(resolveInvalidation({ id: invalid.id })); if (!state.offline) void dispatch(runSync()); }}>重新签署</Button>
                      : <Button size="small" appearance="secondary" onClick={() => dispatch(resolveInvalidation({ id: invalid.id }))}>已知悉（只读基线）</Button>
                )}
              </div>
            ))}
          </section>

          <section className="panel sim-panel">
            <div className="panel-head"><div><h2>服务器情景模拟</h2><span>模拟“断网期间他人在正式记录上的动作”，恢复后同步即可观察合并裁决</span></div></div>
            <div className="sim-buttons">
              {scenarioButtons.map((item) => <Button key={item.label} size="small" appearance="outline" onClick={() => void dispatch(demoScenario(item.kind))}>{item.label}</Button>)}
            </div>
            <Divider />
            <div className="sim-concurrent">
              <Field label="他人在服务器同改 CARD-03 测量值" hint="制造字段双方修改、值不同的冲突"><Input value={concurrentValue} onChange={(_, data) => setConcurrentValue(data.value)} /></Field>
              <Button size="small" appearance="secondary" onClick={() => void dispatch(demoScenario({ kind: 'concurrent', cardId: 'CARD-03', field: 'measurement', value: concurrentValue }))}>写入并发修改</Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Audit() {
  const state = useSelector((root: RootState) => root.maintenance);
  const downloadAudit = () => {
    const csv = ['时间,操作者,动作,说明', ...state.audit.map((item) => [item.time, item.actor, item.action, item.detail].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'B7891-48A-audit.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const diffs = useMemo(() => [
    { card: 'CARD-03', field: '容差', from: '≥ 2800 psi / 10 min', to: '≥ 2850 psi / 10 min', reason: 'AMM 临时修订 TR-114（服务器再修订 R8 → ≥ 2900 psi）' },
    { card: 'CARD-07', field: '依赖', from: 'CARD-02', to: 'CARD-03', reason: '试车前置条件调整' },
    { card: 'CARD-08', field: '证据', from: '近 2 次记录', to: '近 3 次记录', reason: '可靠性复核要求' }
  ], []);
  return (
    <div className="page">
      <PageHeading eyebrow="AUDIT / VERSION CONTROL" title="审计与版本差异" description="对比工卡版本、查看操作历史；同步合并与重试均幂等，同一操作只保留一条正式审计。" actions={<Button appearance="primary" icon={<ArrowDownloadRegular />} onClick={downloadAudit}>导出审计记录</Button>} />
      <div className="audit-grid">
        <section className="panel diff-panel">
          <div className="panel-head"><div><h2>工卡版本差异</h2><span>合并以服务器正式记录的工卡版本为准</span></div><Badge appearance="tint">当前 R{state.serverRevision}</Badge></div>
          <div className="diff-table"><div className="diff-head"><span>工卡</span><span>字段</span><span>原值</span><span>新值 / 原因</span></div>{diffs.map((diff) => <div className="diff-row" key={`${diff.card}-${diff.field}`}><strong>{diff.card}</strong><span>{diff.field}</span><del>{diff.from}</del><div><ins>{diff.to}</ins><small>{diff.reason}</small></div></div>)}</div>
        </section>
        <section className="panel audit-panel">
          <div className="panel-head"><div><h2>完整审计时间线</h2><span>{state.audit.length} 条（按稳定键去重）</span></div><HistoryRegular /></div>
          {state.audit.length === 0 && <div className="empty-note">暂无本地审计。离线暂存、同步合并、重新确认都会记录在这里。</div>}
          {state.audit.map((item) => <div className="audit-row" key={item.key}><span className="timeline-dot" /><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.time} · {item.actor}</small></div></div>)}
        </section>
      </div>
    </div>
  );
}

function NotFound() {
  return <Navigate to="/" replace />;
}

export default function App() {
  const dispatch = useDispatch<AppDispatch>();
  useEffect(() => { void dispatch(bootstrap()); }, [dispatch]);
  return (
    <FluentProvider theme={webLightTheme}>
      <BrowserRouter>
        <Shell><Routes><Route path="/" element={<Overview />} /><Route path="/execution" element={<Execution />} /><Route path="/sync" element={<SyncCenter />} /><Route path="/release" element={<Release />} /><Route path="/audit" element={<Audit />} /><Route path="*" element={<NotFound />} /></Routes></Shell>
      </BrowserRouter>
    </FluentProvider>
  );
}

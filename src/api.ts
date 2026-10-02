import { createApi } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import type { AuthoritativeAction, FieldKey } from './merge';

export type WorkCard = {
  id: string;
  title: string;
  zone: string;
  revision: string;
  estimated: number;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: '未开始' | '执行中' | '待授权' | '已完成';
  measurement: string;
  finding: string;
  evidenceNote: string;
  stage: string;
};

const packageData = {
  id: 'WP-B7891-04',
  aircraft: 'B-7891',
  type: 'B737-800',
  check: '48A 定检',
  station: '上海浦东 · H3 机库',
  plannedStart: '2026-09-28 06:00',
  plannedEnd: '2026-09-30 18:00',
  revision: 'WP R7',
  serverRevision: 7,
  tasks: [
    { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', revision: 'R7', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', evidenceNote: '', stage: '机械签署' },
    { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', revision: 'R7', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', evidenceNote: '', stage: '发动机签署' },
    { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', revision: 'R6', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', evidenceNote: '', stage: '系统签署' },
    { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', revision: 'R7', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', evidenceNote: '', stage: '适航签署' },
    { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', revision: 'R7', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', evidenceNote: '', stage: '适航签署' },
    { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', revision: 'R7', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', evidenceNote: '', stage: '客舱签署' },
    { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', revision: 'R5', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', evidenceNote: '', stage: '动力签署' },
    { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', revision: 'R7', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', evidenceNote: '', stage: '放行签署' }
  ] as WorkCard[]
};

export type PackageResponse = typeof packageData & {
  cardRevs: Record<string, number>;
  authoritative: AuthoritativeAction[];
};

// 服务器端状态（mock）：工卡版本号与权威操作日志。
// 注意：RTK Query 在开发模式下会深冻结查询结果，因此服务器侧维护独立的可变副本，
// 查询时返回克隆对象，避免修改被冻结的对象。
let serverTasks: WorkCard[] = packageData.tasks.map((task) => ({ ...task }));
let serverCardRevs: Record<string, number> = Object.fromEntries(packageData.tasks.map((task) => [task.id, 1]));
let serverAuthoritative: AuthoritativeAction[] = [];
// 客户端进入离线时通知服务器；下次拉取正式记录时，补记离线期间发生的权威操作。
let offlineSince: string | null = null;
let lastAppliedSince: string | null = null;

export function notifyOffline(since: string | null) {
  offlineSince = since;
}

function nowIso() {
  return new Date().toISOString();
}

// 模拟离线期间服务器侧发生的权威操作：CARD-03 被授权继续、系统阶段签署、CARD-02 发动机工程师补记发现。
function applyOfflineServerChanges() {
  const at = nowIso();
  const c3 = serverTasks.find((task) => task.id === 'CARD-03');
  if (c3) {
    c3.status = '执行中';
    c3.finding = '超差已由授权人员批准，按工程指令继续';
    serverCardRevs['CARD-03'] += 1;
    serverAuthoritative.push({
      id: `auth-${at}`,
      type: 'authorize',
      cardId: 'CARD-03',
      at,
      by: '放行授权人',
      detail: '离线期间批准超差继续（EO-2026-1147），原始测量值保留'
    });
  }
  serverAuthoritative.push({
    id: `sign-${at}`,
    type: 'sign',
    stage: '系统',
    at,
    by: '系统负责人',
    detail: '离线期间完成系统阶段签署'
  });
  const c2 = serverTasks.find((task) => task.id === 'CARD-02');
  if (c2) {
    c2.finding = '孔探发现 1 处凹坑 0.2 mm，持续监控（发动机工程师离线记录）';
    serverCardRevs['CARD-02'] += 1;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mockBaseQuery: BaseQueryFn = async (arg) => {
  await delay(180);
  const isPackage = (typeof arg === 'string' && arg === 'package') ||
    (typeof arg === 'object' && arg !== null && 'url' in arg && (arg as { url: string }).url === 'package');
  if (isPackage) {
    if (offlineSince && offlineSince !== lastAppliedSince) {
      applyOfflineServerChanges();
      lastAppliedSince = offlineSince;
    }
    const data: PackageResponse = {
      ...packageData,
      tasks: serverTasks.map((task) => ({ ...task })),
      cardRevs: { ...serverCardRevs },
      authoritative: serverAuthoritative.map((action) => ({ ...action }))
    };
    return { data };
  }
  return { error: { status: 404, data: 'Not found' } };
};

export type CommitCard = {
  cardId: string;
  expectedRev: number;
  baseAt: string;
  fields: Partial<Record<FieldKey, string>>;
};

export type CommitMergeRequest = {
  mergeId: string;
  cards: CommitCard[];
};

export type CommitMergeResult = {
  results: { cardId: string; rev: number }[];
};

export const maintenanceApi = createApi({
  reducerPath: 'maintenanceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Package'],
  endpoints: (builder) => ({
    getWorkPackage: builder.query<PackageResponse, void>({
      query: () => 'package',
      providesTags: ['Package']
    }),
    submitCard: builder.mutation<{ accepted: boolean; revision: number }, { cardId: string; expectedRevision: number; measurement: string; finding: string }>({
      queryFn: async (payload) => {
        await delay(240);
        if (payload.expectedRevision !== packageData.serverRevision) {
          return { error: { status: 409, data: { message: '版本冲突：服务器已有更新，请刷新后重试。' } } };
        }
        return { data: { accepted: true, revision: packageData.serverRevision + 1 } };
      },
      invalidatesTags: ['Package']
    }),
    commitMerge: builder.mutation<CommitMergeResult, CommitMergeRequest>({
      queryFn: async (payload) => {
        await delay(320);
        if (serverAuthoritative.some((action) => action.type === 'release')) {
          return { error: { status: 403, data: { message: '工作包已放行锁定，离线草稿不再写入正式记录。' } } };
        }
        for (const card of payload.cards) {
          const task = serverTasks.find((item) => item.id === card.cardId);
          const invalidated = serverAuthoritative.some((action) => {
            if (action.at <= card.baseAt) return false;
            if (action.type === 'authorize') return action.cardId === card.cardId;
            if (action.type === 'sign') return task ? task.stage.startsWith(action.stage ?? '') : false;
            return false;
          });
          if (invalidated) {
            return {
              error: {
                status: 409,
                data: {
                  message: `${card.cardId} 离线期间存在授权或阶段签署记录，本地结论已失效，请重新确认后再合并。`,
                  cardId: card.cardId,
                  code: 'STALE'
                }
              }
            };
          }
          if (card.expectedRev !== serverCardRevs[card.cardId]) {
            return {
              error: {
                status: 409,
                data: {
                  message: `${card.cardId} 版本冲突：服务器已有更新（本地 R${card.expectedRev}，服务器 R${serverCardRevs[card.cardId]}），请重新合并。`,
                  cardId: card.cardId,
                  code: 'REV',
                  currentRev: serverCardRevs[card.cardId]
                }
              }
            };
          }
        }
        for (const card of payload.cards) {
          const task = serverTasks.find((item) => item.id === card.cardId);
          if (task) {
            if (card.fields.measurement !== undefined) task.measurement = card.fields.measurement;
            if (card.fields.finding !== undefined) task.finding = card.fields.finding;
            if (card.fields.evidenceNote !== undefined) task.evidenceNote = card.fields.evidenceNote;
          }
          serverCardRevs[card.cardId] += 1;
        }
        return { data: { results: payload.cards.map((card) => ({ cardId: card.cardId, rev: serverCardRevs[card.cardId] })) } };
      },
      invalidatesTags: ['Package']
    })
  })
});

export const { useGetWorkPackageQuery, useSubmitCardMutation, useCommitMergeMutation } = maintenanceApi;

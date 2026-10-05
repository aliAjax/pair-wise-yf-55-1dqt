import { configureStore, createSlice, current, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface PendingSource { fieldId: string; label: string; value: string; }
export interface Snapshot {
  id: string;
  versionId: string;
  label: string;
  data: Record<string, string>;
  /** 合并迁移产生的「待选」取值：新字段 id -> 两个来源字段各自的原值 */
  pending?: Record<string, { sources: PendingSource[] }>;
  /** 迁移副本指向原快照 id；原快照保持冻结，仍按合并前字段解释 */
  migratedFrom?: string;
}

export type ConflictKind = 'duplicate' | 'contradiction' | 'self';
export interface RuleConflict { id: string; kind: ConflictKind; ruleIds: string[]; summary: string; }
export interface RuleRetarget { ruleId: string; where: 'fieldId' | 'targetId'; from: string; }
export interface MergePlan {
  sourceIds: [string, string];
  sourceLabels: [string, string];
  target: FormField;
  retargets: RuleRetarget[];
  conflicts: RuleConflict[];
  /** conflictId -> 要保留的规则 id；'__none__' 表示涉及规则全部移除 */
  resolutions: Record<string, string>;
  error: string | null;
  rolledBack: boolean;
}
export interface MergeRecord {
  id: string;
  sourceLabels: [string, string];
  targetId: string;
  targetLabel: string;
  removedRuleIds: string[];
  migratedSnapshotIds: string[];
  pendingCount: number;
  createdAt: string;
}

interface SchemaState {
  versions: FormVersion[];
  rules: LinkRule[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
  mergePlan: MergePlan | null;
  mergeHistory: MergeRecord[];
  publishError: string | null;
}
type RootShape = { schema: SchemaState };

const STORAGE_KEY = 'yf55-schema-state-v2';

const initial: SchemaState = {
  activeVersionId: 'v1',
  previewVersionId: 'v2',
  versions: [
    {
      id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12',
      fields: [
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'amount', label: '申请金额', type: 'number', required: true }
      ], rules: []
    },
    {
      id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28',
      fields: [
        { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
        { id: 'name', label: '申请名称', type: 'text', required: true },
        { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
        { id: 'amount', label: '申请金额', type: 'number', required: true },
        { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false },
        { id: 'billingDate', label: '开票日期', type: 'date', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
        { id: 'r3', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'billingDate' },
        { id: 'r4', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'invoiceDate' },
        { id: 'r5', fieldId: 'department', operator: 'equals', value: '财务', effect: 'show', targetId: 'billingDate' },
        { id: 'r6', fieldId: 'invoiceDate', operator: 'notEmpty', value: '', effect: 'show', targetId: 'billingDate' }
      ]
    }
  ],
  rules: [],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } },
    { id: 's3', versionId: 'v2', label: '九月差旅报销', data: { name: '差旅报销', department: '研发', amount: '3200', invoiceDate: '2026-09-30' } },
    { id: 's4', versionId: 'v2', label: '季度投放费用', data: { name: '季度投放', department: '市场', amount: '150000', billingDate: '2026-10-08' } },
    { id: 's5', versionId: 'v2', label: '年度大会预算', data: { name: '年度大会', department: '市场', amount: '200000', invoiceDate: '2026-11-01', billingDate: '2026-11-15' } },
    { id: 's6', versionId: 'v2', label: '办公用品采购', data: { name: '办公采购', department: '财务', amount: '8000', invoiceDate: '2026-10-01', billingDate: '2026-10-01' } }
  ],
  mergePlan: null,
  mergeHistory: [],
  publishError: null
};

const effectText: Record<LinkRule['effect'], string> = { show: '显示', require: '必填' };

function retargetRules(rules: LinkRule[], sourceIds: [string, string], targetId: string): LinkRule[] {
  return rules.map((rule) => ({
    ...rule,
    fieldId: sourceIds.includes(rule.fieldId) ? targetId : rule.fieldId,
    targetId: sourceIds.includes(rule.targetId) ? targetId : rule.targetId
  }));
}

/** 改指后检测重名（完全重复）、效果冲突和自引用规则 */
export function detectConflicts(rules: LinkRule[]): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  const identityGroups = new Map<string, LinkRule[]>();
  const triggerGroups = new Map<string, LinkRule[]>();
  for (const rule of rules) {
    const identity = [rule.fieldId, rule.operator, rule.value, rule.effect, rule.targetId].join('|');
    identityGroups.set(identity, [...(identityGroups.get(identity) ?? []), rule]);
    const trigger = [rule.fieldId, rule.operator, rule.value, rule.targetId].join('|');
    triggerGroups.set(trigger, [...(triggerGroups.get(trigger) ?? []), rule]);
  }
  for (const group of identityGroups.values()) {
    if (group.length > 1) {
      const ids = group.map((rule) => rule.id);
      conflicts.push({ id: `dup:${ids.join('+')}`, kind: 'duplicate', ruleIds: ids, summary: `重名规则：${ids.join('、')} 触发条件、效果、目标完全相同，需要去重` });
    }
  }
  for (const group of triggerGroups.values()) {
    const effects = [...new Set(group.map((rule) => rule.effect))];
    if (effects.length > 1) {
      const ids = group.map((rule) => rule.id);
      conflicts.push({ id: `con:${ids.join('+')}`, kind: 'contradiction', ruleIds: ids, summary: `效果冲突：${ids.join('、')} 触发条件与目标相同，效果分别为「${effects.map((effect) => effectText[effect]).join(' / ')}」，需要二选一` });
    }
  }
  for (const rule of rules) {
    if (rule.fieldId === rule.targetId) {
      conflicts.push({ id: `self:${rule.id}`, kind: 'self', ruleIds: [rule.id], summary: `自引用：规则 ${rule.id} 合并后触发字段与目标字段相同，规则失去意义，需要移除` });
    }
  }
  return conflicts;
}

/** 生成合并方案：字段替换 + 全部规则改指 + 冲突清单 */
export function buildMergePlan(version: FormVersion, draftRules: LinkRule[], sourceIds: [string, string], target: FormField): MergePlan {
  const sources = sourceIds.map((id) => version.fields.find((field) => field.id === id));
  const sourceLabels: [string, string] = [sources[0]?.label ?? sourceIds[0], sources[1]?.label ?? sourceIds[1]];
  const mergedTarget: FormField = {
    ...target,
    required: sources.some((field) => field?.required),
    ...(target.type === 'select' ? { options: [...new Set(sources.flatMap((field) => field?.options ?? []))] } : {})
  };
  const allRules = [...version.rules, ...draftRules];
  const retargets: RuleRetarget[] = [];
  for (const rule of allRules) {
    if (sourceIds.includes(rule.fieldId)) retargets.push({ ruleId: rule.id, where: 'fieldId', from: rule.fieldId });
    if (sourceIds.includes(rule.targetId)) retargets.push({ ruleId: rule.id, where: 'targetId', from: rule.targetId });
  }
  return {
    sourceIds, sourceLabels, target: mergedTarget, retargets,
    conflicts: detectConflicts(retargetRules(allRules, sourceIds, mergedTarget.id)),
    resolutions: {}, error: null, rolledBack: false
  };
}

export type MergeOutcome = 'fromA' | 'fromB' | 'same' | 'pending' | 'empty' | 'untouched';
export interface SnapshotMergePreview { snapshot: Snapshot; outcome: MergeOutcome; value?: string; sources?: PendingSource[]; }

/** 单份快照的合并取值预演：有值优先；两边都有且不同 -> 待选并留下来源 */
export function planSnapshotMerge(snapshot: Snapshot, sourceIds: [string, string], sourceLabels: [string, string]): SnapshotMergePreview {
  const [a, b] = sourceIds;
  const valueA = snapshot.data[a];
  const valueB = snapshot.data[b];
  if (valueA === undefined && valueB === undefined) return { snapshot, outcome: 'untouched' };
  const hasA = valueA !== undefined && valueA !== '';
  const hasB = valueB !== undefined && valueB !== '';
  if (hasA && hasB) {
    if (valueA === valueB) return { snapshot, outcome: 'same', value: valueA };
    return {
      snapshot, outcome: 'pending',
      sources: [
        { fieldId: a, label: sourceLabels[0], value: valueA },
        { fieldId: b, label: sourceLabels[1], value: valueB }
      ]
    };
  }
  if (hasA) return { snapshot, outcome: 'fromA', value: valueA };
  if (hasB) return { snapshot, outcome: 'fromB', value: valueB };
  return { snapshot, outcome: 'empty' };
}

/** 生成迁移副本；原快照不被修改，仍按合并前字段解释 */
function buildMigratedSnapshot(snapshot: Snapshot, plan: MergePlan, versionId: string, preview: SnapshotMergePreview): Snapshot {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(snapshot.data)) {
    if (!plan.sourceIds.includes(key)) data[key] = value;
  }
  const migrated: Snapshot = { id: `${snapshot.id}-mg`, versionId, label: `${snapshot.label}（已迁移）`, data, migratedFrom: snapshot.id };
  if (preview.outcome === 'pending' && preview.sources) {
    migrated.pending = { [plan.target.id]: { sources: preview.sources } };
  } else if (preview.value !== undefined) {
    migrated.data[plan.target.id] = preview.value;
  }
  return migrated;
}

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const from = version.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = version.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = version.fields.splice(from, 1); version.fields.splice(to, 0, moved);
      state.mergePlan = null;
    },
    addField(state) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const id = `field-${Date.now()}`;
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
      state.mergePlan = null;
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      state.rules.push({ ...action.payload, id: `rule-${Date.now()}` });
      state.mergePlan = null;
    },
    createMergePlan(state, action: PayloadAction<{ sourceIds: [string, string]; target: FormField }>) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const [a, b] = action.payload.sourceIds;
      if (a === b || !version.fields.some((field) => field.id === a) || !version.fields.some((field) => field.id === b)) return;
      state.mergePlan = buildMergePlan(version, state.rules, action.payload.sourceIds, action.payload.target);
      state.publishError = null;
    },
    resolveMergeConflict(state, action: PayloadAction<{ conflictId: string; keepRuleId: string }>) {
      if (!state.mergePlan) return;
      state.mergePlan.resolutions[action.payload.conflictId] = action.payload.keepRuleId;
      state.mergePlan.error = null;
    },
    discardMergePlan(state) {
      state.mergePlan = null;
      state.publishError = null;
    },
    commitMerge(state, action: PayloadAction<{ simulateFailure?: boolean }>) {
      const plan = state.mergePlan;
      if (!plan) return;
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const unresolved = plan.conflicts.filter((conflict) => !plan.resolutions[conflict.id]);
      if (unresolved.length > 0) {
        plan.error = `还有 ${unresolved.length} 个规则冲突未处理，处理完成前不能提交`;
        plan.rolledBack = false;
        return;
      }
      // —— 事务边界：字段、规则、快照的全部结果先在本地区间备好，最后一次性落库 ——
      const insertAt = version.fields.findIndex((field) => plan.sourceIds.includes(field.id));
      const nextFields = version.fields.filter((field) => !plan.sourceIds.includes(field.id));
      nextFields.splice(insertAt >= 0 ? insertAt : nextFields.length, 0, { ...plan.target });

      const versionRuleIds = new Set(version.rules.map((rule) => rule.id));
      const removedRuleIds = new Set<string>();
      for (const conflict of plan.conflicts) {
        const keep = plan.resolutions[conflict.id];
        if (keep === '__none__') conflict.ruleIds.forEach((id) => removedRuleIds.add(id));
        else conflict.ruleIds.filter((id) => id !== keep).forEach((id) => removedRuleIds.add(id));
      }
      const nextRules = retargetRules([...version.rules, ...state.rules], plan.sourceIds, plan.target.id)
        .filter((rule) => !removedRuleIds.has(rule.id));
      const nextVersionRules = nextRules.filter((rule) => versionRuleIds.has(rule.id));
      const nextDraftRules = nextRules.filter((rule) => !versionRuleIds.has(rule.id));

      const migrated: Snapshot[] = [];
      let pendingCount = 0;
      for (const snapshot of state.snapshots) {
        const preview = planSnapshotMerge(snapshot, plan.sourceIds, plan.sourceLabels);
        if (preview.outcome === 'untouched') continue;
        migrated.push(buildMigratedSnapshot(snapshot, plan, version.id, preview));
        if (preview.outcome === 'pending') pendingCount += 1;
      }

      if (action.payload.simulateFailure) {
        // 模拟写库中途失败：上面的字段/规则/快照一概不落库，状态保持提交前
        plan.error = '提交在写入阶段失败，已整体回滚：字段、联动规则、快照均未改动';
        plan.rolledBack = true;
        return;
      }

      version.fields = nextFields;
      version.rules = nextVersionRules;
      state.rules = nextDraftRules;
      state.snapshots.push(...migrated);
      state.mergeHistory.push({
        id: `mg-${Date.now()}`, sourceLabels: plan.sourceLabels, targetId: plan.target.id, targetLabel: plan.target.label,
        removedRuleIds: [...removedRuleIds], migratedSnapshotIds: migrated.map((snapshot) => snapshot.id), pendingCount,
        createdAt: new Date().toISOString().slice(0, 10)
      });
      state.mergePlan = null;
      state.publishError = null;
    },
    resolvePendingValue(state, action: PayloadAction<{ snapshotId: string; fieldId: string; value: string }>) {
      const snapshot = state.snapshots.find((item) => item.id === action.payload.snapshotId);
      const pending = snapshot?.pending?.[action.payload.fieldId];
      if (!snapshot || !pending) return;
      if (!pending.sources.some((source) => source.value === action.payload.value)) return;
      snapshot.data[action.payload.fieldId] = action.payload.value;
      delete snapshot.pending![action.payload.fieldId];
      if (Object.keys(snapshot.pending!).length === 0) delete snapshot.pending;
    },
    publishVersion(state) {
      if (state.mergePlan) {
        const unresolved = state.mergePlan.conflicts.filter((conflict) => !state.mergePlan!.resolutions[conflict.id]);
        state.publishError = unresolved.length > 0
          ? `存在 ${unresolved.length} 个未处理的规则冲突，处理完成前不能发布`
          : '合并方案已就绪但尚未提交，请先提交或放弃后再发布';
        return;
      }
      state.publishError = null;
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      const id = `v${state.versions.length + 1}`;
      state.versions.push({ ...current(source), id, label: `费用申请 ${id}`, createdAt: new Date().toISOString().slice(0, 10) });
      state.activeVersionId = id; state.previewVersionId = id;
    },
    selectPreview(state, action: PayloadAction<string>) {
      state.previewVersionId = action.payload;
      state.mergePlan = null;
      state.publishError = null;
    },
    replaceState(_state, action: PayloadAction<SchemaState>) { return { ...initial, ...action.payload }; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi', baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        const state = raw ? { ...initial, ...(JSON.parse(raw) as SchemaState) } : initial;
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField, addRule, commitMerge, createMergePlan, discardMergePlan, publishVersion,
  reorderFields, replaceState, resolveMergeConflict, resolvePendingValue, selectPreview
} = slice.actions;
export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;

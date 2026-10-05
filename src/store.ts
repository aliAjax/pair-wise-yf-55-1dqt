import { configureStore, createSlice, current, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }
export interface FormVersion { id: string; label: string; createdAt: string; fields: FormField[]; rules: LinkRule[]; }
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }

/** 待选值：两边都有不同值时标记，来源字段与值都保留 */
export interface PendingValueSource { fieldId: string; value: string; }
export interface PendingValue { targetFieldId: string; sources: PendingValueSource[]; chosenFieldId?: string; }
export interface SnapshotMigration { snapshotId: string; values: Record<string, string>; pending: PendingValue[]; }
export interface RuleRewrite { ruleId: string; before: LinkRule; after: LinkRule; }
export interface RuleConflict { id: string; ruleIds: string[]; }
export interface FieldMerge {
  id: string;
  versionId: string;
  sourceFields: FormField[];
  targetField: FormField;
  ruleRewrites: RuleRewrite[];
  conflicts: RuleConflict[];
  snapshotMigrations: SnapshotMigration[];
  createdAt: string;
  /** 提交前的完整状态，用于回滚，保证不留半套结果 */
  preState: SchemaState;
}
export interface MergeDraft {
  sourceFields: FormField[];
  targetField: FormField;
  ruleRewrites: RuleRewrite[];
  conflicts: RuleConflict[];
  snapshotMigrations: SnapshotMigration[];
  conflictResolutions: Record<string, string>;
  pendingChoices: Record<string, string>;
  preState: SchemaState;
}

interface SchemaState {
  versions: FormVersion[];
  rules: LinkRule[];
  activeVersionId: string;
  previewVersionId: string;
  snapshots: Snapshot[];
  merges: FieldMerge[];
  mergeDraft: MergeDraft | null;
  mergeError: string | null;
  publishBlocked: string | null;
}
type RootShape = { schema: SchemaState };

function referencesField(rule: LinkRule, fieldId: string): boolean {
  return rule.fieldId === fieldId || rule.targetId === fieldId;
}

function rewriteRule(rule: LinkRule, sourceIds: string[], targetId: string): LinkRule {
  const after = { ...rule };
  if (sourceIds.includes(after.fieldId)) after.fieldId = targetId;
  if (sourceIds.includes(after.targetId)) after.targetId = targetId;
  return after;
}

function computeRuleRewrites(rules: LinkRule[], sourceIds: string[], targetId: string): RuleRewrite[] {
  return rules
    .filter((rule) => sourceIds.some((id) => referencesField(rule, id)))
    .map((rule) => ({ ruleId: rule.id, before: rule, after: rewriteRule(rule, sourceIds, targetId) }));
}

/** 合并后完全相同的规则归为冲突组（重名/重复），必须先处理 */
function computeConflicts(rules: LinkRule[], sourceIds: string[], targetId: string): RuleConflict[] {
  const rewritten = rules
    .filter((rule) => sourceIds.some((id) => referencesField(rule, id)))
    .map((rule) => ({ ruleId: rule.id, after: rewriteRule(rule, sourceIds, targetId) }));
  const groups = new Map<string, string[]>();
  for (const item of rewritten) {
    const key = JSON.stringify([item.after.fieldId, item.after.operator, item.after.value, item.after.effect, item.after.targetId]);
    const list = groups.get(key);
    if (list) list.push(item.ruleId);
    else groups.set(key, [item.ruleId]);
  }
  let i = 0;
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([, ids]) => ({ id: `conflict-${i++}`, ruleIds: ids }));
}

/** 快照迁移：有值优先；两边都有且不同 → 标待选并保留来源；空值不覆盖 */
function computeSnapshotMigrations(snapshots: Snapshot[], sourceIds: [string, string], targetId: string): SnapshotMigration[] {
  return snapshots.map((snapshot) => {
    const a = snapshot.data[sourceIds[0]] || undefined;
    const b = snapshot.data[sourceIds[1]] || undefined;
    const pending: PendingValue[] = [];
    const values: Record<string, string> = { ...snapshot.data };
    delete values[sourceIds[0]];
    delete values[sourceIds[1]];
    if (a !== undefined && b !== undefined && a !== b) {
      pending.push({ targetFieldId: targetId, sources: [{ fieldId: sourceIds[0], value: a }, { fieldId: sourceIds[1], value: b }] });
    } else {
      const chosen = a ?? b;
      if (chosen !== undefined) values[targetId] = chosen;
    }
    return { snapshotId: snapshot.id, values, pending };
  });
}

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
        { id: 'contactPhone', label: '联系电话', type: 'text', required: false },
        { id: 'mobilePhone', label: '手机号', type: 'text', required: false }
      ],
      rules: [
        { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
        { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
        { id: 'r3', fieldId: 'contactPhone', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
        { id: 'r4', fieldId: 'mobilePhone', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' },
        { id: 'r5', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'contactPhone' },
        { id: 'r6', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'mobilePhone' }
      ]
    }
  ],
  rules: [],
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } },
    { id: 's3', versionId: 'v2', label: '客户回访记录', data: { name: '客户回访', department: '市场', amount: '3000', contactPhone: '010-88886666', mobilePhone: '13800138000' } },
    { id: 's4', versionId: 'v2', label: '供应商登记', data: { name: '供应商', department: '财务', amount: '9000', contactPhone: '021-66668888' } },
    { id: 's5', versionId: 'v2', label: '员工报销', data: { name: '差旅费', department: '研发', amount: '520', mobilePhone: '13912345678' } }
  ],
  merges: [],
  mergeDraft: null,
  mergeError: null,
  publishBlocked: null
};

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
      const [moved] = version.fields.splice(from, 1);
      version.fields.splice(to, 0, moved);
    },
    addField(state) {
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const id = `field-${Date.now()}`;
      version.fields.push({ id, label: '新字段', type: 'text', required: false });
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      state.rules.push({ ...action.payload, id: `rule-${Date.now()}` });
    },
    startMerge(state, action: PayloadAction<{ sourceA: string; sourceB: string }>) {
      const { sourceA, sourceB } = action.payload;
      if (sourceA === sourceB || state.mergeDraft) return;
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const fieldA = version.fields.find((item) => item.id === sourceA);
      const fieldB = version.fields.find((item) => item.id === sourceB);
      if (!fieldA || !fieldB) return;
      const sourceIds: [string, string] = [sourceA, sourceB];
      const targetField: FormField = { id: `merged-${Date.now()}`, label: `${fieldA.label} / ${fieldB.label}`, type: fieldA.type, required: false };
      const allRules = [...version.rules, ...state.rules];
      state.mergeDraft = {
        sourceFields: [fieldA, fieldB],
        targetField,
        ruleRewrites: computeRuleRewrites(allRules, sourceIds, targetField.id),
        conflicts: computeConflicts(allRules, sourceIds, targetField.id),
        snapshotMigrations: computeSnapshotMigrations(state.snapshots, sourceIds, targetField.id),
        conflictResolutions: {},
        pendingChoices: {},
        preState: structuredClone(current(state))
      };
      state.mergeError = null;
    },
    updateMergeTargetLabel(state, action: PayloadAction<string>) {
      if (state.mergeDraft) state.mergeDraft.targetField.label = action.payload;
    },
    resolveMergeConflict(state, action: PayloadAction<{ conflictId: string; ruleId: string }>) {
      if (!state.mergeDraft) return;
      state.mergeDraft.conflictResolutions[action.payload.conflictId] = action.payload.ruleId;
    },
    resolveMergePending(state, action: PayloadAction<{ snapshotId: string; fieldId: string }>) {
      if (!state.mergeDraft) return;
      state.mergeDraft.pendingChoices[action.payload.snapshotId] = action.payload.fieldId;
    },
    cancelMerge(state) {
      state.mergeDraft = null;
      state.mergeError = null;
    },
    commitMerge(state) {
      const draft = state.mergeDraft;
      if (!draft) return;
      const unresolved = draft.conflicts.filter((conflict) => !draft.conflictResolutions[conflict.id]);
      if (unresolved.length) {
        const restored = structuredClone(draft.preState);
        restored.mergeDraft = structuredClone(current(draft));
        restored.mergeError = `存在 ${unresolved.length} 个未处理的规则冲突，已回滚到合并前状态。请先处理冲突再提交。`;
        restored.publishBlocked = restored.mergeError;
        return restored;
      }
      const version = state.versions.find((item) => item.id === state.previewVersionId);
      if (!version) return;
      const sourceIds = draft.sourceFields.map((field) => field.id);
      const preState = structuredClone(draft.preState);
      try {
        const rewrite = (rules: LinkRule[]) => rules.map((rule) => rewriteRule(rule, sourceIds, draft.targetField.id));
        version.rules = rewrite(version.rules);
        state.rules = rewrite(state.rules);
        version.fields = [...version.fields.filter((field) => !sourceIds.includes(field.id)), draft.targetField];
        const fieldIds = new Set(version.fields.map((field) => field.id));
        const dangling = [...version.rules, ...state.rules].some((rule) => !fieldIds.has(rule.fieldId) || !fieldIds.has(rule.targetId));
        if (dangling) throw new Error('dangling rule references after merge');
        const record: FieldMerge = {
          id: `merge-${Date.now()}`,
          versionId: version.id,
          sourceFields: draft.sourceFields,
          targetField: draft.targetField,
          ruleRewrites: draft.ruleRewrites,
          conflicts: draft.conflicts,
          snapshotMigrations: draft.snapshotMigrations.map((migration) => {
            const chosenId = draft.pendingChoices[migration.snapshotId];
            const pending = migration.pending.map((item) => ({ ...item, chosenFieldId: chosenId ?? item.chosenFieldId }));
            const values = { ...migration.values };
            for (const item of pending) {
              if (item.chosenFieldId) {
                const source = item.sources.find((s) => s.fieldId === item.chosenFieldId);
                if (source) values[item.targetFieldId] = source.value;
              }
            }
            return { snapshotId: migration.snapshotId, values, pending };
          }),
          createdAt: new Date().toISOString().slice(0, 10),
          preState
        };
        state.merges.push(record);
        state.mergeDraft = null;
        state.mergeError = null;
        state.publishBlocked = null;
      } catch {
        const restored = preState;
        restored.mergeDraft = structuredClone(current(draft));
        restored.mergeError = '提交失败：合并过程中出现异常，已回滚到合并前状态。';
        restored.publishBlocked = restored.mergeError;
        return restored;
      }
    },
    rollbackMerge(state, action: PayloadAction<string>) {
      const record = state.merges.find((item) => item.id === action.payload);
      if (!record) return;
      return structuredClone(record.preState);
    },
    publishVersion(state) {
      if (state.mergeDraft) {
        const unresolved = state.mergeDraft.conflicts.filter((conflict) => !state.mergeDraft!.conflictResolutions[conflict.id]);
        state.publishBlocked = unresolved.length
          ? `存在 ${unresolved.length} 个未处理的规则冲突，合并未处理完，禁止发布。`
          : '字段合并尚未提交，禁止发布。';
        return;
      }
      state.publishBlocked = null;
      const source = state.versions.find((item) => item.id === state.previewVersionId);
      if (!source) return;
      const id = `v${state.versions.length + 1}`;
      state.versions.push({ ...structuredClone(source), id, label: `费用申请 ${id}`, createdAt: new Date().toISOString().slice(0, 10) });
      state.activeVersionId = id;
      state.previewVersionId = id;
    },
    selectPreview(state, action: PayloadAction<string>) { state.previewVersionId = action.payload; },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi', baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem('yf55-schema-state');
        const state = raw ? JSON.parse(raw) as SchemaState : initial;
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField, addRule, publishVersion, reorderFields, replaceState, selectPreview,
  startMerge, updateMergeTargetLabel, resolveMergeConflict, resolveMergePending,
  cancelMerge, commitMerge, rollbackMerge
} = slice.actions;
export const store = configureStore({ reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer }, middleware: (getDefault) => getDefault().concat(schemaApi.middleware) });
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('yf55-schema-state');
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  store.subscribe(() => localStorage.setItem('yf55-schema-state', JSON.stringify((store.getState() as RootShape).schema)));
}
export type RootState = RootShape;

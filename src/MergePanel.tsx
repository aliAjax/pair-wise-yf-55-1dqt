import { Alert, Box, Button, Checkbox, Chip, Divider, FormControl, FormControlLabel, InputLabel, MenuItem, Radio, RadioGroup, Select, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  commitMerge, createMergePlan, discardMergePlan, planSnapshotMerge, resolveMergeConflict,
  type FieldType, type MergeOutcome, type RootState
} from './store';

const effectText = { show: '显示', require: '必填' } as const;
const outcomeSeverity: Record<MergeOutcome, 'success' | 'warning' | 'info'> = {
  fromA: 'success', fromB: 'success', same: 'success', pending: 'warning', empty: 'info', untouched: 'info'
};

export default function MergePanel() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const version = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const plan = state.mergePlan;
  const fields = version.fields;
  const allRules = [...version.rules, ...state.rules];
  const [sourceA, setSourceA] = useState('invoiceDate');
  const [sourceB, setSourceB] = useState('billingDate');
  const [targetLabel, setTargetLabel] = useState('开票日期（合并）');
  const [targetType, setTargetType] = useState<FieldType>('date');
  const [simulateFailure, setSimulateFailure] = useState(false);

  const validA = fields.some((field) => field.id === sourceA) ? sourceA : fields[0]?.id ?? '';
  const validB = fields.some((field) => field.id === sourceB) && sourceB !== validA ? sourceB : fields.find((field) => field.id !== validA)?.id ?? '';
  const lastMerge = state.mergeHistory.at(-1);

  function generate() {
    if (!validA || !validB || validA === validB) return;
    dispatch(createMergePlan({
      sourceIds: [validA, validB],
      target: { id: `merged-${Date.now()}`, label: targetLabel.trim() || '合并字段', type: targetType, required: false }
    }));
  }

  function outcomeText(outcome: MergeOutcome, value: string | undefined, sources: { label: string; value: string }[] | undefined): string {
    if (!plan) return '';
    switch (outcome) {
      case 'fromA': return `仅「${plan.sourceLabels[0]}」有值 → 采用「${value}」`;
      case 'fromB': return `仅「${plan.sourceLabels[1]}」有值 → 采用「${value}」`;
      case 'same': return `两边取值一致 → 采用「${value}」`;
      case 'pending': return `两边都有值且不同 → 标记「待选」，来源保留：${sources?.map((source) => `${source.label}=${source.value}`).join('、')}`;
      case 'empty': return '两边都为空 → 新字段留空';
      case 'untouched': return '不涉及合并字段，快照保持冻结原样';
    }
  }

  return (
    <Box>
      <Typography variant="h6">字段合并（去重）</Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        把两个重复字段合并为一个新字段：引用旧字段的联动规则统一改指新字段；旧快照仍按合并前字段解释，迁移副本有值优先，两边值不同标记「待选」并保留来源；提交原子化，失败整体回滚。
      </Typography>

      {lastMerge && !plan && (
        <Alert severity="success" sx={{ mb: 2 }}>
          上次合并完成：「{lastMerge.sourceLabels[0]}」「{lastMerge.sourceLabels[1]}」→「{lastMerge.targetLabel}」，
          清理规则 {lastMerge.removedRuleIds.length} 条，生成迁移快照 {lastMerge.migratedSnapshotIds.length} 份
          {lastMerge.pendingCount > 0 ? `（其中 ${lastMerge.pendingCount} 个字段待选，可到「迁移模拟」页选择取值）` : ''}。原快照保持冻结。
        </Alert>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>重复字段 A</InputLabel>
          <Select label="重复字段 A" value={validA} onChange={(event) => setSourceA(event.target.value)}>
            {fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel>重复字段 B</InputLabel>
          <Select label="重复字段 B" value={validB} onChange={(event) => setSourceB(event.target.value)}>
            {fields.filter((field) => field.id !== validA).map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField size="small" label="合并后字段名" value={targetLabel} onChange={(event) => setTargetLabel(event.target.value)} />
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>类型</InputLabel>
          <Select label="类型" value={targetType} onChange={(event) => setTargetType(event.target.value as FieldType)}>
            <MenuItem value="text">text</MenuItem><MenuItem value="number">number</MenuItem>
            <MenuItem value="select">select</MenuItem><MenuItem value="date">date</MenuItem>
          </Select>
        </FormControl>
        <Button variant="contained" onClick={generate} disabled={!validA || !validB || validA === validB}>生成合并方案</Button>
      </Stack>

      {plan && (
        <Stack spacing={2} mt={3}>
          <div>
            <Typography fontWeight={700} mb={1}>字段变更</Typography>
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Chip color="error" variant="outlined" label={`移除 ${plan.sourceLabels[0]}（${plan.sourceIds[0]}）`} />
              <Chip color="error" variant="outlined" label={`移除 ${plan.sourceLabels[1]}（${plan.sourceIds[1]}）`} />
              <Chip color="success" variant="outlined" label={`新增 ${plan.target.label}（${plan.target.id}）`} />
            </Stack>
          </div>
          <Divider />
          <div>
            <Typography fontWeight={700} mb={1}>引用改指（{plan.retargets.length} 处）</Typography>
            {plan.retargets.length === 0 && <Typography variant="body2" color="text.secondary">没有规则引用这两个字段。</Typography>}
            {plan.retargets.map((retarget, index) => (
              <Typography key={`${retarget.ruleId}-${retarget.where}-${index}`} variant="body2">
                规则 {retarget.ruleId}：{retarget.where === 'fieldId' ? '触发字段' : '目标字段'} {retarget.from} → {plan.target.id}
              </Typography>
            ))}
          </div>
          <Divider />
          <div>
            <Typography fontWeight={700} mb={1}>规则冲突（{plan.conflicts.length}）—— 未处理完不能提交，也不能发布</Typography>
            {plan.conflicts.length === 0 && <Alert severity="success">没有重名或冲突规则。</Alert>}
            {plan.conflicts.map((conflict) => (
              <Alert key={conflict.id} severity={plan.resolutions[conflict.id] ? 'success' : 'warning'} sx={{ mb: 1 }}>
                <Typography variant="body2" mb={0.5}>{conflict.summary}</Typography>
                <RadioGroup
                  row
                  value={plan.resolutions[conflict.id] ?? ''}
                  onChange={(event) => dispatch(resolveMergeConflict({ conflictId: conflict.id, keepRuleId: event.target.value }))}
                >
                  {conflict.kind === 'self'
                    ? <FormControlLabel value="__none__" control={<Radio size="small" />} label="移除该规则" />
                    : conflict.ruleIds.map((ruleId) => {
                      const rule = allRules.find((item) => item.id === ruleId);
                      const label = conflict.kind === 'duplicate'
                        ? `保留 ${ruleId}（删除其余重复项）`
                        : `保留「${rule ? effectText[rule.effect] : ''}」效果（规则 ${ruleId}）`;
                      return <FormControlLabel key={ruleId} value={ruleId} control={<Radio size="small" />} label={label} />;
                    })}
                </RadioGroup>
              </Alert>
            ))}
          </div>
          <Divider />
          <div>
            <Typography fontWeight={700} mb={1}>快照迁移预演（原快照保持冻结，仅生成迁移副本）</Typography>
            {state.snapshots.map((snapshot) => {
              const preview = planSnapshotMerge(snapshot, plan.sourceIds, plan.sourceLabels);
              return (
                <Alert key={snapshot.id} severity={outcomeSeverity[preview.outcome]} sx={{ mb: 1 }}>
                  {snapshot.label}：{outcomeText(preview.outcome, preview.value, preview.sources)}
                </Alert>
              );
            })}
          </div>
          <FormControlLabel
            control={<Checkbox checked={simulateFailure} onChange={(event) => setSimulateFailure(event.target.checked)} />}
            label="模拟提交中途失败（验证整体回滚，不留半套结果）"
          />
          <Stack direction="row" spacing={2}>
            <Button variant="contained" color="primary" onClick={() => dispatch(commitMerge({ simulateFailure }))}>提交合并</Button>
            <Button variant="outlined" onClick={() => dispatch(discardMergePlan())}>放弃方案</Button>
          </Stack>
          {plan.error && <Alert severity="error">{plan.error}{plan.rolledBack ? '（可修正后重新提交）' : ''}</Alert>}
        </Stack>
      )}
    </Box>
  );
}

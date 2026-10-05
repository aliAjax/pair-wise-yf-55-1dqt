import { Alert, Box, Button, Card, CardContent, Chip, Divider, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { cancelMerge, commitMerge, resolveMergeConflict, resolveMergePending, rollbackMerge, startMerge, updateMergeTargetLabel, type LinkRule, type RootState } from './store';

function ruleText(rule: LinkRule, labelOf: (id: string) => string): string {
  return `${labelOf(rule.fieldId)} ${rule.operator === 'equals' ? '等于' : '非空'} ${rule.value || ''} → ${rule.effect === 'require' ? '要求' : '显示'} ${labelOf(rule.targetId)}`;
}

export default function MergePanel() {
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const version = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const [sourceA, setSourceA] = useState('');
  const [sourceB, setSourceB] = useState('');
  const draft = state.mergeDraft;
  const lastMerge = state.merges.at(-1);
  const allRules = [...version.rules, ...state.rules];
  const ruleById = (id: string) => allRules.find((rule) => rule.id === id);
  const fieldLabel = (id: string): string => {
    if (draft && draft.targetField.id === id) return draft.targetField.label;
    const inVersion = version.fields.find((field) => field.id === id);
    if (inVersion) return inVersion.label;
    for (const merge of state.merges) {
      const found = [...merge.sourceFields, merge.targetField].find((field) => field.id === id);
      if (found) return found.label;
    }
    return id;
  };
  const snapshotLabel = (id: string) => state.snapshots.find((snapshot) => snapshot.id === id)?.label ?? id;
  const start = () => { if (sourceA && sourceB && sourceA !== sourceB) dispatch(startMerge({ sourceA, sourceB })); };
  const unresolvedCount = draft ? draft.conflicts.filter((conflict) => !draft.conflictResolutions[conflict.id]).length : 0;
  const pendingMigrations = draft ? draft.snapshotMigrations.filter((migration) => migration.pending.length > 0) : [];

  return (
    <Card>
      <CardContent>
        <Typography variant="h6">字段合并</Typography>
        <Typography variant="body2" color="text.secondary" mb={2}>合并两个重复字段，联动规则统一指向新字段；规则重名或冲突先列出，处理完才允许发布；提交失败自动回滚，不留半套结果。</Typography>
        {state.mergeError && <Alert severity="error" sx={{ mb: 2 }}>{state.mergeError}</Alert>}

        {!draft && (
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" fullWidth>
              <InputLabel>重复字段 A</InputLabel>
              <Select label="重复字段 A" value={sourceA} onChange={(event) => setSourceA(event.target.value)}>
                {version.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel>重复字段 B</InputLabel>
              <Select label="重复字段 B" value={sourceB} onChange={(event) => setSourceB(event.target.value)}>
                {version.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
              </Select>
            </FormControl>
            <Button variant="contained" onClick={start} disabled={!sourceA || !sourceB || sourceA === sourceB}>开始合并</Button>
          </Stack>
        )}

        {draft && (
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" mb={2}>
              {draft.sourceFields.map((field) => <Chip key={field.id} label={field.label} />)}
              <Typography>→</Typography>
              <TextField size="small" value={draft.targetField.label} onChange={(event) => dispatch(updateMergeTargetLabel(event.target.value))} />
              <Chip label={draft.targetField.type} size="small" />
            </Stack>

            <Typography fontWeight={700} mb={1}>引用将被改写（{draft.ruleRewrites.length}）</Typography>
            {draft.ruleRewrites.length === 0 && <Typography variant="body2" color="text.secondary" mb={2}>没有联动规则引用这两个字段。</Typography>}
            {draft.ruleRewrites.map((rewrite) => (
              <Alert key={rewrite.ruleId} severity="info" sx={{ mb: 1 }}>
                规则 {rewrite.ruleId}：{ruleText(rewrite.before, fieldLabel)} → {ruleText(rewrite.after, fieldLabel)}
              </Alert>
            ))}

            <Divider sx={{ my: 2 }} />
            <Typography fontWeight={700} mb={1}>规则冲突（{draft.conflicts.length}，未处理完禁止发布）</Typography>
            {draft.conflicts.length === 0 && <Alert severity="success" sx={{ mb: 1 }}>合并后没有重复或冲突的规则。</Alert>}
            {draft.conflicts.map((conflict) => {
              const resolved = draft.conflictResolutions[conflict.id];
              return (
                <Alert key={conflict.id} severity={resolved ? 'success' : 'warning'} sx={{ mb: 1 }}>
                  <Typography variant="body2" fontWeight={700} mb={1}>合并后规则重复，请保留一条：</Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    {conflict.ruleIds.map((ruleId) => {
                      const rule = ruleById(ruleId);
                      const selected = resolved === ruleId;
                      return (
                        <Button key={ruleId} size="small" variant={selected ? 'contained' : 'outlined'} onClick={() => dispatch(resolveMergeConflict({ conflictId: conflict.id, ruleId }))}>
                          保留 {ruleId}{rule ? `：${ruleText(rule, fieldLabel)}` : ''}
                        </Button>
                      );
                    })}
                  </Stack>
                </Alert>
              );
            })}

            <Divider sx={{ my: 2 }} />
            <Typography fontWeight={700} mb={1}>待选数据（两边都有不同值，已保留来源）</Typography>
            {pendingMigrations.length === 0 && <Alert severity="success" sx={{ mb: 1 }}>没有两边冲突的数据；迁移时有值优先，空值不覆盖。</Alert>}
            {pendingMigrations.map((migration) => (
              <Alert key={migration.snapshotId} severity="warning" sx={{ mb: 1 }}>
                <Typography variant="body2" fontWeight={700} mb={1}>{snapshotLabel(migration.snapshotId)}</Typography>
                {migration.pending.map((item) => {
                  const chosen = draft.pendingChoices[migration.snapshotId];
                  return (
                    <Box key={item.targetFieldId}>
                      <Typography variant="body2" mb={1}>两边值不同，标记为待选（来源已保留，不丢数据）：</Typography>
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        {item.sources.map((source) => (
                          <Button key={source.fieldId} size="small" variant={chosen === source.fieldId ? 'contained' : 'outlined'} onClick={() => dispatch(resolveMergePending({ snapshotId: migration.snapshotId, fieldId: source.fieldId }))}>
                            采用 {fieldLabel(source.fieldId)}：{source.value}
                          </Button>
                        ))}
                      </Stack>
                      {chosen && <Typography variant="caption" color="success.main">已选择：{fieldLabel(chosen)}</Typography>}
                    </Box>
                  );
                })}
              </Alert>
            ))}

            <Stack direction="row" spacing={2} mt={2}>
              <Button variant="contained" color="primary" disabled={unresolvedCount > 0} onClick={() => dispatch(commitMerge())}>提交合并</Button>
              <Button variant="outlined" onClick={() => dispatch(cancelMerge())}>取消</Button>
            </Stack>
            {unresolvedCount > 0 && <Alert severity="error" sx={{ mt: 1 }}>还有 {unresolvedCount} 个规则冲突未处理，提交将回滚到合并前，且禁止发布。</Alert>}
          </Box>
        )}

        {!draft && lastMerge && (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography variant="body2" mb={1}>上次合并：{lastMerge.sourceFields.map((field) => field.label).join(' + ')} → {lastMerge.targetField.label}（{lastMerge.createdAt}）。旧快照仍按合并前字段解释。</Typography>
            <Button size="small" variant="outlined" onClick={() => dispatch(rollbackMerge(lastMerge.id))}>回滚到合并前</Button>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import { superAuth } from '../../../shared/auth';
import type {
  SurveyTemplateRecord,
  SurveyTemplateVersionRecord,
} from '../../../shared/api/types';
import { Button, Card, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { runBackup } from '../api';
import { BackupAlarmBanner } from '../components/BackupAlarmBanner';
import { useBackupStatus } from '../hooks';
import { formatDateTime, nowPbDateTime } from '../lib/format';
import { ACTIVE_STATUS_LABELS } from '../lib/labels';
import {
  countLockedQuestions,
  extractTemplateQuestions,
  validateSchemaJsonText,
  type TemplateQuestionView,
} from '../lib/templates';

/**
 * 系统与模板（/super/system）。
 * - 备份状态卡片：最近备份时间/结果；失败显著告警横幅（AC-23）；手动触发备份（写审计）；
 * - 标准问卷模板管理：模板与版本列表、新版本发布（FR-SUR-001/011）、锁定题目标识。
 *   模板具体题目内容 PRD 未写死（technical-design 待确认 #5），本页按能力层实现：
 *   版本 schema 以 JSON 编辑，已发布版本不可变（database-design §5.2.13）。
 */
export function SuperSystemPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);
  const backup = useBackupStatus();

  const [backupRunning, setBackupRunning] = useState(false);
  const [confirmBackupOpen, setConfirmBackupOpen] = useState(false);

  // 模板数据
  const [templates, setTemplates] = useState<SurveyTemplateRecord[] | null>(null);
  const [versions, setVersions] = useState<SurveyTemplateVersionRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // 版本题目预览 / 发布新版本
  const [previewVersion, setPreviewVersion] = useState<SurveyTemplateVersionRecord | null>(null);
  const [publishTemplate, setPublishTemplate] = useState<SurveyTemplateRecord | null>(null);
  const [schemaText, setSchemaText] = useState('');
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadTemplates = useCallback(async () => {
    const [templateList, versionList] = await Promise.all([
      cc.surveyTemplates.getFullList({ sort: 'created' }),
      cc.surveyTemplateVersions.getFullList({ sort: '-version' }),
    ]);
    setTemplates(templateList);
    setVersions(versionList);
  }, [cc]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      cc.surveyTemplates.getFullList({ sort: 'created' }),
      cc.surveyTemplateVersions.getFullList({ sort: '-version' }),
    ])
      .then(([templateList, versionList]) => {
        if (!cancelled) {
          setTemplates(templateList);
          setVersions(versionList);
        }
      })
      .catch((err) => {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const versionsOf = useCallback(
    (templateId: string) =>
      versions
        .filter((v) => v.template_id === templateId)
        .sort((a, b) => b.version - a.version),
    [versions],
  );

  const currentVersionOf = useCallback(
    (template: SurveyTemplateRecord) =>
      versions.find((v) => v.id === template.current_version_id),
    [versions],
  );

  const onRunBackup = async () => {
    setBackupRunning(true);
    try {
      await runBackup();
      toast('备份已执行，结果见状态卡片与审计日志', 'success');
      setConfirmBackupOpen(false);
      await backup.refresh();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
      await backup.refresh().catch(() => undefined);
    } finally {
      setBackupRunning(false);
    }
  };

  const onToggleTemplateStatus = async (template: SurveyTemplateRecord) => {
    setSaving(true);
    try {
      await cc.surveyTemplates.update(template.id, {
        status: template.status === 'active' ? 'disabled' : 'active',
      });
      toast(template.status === 'active' ? '模板已停用' : '模板已启用', 'success');
      await loadTemplates();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const openPublish = (template: SurveyTemplateRecord) => {
    const current = currentVersionOf(template);
    setPublishTemplate(template);
    setSchemaText(current ? JSON.stringify(current.schema_json, null, 2) : '{\n  "questions": []\n}');
    setSchemaError(null);
  };

  const onPublishVersion = async () => {
    if (!publishTemplate) return;
    const error = validateSchemaJsonText(schemaText);
    setSchemaError(error);
    if (error) return;
    setSaving(true);
    try {
      const nextVersion = Math.max(0, ...versionsOf(publishTemplate.id).map((v) => v.version)) + 1;
      const created = await cc.surveyTemplateVersions.create({
        template_id: publishTemplate.id,
        version: nextVersion,
        schema_json: JSON.parse(schemaText) as unknown,
        published_at: nowPbDateTime(),
        published_by: superAuth.record?.id ?? '',
      });
      await cc.surveyTemplates.update(publishTemplate.id, { current_version_id: created.id });
      toast(`已发布版本 v${nextVersion}，仅影响之后新建的活动问卷`, 'success');
      setPublishTemplate(null);
      await loadTemplates();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const previewQuestions: TemplateQuestionView[] = useMemo(
    () => (previewVersion ? extractTemplateQuestions(previewVersion.schema_json) : []),
    [previewVersion],
  );

  const selectedTemplate = templates?.find((t) => t.id === selectedTemplateId) ?? null;

  return (
    <SuperLayout title="系统与模板">
      {backup.status ? <BackupAlarmBanner status={backup.status} /> : null}

      <Card
        title="备份状态"
        actions={
          <Button variant="secondary" loading={backup.loading} onClick={() => void backup.refresh()}>
            刷新
          </Button>
        }
      >
        {backup.loading && !backup.status ? (
          <Loading />
        ) : backup.error ? (
          <p className="cc-error" role="alert">
            {backup.error}
          </p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <tbody>
                <tr>
                  <th>最近备份时间</th>
                  <td>{formatDateTime(backup.status?.lastBackup?.at)}</td>
                </tr>
                <tr>
                  <th>结果</th>
                  <td>
                    {backup.status?.lastBackup?.result === 'success' ? (
                      <span className="sa-badge sa-badge-success">成功</span>
                    ) : backup.status?.lastBackup?.result === 'failure' ? (
                      <span className="sa-badge sa-badge-danger">失败</span>
                    ) : (
                      <span className="sa-muted">暂无备份记录</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>备份文件</th>
                  <td>{backup.status?.lastBackup?.file ?? '—'}</td>
                </tr>
                <tr>
                  <th>说明</th>
                  <td className="sa-cell-wrap">
                    {backup.status?.lastBackup?.message ??
                      '数据库及上传文件每日自动备份，默认保留最近 30 天（PRD §12.3）。'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="sa-actions" style={{ marginTop: '0.75rem' }}>
          <Button onClick={() => setConfirmBackupOpen(true)}>手动触发一次备份</Button>
        </div>
      </Card>

      <Card title="标准问卷模板">
        {templates === null ? (
          <Loading />
        ) : templates.length === 0 ? (
          <p className="sa-muted">暂无模板；初始模板由后端迁移注入（FR-SUR-001）。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>模板代码</th>
                  <th>名称</th>
                  <th>状态</th>
                  <th>当前版本</th>
                  <th>版本数</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl) => {
                  const current = currentVersionOf(tpl);
                  return (
                    <tr key={tpl.id}>
                      <td>
                        <code>{tpl.template_code}</code>
                      </td>
                      <td className="sa-cell-wrap">{tpl.name}</td>
                      <td>
                        <span
                          className={`sa-badge ${tpl.status === 'active' ? 'sa-badge-success' : 'sa-badge-danger'}`}
                        >
                          {ACTIVE_STATUS_LABELS[tpl.status]}
                        </span>
                      </td>
                      <td>{current ? `v${current.version}` : '—'}</td>
                      <td>{versionsOf(tpl.id).length}</td>
                      <td>
                        <div className="sa-actions">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setSelectedTemplateId(
                                selectedTemplateId === tpl.id ? null : tpl.id,
                              )
                            }
                          >
                            {selectedTemplateId === tpl.id ? '收起版本' : '版本列表'}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={tpl.status !== 'active'}
                            onClick={() => openPublish(tpl)}
                          >
                            发布新版本
                          </Button>
                          <Button
                            variant={tpl.status === 'active' ? 'danger' : 'secondary'}
                            disabled={saving}
                            onClick={() => void onToggleTemplateStatus(tpl)}
                          >
                            {tpl.status === 'active' ? '停用' : '启用'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selectedTemplate ? (
          <div style={{ marginTop: '1rem' }}>
            <h3 className="cc-card-title">
              版本列表：{selectedTemplate.name}
            </h3>
            <p className="sa-muted">
              已发布版本不可变；模板更新 = 新增版本行 + 切换当前版本，仅影响之后新建的活动问卷，
              已复制的活动问卷固定原版本（FR-SUR-011、AC-13）。
            </p>
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>发布时间</th>
                    <th>发布人</th>
                    <th>题目数</th>
                    <th>锁定题数</th>
                    <th>当前版本</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versionsOf(selectedTemplate.id).map((v) => (
                    <tr key={v.id}>
                      <td>v{v.version}</td>
                      <td>{formatDateTime(v.published_at)}</td>
                      <td>{v.published_by}</td>
                      <td>{extractTemplateQuestions(v.schema_json).length}</td>
                      <td>{countLockedQuestions(v.schema_json)}</td>
                      <td>
                        {selectedTemplate.current_version_id === v.id ? (
                          <span className="sa-badge sa-badge-success">当前</span>
                        ) : (
                          <span className="sa-muted">—</span>
                        )}
                      </td>
                      <td>
                        <Button variant="secondary" onClick={() => setPreviewVersion(v)}>
                          查看题目
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </Card>

      {/* 手动备份确认 */}
      <Modal
        open={confirmBackupOpen}
        title="手动触发备份"
        onClose={() => setConfirmBackupOpen(false)}
        footer={
          <>
            <Button loading={backupRunning} onClick={() => void onRunBackup()}>
              确认执行
            </Button>
            <Button variant="secondary" onClick={() => setConfirmBackupOpen(false)}>
              取消
            </Button>
          </>
        }
      >
        <p>
          将立即执行一次完整备份（数据库 + 上传文件），执行结果写入审计日志；
          失败时本页与全局看板将显示显著告警（AC-23）。
        </p>
      </Modal>

      {/* 版本题目预览（锁定题标识） */}
      <Modal
        open={previewVersion !== null}
        title={`版本题目：v${previewVersion?.version ?? ''}`}
        onClose={() => setPreviewVersion(null)}
      >
        {previewQuestions.length === 0 ? (
          <p className="sa-muted">该版本未包含可解析的题目定义。</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {previewQuestions.map((q) => (
              <li key={q.question_code} className="sa-question-item">
                <div>
                  <code>{q.question_code}</code> {q.title}
                </div>
                <div className="sa-actions" style={{ marginTop: '0.25rem' }}>
                  <span className="sa-badge">{q.question_type}</span>
                  {q.locked ? <span className="sa-badge sa-badge-danger">锁定题（机构不可改）</span> : null}
                  {q.is_sensitive ? <span className="sa-badge sa-badge-warn">敏感题</span> : null}
                  {q.required ? <span className="sa-badge sa-badge-info">必填</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="sa-muted">
          锁定题由超级管理员维护，机构不能修改或删除（FR-SUR-001）；敏感题在普通导出中按标记排除（FR-SUR-012）。
        </p>
      </Modal>

      {/* 发布新版本 */}
      <Modal
        open={publishTemplate !== null}
        title={`发布新版本：${publishTemplate?.name ?? ''}`}
        onClose={() => setPublishTemplate(null)}
        footer={
          <>
            <Button loading={saving} onClick={() => void onPublishVersion()}>
              发布
            </Button>
            <Button variant="secondary" onClick={() => setPublishTemplate(null)}>
              取消
            </Button>
          </>
        }
      >
        <p className="sa-confirm-warning">
          新版本发布后即不可修改，且只影响之后新建的活动问卷；已复制的活动问卷固定在原版本，不受影响（FR-SUR-011）。
        </p>
        <div className="cc-field">
          <label className="cc-label" htmlFor="sa-schema-json">
            题目定义 JSON（schema_json）
          </label>
          <textarea
            id="sa-schema-json"
            className="sa-textarea"
            value={schemaText}
            onChange={(e) => {
              setSchemaText(e.target.value);
              if (schemaError) setSchemaError(validateSchemaJsonText(e.target.value));
            }}
            aria-invalid={schemaError ? true : undefined}
          />
          {schemaError ? (
            <p className="cc-error" role="alert">
              {schemaError}
            </p>
          ) : null}
          <p className="cc-hint">
            已预填当前版本内容便于修改；建议包含 questions 数组（question_code、question_type、title、
            locked、is_sensitive、required、options）。模板发布将写入审计日志（PRD §11.3）。
          </p>
        </div>
      </Modal>
    </SuperLayout>
  );
}

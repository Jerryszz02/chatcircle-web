import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  SurveyTemplateRecord,
  SurveyTemplateVersionRecord,
} from '../../../shared/api/types';
import { Button, Card, Input, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { createSurveyTemplate, publishTemplateVersion } from '../api';
import { BackupAlarmBanner } from '../components/BackupAlarmBanner';
import { TemplatePreviewModal } from '../components/TemplatePreviewModal';
import { TemplateSchemaEditor } from '../components/TemplateSchemaEditor';
import { useBackupStatus } from '../hooks';
import { formatDateTime } from '../lib/format';
import { ACTIVE_STATUS_LABELS } from '../lib/labels';
import { countLockedQuestions, extractTemplateQuestions } from '../lib/templates';

/**
 * 系统与模板（/super/system）。
 * - 备份状态卡片：最近备份时间/结果；失败显著告警横幅（AC-23）。备份由 deploy/backup.sh
 *   每日自动执行（手动备份端点已下线，410 Gone，2026-08 安全加固），本页只读展示；
 * - 标准问卷模板管理：模板与版本列表、新建模板、新版本发布（FR-SUR-001/011）、锁定题目标识。
 *   模板具体题目内容 PRD 未写死（technical-design 待确认 #5），本页按能力层实现：
 *   版本 schema 由可视化编辑器（TemplateSchemaEditor）产出，已发布版本不可变
 *   （database-design §5.2.13）；新建/发布走后端事务端点并写审计（PRD §11.3）。
 */
export function SuperSystemPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);
  const backup = useBackupStatus();

  // 模板数据
  const [templates, setTemplates] = useState<SurveyTemplateRecord[] | null>(null);
  const [versions, setVersions] = useState<SurveyTemplateVersionRecord[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  // 版本题目预览 / 发布新版本 / 新建模板
  const [previewVersion, setPreviewVersion] = useState<SurveyTemplateVersionRecord | null>(null);
  const [publishTemplate, setPublishTemplate] = useState<SurveyTemplateRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTemplate, setNewTemplate] = useState({ template_code: '', name: '', description: '' });
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

  const onPublishVersion = async (schema: { questions: Record<string, unknown>[] }) => {
    if (!publishTemplate) return;
    setSaving(true);
    try {
      const res = await publishTemplateVersion(publishTemplate.id, schema);
      toast(`已发布版本 v${res.version.version}，仅影响之后新建的活动问卷`, 'success');
      setPublishTemplate(null);
      await loadTemplates();
    } catch (err) {
      // 编辑器内联展示错误、保持打开
      throw normalizeApiError(err);
    } finally {
      setSaving(false);
    }
  };

  const onCreateTemplate = async (schema: { questions: Record<string, unknown>[] }) => {
    const templateCode = newTemplate.template_code.trim();
    const name = newTemplate.name.trim();
    if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(templateCode)) {
      throw new Error('模板代码必填，须为大写字母开头的 2~50 位大写字母/数字/下划线');
    }
    if (!name) {
      throw new Error('模板名称必填');
    }
    setSaving(true);
    try {
      await createSurveyTemplate({
        template_code: templateCode,
        name,
        description: newTemplate.description.trim(),
        schema_json: schema,
      });
      toast(`模板 ${templateCode} 已创建（v1）`, 'success');
      setCreateOpen(false);
      setNewTemplate({ template_code: '', name: '', description: '' });
      await loadTemplates();
    } catch (err) {
      throw normalizeApiError(err);
    } finally {
      setSaving(false);
    }
  };

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
      </Card>

      <Card
        title="标准问卷模板"
        actions={
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            新建模板
          </Button>
        }
      >
        {templates === null ? (
          <Loading />
        ) : templates.length === 0 ? (
          <p className="sa-muted">暂无模板，可点击右上角「新建模板」创建（FR-SUR-001）。</p>
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
                            disabled={!current}
                            onClick={() => current && setPreviewVersion(current)}
                          >
                            预览
                          </Button>
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
                            onClick={() => setPublishTemplate(tpl)}
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

      {/* 版本内容预览：真实渲染参与者填写样式（含锁定题/敏感题标识） */}
      <TemplatePreviewModal
        key={previewVersion?.id ?? 'preview-closed'}
        open={previewVersion !== null}
        title={`内容预览：v${previewVersion?.version ?? ''}`}
        schemaJson={previewVersion?.schema_json ?? null}
        onClose={() => setPreviewVersion(null)}
      />

      {/* 发布新版本（可视化编辑器；已发布版本不可变，FR-SUR-011） */}
      <Modal
        open={publishTemplate !== null}
        title={`发布新版本：${publishTemplate?.name ?? ''}`}
        onClose={() => setPublishTemplate(null)}
      >
        <p className="sa-confirm-warning">
          新版本发布后即不可修改，且只影响之后新建的活动问卷；已复制的活动问卷固定在原版本，不受影响（FR-SUR-011）。
          发布将写入审计日志（PRD §11.3）。
        </p>
        {publishTemplate ? (
          <TemplateSchemaEditor
            key={publishTemplate.id}
            initialSchema={currentVersionOf(publishTemplate)?.schema_json ?? null}
            saving={saving}
            submitLabel="发布"
            onSubmit={onPublishVersion}
            onCancel={() => setPublishTemplate(null)}
          />
        ) : null}
      </Modal>

      {/* 新建模板（含首个版本；后端事务回补 current_version_id） */}
      <Modal
        open={createOpen}
        title="新建问卷模板"
        onClose={() => setCreateOpen(false)}
      >
        <Input
          label="模板代码（template_code）"
          required
          value={newTemplate.template_code}
          hint="大写字母开头的 2~50 位大写字母/数字/下划线，全平台唯一（PRD 附录 B）"
          onChange={(e) => setNewTemplate({ ...newTemplate, template_code: e.target.value })}
        />
        <Input
          label="模板名称"
          required
          value={newTemplate.name}
          onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
        />
        <Input
          label="描述（可选）"
          value={newTemplate.description}
          onChange={(e) => setNewTemplate({ ...newTemplate, description: e.target.value })}
        />
        {createOpen ? (
          <TemplateSchemaEditor
            initialSchema={null}
            saving={saving}
            submitLabel="创建模板"
            onSubmit={onCreateTemplate}
            onCancel={() => setCreateOpen(false)}
          />
        ) : null}
      </Modal>
    </SuperLayout>
  );
}

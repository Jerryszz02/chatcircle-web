import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { collectionsForRole } from '../../../shared/api/collections';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  AdminInviteRecord,
  InviteStatus,
  OrganizationRecord,
} from '../../../shared/api/types';
import { Button, Card, Input, Loading, Modal } from '../../../shared/ui';
import { SuperLayout } from '../SuperLayout';
import { useSuperToast } from '../hooks';
import { createInvite, extractInviteCode, revokeInvite } from '../api';
import { OrgSwitchesEditor } from '../components/OrgSwitchesEditor';
import { formatDateTime } from '../lib/format';
import {
  INVITE_FILTER_OPTIONS,
  canRevokeInvite,
  effectiveInviteStatus,
  filterInvitesByStatus,
} from '../lib/inviteStatus';
import { ACTIVE_STATUS_LABELS, INVITE_STATUS_LABELS } from '../lib/labels';
import type { OrgSwitchKey } from '../lib/orgSwitch';

type OrgWithExpand = OrganizationRecord;
type InviteWithExpand = AdminInviteRecord & {
  expand?: { organization_id?: OrganizationRecord };
};

/** 邀请码有效期可调范围（天）；默认 7 天（PRD §4.2、FR-ORG-002，范围为本端能力层取值）。 */
const DEFAULT_INVITE_DAYS = 7;
const MAX_INVITE_DAYS = 90;

/**
 * 机构管理与邀请码（/super/organizations）。
 * - 机构创建/停用/开关配置（FR-ORG-001/004/005），变更审计由后端 hooks 写入；
 * - 邀请码生成（明文仅展示一次，PRD §11.2）、四态列表、撤销（FR-ORG-002，写审计）。
 */
export function SuperOrganizationsPage() {
  const { toast } = useSuperToast();
  const cc = useMemo(() => collectionsForRole('super'), []);

  const [orgs, setOrgs] = useState<OrgWithExpand[] | null>(null);
  const [invites, setInvites] = useState<InviteWithExpand[] | null>(null);
  const [inviteFilter, setInviteFilter] = useState<InviteStatus | ''>('');
  const [inviteOrgFilter, setInviteOrgFilter] = useState('');

  // 弹窗状态
  const [createOpen, setCreateOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<OrganizationRecord | null>(null);
  const [inviteOrg, setInviteOrg] = useState<OrganizationRecord | null>(null);
  const [inviteDays, setInviteDays] = useState(DEFAULT_INVITE_DAYS);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<InviteWithExpand | null>(null);

  // 新机构表单
  const [newName, setNewName] = useState('');
  const [newRemark, setNewRemark] = useState('');
  const [saving, setSaving] = useState(false);

  const loadOrgs = useCallback(async () => {
    setOrgs(await cc.organizations.getFullList({ sort: 'created' }));
  }, [cc]);

  const loadInvites = useCallback(async () => {
    setInvites(
      await cc.adminInvites.getFullList({ sort: '-created', expand: 'organization_id' }),
    );
  }, [cc]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [orgList, inviteList] = await Promise.all([
          cc.organizations.getFullList({ sort: 'created' }),
          cc.adminInvites.getFullList({ sort: '-created', expand: 'organization_id' }),
        ]);
        if (!cancelled) {
          setOrgs(orgList);
          setInvites(inviteList);
        }
      } catch (err) {
        if (!cancelled) toast(normalizeApiError(err).message, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cc, toast]);

  const visibleInvites = useMemo(() => {
    const byStatus = filterInvitesByStatus(invites ?? [], inviteFilter);
    return inviteOrgFilter
      ? byStatus.filter((inv) => inv.organization_id === inviteOrgFilter)
      : byStatus;
  }, [invites, inviteFilter, inviteOrgFilter]);

  // ---------- 机构操作 ----------

  const onCreateOrg = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await cc.organizations.create({
        name: newName.trim(),
        remark: newRemark.trim() || undefined,
        status: 'active',
        // 新机构默认两个开关均关闭：发布直发、不允许敏感导出（最小权限起点）
        require_activity_approval: false,
        allow_sensitive_export: false,
      });
      toast('机构已创建', 'success');
      setCreateOpen(false);
      setNewName('');
      setNewRemark('');
      await loadOrgs();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onToggleOrgStatus = async (org: OrganizationRecord) => {
    setSaving(true);
    try {
      await cc.organizations.update(org.id, {
        status: org.status === 'active' ? 'disabled' : 'active',
      });
      toast(org.status === 'active' ? '机构已停用，其管理员将无法进入后台' : '机构已启用', 'success');
      await loadOrgs();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onSaveSwitches = async (next: Record<OrgSwitchKey, boolean>) => {
    if (!editOrg) return;
    setSaving(true);
    try {
      await cc.organizations.update(editOrg.id, next);
      toast('机构开关已更新', 'success');
      await loadOrgs();
      setEditOrg(null);
    } catch (err) {
      // 抛回给编辑器展示错误，弹窗保留
      setSaving(false);
      throw err;
    }
    setSaving(false);
  };

  // ---------- 邀请码操作 ----------

  const onGenerateInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteOrg) return;
    setSaving(true);
    try {
      const res = await createInvite({
        organization_id: inviteOrg.id,
        expires_in_days: inviteDays,
      });
      const code = extractInviteCode(res);
      setGeneratedCode(code || '（服务端未返回明文，请在审计日志中核对生成记录）');
      await loadInvites();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const onCopyCode = async () => {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      toast('已复制到剪贴板', 'success');
    } catch {
      toast('复制失败，请手动选中复制', 'error');
    }
  };

  const onRevokeInvite = async () => {
    if (!revokingInvite) return;
    setSaving(true);
    try {
      await revokeInvite(revokingInvite.id);
      toast('邀请码已撤销', 'success');
      setRevokingInvite(null);
      await loadInvites();
    } catch (err) {
      toast(normalizeApiError(err).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SuperLayout title="机构管理与邀请码">
      <Card
        title="机构列表"
        actions={<Button onClick={() => setCreateOpen(true)}>创建机构</Button>}
      >
        {orgs === null ? (
          <Loading />
        ) : orgs.length === 0 ? (
          <p className="sa-muted">暂无机构，请先创建。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>机构名称</th>
                  <th>状态</th>
                  <th>发布需平台审核</th>
                  <th>允许敏感导出</th>
                  <th>备注</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((org) => (
                  <tr key={org.id}>
                    <td className="sa-cell-wrap">{org.name}</td>
                    <td>
                      <span
                        className={`sa-badge ${org.status === 'active' ? 'sa-badge-success' : 'sa-badge-danger'}`}
                      >
                        {ACTIVE_STATUS_LABELS[org.status]}
                      </span>
                    </td>
                    <td>{org.require_activity_approval ? '开启' : '关闭'}</td>
                    <td>{org.allow_sensitive_export ? '开启' : '关闭'}</td>
                    <td className="sa-cell-wrap">{org.remark ?? '—'}</td>
                    <td>{formatDateTime(org.created)}</td>
                    <td>
                      <div className="sa-actions">
                        <Button variant="secondary" onClick={() => setEditOrg(org)}>
                          配置开关
                        </Button>
                        <Button
                          variant={org.status === 'active' ? 'danger' : 'secondary'}
                          disabled={saving}
                          onClick={() => void onToggleOrgStatus(org)}
                        >
                          {org.status === 'active' ? '停用' : '启用'}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={org.status !== 'active'}
                          onClick={() => {
                            setInviteOrg(org);
                            setInviteDays(DEFAULT_INVITE_DAYS);
                          }}
                        >
                          生成邀请码
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="管理员邀请码">
        <div className="sa-filter-bar">
          <div className="cc-field">
            <label className="cc-label" htmlFor="invite-status-filter">
              状态
            </label>
            <select
              id="invite-status-filter"
              className="sa-select"
              value={inviteFilter}
              onChange={(e) => setInviteFilter(e.target.value as InviteStatus | '')}
            >
              {INVITE_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="cc-field">
            <label className="cc-label" htmlFor="invite-org-filter">
              机构
            </label>
            <select
              id="invite-org-filter"
              className="sa-select"
              value={inviteOrgFilter}
              onChange={(e) => setInviteOrgFilter(e.target.value)}
            >
              <option value="">全部机构</option>
              {(orgs ?? []).map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {invites === null ? (
          <Loading />
        ) : visibleInvites.length === 0 ? (
          <p className="sa-muted">暂无符合条件的邀请码。</p>
        ) : (
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>机构</th>
                  <th>状态</th>
                  <th>有效期至</th>
                  <th>使用人</th>
                  <th>使用时间</th>
                  <th>生成时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleInvites.map((inv) => {
                  const eff = effectiveInviteStatus(inv);
                  return (
                    <tr key={inv.id}>
                      <td className="sa-cell-wrap">
                        {inv.expand?.organization_id?.name ?? inv.organization_id}
                      </td>
                      <td>
                        <span
                          className={`sa-badge ${
                            eff === 'unused'
                              ? 'sa-badge-info'
                              : eff === 'used'
                                ? 'sa-badge-success'
                                : 'sa-badge-danger'
                          }`}
                        >
                          {INVITE_STATUS_LABELS[eff]}
                        </span>
                      </td>
                      <td>{formatDateTime(inv.expires_at)}</td>
                      <td>{inv.used_by ?? '—'}</td>
                      <td>{formatDateTime(inv.used_at)}</td>
                      <td>{formatDateTime(inv.created)}</td>
                      <td>
                        {canRevokeInvite(inv) ? (
                          <Button variant="danger" onClick={() => setRevokingInvite(inv)}>
                            撤销
                          </Button>
                        ) : (
                          <span className="sa-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="sa-muted">
          邀请码明文仅在生成时展示一次，表中不保存明文（仅存哈希，PRD §11.2）。
        </p>
      </Card>

      {/* 创建机构 */}
      <Modal
        open={createOpen}
        title="创建机构"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button type="submit" form="sa-create-org-form" loading={saving}>
              创建
            </Button>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
          </>
        }
      >
        <form id="sa-create-org-form" onSubmit={(e) => void onCreateOrg(e)}>
          <Input
            label="机构名称"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
          />
          <Input
            label="内部备注"
            value={newRemark}
            onChange={(e) => setNewRemark(e.target.value)}
            hint="选填，仅平台内部可见"
          />
          <p className="sa-muted">
            新机构默认：活动发布直发（不需平台审核）、不允许机构管理员敏感导出；创建后可在「配置开关」中变更，变更将写入审计日志。
          </p>
        </form>
      </Modal>

      {/* 配置机构开关（确认流见 OrgSwitchesEditor） */}
      <Modal
        open={editOrg !== null}
        title={`配置开关：${editOrg?.name ?? ''}`}
        onClose={() => setEditOrg(null)}
      >
        {editOrg ? (
          <>
            <OrgSwitchesEditor org={editOrg} saving={saving} onSave={onSaveSwitches} />
            <p className="sa-muted">开关变更属于高风险操作，将由服务端写入审计日志（FR-AUD-004）。</p>
          </>
        ) : null}
      </Modal>

      {/* 生成邀请码 */}
      <Modal
        open={inviteOrg !== null && generatedCode === null}
        title={`生成邀请码：${inviteOrg?.name ?? ''}`}
        onClose={() => setInviteOrg(null)}
        footer={
          <>
            <Button type="submit" form="sa-invite-form" loading={saving}>
              生成
            </Button>
            <Button variant="secondary" onClick={() => setInviteOrg(null)}>
              取消
            </Button>
          </>
        }
      >
        <form id="sa-invite-form" onSubmit={(e) => void onGenerateInvite(e)}>
          <Input
            label="有效期（天）"
            type="number"
            min={1}
            max={MAX_INVITE_DAYS}
            value={inviteDays}
            onChange={(e) => setInviteDays(Number(e.target.value) || DEFAULT_INVITE_DAYS)}
            hint={`默认 ${DEFAULT_INVITE_DAYS} 天，可按需调整（FR-ORG-002）`}
            required
          />
          <p className="sa-muted">
            邀请码为一次性使用：注册成功一个管理员后立即失效；明文仅生成后展示一次，请当场复制并安全下发。
          </p>
        </form>
      </Modal>

      {/* 邀请码明文（仅展示一次） */}
      <Modal
        open={generatedCode !== null}
        title="邀请码已生成（仅此一次展示）"
        onClose={() => {
          setGeneratedCode(null);
          setInviteOrg(null);
        }}
        footer={
          <>
            <Button onClick={() => void onCopyCode()}>复制邀请码</Button>
            <Button
              variant="secondary"
              onClick={() => {
                setGeneratedCode(null);
                setInviteOrg(null);
              }}
            >
              完成
            </Button>
          </>
        }
      >
        <p className="sa-confirm-warning sa-confirm-warning-high" role="alert">
          请立即复制并安全下发；关闭后平台无法再次查看该邀请码明文。
        </p>
        <p className="sa-invite-code">{generatedCode}</p>
      </Modal>

      {/* 撤销邀请码确认 */}
      <Modal
        open={revokingInvite !== null}
        title="撤销邀请码"
        onClose={() => setRevokingInvite(null)}
        footer={
          <>
            <Button variant="danger" loading={saving} onClick={() => void onRevokeInvite()}>
              确认撤销
            </Button>
            <Button variant="secondary" onClick={() => setRevokingInvite(null)}>
              取消
            </Button>
          </>
        }
      >
        <p>
          确认撤销该邀请码？撤销后立即失效、不能再用于注册管理员；该操作将写入审计日志。
        </p>
      </Modal>
    </SuperLayout>
  );
}

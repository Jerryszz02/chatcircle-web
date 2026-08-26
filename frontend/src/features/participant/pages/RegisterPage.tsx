import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { normalizeApiError } from '../../../shared/api/http';
import { collectionsForRole } from '../../../shared/api/collections';
import { participantAuth } from '../../../shared/auth';
import { useSessionSnapshot } from '../../../shared/session';
import { pbClients } from '../../../shared/pocketbase';
import type { RegistrationRecord } from '../../../shared/api/types';
import { Button, Card, Loading, PageLayout } from '../../../shared/ui';
import { registerForActivity } from '../api';
import { ParticipantAuthForm } from '../components/ParticipantAuthForm';
import { RegistrationForm } from '../components/RegistrationForm';
import { registrationClosedReasonCopy, registrationStatusMeta } from '../lib/status';
import { usePublicActivity } from '../lib/usePublicActivity';

/**
 * 报名链路（/a/:activityId/register）：
 * 点击报名 → 用户名密码单框自动识别登录/注册（错误密码提示不建号，AC-06）
 * → 登录后报名表单（FR-REG-001/002）→ 提交成功页回访指引（FR-PAR-003）。
 * 同一参与者同一活动仅一条报名（FR-REG-003）：已报名则直接展示当前状态。
 */

type RegCheck =
  | { phase: 'idle' | 'checking' }
  | { phase: 'none' }
  | { phase: 'exists'; registration: RegistrationRecord }
  | { phase: 'failed'; message: string };

/** 报名状态展示（已报名回看 / 提交成功后共用）。 */
function RegistrationStatusView({
  registration,
  activityId,
  justSubmitted,
}: {
  registration: RegistrationRecord;
  activityId: string;
  justSubmitted: boolean;
}) {
  const meta = registrationStatusMeta(registration.status);
  return (
    <>
      <Card title={justSubmitted ? '报名已提交' : '我的报名'}>
        <p>
          当前状态：
          <span className={`cc-tag cc-tag-${meta.tone}`}>{meta.label}</span>
        </p>
        <p className="cc-hint">{meta.hint}</p>
        {registration.status_reason ? (
          <p className="cc-hint">原因：{registration.status_reason}</p>
        ) : null}
      </Card>
      {justSubmitted ? (
        <Card title="请保存好您的凭据">
          <ul className="cc-guide-list">
            <li>用户名和密码是您查看审核结果、现场签到与填写问卷的唯一凭据，请截图或抄写保存；平台不提供找回。</li>
            <li>审核结果不会通过短信或微信通知，请在活动开始前使用用户名和密码登录「我的」中心查看。</li>
          </ul>
        </Card>
      ) : null}
      <div className="cc-actions">
        <Link to="/me" className="cc-btn cc-btn-primary cc-btn-block">
          前往「我的」中心
        </Link>
        <Link to={`/a/${activityId}`} className="cc-btn cc-btn-secondary cc-btn-block">
          返回活动详情
        </Link>
      </div>
    </>
  );
}

export function RegisterPage() {
  const { activityId = '' } = useParams();
  const { data, error, loading, reload } = usePublicActivity(activityId);
  // 登录成功后自增，触发本人报名检查重跑。
  const [authVersion, setAuthVersion] = useState(0);
  const [regCheck, setRegCheck] = useState<RegCheck>({ phase: 'idle' });
  const [submitted, setSubmitted] = useState<RegistrationRecord | null>(null);

  // 订阅会话变化：登录/登出（含其它链路触发的登出）后表单区即时切换
  useSessionSnapshot();
  const authed = participantAuth.isValid();
  const registrationOpen = data?.registration.open ?? false;

  // 登录后检查本人是否已有本活动报名（FR-REG-003 重复进入显示现有状态）。
  useEffect(() => {
    if (!authed || !registrationOpen) return;
    let cancelled = false;
    setRegCheck({ phase: 'checking' });
    collectionsForRole('participant')
      .registrations.getList(1, 1, {
        filter: pbClients.participant.filter('activity_id = {:activityId}', { activityId }),
      })
      .then((res) => {
        if (cancelled) return;
        const existing = res.items[0];
        setRegCheck(
          existing ? { phase: 'exists', registration: existing } : { phase: 'none' },
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setRegCheck({ phase: 'failed', message: normalizeApiError(err).message });
      });
    return () => {
      cancelled = true;
    };
  }, [authed, registrationOpen, activityId, authVersion]);

  return (
    <PageLayout section="参与者端" title="活动报名" className="ccp-root">
      <div className="cc-auth-mark" aria-hidden="true">
        <span />
        <span />
      </div>
      {loading ? <Loading fullscreen /> : null}

      {!loading && error ? (
        <Card>
          <p>{error.status === 404 || error.status === 403 ? '活动不存在或未开放' : error.message}</p>
          {error.status !== 404 && error.status !== 403 ? (
            <Button variant="secondary" onClick={reload}>
              重试
            </Button>
          ) : null}
        </Card>
      ) : null}

      {!loading && data && !registrationOpen ? (
        <Card>
          {(() => {
            const copy = registrationClosedReasonCopy(data.registration.reason);
            return (
              <>
                <p className="cc-closed-title">{copy.title}</p>
                <p className="cc-hint">{copy.detail}</p>
              </>
            );
          })()}
          <Link to={`/a/${activityId}`} className="cc-btn cc-btn-secondary cc-btn-block">
            返回活动详情
          </Link>
        </Card>
      ) : null}

      {!loading && data && registrationOpen && submitted ? (
        <RegistrationStatusView registration={submitted} activityId={activityId} justSubmitted />
      ) : null}

      {!loading && data && registrationOpen && !submitted && !authed ? (
        <>
          <Card title={`报名：${data.activity.title}`}>
            <ParticipantAuthForm
              showPrivacyNotice
              intro="输入用户名和密码：新用户名将自动注册并登录，已有用户名请输入对应密码登录。"
              onSuccess={() => setAuthVersion((v) => v + 1)}
            />
          </Card>
          <p className="cc-hint">
            报名需要先登录；平台不会向您的手机或微信发送任何消息。
          </p>
        </>
      ) : null}

      {!loading && data && registrationOpen && !submitted && authed && regCheck.phase === 'checking' ? (
        <Loading fullscreen label="正在确认报名信息…" />
      ) : null}

      {!loading && data && registrationOpen && !submitted && authed && regCheck.phase === 'failed' ? (
        <Card>
          <p>{regCheck.message}</p>
          <Button variant="secondary" onClick={() => setAuthVersion((v) => v + 1)}>
            重试
          </Button>
        </Card>
      ) : null}

      {!loading && data && registrationOpen && !submitted && authed && regCheck.phase === 'exists' ? (
        <RegistrationStatusView registration={regCheck.registration} activityId={activityId} justSubmitted={false} />
      ) : null}

      {!loading && data && registrationOpen && !submitted && authed && regCheck.phase === 'none' ? (
        <Card title={`报名表：${data.activity.title}`}>
          <RegistrationForm
            fields={data.registration_fields}
            remaining={{
              total: data.registration.remaining_total,
              speaker: data.registration.remaining_speaker,
              listener: data.registration.remaining_listener,
            }}
            submitRegistration={(input) =>
              registerForActivity(activityId, input).then((res) => res.registration)
            }
            onSubmitted={setSubmitted}
          />
        </Card>
      ) : null}
    </PageLayout>
  );
}

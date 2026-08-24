import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { normalizeApiError } from '../../../shared/api/http';
import { participantAuth } from '../../../shared/auth';
import { Button, Card, Loading, PageLayout } from '../../../shared/ui';
import { isUnauthorized, selfTrainingCheckin } from '../api';
import { formatDateTime, trainingCheckinFailureCopy } from '../lib/status';

/**
 * 培训扫码签到落地页（/training-checkin/:token）。
 * 固定二维码内容指向本页（token = 培训的 checkin_qr_token，不暴露培训 id）；
 * 有效性由签到开放状态控制。进入页面即发起一次自助签到：
 * - 成功 → 展示签到时间与结果；
 * - 重复扫码 → 服务端幂等返回已有记录，展示「已签到」不报错；
 * - 失败按原因分开展示：未开放 / 已结束 / 聆听者报名未通过（listener_not_approved）。
 */
type Phase =
  | { kind: 'loading' }
  | { kind: 'success'; checkedInAt: string; already: boolean }
  | { kind: 'failed'; title: string; detail: string };

export function TrainingCheckinPage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  const attempt = useCallback(() => {
    if (!token) {
      setPhase({ kind: 'failed', title: '链接无效', detail: '缺少签到标识，请确认二维码完整。' });
      return;
    }
    setPhase({ kind: 'loading' });
    selfTrainingCheckin(token)
      .then((res) => {
        setPhase({
          kind: 'success',
          checkedInAt: res.attendance.checked_in_at,
          already: res.already_checked_in === true,
        });
      })
      .catch((err) => {
        const apiErr = normalizeApiError(err);
        if (isUnauthorized(apiErr)) {
          participantAuth.logout();
          navigate(`/login?redirect=${encodeURIComponent(`/training-checkin/${token}`)}`, {
            replace: true,
          });
          return;
        }
        const copy = trainingCheckinFailureCopy(apiErr);
        setPhase({ kind: 'failed', title: copy.title, detail: copy.detail });
      });
  }, [token, navigate]);

  useEffect(() => {
    attempt();
  }, [attempt]);

  return (
    <PageLayout section="参与者端" title="培训签到" className="ccp-root">
      {phase.kind === 'loading' ? <Loading fullscreen label="正在签到…" /> : null}

      {phase.kind === 'success' ? (
        <Card>
          <p className="cc-result-title">{phase.already ? '您已签到' : '签到成功'}</p>
          <p className="cc-hint">
            签到时间：{formatDateTime(phase.checkedInAt)}
            {phase.already ? '（重复扫码不会产生新的签到记录）' : ''}
          </p>
          <Link to="/trainings" className="cc-btn cc-btn-secondary cc-btn-block">
            查看我的培训
          </Link>
        </Card>
      ) : null}

      {phase.kind === 'failed' ? (
        <Card>
          <p className="cc-result-title cc-result-failed">{phase.title}</p>
          <p className="cc-hint">{phase.detail}</p>
          <div className="cc-actions">
            <Button variant="secondary" block onClick={attempt}>
              重试
            </Button>
            <Link to="/trainings" className="cc-btn cc-btn-secondary cc-btn-block">
              查看我的培训
            </Link>
          </div>
        </Card>
      ) : null}
    </PageLayout>
  );
}

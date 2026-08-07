import { Link } from 'react-router-dom';
import { PageLayout } from '../../../shared/ui';
import { ProjectIntro } from '../components/ProjectIntro';
import { HeaderActions } from '../components/HeaderActions';

/**
 * 首页（/，未登录可看）：平台介绍落地页。
 * 只保留项目介绍与导航；活动广场与问卷入口已拆到独立页 /activities
 * （浏览活动不需要账号；报名与填写问卷时在对应链路内登录/自动注册，FR-AUTH-001）。
 */
export function HomePage() {
  return (
    <PageLayout actions={<HeaderActions />} className="ccp-root">
      <section className="ccp-hero" aria-label="平台介绍">
        <div className="ccp-hero-rings" aria-hidden="true">
          <span />
          <span />
        </div>
        <p className="ccp-hero-eyebrow">参与者端</p>
        <h1 className="ccp-hero-title">Chat Circles</h1>
        <p className="ccp-hero-sub">
          安全表达，认真倾听，形成连接。浏览活动无需账号；报名活动、填写问卷时需要登录，
          报名过程中输入用户名和密码即可自动注册。
        </p>
        <Link to="/activities" className="cc-btn cc-btn-primary ccp-hero-cta">
          浏览活动与问卷
        </Link>
      </section>

      {/* 页内锚点导航：项目介绍区块 + 活动/问卷独立页（吸顶，样式见 participant.css .ccp-nav） */}
      <nav className="ccp-nav" aria-label="页面导航">
        <a href="#challenge">挑战</a>
        <a href="#programme">计划</a>
        <a href="#impact">影响</a>
        <a href="#measurement">成效评估</a>
        <a href="#partners">合作伙伴</a>
        <Link to="/activities#activities">活动</Link>
        <Link to="/activities#surveys">问卷</Link>
      </nav>

      <ProjectIntro />
    </PageLayout>
  );
}

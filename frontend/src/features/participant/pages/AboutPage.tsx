import { Link } from 'react-router-dom';
import { PublicPageLayout } from '../components/PublicPageLayout';

/**
 * 关于我们（/about，未登录可看）：Chat Circles 项目完整介绍（2026-08 UI 重构新增）。
 * 内容依据《Chat Circles 项目简介（2026 年 8 月）》改写为面向 C 端的通俗中文，
 * 替代原首页计划书口径的长介绍（ProjectIntro，已随重构移除）。
 * 区块：我们是谁 → 为什么重要 → 项目模式 → 一场活动怎么走 → 首场试点成果 →
 * 如何参与 → 合作与支持 → 运营方。
 */

/** 「为什么重要」数据点（来源：中科院心理所《中国国民心理健康发展报告（2021—2022）》）。 */
const WHY_FACTS = [
  { value: '14.8%', note: '我国 8–20 岁青少年抑郁风险检出率，约每 7 人中 1 人' },
  { value: '40%', note: '的青少年感到孤独' },
  { value: '21.48%', note: '大学生抑郁风险检出率' },
  { value: '45.28%', note: '大学生焦虑风险检出率' },
];

/** 项目模式三步：一套体系，而非一次活动。 */
const MODEL_STEPS = [
  {
    num: '1',
    title: '倾听者培训',
    sub: '3 小时工作坊',
    desc: '每位倾听者先完成 3 小时的专业培训：主动倾听、发掘优势、边界与转介。培训前后还会测量倾听者的自信心变化。',
  },
  {
    num: '2',
    title: '对话活动',
    sub: '2 小时',
    desc: '正念开场 + 60 分钟一对一对话 + 团体反思与资源分享。一个安全、温暖、刻意非临床的空间。',
  },
  {
    num: '3',
    title: '双向影响',
    sub: '两类受益者',
    desc: '青年减轻压力、建立能动性；志愿者获得技能与成就感。一个项目，两类受益者。',
  },
];

/** 一场 2 小时活动的流程。 */
const ACTIVITY_FLOW = [
  { time: '开场', name: '正念安定', desc: '在引导下做简短的正念练习，让身心先慢下来。' },
  { time: '60 分钟', name: '一对一对话', desc: '活动的核心：由提示卡引导、以正向心理学为框架的结构化对话。' },
  { time: '收尾', name: '团体反思', desc: '围在一起分享一个收获，并获得后续支持资源的信息。' },
];

/** 首场试点成果（2026-06-12，匿名问卷，倾诉者 n=13、倾听者 n=15）。 */
const PILOT_METRICS = [
  { value: '−2.15', note: '倾诉者自报压力（0–10 分）：5.08 → 2.92，13 人中 11 人下降' },
  { value: '+1.00', note: '积极情绪（1–5 分）：2.43 → 3.43，13 人中 10 人上升' },
  { value: '77%', note: '参与者认同「今天的对话让我感到被真正倾听」' },
  { value: '60', note: '倾听者净推荐值 NPS（推荐分 9.07 / 10）' },
  { value: '73%', note: '倾听者愿意再次服务（15 人中 11 人）' },
];

/** 合作与支持的四类资源（面向基金会 / 企业 / 社区伙伴）。 */
const SUPPORT_TYPES = [
  { title: '公益资金', desc: '试点期项目运营经费：倾听者培训、活动组织、测量与评估、平台运营。' },
  {
    title: '活动场地',
    desc: '适合 20–30 人、氛围轻松的社区空间（每场约 2 小时）——咖啡馆、社区中心、企业空间均可。',
  },
  { title: '员工志愿者', desc: '员工或伙伴网络成员担任倾听者：每人 3 小时培训 + 2 小时活动。' },
  { title: '饮品与物料', desc: '活动期间的饮品与基础物料支持，降低青年的参与心理门槛。' },
];

export function AboutPage() {
  return (
    <PublicPageLayout>
      <header className="ccp-about-hero">
        <p className="cc-label-eyebrow">关于我们</p>
        <h1 className="ccp-about-title">关于 Chat Circles</h1>
        <p className="ccp-about-lead">
          一个青年心理健康公益项目：把「想说说不出」的青年，和「愿意认真听」的志愿者，带到同一张桌子前。
        </p>
      </header>

      {/* 我们是谁 */}
      <section aria-labelledby="about-who" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-who">
          我们是谁
        </h2>
        <p className="ccp-about-text">
          Chat Circles 是由社会企业 Empact
          发起的青年心理健康公益项目。我们把经过 3 小时专业培训的志愿者（「倾听者」），与处于升学、初入职场等过渡期的青年（「倾诉者」）一对一配对，在一个安全、温暖、刻意非临床的空间里，进行
          60 分钟以正向心理学为框架的结构化对话——没有评判，没有建议，只有真正的倾听。
        </p>
      </section>

      {/* 为什么重要 */}
      <section aria-labelledby="about-why" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-why">
          为什么重要
        </h2>
        <p className="ccp-about-text">
          许多处于压力中的青年并不需要临床干预，但也找不到一个低门槛、不被另眼相看的倾诉出口——专业服务门槛太高，朋友之间又难以开口。Chat
          Circles 填补的正是这层「社区第一层心理支持」的缺口，并在需要时提供清晰的转介路径。
        </p>
        <ul className="ccp-metric-grid">
          {WHY_FACTS.map((fact) => (
            <li key={fact.note} className="cc-metric">
              <p className="cc-metric-value">{fact.value}</p>
              <p className="cc-metric-note">{fact.note}</p>
            </li>
          ))}
        </ul>
        <p className="ccp-about-footnote">
          数据来源：中国科学院心理研究所《中国国民心理健康发展报告（2021—2022）》。
        </p>
      </section>

      {/* 项目模式 */}
      <section aria-labelledby="about-model" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-model">
          项目模式：一套体系，而非一次活动
        </h2>
        <ol className="ccp-step-list">
          {MODEL_STEPS.map((step) => (
            <li key={step.num} className="ccp-step">
              <span className="ccp-step-num" aria-hidden="true">
                {step.num}
              </span>
              <div>
                <h3 className="ccp-step-title">
                  {step.title}
                  <span className="ccp-step-sub">{step.sub}</span>
                </h3>
                <p className="ccp-about-text">{step.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* 一场活动怎么走 */}
      <section aria-labelledby="about-flow" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-flow">
          一场活动怎么走
        </h2>
        <ol className="ccp-flow-list">
          {ACTIVITY_FLOW.map((flow) => (
            <li key={flow.name} className="ccp-flow-item">
              <p className="ccp-flow-time">{flow.time}</p>
              <h3 className="ccp-flow-name">{flow.name}</h3>
              <p className="ccp-about-text">{flow.desc}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* 首场试点成果 */}
      <section aria-labelledby="about-pilot" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-pilot">
          首场试点成果
        </h2>
        <p className="ccp-about-text">
          2026 年 6 月 12 日，首场活动迎来 13 位青年倾诉者与 15 位企业员工倾听者。
          所有数据来自活动前、离场时及四周后的匿名问卷，由匿名 ID 匹配同一位参与者的前后测。
        </p>
        <ul className="ccp-metric-grid">
          {PILOT_METRICS.map((metric) => (
            <li key={metric.note} className="cc-metric">
              <p className="cc-metric-value">{metric.value}</p>
              <p className="cc-metric-note">{metric.note}</p>
            </li>
          ))}
        </ul>
        <blockquote className="ccp-quote">
          <p className="ccp-quote-text">「一个暂停下来、梳理自己的机会……结束后很有力量。」</p>
          <cite className="ccp-quote-source">—— 首场活动倾诉者 · 离场问卷</cite>
        </blockquote>
        <p className="ccp-about-footnote">
          四周后跟进（回收 6/13）：全部受访者表示更愿意在对话中敞开心扉，希望感未见回落。
          本项目当前为单场试点、小样本自报数据，我们将其作为关联性证据诚实呈现，并将在规模化阶段引入更严格的评估设计。
        </p>
      </section>

      {/* 如何参与 */}
      <section aria-labelledby="about-join" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-join">
          如何参与
        </h2>
        <div className="ccp-card-grid">
          <div className="ccp-card">
            <div className="ccp-card-body">
              <h3 className="ccp-card-title">我想倾诉</h3>
              <p className="ccp-about-text">
                如果你正处在升学、初入职场等过渡期，想找个安全的地方把心里的话说出来——报名下一场活动，到场签到后由工作人员按现场顺序安排倾听者，聊
                60 分钟。
              </p>
              <Link to="/activities" className="cc-btn cc-btn-primary cc-btn-block">
                浏览活动并报名
              </Link>
            </div>
          </div>
          <div className="ccp-card">
            <div className="ccp-card-body">
              <h3 className="ccp-card-title">我想成为倾听者</h3>
              <p className="ccp-about-text">
                完成 3
                小时倾听培训后即可参与活动服务。你将学会主动倾听与支持性提问——不给建议，只给出全神贯注的关注。
              </p>
              <Link to="/activities" className="cc-btn cc-btn-secondary cc-btn-block">
                查看培训与活动
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* 合作与支持 */}
      <section aria-labelledby="about-support" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-support">
          合作与支持
        </h2>
        <p className="ccp-about-text">
          Chat Circles 模式轻量、可复制。如果你是基金会、企业或社区伙伴，可以通过以下任意一种方式参与：
        </p>
        <ul className="ccp-card-grid">
          {SUPPORT_TYPES.map((support) => (
            <li key={support.title} className="ccp-card">
              <div className="ccp-card-body">
                <h3 className="ccp-card-title">{support.title}</h3>
                <p className="ccp-about-text">{support.desc}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="ccp-about-text">
          合作洽谈请联系：
          <a href="mailto:maggie.yang@empact.sg" className="ccp-text-link">
            maggie.yang@empact.sg
          </a>
        </p>
      </section>

      {/* 运营方 */}
      <section aria-labelledby="about-operator" className="ccp-about-section">
        <h2 className="ccp-section-title" id="about-operator">
          运营方
        </h2>
        <p className="ccp-about-text">
          Chat Circles 由社会企业 Empact 发起与运营，与国内成熟青少年心理健康服务机构合作开展，
          并通过 Empact 自建影响力评估框架对每场活动进行数字化测量与分析。
        </p>
      </section>
    </PublicPageLayout>
  );
}

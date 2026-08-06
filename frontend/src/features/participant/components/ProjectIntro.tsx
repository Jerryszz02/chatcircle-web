/**
 * 首页项目介绍：移植自 Chat Circles 计划书（chat_circles_proposal_zh）的公开内容，
 * 按现有参与者端视觉语言（global.css token + participant.css 的 .ccp-* 类）重排。
 * 文案在计划书基础上仅去掉了资助申请框架（资助方/申请书措辞），内容本身不变。
 * 纯静态展示，无数据依赖；锚点 id 供首页吸顶导航跳转。
 */

const PROBLEM_CARDS = [
  {
    label: '压力无处释放',
    title: '压力悄然积聚',
    desc: '学业压力、父母期待、同辈竞争与对未来的迷茫，在人生过渡期同时涌现。然而许多青年缺乏一个安全、低门槛的空间去倾诉——一个不怕被评判、被建议、被追责的地方。',
    tint: '',
  },
  {
    label: '连结的缺失',
    title: '被人群包围，却无人真正看见',
    desc: '数字联结制造了社交生活的假象，却缺乏其本质。许多新加坡年轻人拥有数百个网络联系人，却难以说出一个可以真正坦诚相待的人。',
    tint: 'ccp-tint-accent',
  },
  {
    label: '污名化与资源获取',
    title: '寻求帮助并不容易',
    desc: '即使青年意识到自己正在挣扎，寻求专业支持的门槛依然很高。污名化、费用以及现有服务的临床性质，使许多年轻人选择独自承受。',
    tint: 'ccp-tint-info',
  },
  {
    label: '体系中的缺口',
    title: '第一层支持严重不足',
    desc: '新加坡心理健康策略将上游预防列为最高优先事项，然而面向青年的社区层面日常身心支持，与临床服务相比仍严重不足。差距最大之处，恰恰是最有可能预防问题的地方。',
    tint: 'ccp-tint-brand',
  },
];

const TRANSITIONS = [
  {
    title: '学校到学校',
    desc: '每次转变都打散了原有的社交网络，要求青年迅速融入陌生的环境与同辈群体',
  },
  {
    title: '学校到职场',
    desc: '踏入职场带来身份认同的转变、新的权力关系，以及失去学校所提供的结构性支持体系',
  },
  {
    title: '角色到角色',
    desc: '职业生涯初期的频繁转换，带来反复的适应循环、归属感焦虑，以及从头重建身份认同的需要',
  },
];

const PACKAGES = [
  {
    num: '1',
    title: '聆听者培训',
    sub: '活动开始前',
    desc: '每位聆听者须完成一个3小时的身心健康对话技能工作坊，学习主动聆听、发掘优势和正向心理学，并通过结构性角色扮演进行实践，方可参与活动。',
    who: '受益对象：聆听者',
    tint: 'ccp-tint-accent',
  },
  {
    num: '2',
    title: 'Chat Circles 活动',
    sub: '活动本身',
    desc: '一个2小时的引导式体验——正念开场、在饮料陪伴下进行的一对一结构性对话、团体分享与结束环节。一个安全、温暖、非临床的真实人际连结空间。',
    who: '受益对象：倾诉者 + 聆听者',
    tint: 'ccp-tint-brand',
  },
  {
    num: '3',
    title: '双向影响',
    sub: '综合成果',
    desc: '倾诉者体验被聆听、减轻压力、建立能动性；聆听者获得真实技能、找到成就感，并往往进一步追求自我发展。一个计划，两类受益者，成倍放大的影响力。',
    who: '受益对象：倾诉者 + 聆听者 + 生态系统',
    tint: 'ccp-tint-info',
  },
];

const PILLARS = [
  { title: '正向心理学框架', sub: '以优势为本，而非聚焦问题', accent: false },
  { title: '一对一，无旁观者', sub: '私密、安全、保密', accent: true },
  { title: '正念开场', sub: 'Hush 聋人引导员，呼吸技巧', accent: false },
  { title: '由参与者主导的结束环节', sub: '一个收获，一个被点名的优势', accent: true },
  { title: '清晰的转介途径', sub: '有需要时提供进一步支持', accent: false },
];

const FLOW_STEPS = [
  { time: '20分钟', name: '到达', desc: '倾诉者选择聆听者，饮料点好，氛围逐渐安定。' },
  { time: '10分钟', name: '情境说明', desc: '主持人热情欢迎，讲解对话礼仪，确保安全感。' },
  { time: '15分钟', name: '安定身心', desc: 'Hush 引导员使用触感物品和呼吸练习带领正念活动。' },
  { time: '60分钟', name: '对话', desc: '活动的核心。由提示卡引导，聚焦于优势。' },
  { time: '15分钟', name: '反思', desc: '团体分享，说出一个收获，分享后续资源。' },
];

const CHATTER_POINTS = [
  '根据第一印象选择聆听者——从一开始便拥有自主权',
  '分享自己生命中有意义、有目的的时刻',
  '借助触感提示物练习命名自身情绪',
  '带着一个被点名的优势和一个有意义的收获离开',
  '如需进一步支持，可获得转介信息',
];

const LISTENER_POINTS = [
  '在整整60分钟内给予全神贯注、不带评判的关注',
  '以正向心理学为引导，提出开放性、向前看的问题',
  '反映所听到的内容——从不给建议、修正或转移话题',
  '在倾诉者的分享中点出一个优势或有意义的特质',
  '能识别何时需要让主办方介入以提供更多支持',
];

const TRAINING_BLOCKS = [
  {
    mins: '30',
    title: '欢迎、背景与自我觉察',
    desc: '聆听者了解自身角色及其边界。他们从自身的情绪觉察练习开始——先亲身体验他们将为倾诉者创造的感受。完成培训前自信心调查。',
    tags: ['自我反思', '角色清晰', '基线调查'],
  },
  {
    mins: '45',
    title: '核心对话技能',
    desc: '主动聆听、不带评判的临在，以及支持性提问。实际示范与配对练习，聚焦于聆听与建议之间的区别——这是新志愿者最常见的盲点。',
    tags: ['主动聆听', '开放性问题', '配对练习'],
  },
  {
    mins: '30',
    title: '正向心理学要领',
    desc: 'Chat Circles 背后的理念。发掘优势、有意义的时刻，以及成长型思维的语言。聆听者练习在他人的分享中识别并点名优势——这正是令本计划与众不同的核心技能。',
    tags: ['发掘优势', '正向框架', '由 TSPP 引导'],
  },
  {
    mins: '50',
    title: '角色扮演与场景练习',
    desc: '使用实际提示卡进行完整的对话模拟。两轮结构性练习，由培训师观察并给予反馈。具体场景包括：对话陷入僵局、倾诉者出现情绪困扰迹象、如何温暖地结束对话。',
    tags: ['角色扮演', '培训师观察', '场景卡片'],
  },
  {
    mins: '25',
    title: '边界、转介途径与自我关怀',
    desc: '当对话内容在脑海中挥之不去时该如何应对；如何识别何时需要为某人连接进一步支持；升级协议演练；完成培训后自信心调查。聆听者带着充分准备而非焦虑离开。',
    tags: ['边界', '转介协议', '培训后调查'],
  },
];

const SPARK_CARDS = [
  {
    title: '现代连结的悖论',
    desc: '当今青年是历史上数字连结程度最高的一代，却也是最孤独的一代之一。社交媒体制造了连结的外观，却缺乏其内涵。Chat Circles 提供的恰恰相反——没有屏幕，没有表演，没有观众，只有两个人和一段不匆忙的对话。',
  },
  {
    title: '打破"隐形"的循环',
    desc: '真正被聆听——没有打断，没有评判，没有预设议程——是一种身体力行的体验。对于许多处于过渡期的青年而言，被一个陌生人真诚看见和珍视这一简单行为，能从根本上改变他们对自己及前行能力的认知。',
  },
  {
    title: '在关键时刻建立社交自信',
    desc: '过渡期需要新的社交技能。Chat Circles 提供了一次与陌生人进行真实对话的安全、结构化体验——为"连结是什么感觉"建立新的参照点，并培养再次主动寻求连结的自信。',
  },
  {
    title: '连结是双向的',
    desc: '这段体验并非单向的。聆听者——往往是在高绩效、低脆弱性职场工作的企业员工——常常形容 Chat Circles 是他们数月以来最真实的人际交流之一。这份火花是相互的。',
  },
];

const CHATTER_OUTCOMES = [
  {
    label: '倾诉者成果 1',
    title: '一段被真正聆听的转化性体验',
    desc: '对于许多在不确定的过渡期中摸索前行的青年而言，拥有一位陌生人给予全神贯注、不带评判的临在，是真正难得的体验。在没有建议、没有打断、没有预设目的的情况下被聆听，会带来一种可感知的转变——一种积极的火花和焕新的自我价值感，远在活动结束后仍持续涌动。',
    tint: 'ccp-tint-brand',
  },
  {
    label: '倾诉者成果 2',
    title: '压力与情绪负担的减轻',
    desc: '青年带着过渡期的重担来到 Chat Circles——学业压力、职业不确定性、社交焦虑。安定练习、正念开场，以及不匆忙、富有支持性的对话体验，共同作用以减轻这些压力。比来时轻松地离开，本身就是一个有意义的成果。',
    tint: 'ccp-tint-accent',
  },
  {
    label: '倾诉者成果 3',
    title: '个人优势的被看见',
    desc: '通过引导性的正向心理学对话，每位倾诉者至少有一个个人优势被点名并反映回给他们。在一个不断用外部标准衡量青年的世界里，被看见"是谁"而非"做了什么"，既是一种肯定，也是一种心理扎根。',
    tint: 'ccp-tint-info',
  },
  {
    label: '倾诉者成果 4',
    title: '建立向前迈进的能动性与自信',
    desc: '被聆听、拥有被点名的优势、体验情感安全感，这些共同建立的不仅仅是好感觉——而是能动性。年轻人带着一种焕新的确信离开，相信自己有能力应对前方的路。这是与青年过渡期支持最直接相关的成果：不只是感觉好一些，而是感到自己有能力。',
    tint: '',
  },
  {
    label: '倾诉者成果 5',
    title: '对人际连结的焕新开放',
    desc: '通过在安全、结构化的环境中与陌生人进行有意义的对话，青年得以建立对自身社交能力的自信。这次活动成为一个参照点——证明真实的连结是可能的，值得再次追寻，直接对抗那种在人生过渡期往往会加深的孤立感。',
    tint: 'ccp-tint-success',
  },
  {
    label: '倾诉者成果 6',
    title: '对社区资源与途径的认知',
    desc: '每位倾诉者离开时，都了解到可供自己使用的支持资源——辅导、导师计划、正向心理学课程、同伴支持网络。对于那些从不会主动寻求帮助的青年而言，一次温暖、无污名化的资源介绍，可能正是他们真正踏出那一步的开始。',
    tint: 'ccp-tint-warning',
  },
];

const LISTENER_OUTCOMES = [
  {
    label: '聆听者成果 1',
    title: '在真实对话中学习并实践技能',
    desc: '聆听者培养并立即运用主动聆听、发掘优势、不带评判的临在以及支持性提问等技能。与大多数培训不同，这些技能并非停留在理论层面——它们在同一天的真实对话中接受检验。这种"学习+实践"于一次活动中完成的方式，加速了真正能力的形成。',
    tint: 'ccp-tint-warning',
  },
  {
    label: '聆听者成果 2',
    title: '好奇心的火花与新的学习路径',
    desc: '对于初次接触正向心理学和教练技术的聆听者，这次培训打开了一扇门。许多人离开时渴望深入探索——报读 TSPP 课程、获取教练认证，或参与社区引导角色。Chat Circles 成为通往更广阔个人与职业发展生态系统的门户。',
    tint: 'ccp-tint-info',
  },
  {
    label: '聆听者成果 3',
    title: '通过有意义的贡献获得满足感',
    desc: '对于已具备教练、辅导或引导技能的聆听者，Chat Circles 提供了真正难得的机会——一个结构化、安全、有目的的情境，让他们将这些技能用于真正能从中受益的人。这种"给予得恰到好处，并看到它产生效果"的体验，带来深刻的满足感，并持续激励长期的志愿参与。',
    tint: 'ccp-tint-brand',
  },
  {
    label: '聆听者成果 4',
    title: '通过给予提升个人身心健康',
    desc: '全神贯注地聆听、为另一个人的故事留出空间，以及见证他们的成长，本身就是一种滋养。聆听者一致表示，活动结束后感到与他人更有连结、更有目标感、对自己更加积极。让倾诉者振奋的对话，同样也在提升聆听者。',
    tint: 'ccp-tint-success',
  },
];

const ECOSYSTEM_OUTCOMES = [
  {
    label: '生态系统成果 1',
    title: '触达青年的有效社区外展渠道',
    desc: '那些绝不会打开政府邮件、参加讲座或致电求助热线的青年，却愿意与陌生人共饮、进行一段真实的对话。Chat Circles 创造了一个受信任、低门槛的接触点，让各类计划、资源和服务能够有机地触达青年——在一个他们放松、开放、易于接受的情境中。',
    tint: '',
  },
  {
    label: '生态系统成果 2',
    title: '填补新加坡关怀体系中的第一层缺口',
    desc: '新加坡国家心理健康与身心健康策略依赖于强有力的上游预防层——然而社区层面的基础设施仍然薄弱。Chat Circles 直接回应这一需求，创建了一个可规模化、可复制的第一层支持模式，可被学校、慈善机构、企业和社区空间采用。它不是一次性活动，而是一套基础设施。',
    tint: 'ccp-tint-accent',
  },
];

const METH_TOOLS = [
  {
    name: 'PANAS-SF',
    full: '正负情感量表——简短版',
    desc: '测量情绪情感——具体而言，是正向情绪是否存在且活跃。五个情绪词（感兴趣、兴奋、强健、热情、自豪）各以1-5分评分。分别在活动开始前和结束时进行。前后得分的差异，是被聆听体验带来情绪提升的直接证据。',
    captures: '情绪提升 · 正向情感转变 · 心境改变',
    tint: 'ccp-tint-brand',
  },
  {
    name: '单题压力测量',
    full: '经验证的单题感知压力量表',
    desc: '"你现在感到多大压力？"以0-10分评分。简洁、普遍易懂，任何人都能立即理解。分别在活动前后进行。得分降低是最直观、最有说服力的影响力指标之一——对于关注青年过渡期压力的议题尤为切题。',
    captures: '压力减轻 · 情绪调节 · 过渡期压力释放',
    tint: 'ccp-tint-warning',
  },
  {
    name: '状态希望量表',
    full: '改编自史奈德状态希望量表（能动性 + 路径思维分量表）',
    desc: '将希望衡量为一种认知能力而非情感——相信前进的路径存在（路径思维）以及追求这些路径的能量（能动性思维）。与测量稳定特质的特质版本不同，状态版本捕捉的是此刻的希望感，使其成为活动结束后即时测量的理想工具。三道改编题目仅在活动结束后作答。',
    captures: '能动性建立 · 路径思维 · 应对过渡期的自信',
    tint: 'ccp-tint-info',
  },
];

type MeasureRow = { outcome: string; tool: string; detail: string; when: string };

const CHATTER_MEASURES: MeasureRow[] = [
  {
    outcome: '真正被聆听',
    tool: 'PANAS-SF',
    detail: '活动前后各对5个情绪词以1-5分评分——得分变化显示情绪提升',
    when: '当天',
  },
  {
    outcome: '真正被聆听',
    tool: 'Exit survey',
    detail: '"今天的对话让我感到被真正聆听" — 1-5分',
    when: '当天',
  },
  {
    outcome: '压力减轻',
    tool: 'Stress item',
    detail: '"你现在感到多大压力？" — 活动前后以0-10分评分',
    when: '当天',
  },
  {
    outcome: '压力减轻',
    tool: 'Exit survey',
    detail: '"比起到来时，我现在感到更平静、更安定" — 1-5分',
    when: '当天',
  },
  {
    outcome: '优势被看见',
    tool: 'Exit survey',
    detail: '"我带着对自己某个积极方面的认知离开" — 1-5分',
    when: '当天',
  },
  {
    outcome: '优势被看见',
    tool: 'Listener note',
    detail: '聆听者记录他们所点名的具体优势——质性证据',
    when: '当天',
  },
  {
    outcome: '能动性与自信',
    tool: 'State Hope',
    detail: '"我感到自己更有能力应对前方的挑战" — 1-5分（能动性分量表）',
    when: '当天',
  },
  {
    outcome: '能动性与自信',
    tool: 'State Hope',
    detail: '"我感到在面对挑战时更有自信" — 1-5分（能动性分量表）',
    when: '当天',
  },
  {
    outcome: '能动性与自信',
    tool: 'State Hope',
    detail: '"我能看到自己前进的方向" — 1-5分（路径思维分量表）',
    when: '当天',
  },
  {
    outcome: '对连结的开放',
    tool: 'Exit survey',
    detail: '"今天让我感到更愿意与身边的人建立连结" — 1-5分',
    when: '当天',
  },
  {
    outcome: '对连结的开放',
    tool: 'Follow-up survey',
    detail: '"自 Chat Circles 活动以来，你是否与新认识的人进行过一次有意义的对话？" — 是/否',
    when: '4周后',
  },
  {
    outcome: '资源认知',
    tool: 'Exit survey',
    detail: '"我现在知道如果需要进一步支持或了解更多，可以去哪里" — 1-5分',
    when: '当天',
  },
  {
    outcome: '资源认知',
    tool: 'Follow-up survey',
    detail: '"你是否了解或使用过 Chat Circles 活动分享的任何资源？" — 是/否 + 开放性回答',
    when: '4周后',
  },
];

const LISTENER_MEASURES: MeasureRow[] = [
  {
    outcome: '技能学习与实践',
    tool: 'Self-efficacy scale',
    detail: '培训前、培训后及活动后各进行一次4题自信心调查——得分变化追踪成长',
    when: '三个时间点',
  },
  {
    outcome: '技能学习与实践',
    tool: 'Trainer checklist',
    detail: '观察员在角色扮演中以3分制评估6项核心技能',
    when: '培训当天',
  },
  {
    outcome: '好奇心的火花',
    tool: 'Post-event survey',
    detail: '"今天激发了我对正向心理学或教练技术进一步学习的兴趣" — 1-5分',
    when: '当天',
  },
  {
    outcome: '好奇心的火花',
    tool: 'Post-event survey',
    detail: '"我希望了解更多进一步培训或志愿机会" — 是/否',
    when: '当天',
  },
  {
    outcome: '通过贡献获得满足感',
    tool: 'Post-event survey',
    detail: '"我感到自己在今天的对话中真正发挥了积极作用" — 1-5分',
    when: '当天',
  },
  {
    outcome: '通过贡献获得满足感',
    tool: 'Post-event survey',
    detail: '"我愿意再次作为聆听者参与志愿活动" — 是/否（追踪留任率）',
    when: '当天',
  },
  {
    outcome: '个人身心健康提升',
    tool: 'Post-event survey',
    detail: '"与活动开始前相比，我现在感到更积极、更有活力" — 1-5分',
    when: '当天',
  },
  {
    outcome: '个人身心健康提升',
    tool: 'Post-event survey',
    detail: '"今天的对话对我个人而言是有意义、有目的的" — 1-5分',
    when: '当天',
  },
];

const ECOSYSTEM_MEASURES: MeasureRow[] = [
  {
    outcome: '有效的外展渠道',
    tool: 'Partner survey',
    detail: '合作机构汇报 Chat Circles 是否触达了此前未使用其服务的青年',
    when: '持续进行',
  },
  {
    outcome: '有效的外展渠道',
    tool: 'Partner tracking',
    detail: '每次活动触达的首次接触青年人数；转介接受率',
    when: '持续进行',
  },
];

const STORY_MEASURES: MeasureRow[] = [
  {
    outcome: '连结与改变的故事',
    tool: 'Open reflection',
    detail: '"用一句话描述，今天的对话对你意味着什么？" — 在结束环节经同意后收集',
    when: '当天',
  },
];

const PARTNERS = [
  {
    role: '企业参与合作伙伴',
    name: 'Anagami 影响',
    desc: '一家目的导向与系统设计工作室，协助领导者、企业和社区重塑思维方式与运作结构，以促进集体身心健康。负责联络企业合作伙伴和首席执行官，争取志愿者参与、认可，以及在试行阶段之后的计划采纳。',
  },
  {
    role: '社区与场地合作伙伴',
    name: 'CapitaLand Hope Foundation',
    desc: '凯德集团的慈善机构。通过其社区合作伙伴和餐饮租户网络，支持参与者招募和场地外展。是将本计划引入新加坡各处便捷、友好社区空间的关键合作者。',
  },
  {
    role: '计划主导机构',
    name: 'Empact.sg',
    desc: '具备跨界合作、计划设计、影响力评估和志愿者管理专业知识的社会企业。负责整体计划管理、志愿者协调和汇报工作。',
  },
  {
    role: '体验合作伙伴',
    name: 'Hush TeaBar',
    desc: '新加坡首家无声茶吧，由聋人社群成员共同领导。在每次活动中运用触感和呼吸技巧引导正念与安定身心环节，以亲身经历的视角诠释身心健康。',
  },
  {
    role: '培训合作伙伴',
    name: 'The School of Positive Psychology',
    desc: '新加坡及亚洲正向心理学教育与培训的先驱机构。共同设计并讲授聆听者培训课程，提供志愿者外展和方法论支持。',
  },
];

function OutcomeCards({
  cards,
  cols = 3,
}: {
  cards: { label: string; title: string; desc: string; tint: string }[];
  cols?: 2 | 3;
}) {
  return (
    <div className={`ccp-grid ${cols === 2 ? 'ccp-grid-2' : 'ccp-grid-3'}`}>
      {cards.map((card) => (
        <div key={card.label} className={`ccp-card${card.tint ? ` ${card.tint}` : ''}`}>
          <p className="ccp-card-label">{card.label}</p>
          <h3>{card.title}</h3>
          <p>{card.desc}</p>
        </div>
      ))}
    </div>
  );
}

function MeasureTable({ rows }: { rows: MeasureRow[] }) {
  return (
    <div className="ccp-table-wrap">
      <table className="ccp-table">
        <thead>
          <tr>
            <th>成果</th>
            <th>工具／方法</th>
            <th>题目或测量内容</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <strong>{row.outcome}</strong>
              </td>
              <td>
                <span className="cc-tag cc-tag-neutral">{row.tool}</span>
              </td>
              <td>{row.detail}</td>
              <td>
                <span
                  className={`cc-tag ${row.when === '当天' ? 'cc-tag-info' : 'cc-tag-warning'}`}
                >
                  {row.when}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectIntro() {
  return (
    <div className="ccp-intro">
      <section id="challenge" className="ccp-intro-section ccp-anchor" aria-label="挑战">
        <p className="cc-label-eyebrow">挑战</p>
        <h2 className="ccp-section-title">正处于过渡期的青年，比任何时候都更感压力与孤独</h2>
        <p className="ccp-intro-lead">
          在最需要韧性的人生时刻，新加坡青年承受着巨大的压力。这些过渡阶段——转校、进入职场、适应新角色——正是年轻人最需要支持、却最不可能主动寻求帮助的时期。
        </p>
        <div className="ccp-grid ccp-grid-2">
          {PROBLEM_CARDS.map((card) => (
            <div key={card.label} className={`ccp-card${card.tint ? ` ${card.tint}` : ''}`}>
              <p className="ccp-card-label">{card.label}</p>
              <h3>{card.title}</h3>
              <p>{card.desc}</p>
            </div>
          ))}
        </div>
        <div className="ccp-dark" style={{ marginTop: 12 }}>
          <div className="ccp-grid ccp-grid-3">
            {TRANSITIONS.map((item) => (
              <div key={item.title} className="ccp-dark-card">
                <h4>{item.title}</h4>
                <p>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="programme" className="ccp-intro-section ccp-anchor" aria-label="计划">
        <p className="cc-label-eyebrow">计划</p>
        <h2 className="ccp-section-title">一套完整的计划——而非单次活动</h2>
        <p className="ccp-intro-lead">
          Chat Circles
          是一套经过精心设计的体系，由两个相互依存的组成部分构成：为青年提供的结构性交流活动，以及为志愿聆听者提供的身心健康对话技能培训。缺少任何一方，计划都无法运作。两者结合，同时为"倾诉者"与"聆听者"带来成果——使整个计划成为真正的社区投资，而非单次活动。
        </p>
        <div className="ccp-pkg-strip">
          {PACKAGES.map((pkg, i) => (
            <div key={pkg.num} style={{ display: 'contents' }}>
              {i > 0 ? <div className="ccp-pkg-op">{i === 1 ? '+' : '='}</div> : null}
              <div className={`ccp-card ccp-pkg-card${pkg.tint ? ` ${pkg.tint}` : ''}`}>
                <div className="ccp-pkg-num">{pkg.num}</div>
                <div>
                  <h3>{pkg.title}</h3>
                  <p className="ccp-card-label">{pkg.sub}</p>
                  <p style={{ marginBottom: 8 }}>{pkg.desc}</p>
                  <span className="cc-tag cc-tag-neutral">{pkg.who}</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        <p className="ccp-group-label">活动设计——当天发生的事</p>
        <div className="ccp-dark">
          <div className="ccp-split">
            <div>
              <h3>Chat Circles 体验</h3>
              <p style={{ fontSize: 'var(--cc-fs-small)', lineHeight: 1.8 }}>
                每次活动将青年参与者（倾诉者）与经过培训的志愿对话伙伴（聆听者）配对，共同进行一段60分钟、以正向心理学为引导的一对一结构性交流。对话聚焦于优势、有意义的时刻以及能振奋精神的事——而非问题或挑战。
              </p>
              <p style={{ fontSize: 'var(--cc-fs-small)', lineHeight: 1.8, marginTop: 12 }}>
                环境温馨友好，刻意保持非临床氛围。一个舒适的场地，一杯饮料，一位愿意给予你全神贯注、不带评判的陌生人。
              </p>
            </div>
            <ul className="ccp-pillars">
              {PILLARS.map((pillar) => (
                <li key={pillar.title} className="ccp-pillar">
                  <span
                    className={`ccp-pillar-dot${pillar.accent ? ' ccp-pillar-dot-accent' : ''}`}
                    aria-hidden="true"
                  />
                  <span>
                    <span className="ccp-pillar-title">{pillar.title}</span>
                    <br />
                    <span className="ccp-pillar-sub">{pillar.sub}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="ccp-flow" style={{ marginTop: 12 }}>
          {FLOW_STEPS.map((step) => (
            <div key={step.name} className="ccp-flow-step">
              <p className="ccp-flow-time">{step.time}</p>
              <p className="ccp-flow-name">{step.name}</p>
              <p className="ccp-flow-desc">{step.desc}</p>
            </div>
          ))}
        </div>

        <div className="ccp-grid ccp-grid-2" style={{ marginTop: 12 }}>
          <div className="ccp-card ccp-tint-brand">
            <h3>倾诉者</h3>
            <p className="ccp-role-sub">青年参与者——被服务的一方</p>
            <ul className="ccp-role-list">
              {CHATTER_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
          <div className="ccp-card ccp-tint-accent">
            <h3>聆听者</h3>
            <p className="ccp-role-sub">经过培训的志愿对话伙伴</p>
            <ul className="ccp-role-list">
              {LISTENER_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </div>

        <p className="ccp-group-label">聆听者培训——活动前的准备</p>
        <p className="ccp-intro-lead">
          每位聆听者在参与活动前须完成一个三小时的身心健康对话技能工作坊。该培训由正向心理学学院合作设计与讲授，旨在赋予志愿者开展有意义、以优势为本的对话技能——而非诊断、修复或辅导。
        </p>
        <div className="ccp-grid">
          {TRAINING_BLOCKS.map((block) => (
            <div key={block.title} className="ccp-card ccp-training">
              <div className="ccp-training-time">
                <span className="ccp-training-min">{block.mins}</span>
                <span className="ccp-training-min-label">分钟</span>
              </div>
              <div className="ccp-training-body">
                <h4>{block.title}</h4>
                <p>{block.desc}</p>
                <div className="ccp-tag-row">
                  {block.tags.map((tag) => (
                    <span key={tag} className="cc-tag cc-tag-neutral">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="impact" className="ccp-intro-section ccp-anchor" aria-label="计划影响">
        <p className="cc-label-eyebrow">计划影响</p>
        <h2 className="ccp-section-title">Chat Circles 为所有参与者创造的价值</h2>
        <p className="ccp-intro-lead">
          Chat Circles
          的影响同时向三个方向流动——流向参与的青年、流向聆听的志愿者，以及流向更广泛的社区生态系统。而这一切背后，只有一个核心理念：真实的人际连结，只要用心创造，就能改变一个人内心的某些东西。
        </p>

        <div className="ccp-dark">
          <h3>真实人际连结的火花</h3>
          <p style={{ maxWidth: 720, fontSize: 'var(--cc-fs-small)', lineHeight: 1.8 }}>
            Chat Circles
            并不声称能解决孤独问题。它所创造的，是更为精准的东西——一段经过精心设计的、真正被另一个人聆听的体验。在一座年轻人被人群包围、却鲜少被真正看见的城市里，这样的体验比听起来更稀有，也更有力量。
          </p>
          <div className="ccp-grid ccp-grid-2" style={{ marginTop: 16 }}>
            {SPARK_CARDS.map((card) => (
              <div key={card.title} className="ccp-dark-card">
                <h4>{card.title}</h4>
                <p>{card.desc}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="ccp-group-label">对倾诉者</p>
        <OutcomeCards cards={CHATTER_OUTCOMES} />
        <p className="ccp-group-label">对聆听者</p>
        <OutcomeCards cards={LISTENER_OUTCOMES} />
        <p className="ccp-group-label">对生态系统</p>
        <OutcomeCards cards={ECOSYSTEM_OUTCOMES} cols={2} />

        <div className="ccp-dark" style={{ marginTop: 24 }}>
          <p className="ccp-quote-text">
            "Chat Circles
            并不要求年轻人处于困境中才能从中受益。它只要求他们做一个普通的人——对自己抱有好奇，对连结保持开放，愿意花一个小时进行真实的对话。成功的衡量标准，不是痛苦的消失，而是某种更美好的东西的存在。"
          </p>
          <cite className="ccp-quote-cite">—— Chat Circles 计划理念，Empact.sg</cite>
        </div>
      </section>

      <section id="measurement" className="ccp-intro-section ccp-anchor" aria-label="成效评估">
        <p className="cc-label-eyebrow">成效评估</p>
        <h2 className="ccp-section-title">我们如何衡量重要的事</h2>
        <p className="ccp-intro-lead">
          我们的评估方式适度、低负担且具有可信度。我们使用三种经过验证的工具，共同构建多维度的证据体系——在单次活动中捕捉情绪提升、压力减轻和能动性建立的证据，并在四周后收集跟进证据。
        </p>

        <div className="ccp-card">
          <h3>我们的评估工具</h3>
          <p style={{ marginBottom: 16 }}>
            每种工具捕捉影响力的一个独特且互补的维度。合计占用参与者不到6分钟的时间——轻量到不会让人感到像临床评估，却足够严谨，能生成可信的影响力证据。
          </p>
          <div className="ccp-grid ccp-grid-3">
            {METH_TOOLS.map((tool) => (
              <div key={tool.name} className={`ccp-card ${tool.tint}`}>
                <h3 style={{ marginBottom: 2 }}>{tool.name}</h3>
                <p className="ccp-card-label" style={{ letterSpacing: 0 }}>
                  {tool.full}
                </p>
                <p style={{ marginBottom: 10 }}>{tool.desc}</p>
                <p>
                  <strong>捕捉：</strong>
                  {tool.captures}
                </p>
              </div>
            ))}
          </div>
          <p style={{ marginTop: 16 }}>
            <strong>为何结合使用这三种工具：</strong>PANAS-SF
            回答「活动提升了他们的心情吗？」；压力测量回答「活动缓解了他们的压力吗？」；状态希望量表回答「活动改变了他们对自身行动能力的看法吗？」。第三个问题将
            Chat Circles
            从一种身心健康体验提升为一种能动性建构干预——这正是青年过渡期支持最关心的论点。
          </p>
        </div>

        <p className="ccp-group-label">对倾诉者</p>
        <MeasureTable rows={CHATTER_MEASURES} />
        <p className="ccp-group-label">对聆听者</p>
        <MeasureTable rows={LISTENER_MEASURES} />
        <p className="ccp-group-label">对生态系统</p>
        <MeasureTable rows={ECOSYSTEM_MEASURES} />
        <p className="ccp-group-label">质性证据</p>
        <MeasureTable rows={STORY_MEASURES} />
      </section>

      <section id="partners" className="ccp-intro-section ccp-anchor" aria-label="合作伙伴">
        <p className="cc-label-eyebrow">主要合作伙伴</p>
        <h2 className="ccp-section-title">为社区影响力而生的合作</h2>
        <p className="ccp-intro-lead">
          Chat Circles
          汇聚了一个独特的合作伙伴联盟——各方贡献独特的专业知识、网络与资源，共同打造一个整体大于各部分之和的计划。
        </p>
        <div className="ccp-grid ccp-grid-2">
          {PARTNERS.map((partner, i) => (
            <div
              key={partner.name}
              className={`ccp-card${i === PARTNERS.length - 1 ? ' ccp-grid-span' : ''}`}
            >
              <p className="ccp-card-label">{partner.role}</p>
              <h3>{partner.name}</h3>
              <p>{partner.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/// <reference path="../pb_data/types.d.ts" />

// 2026-09-24 approved Chatter/Listener post-session questionnaires. Existing
// activity surveys retain their own materialised questions and version links.
const bilingual = (english, chinese) => english + '\n' + chinese;
const choice = (value, english, chinese) => ({ value, label: english + ' / ' + chinese });
const agreement = {
  min: 1, max: 5,
  labels: {
    1: 'Strongly disagree / 非常不同意', 2: 'Disagree / 不同意',
    3: 'Neutral / 中立', 4: 'Agree / 同意', 5: 'Strongly agree / 非常同意',
  },
};
const confidence = {
  min: 1, max: 5,
  labels: {
    1: 'Not at all confident / 完全没有自信',
    5: 'Very confident / 非常自信',
  },
};
const q = (code, type, english, chinese, settings) => {
  const cfg = settings || {};
  const item = {
    question_code: code,
    question_type: type,
    title: bilingual(english, chinese),
    required: cfg.required !== false,
    locked: true,
    is_sensitive: !!cfg.sensitive,
    order_index: 0, // assigned from final array order below (conditional items are interleaved)
  };
  if (cfg.options) item.options_json = { options: cfg.options };
  if (cfg.validation) item.validation_json = cfg.validation;
  return item;
};
const agree = (code, english, chinese, cfg) => q(code, 'scale_1_5', english, chinese,
  Object.assign({ validation: agreement }, cfg || {}));

const CHATTER = [
  agree('CPOST_Q01', 'After today\'s session, I can think of more ways to reach my current goals or navigate my transition.', '与活动前相比，我能想到更多办法去实现当前的目标或应对当前的转型。'),
  agree('CPOST_Q02', 'After today\'s session, I feel I have more energy and capability to pursue my goals.', '与活动前相比，我感到更有能量和能力去追求自己的目标。'),
  agree('CPOST_Q03', 'After today\'s conversation, I feel more grounded in my personal strengths to help me move forward.', '今天的对话让我更扎实地感到自己的优势，能支持我继续前行。'),
  agree('CPOST_Q04', 'After today\'s session, I better recognise that my life has meaning and purpose.', '今天的活动让我更认识到自己的生活有意义和目标。'),
  agree('CPOST_Q05', 'After today\'s session, I feel better able to bounce back when things don\'t go well, such as losses and setbacks.', '与活动前相比，我感到自己更能在遭遇损失或挫折后恢复过来。'),
  agree('CPOST_Q06', 'After today\'s session, I feel better able to work through difficult emotions such as sadness, fear, anger or frustration.', '与活动前相比，我感到自己更能处理难过、害怕、生气或沮丧等困难情绪。'),
  agree('CPOST_Q07', 'After today\'s session, I am not as easily discouraged when things don\'t go my way.', '与活动前相比，我不那么容易因事情不顺而气馁。'),
  agree('CPOST_Q08', 'After today\'s session, I am more willing to seek out a supportive conversation or connect with others when I face a challenge.', '与活动前相比，遇到挑战时我更愿意主动寻找支持性的对话或与他人连结。'),
  agree('CPOST_Q09', 'After today\'s conversation, I feel more positive about connecting with others.', '今天的对话让我更认同：与他人连结可以是积极的体验。'),
  agree('CPOST_Q10', 'After today\'s session, I know better how to recognise signs of mental or emotional distress in myself or in others.', '与活动前相比，我更知道如何识别自己或他人心理与情绪困扰的征兆。'),
  q('CPOST_Q11', 'single_choice', 'After today\'s session, do you know where or how to access further community support or resources if you need them?', '今天的活动之后，如果需要进一步的支持或资源，你是否知道可以去哪里、如何获得？', {
    options: [choice('yes', 'Yes', '知道'), choice('unsure', 'Unsure', '不确定'), choice('no', 'No', '不知道')],
  }),
  q('CPOST_Q12', 'single_choice', 'Compared to before today\'s session, how stressed do you feel right now?', '与活动前相比，你此刻的压力如何？', {
    options: [choice('much_lower', 'Much lower', '明显更低'), choice('slightly_lower', 'Slightly lower', '略低'), choice('same', 'About the same', '差不多'), choice('slightly_higher', 'Slightly higher', '略高'), choice('much_higher', 'Much higher', '明显更高')],
  }),
  q('CPOST_Q13', 'scale_0_10', 'How stressed do you feel right now?', '你此刻感到多大压力？', {
    sensitive: true, validation: { min: 0, max: 10, labels: { 0: 'No stress / 没有压力', 10: 'Extreme stress / 压力极大' } },
  }),
  agree('CPOST_Q14', 'In today\'s session, I felt truly heard.', '今天的对话让我感到被真正倾听。'),
  agree('CPOST_Q15', 'My Listener gave me their full, undivided attention.', '我的倾听者给了我全程专注的陪伴。'),
  agree('CPOST_Q16', 'I felt comfortable and safe during today\'s conversation.', '今天的对话中我感到自在和安全。'),
  q('CPOST_Q17', 'single_choice', 'My Listener helped me name at least one personal strength I have.', '倾听者帮助我说出了至少一个自己拥有的优势。', {
    options: [choice('yes', 'Yes', '是'), choice('no', 'No', '否')],
  }),
  agree('CPOST_Q18', 'Overall, I am satisfied with today\'s Chat Circles session.', '总体而言，我对今天的 Chat Circles 活动满意。'),
  agree('CPOST_Q19', 'The prompt cards helped me reflect on my experiences.', '提示卡帮助我梳理了自己的经历。'),
  q('CPOST_Q20', 'single_choice', 'The duration of today\'s conversation was:', '今天对话的时长：', {
    options: [choice('too_short', 'Too short', '太短'), choice('just_right', 'Just right', '刚好'), choice('too_long', 'Too long', '太长')],
  }),
  q('CPOST_Q21', 'multi_choice', 'Based on today\'s experience, what would you like to explore next? (Select all that apply)', '根据今天的活动，你接下来希望探索什么？（请选择所有适用选项）', {
    validation: { exclusive_values: ['nothing_for_now'] },
    options: [
      choice('another_listener_conversation', 'Another conversation with a Listener', '再找倾听者聊一次'),
      choice('community_activities', 'Community activities or groups', '参加社区活动或小组'),
      choice('professional_services', 'Professional mental health services', '寻求专业心理服务'),
      choice('other_support_resources', 'Other support resources', '了解其他支持资源'),
      choice('other', 'Other (please specify)', '其他（请注明）'),
      choice('nothing_for_now', 'Nothing for now', '暂时没有'),
    ],
  }),
  q('CPOST_Q21_OTHER', 'text_long', 'Other (please specify):', '其他（请注明）：', {
    sensitive: true,
    validation: { show_when: { question_code: 'CPOST_Q21', value: 'other' } },
  }),
  q('CPOST_Q22', 'text_long', 'What is one thing you will take away from today\'s session? (optional)', '用一句话描述，今天的对话对你意味着什么？（选答）', { required: false, sensitive: true }),
  q('CPOST_Q23', 'text_long', 'Do you have any suggestions to make future sessions even better? (optional)', '对今后的活动有什么建议？（选答）', { required: false, sensitive: true }),
];
const LISTENER = [
  agree('LPOST_Q01', 'After practising active listening and strength-spotting in today\'s conversation, I feel confident using these skills to support a young person in the future.', '在今天的对话中练习了积极倾听和优势识别之后，我有信心在未来运用这些技能支持一位年轻人。'),
  q('LPOST_Q02', 'single_choice', 'Compared to before today\'s session, how would you rate your own personal wellbeing and mood right now?', '与活动前相比，你此刻的幸福感和心情如何？', {
    options: [choice('much_better', 'Much better', '明显更好'), choice('slightly_better', 'Slightly better', '略好'), choice('same', 'About the same', '差不多'), choice('slightly_worse', 'Slightly worse', '略差'), choice('much_worse', 'Much worse', '明显更差')],
  }),
  q('LPOST_Q03', 'single_choice', 'Has this experience sparked your interest in pursuing further learning pathways (further courses, deeper coaching certifications, or continued volunteering)?', '这次经历是否激发了你进一步学习的兴趣（进阶课程、更深的教练认证，或继续志愿服务）？', {
    options: [choice('yes_definitely', 'Yes definitely', '肯定有'), choice('maybe', 'Maybe', '也许'), choice('not_particularly', 'Not particularly', '不太有'), choice('no', 'No', '没有')],
  }),
  q('LPOST_Q04', 'scale_1_5', 'How fulfilling did you find the experience of giving your full attention and holding space for your Chatter\'s story today?', '今天全神贯注倾听、为你的 Chatter 的故事留出空间，这段经历让你觉得有多充实？', {
    validation: { min: 1, max: 5, labels: { 1: 'Not at all fulfilling / 完全没有', 5: 'Very fulfilling / 非常充实' } },
  }),
  q('LPOST_Q05', 'scale_1_5', 'I feel confident in my ability to have a supportive conversation with a stranger. (C1)', '我感到自信能够与一位陌生人进行一次支持性对话。（C1）', { validation: confidence }),
  q('LPOST_Q06', 'scale_1_5', 'I feel able to listen without giving advice or changing the topic. (C2)', '我感到自己能够在不给建议、不转移话题的情况下倾听。（C2）', { validation: confidence }),
  q('LPOST_Q07', 'scale_1_5', 'I feel confident in identifying and naming personal strengths in what others share. (C3)', '我感到自信能够识别并点名他人分享中的个人优势。（C3）', { validation: confidence }),
  q('LPOST_Q08', 'scale_1_5', 'I feel ready to recognise when someone may need further support, and to respond appropriately. (C4)', '我感到准备好识别何时某人可能需要进一步支持，以及如何妥善回应。（C4）', { validation: confidence }),
  q('LPOST_Q09', 'single_choice', 'Did you successfully practise active listening and strength-spotting in your conversation today?', '今天的对话中，你是否成功实践了积极倾听和优势识别？', {
    options: [choice('yes', 'Yes', '是'), choice('somewhat', 'Somewhat', '部分是'), choice('no', 'No', '否')],
  }),
  q('LPOST_Q10', 'text_short', 'I chatted with (Chatter Tag):', '我对话的 Chatter 编号：', {
    sensitive: true, validation: { pattern: '^C[0-9]+$', example: 'C07' },
  }),
  q('LPOST_Q11', 'single_choice', 'Did your Chatter indicate a need for further support?', '你的 Chatter 是否表现出需要进一步支持？', {
    sensitive: true, options: [choice('yes', 'Yes', '是'), choice('no', 'No', '否')],
  }),
  q('LPOST_Q12', 'scale_0_10', 'How likely are you to recommend volunteering as a Listener to a friend or colleague?', '你有多大可能向朋友或同事推荐成为倾听志愿者？', {
    validation: { min: 0, max: 10 },
  }),
  q('LPOST_Q13', 'text_long', 'What is the main reason for your score above?', '你给出这个评分的主要原因是什么？', { sensitive: true }),
  agree('LPOST_Q14', 'The prompt cards were helpful.', '提示卡对我有帮助。'),
  agree('LPOST_Q15', 'The space/venue was suitable.', '场地适合今天的活动。'),
  agree('LPOST_Q16', 'I had the resources and support I needed.', '我获得了所需的资源和支持。'),
  q('LPOST_Q17', 'single_choice', 'The duration of today\'s session was:', '今天活动的时长：', {
    options: [choice('too_short', 'Too short', '太短'), choice('just_right', 'Just right', '刚好'), choice('too_long', 'Too long', '太长')],
  }),
  q('LPOST_Q18', 'single_choice', 'Are you willing to (continue to) be on the volunteer Listener list?', '你是否愿意（继续）留在倾听志愿者名单中？', {
    options: [choice('yes', 'Yes', '是'), choice('no', 'No', '否')],
  }),
  q('LPOST_Q19', 'text_long', 'Is there anything else we can do to support you or improve future sessions? (optional)', '我们还能做些什么来支持你或改进今后的活动？（选答）', { required: false, sensitive: true }),
];
CHATTER.forEach((item, index) => { item.order_index = index; });
LISTENER.forEach((item, index) => { item.order_index = index; });

const FORMS = [
  {
    code: 'CHATTER_POST_20260924', name: 'Chatter 后测问卷 / Chatter post-session survey',
    role: 'speaker', questions: CHATTER,
    description: '2026-09-24 统一版；23 道主问题及“其他”条件补充输入。答卷通过登录账户的报名记录关联，不重复询问本人 Chatter Tag。',
  },
  {
    code: 'LISTENER_POST_20260924', name: 'Listener 后测问卷 / Listener post-session survey',
    role: 'listener', questions: LISTENER,
    description: '2026-09-24 统一版；19 题。答卷通过登录账户的报名记录关联，第 10 题填写搭档的 Chatter Tag。',
  },
];

migrate((app) => {
  const retired = [];
  const old = app.findRecordsByFilter('survey_templates', "status = 'active'", '', 10000);
  for (const template of old) {
    if (template.get('kind') === 'registration' || FORMS.some((form) => form.code === template.get('template_code'))) continue;
    retired.push({ id: template.id, status: template.get('status') });
    template.set('status', 'disabled');
    app.save(template);
  }

  const templateCollection = app.findCollectionByNameOrId('survey_templates');
  const versionCollection = app.findCollectionByNameOrId('survey_template_versions');
  const activeIds = [];
  for (const form of FORMS) {
    const matches = app.findRecordsByFilter('survey_templates', 'template_code = {:code}', '', 1, 0, { code: form.code });
    let template = matches[0];
    if (!template) {
      template = new Record(templateCollection);
      template.set('template_code', form.code);
      template.set('name', form.name);
      template.set('description', form.description);
      template.set('kind', 'survey');
      template.set('role_scope', form.role);
      template.set('status', 'active');
      const versionId = $security.randomStringWithAlphabet(15, 'abcdefghijklmnopqrstuvwxyz0123456789');
      template.set('current_version_id', versionId);
      app.saveNoValidate(template); // Current version relation forms a cycle with version.template_id.
      const version = new Record(versionCollection);
      version.set('id', versionId);
      version.set('template_id', template.id);
      version.set('version', 1);
      version.set('schema_json', { questions: form.questions });
      version.set('published_at', new Date().toISOString());
      version.set('published_by', 'system');
      app.save(version);
    } else {
      // A rollback leaves immutable versions in place, including any used by activities.
      template.set('kind', 'survey');
      template.set('role_scope', form.role);
      template.set('status', 'active');
      app.save(template);
    }
    activeIds.push(template.id);
  }

  const audit = new Record(app.findCollectionByNameOrId('audit_logs'));
  audit.set('actor_id', 'system');
  audit.set('actor_role', 'system');
  audit.set('action', 'migration.post_session_20260924');
  audit.set('target_type', 'survey_template');
  audit.set('target_id', activeIds[0]);
  audit.set('result', 'success');
  audit.set('metadata', { retired, activeIds });
  app.save(audit);
}, (app) => {
  // Preserve every template/version and any historical activity/answer. Restore only
  // catalogue entries this migration retired, then hide the two new entries.
  const audits = app.findRecordsByFilter('audit_logs', "action = 'migration.post_session_20260924'", '-created', 1);
  if (!audits.length) return;
  const state = JSON.parse(String(audits[0].get('metadata')));
  for (const item of state.retired || []) {
    const template = app.findRecordById('survey_templates', item.id);
    if (template.get('status') === 'disabled') {
      template.set('status', item.status);
      app.save(template);
    }
  }
  for (const id of state.activeIds || []) {
    const template = app.findRecordById('survey_templates', id);
    template.set('status', 'disabled');
    app.save(template);
  }
});

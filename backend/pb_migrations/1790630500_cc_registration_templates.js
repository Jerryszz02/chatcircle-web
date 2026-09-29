/// <reference path="../pb_data/types.d.ts" />
// Approved 2026-09-29 registration demos. Old fields/answers and activity configurations are retained.
migrate((app) => {
  const forms = [
  {
    "template_code": "CHATTER_REGISTRATION_20260929",
    "name": "Chatter 报名表",
    "role_scope": "speaker",
    "fields": [
      {
        "field_code": "FULL_NAME",
        "field_type": "text",
        "label": "姓名 / Your name",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "both",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 1,
          "hint": ""
        }
      },
      {
        "field_code": "C24_EMAIL",
        "field_type": "text",
        "label": "电子邮箱 / Email for registration updates",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 2,
          "hint": "",
          "input_type": "email"
        }
      },
      {
        "field_code": "C24_PHONE",
        "field_type": "text",
        "label": "联系电话 / Contact number",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 3,
          "hint": "用于必要的报名及活动联络。 / For essential registration and session contact.",
          "input_type": "tel"
        }
      },
      {
        "field_code": "C24_AGE",
        "field_type": "single_choice",
        "label": "年龄段 / Your age range",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "under_18",
            "label": "未满 18 岁 / Under 18"
          },
          {
            "value": "18_24",
            "label": "18–24 岁 / 18–24"
          },
          {
            "value": "25_35",
            "label": "25–35 岁 / 25–35"
          },
          {
            "value": "36_or_older",
            "label": "36 岁及以上 / 36 or older"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 4,
          "hint": ""
        }
      },
      {
        "field_code": "C24_GENDER",
        "field_type": "single_choice",
        "label": "性别 / Your gender",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "man",
            "label": "男 / Man"
          },
          {
            "value": "woman",
            "label": "女 / Woman"
          },
          {
            "value": "other",
            "label": "自我描述 / Self-describe"
          },
          {
            "value": "prefer_not_to_say",
            "label": "不愿透露 / Prefer not to say"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 5,
          "hint": ""
        }
      },
      {
        "field_code": "C24_GENDER_OTHER",
        "field_type": "text",
        "label": "性别：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 6,
          "show_when": {
            "field_code": "C24_GENDER",
            "value": "other"
          }
        }
      },
      {
        "field_code": "C24_ETHNICITY",
        "field_type": "text",
        "label": "族群／种族（选填） / Ethnic background (optional)",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 7,
          "hint": "可按自己的身份认同填写，也可留空。 / Describe in your own words, or leave blank."
        }
      },
      {
        "field_code": "C24_OCCUPATION",
        "field_type": "single_choice",
        "label": "当前职业／主要身份 / Current occupation or main role",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "student",
            "label": "学生 / Student"
          },
          {
            "value": "employee",
            "label": "受雇工作 / Employee"
          },
          {
            "value": "self_employed",
            "label": "自雇／自由职业 / Self-employed"
          },
          {
            "value": "seeking_work",
            "label": "求职中 / Seeking work"
          },
          {
            "value": "family_caregiver",
            "label": "照护家庭 / Family caregiver"
          },
          {
            "value": "retired",
            "label": "退休 / Retired"
          },
          {
            "value": "other",
            "label": "其他 / Another role"
          },
          {
            "value": "prefer_not_to_say",
            "label": "不愿透露 / Prefer not to say"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 8,
          "hint": ""
        }
      },
      {
        "field_code": "C24_OCCUPATION_OTHER",
        "field_type": "text",
        "label": "当前职业／主要身份：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 9,
          "show_when": {
            "field_code": "C24_OCCUPATION",
            "value": "other"
          }
        }
      },
      {
        "field_code": "C24_EDUCATION",
        "field_type": "single_choice",
        "label": "最高已完成学历 / Highest completed education",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "primary_school_or_below",
            "label": "小学及以下 / Primary school or below"
          },
          {
            "value": "secondary_school",
            "label": "中学 / Secondary school"
          },
          {
            "value": "upper_secondary_or_vocational_education",
            "label": "高中／职业教育 / Upper secondary or vocational education"
          },
          {
            "value": "diploma",
            "label": "专科／文凭 / Diploma"
          },
          {
            "value": "bachelor_s_degree",
            "label": "本科 / Bachelor’s degree"
          },
          {
            "value": "postgraduate_degree",
            "label": "研究生及以上 / Postgraduate degree"
          },
          {
            "value": "other",
            "label": "其他 / Another qualification"
          },
          {
            "value": "prefer_not_to_say",
            "label": "不愿透露 / Prefer not to say"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 10,
          "hint": ""
        }
      },
      {
        "field_code": "C24_EDUCATION_OTHER",
        "field_type": "text",
        "label": "最高已完成学历：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 11,
          "show_when": {
            "field_code": "C24_EDUCATION",
            "value": "other"
          }
        }
      },
      {
        "field_code": "C24_TRANSITION",
        "field_type": "single_choice",
        "label": "你目前主要经历哪一类转变？ / Which transition best fits your situation?",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "school_transition",
            "label": "升学／转学 / School transition"
          },
          {
            "value": "starting_working_life",
            "label": "初入职场 / Starting working life"
          },
          {
            "value": "job_change",
            "label": "换工作 / Job change"
          },
          {
            "value": "new_responsibilities_at_work",
            "label": "承担新的工作角色 / New responsibilities at work"
          },
          {
            "value": "personal_transition",
            "label": "个人生活变化 / Personal transition"
          },
          {
            "value": "none_applies",
            "label": "以上均不适用 / None applies"
          },
          {
            "value": "other",
            "label": "其他 / Another transition"
          }
        ],
        "config_json": {
          "section": "参与背景 / Your reason for joining",
          "order_index": 12,
          "hint": ""
        }
      },
      {
        "field_code": "C24_TRANSITION_OTHER",
        "field_type": "text",
        "label": "你目前主要经历哪一类转变？：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "参与背景 / Your reason for joining",
          "order_index": 13,
          "show_when": {
            "field_code": "C24_TRANSITION",
            "value": "other"
          }
        }
      },
      {
        "field_code": "C24_STORY",
        "field_type": "text",
        "label": "最近有什么小收获或挑战，你愿意在对话中聊聊？ / Is there a recent win or difficulty you would like to talk about?",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "参与背景 / Your reason for joining",
          "order_index": 14,
          "hint": "一句话即可，也可以到现场再分享。 / A sentence is enough; you may also wait until the conversation.",
          "input_type": "textarea"
        }
      },
      {
        "field_code": "C24_SOURCE",
        "field_type": "single_choice",
        "label": "你从哪里了解到 Chat Circles？ / Where did you discover Chat Circles?",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "organiser_or_partner",
            "label": "主办方或合作机构 / Organiser or partner"
          },
          {
            "value": "friend_or_colleague",
            "label": "朋友或同事介绍 / Friend or colleague"
          },
          {
            "value": "email_invitation",
            "label": "邮件 / Email invitation"
          },
          {
            "value": "social_platform",
            "label": "社交平台 / Social platform"
          },
          {
            "value": "school_or_employer",
            "label": "学校或工作单位 / School or employer"
          },
          {
            "value": "other",
            "label": "其他 / Another source"
          }
        ],
        "config_json": {
          "section": "参与背景 / Your reason for joining",
          "order_index": 15,
          "hint": ""
        }
      },
      {
        "field_code": "C24_SOURCE_OTHER",
        "field_type": "text",
        "label": "你从哪里了解到 Chat Circles？：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "参与背景 / Your reason for joining",
          "order_index": 16,
          "show_when": {
            "field_code": "C24_SOURCE",
            "value": "other"
          }
        }
      },
      {
        "field_code": "C24_ROLE",
        "field_type": "single_choice",
        "label": "我理解倾听者提供专注、尊重的倾听，不提供诊断或治疗。 / I understand the Listener offers attentive listening, without diagnosis or treatment.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "参与约定 / Before joining",
          "order_index": 17,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "C24_PRIVACY",
        "field_type": "single_choice",
        "label": "我会尊重对话中的隐私，不随意传播他人的分享。 / I will respect the other person’s privacy.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "参与约定 / Before joining",
          "order_index": 18,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "C24_CHOICE",
        "field_type": "single_choice",
        "label": "我知道可以选择倾听者，不合适时也可以向工作人员申请更换。 / I can ask the team for a different Listener.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "参与约定 / Before joining",
          "order_index": 19,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "C24_CONSENT",
        "field_type": "single_choice",
        "label": "我同意主办方为处理本次报名、必要联络及活动评估使用本表信息。 / I agree to the use of these details for registration, essential contact and programme evaluation.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "speaker",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "参与约定 / Before joining",
          "order_index": 20,
          "hint": "请阅读网站隐私说明，了解信息使用与联络方式。 / Please read the website privacy notice for details.",
          "input_type": "ack"
        }
      }
    ]
  },
  {
    "template_code": "LISTENER_REGISTRATION_20260929",
    "name": "Listener 报名表",
    "role_scope": "listener",
    "fields": [
      {
        "field_code": "FULL_NAME",
        "field_type": "text",
        "label": "姓名 / Your name",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "both",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 1,
          "hint": ""
        }
      },
      {
        "field_code": "L24_EMAIL",
        "field_type": "text",
        "label": "电子邮箱 / Email for registration updates",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 2,
          "hint": "",
          "input_type": "email"
        }
      },
      {
        "field_code": "L24_PHONE",
        "field_type": "text",
        "label": "联系电话（选填） / Contact number (optional)",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": false,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 3,
          "hint": "用于必要的志愿服务联络。 / For essential volunteering contact.",
          "input_type": "tel"
        }
      },
      {
        "field_code": "L24_AGE",
        "field_type": "single_choice",
        "label": "年龄段 / Your age range",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "under_21",
            "label": "未满 21 岁 / Under 21"
          },
          {
            "value": "21_29",
            "label": "21–29 岁 / 21–29"
          },
          {
            "value": "30_39",
            "label": "30–39 岁 / 30–39"
          },
          {
            "value": "40_49",
            "label": "40–49 岁 / 40–49"
          },
          {
            "value": "50_or_older",
            "label": "50 岁及以上 / 50 or older"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 4,
          "hint": "年龄信息用于报名安排，参与资格以项目要求为准。 / Participation is subject to programme requirements."
        }
      },
      {
        "field_code": "L24_GENDER",
        "field_type": "single_choice",
        "label": "性别 / Your gender",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "man",
            "label": "男 / Man"
          },
          {
            "value": "woman",
            "label": "女 / Woman"
          },
          {
            "value": "other",
            "label": "自我描述 / Self-describe"
          },
          {
            "value": "prefer_not_to_say",
            "label": "不愿透露 / Prefer not to say"
          }
        ],
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 5,
          "hint": ""
        }
      },
      {
        "field_code": "L24_GENDER_OTHER",
        "field_type": "text",
        "label": "性别：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 6,
          "show_when": {
            "field_code": "L24_GENDER",
            "value": "other"
          }
        }
      },
      {
        "field_code": "L24_ORGANISATION",
        "field_type": "text",
        "label": "你所代表的公司／机构（选填） / Organisation you represent (optional)",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": false,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "基本信息 / About you",
          "order_index": 7,
          "hint": "以个人身份参加可留空。 / Leave blank if joining independently."
        }
      },
      {
        "field_code": "L24_MOTIVATION",
        "field_type": "text",
        "label": "你为什么希望成为倾听志愿者？ / Why would you like to volunteer as a Listener?",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "志愿参与 / Volunteering",
          "order_index": 8,
          "hint": "",
          "input_type": "textarea"
        }
      },
      {
        "field_code": "L24_SOURCE",
        "field_type": "single_choice",
        "label": "你从哪里了解到 Chat Circles？ / Where did you discover Chat Circles?",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": false,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "organiser_or_partner",
            "label": "主办方或合作机构 / Organiser or partner"
          },
          {
            "value": "friend_or_colleague",
            "label": "朋友或同事介绍 / Friend or colleague"
          },
          {
            "value": "email_invitation",
            "label": "邮件 / Email invitation"
          },
          {
            "value": "social_platform",
            "label": "社交平台 / Social platform"
          },
          {
            "value": "school_or_employer",
            "label": "学校或工作单位 / School or employer"
          },
          {
            "value": "other",
            "label": "其他 / Another source"
          }
        ],
        "config_json": {
          "section": "志愿参与 / Volunteering",
          "order_index": 9,
          "hint": ""
        }
      },
      {
        "field_code": "L24_SOURCE_OTHER",
        "field_type": "text",
        "label": "你从哪里了解到 Chat Circles？：请说明 / Please specify",
        "source_type": "standard",
        "is_sensitive": true,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": null,
        "config_json": {
          "section": "志愿参与 / Volunteering",
          "order_index": 10,
          "show_when": {
            "field_code": "L24_SOURCE",
            "value": "other"
          }
        }
      },
      {
        "field_code": "L24_ROLE",
        "field_type": "single_choice",
        "label": "我理解倾听者应专注理解对方、发现优势，不急于给出建议。 / I will focus on understanding the Chatter and noticing their strengths.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "角色与准备 / Role and preparation",
          "order_index": 11,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "L24_TRAINING",
        "field_type": "single_choice",
        "label": "我了解正式参与倾听服务前，需要完成项目要求的培训。 / I understand that required training comes before volunteering in a session.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "角色与准备 / Role and preparation",
          "order_index": 12,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "L24_PRIVACY",
        "field_type": "single_choice",
        "label": "我会尊重参与者隐私；遇到超出角色范围的问题时，向现场负责人寻求支持。 / I will respect participants’ privacy and seek the team’s support when needed.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "角色与准备 / Role and preparation",
          "order_index": 13,
          "hint": "",
          "input_type": "ack"
        }
      },
      {
        "field_code": "L24_CONSENT",
        "field_type": "single_choice",
        "label": "我同意主办方为处理志愿报名、必要联络及活动评估使用本表信息。 / I agree to the use of these details for volunteer registration, essential contact and programme evaluation.",
        "source_type": "standard",
        "is_sensitive": false,
        "required_default": true,
        "role_scope": "listener",
        "status": "active",
        "options_json": [
          {
            "value": "agree",
            "label": "我已了解并同意 / I understand and agree"
          }
        ],
        "config_json": {
          "section": "角色与准备 / Role and preparation",
          "order_index": 14,
          "hint": "请阅读网站隐私说明，了解信息使用与联络方式。 / Please read the website privacy notice for details.",
          "input_type": "ack"
        }
      }
    ]
  }
];
  const decode = (raw, fallback) => { try { return JSON.parse(String(raw)) || fallback; } catch (_) { return fallback; } };
  const oldDefs = app.findRecordsByFilter('registration_field_defs', '', '', 0);
  const oldActivities = app.findRecordsByFilter('activities', '', '', 0);
  const approvedCodes = forms.flatMap((form) => form.fields.map((field) => field.field_code));
  const state = { fields: [], activity_run: $security.randomString(15), template_ids: [], new_field_ids: [] };
  const fieldsCol = app.findCollectionByNameOrId('registration_field_defs');
  for (const form of forms) {
    for (const field of form.fields) {
      const existing = app.findRecordsByFilter('registration_field_defs', "organization_id = '' && field_code = {:code}", '', 1, 0, { code: field.field_code });
      let def = existing[0];
      if (!def) {
        def = new Record(fieldsCol);
        for (const key of Object.keys(field)) def.set(key, field[key]);
        app.save(def);
      } else if (field.field_code !== 'FULL_NAME') {
        def.set('config_json', field.config_json); app.save(def);
      }
      if (field.field_code !== 'FULL_NAME') state.new_field_ids.push(def.id);
      field.id = def.id;
    }
    const templates = app.findCollectionByNameOrId('survey_templates');
    const matches = app.findRecordsByFilter('survey_templates', 'template_code = {:code}', '', 1, 0, { code: form.template_code });
    const tpl = matches[0] || new Record(templates);
    if (matches.length) {
      tpl.set('kind', 'registration'); tpl.set('role_scope', form.role_scope);
      tpl.set('status', 'active'); app.save(tpl); state.template_ids.push(tpl.id); continue;
    }
    tpl.set('template_code', form.template_code);
    tpl.set('name', form.name);
    tpl.set('description', '2026-09-29 确认版；用于活动报名，日期、地点、餐饮和培训时段由活动单独配置。');
    tpl.set('kind', 'registration');
    tpl.set('role_scope', form.role_scope);
    tpl.set('status', 'active');
    const versionId = $security.randomStringWithAlphabet(15, 'abcdefghijklmnopqrstuvwxyz0123456789');
    tpl.set('current_version_id', versionId);
    app.saveNoValidate(tpl);
    const ver = new Record(app.findCollectionByNameOrId('survey_template_versions'));
    ver.set('id', versionId);
    ver.set('template_id', tpl.id);
    ver.set('version', 1);
    ver.set('schema_json', { kind: 'registration', role_scope: form.role_scope, fields: form.fields });
    ver.set('published_at', new Date().toISOString());
    ver.set('published_by', 'system');
    app.save(ver);
    state.template_ids.push(tpl.id);
  }
  // Materialise pre-upgrade defaults. New fields remain off in existing activities;
  // explicit per-activity choices and custom fields remain unchanged.
  for (const activity of oldActivities) {
    const original = decode(activity.get('form_config_json'), {});
    const cfg = Object.assign({}, original);
    const previous = Array.isArray(cfg.fields) ? cfg.fields : [];
    const byId = {};
    for (const item of previous) if (item && item.field_def_id) byId[item.field_def_id] = item;
    for (const def of oldDefs) {
      if (def.get('status') !== 'active') continue;
      if (def.get('organization_id') && def.get('organization_id') !== activity.get('organization_id')) continue;
      if (!byId[def.id]) byId[def.id] = { field_def_id: def.id, enabled: true, required: !!def.get('required_default') };
    }
    for (const id of state.new_field_ids) byId[id] = { field_def_id: id, enabled: false, required: false };
    cfg.fields = Object.keys(byId).map((id) => byId[id]);
    activity.set('form_config_json', cfg);
    app.saveNoValidate(activity);
    const change = new Record(app.findCollectionByNameOrId('audit_logs'));
    change.set('actor_id', 'system'); change.set('actor_role', 'system');
    change.set('action', 'migration.registration_20260929.activity');
    change.set('target_type', 'activity'); change.set('target_id', activity.id);
    change.set('result', 'success');
    change.set('metadata', { run: state.activity_run, before: original, after: decode(activity.get('form_config_json'), cfg) });
    app.save(change);
  }
  // Retire old default fields without disabling fields used by historical activities.
  for (const def of oldDefs) {
    if (def.get('organization_id') || approvedCodes.indexOf(def.get('field_code')) >= 0) continue;
    const before = decode(def.get('config_json'), {});
    state.fields.push({ id: def.id, before });
    def.set('config_json', Object.assign({}, before, { default_disabled: true }));
    app.save(def);
  }
  const audit = new Record(app.findCollectionByNameOrId('audit_logs'));
  audit.set('actor_id', 'system'); audit.set('actor_role', 'system');
  audit.set('action', 'migration.registration_20260929'); audit.set('target_type', 'survey_template');
  audit.set('target_id', 'registration_20260929'); audit.set('result', 'success'); audit.set('metadata', state);
  app.save(audit);
}, (app) => {
  // Keep submitted business records and versions. Disable the new catalogue entries on rollback.
  const audits = app.findRecordsByFilter('audit_logs', "action = 'migration.registration_20260929'", '-created', 1);
  if (!audits.length) return;
  const state = JSON.parse(String(audits[0].get('metadata')));
  const stable = (value) => {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  };
  const changes = app.findRecordsByFilter('audit_logs',
    "action = 'migration.registration_20260929.activity' && metadata.run = {:run}", '', 0, 0, { run: state.activity_run });
  for (const change of changes) {
    const item = JSON.parse(String(change.get('metadata')));
    item.id = change.get('target_id');
    try {
      const record = app.findRecordById('activities', item.id);
      if (stable(JSON.parse(String(record.get('form_config_json')))) === stable(item.after)) {
        record.set('form_config_json', item.before); app.saveNoValidate(record);
      }
    } catch (_) { /* An independently removed activity must not block rollback. */ }
  }
  for (const item of state.fields) {
    const record = app.findRecordById('registration_field_defs', item.id);
    record.set('config_json', item.before); app.save(record);
  }
  for (const id of state.new_field_ids) {
    const record = app.findRecordById('registration_field_defs', id);
    const cfg = JSON.parse(String(record.get('config_json')));
    record.set('config_json', Object.assign({}, cfg, { default_disabled: true })); app.save(record);
  }
  for (const id of state.template_ids) {
    const record = app.findRecordById('survey_templates', id); record.set('status', 'disabled'); app.save(record);
  }
});

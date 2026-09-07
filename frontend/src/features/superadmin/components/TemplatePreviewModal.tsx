import { useMemo, useState } from 'react';
import type { QuestionType } from '../../../shared/api/types';
import { Modal } from '../../../shared/ui';
import { TEMPLATE_QUESTION_TYPES } from '../../../shared/survey/questionDrafts';
import type { PublicSurveyQuestion } from '../../participant/api';
import { SurveyQuestionField } from '../../participant/components/SurveyQuestionField';
import {
  buildSurveyFormModel,
  type SurveyAnswerMap,
  type SurveyAnswerValue,
} from '../../participant/lib/survey';
import { extractTemplateQuestionRows } from '../lib/templates';

/**
 * 模板版本内容预览：把版本 schema_json 的题目定义用参与者端真实填写组件
 * （SurveyQuestionField）渲染，可交互试填——答案只保存在本地 state，不提交任何数据。
 * 题型无法识别的题目行直接跳过（schema 发布时已经服务端校验，这里只是防御）。
 */
export function TemplatePreviewModal({
  open,
  title,
  schemaJson,
  onClose,
}: {
  open: boolean;
  /** 弹窗标题，如「内容预览：模板名 v2」。 */
  title: string;
  /** 版本 schema_json；为 null/结构不符时降级为占位提示。 */
  schemaJson: unknown;
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<SurveyAnswerMap>({});

  const models = useMemo(() => {
    const rows = extractTemplateQuestionRows(schemaJson)
      .filter((q) => TEMPLATE_QUESTION_TYPES.includes(q.question_type as QuestionType))
      .map(
        (q, index) =>
          ({
            id:
              typeof q.question_code === 'string' && q.question_code
                ? q.question_code
                : `preview_${index}`,
            question_code: typeof q.question_code === 'string' ? q.question_code : `Q${index + 1}`,
            question_type: q.question_type as QuestionType,
            title: typeof q.title === 'string' ? q.title : '',
            required: q.required === true,
            locked: q.locked === true,
            is_sensitive: q.is_sensitive === true,
            order_index: typeof q.order_index === 'number' ? q.order_index : index,
            options_json: q.options_json,
          }) as PublicSurveyQuestion,
      );
    return buildSurveyFormModel(rows);
  }, [schemaJson]);

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {models.length === 0 ? (
        <p className="sa-muted">该版本未包含可解析的题目定义。</p>
      ) : (
        <>
          <p className="sa-muted">以下为参与者实际填写样式，可交互试填，不会提交任何数据。</p>
          {models.map((model) => (
            <div key={model.id} className="sa-question-item">
              <div className="sa-actions" style={{ marginBottom: '0.25rem' }}>
                <code>{model.questionCode}</code>
                <span className="sa-badge">{model.questionType}</span>
                {model.locked ? (
                  <span className="sa-badge sa-badge-danger">锁定题（机构不可改）</span>
                ) : null}
                {model.isSensitive ? <span className="sa-badge sa-badge-warn">敏感题</span> : null}
                {model.required ? <span className="sa-badge sa-badge-info">必填</span> : null}
              </div>
              <SurveyQuestionField
                model={model}
                value={answers[model.questionCode]}
                onChange={(value: SurveyAnswerValue) =>
                  setAnswers((prev) => ({ ...prev, [model.questionCode]: value }))
                }
              />
            </div>
          ))}
        </>
      )}
      <p className="sa-muted">
        锁定题由超级管理员维护，机构不能修改或删除（FR-SUR-001）；敏感题在普通导出中按标记排除（FR-SUR-012）。
      </p>
    </Modal>
  );
}

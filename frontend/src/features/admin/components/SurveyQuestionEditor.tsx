import { useEffect, useRef, useState } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import type {
  ActivitySurveyRecord,
  SourceType,
  SurveyQuestionRecord,
} from '../../../shared/api/types';
import {
  CHOICE_QUESTION_TYPES,
  TEMPLATE_QUESTION_TYPES,
  draftsFromSchema,
  emptyQuestionDraft,
  validateQuestionDrafts,
  type TemplateQuestionDraft,
} from '../../../shared/survey/questionDrafts';
import { Button, Input } from '../../../shared/ui';
import { QUESTION_TYPE_LABELS, SOURCE_TYPE_LABELS } from '../lib/labels';

/**
 * 机构管理端可视化问卷题目编辑器（复用超管端 TemplateSchemaEditor 的交互结构，
 * 草稿模型共用 shared/survey/questionDrafts）。
 *
 * 与超管端差异（机构端约束，surveys.pb.js 守卫）：
 * - 无 question_code 输入：新题 code 提交时由 lib/surveyQuestionApply 自动生成；
 * - 无「锁定核心题」复选框、无 validation_json 编辑、无删除、无 JSON 原文模式；
 * - 锁定题只读（无编辑按钮），且作为排序锚点——任何题不可上移/下移跨过锁定题；
 * - 题型仅新建题可选，已有题题型不可改（统计/导出口径稳定，PRD §8.3）。
 *
 * 提交由 onSubmit 落库（lib/surveyQuestionApply 的 applyQuestionChanges）；
 * onSubmit 抛错时错误文案内联展示、不打断编辑。
 */

export interface SurveyQuestionEditorProps {
  /** 所属活动问卷（其 id 参与外部数据指纹，切换问卷时强制重置草稿）。 */
  survey: ActivitySurveyRecord;
  /** 当前题目行（父组件加载/保存后 reload 的结果）。 */
  questions: SurveyQuestionRecord[];
  /** 外部提交中状态（禁用交互、主按钮 loading）。 */
  saving: boolean;
  /** 提交（参数为编辑器草稿）；抛错时错误文案内联展示。 */
  onSubmit: (drafts: TemplateQuestionDraft[]) => Promise<void>;
}

/** 单题编辑中的表单状态。 */
interface EditingState {
  form: TemplateQuestionDraft;
  isNew: boolean;
}

/**
 * 校验前为 code 为空的新草稿填入临时占位码（真实 code 提交时由适配器自动生成；
 * 占位码仅用于通过必填/格式校验）。占位码带草稿 key 保证唯一，
 * 避免多道新题被误判 question_code 重复。
 */
function withPreviewCodes(drafts: TemplateQuestionDraft[]): TemplateQuestionDraft[] {
  return drafts.map((d) =>
    d.question_code.trim() ? d : { ...d, question_code: `CUS_PREVIEW_${d.key}` },
  );
}

export function SurveyQuestionEditor({
  survey,
  questions,
  saving,
  onSubmit,
}: SurveyQuestionEditorProps) {
  const [drafts, setDrafts] = useState<TemplateQuestionDraft[]>(() =>
    draftsFromSchema({ questions }),
  );
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 外部数据指纹：父组件保存成功后会 reload questions（PocketBase 每次写操作都会
  // 刷新 updated），此时重置草稿；reload 回包内容未变（指纹相同）或用户编辑过程中
  // 均不重置，避免打断输入。
  const fingerprint = `${survey.id}|${questions.map((q) => `${q.id}:${q.updated}`).join(',')}`;
  const fingerprintRef = useRef(fingerprint);
  useEffect(() => {
    if (fingerprintRef.current === fingerprint) return;
    fingerprintRef.current = fingerprint;
    setDrafts(draftsFromSchema({ questions }));
    setEditing(null);
    setFormError(null);
    setError(null);
  }, [fingerprint, questions]);

  /** 草稿来源标识：draft 模型不携带 source_type，按 code 回查原始行；新题为自定义。 */
  const sourceTypeOf = (d: TemplateQuestionDraft): SourceType => {
    const code = d.question_code.trim();
    if (!code) return 'custom';
    return questions.find((q) => q.question_code === code)?.source_type ?? 'custom';
  };

  // ---------- 列表操作 ----------

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    // 锁定题为排序锚点：自身不可移动，也不可被跨过（按钮侧已 disabled，此处兜底）
    if (drafts[index].locked || drafts[target].locked) return;
    setDrafts((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const openEdit = (draft: TemplateQuestionDraft) => {
    setEditing({
      form: { ...draft, options: draft.options.map((o) => ({ ...o })) },
      isNew: false,
    });
    setFormError(null);
  };

  const openNew = () => {
    setEditing({ form: emptyQuestionDraft(), isNew: true });
    setFormError(null);
  };

  // ---------- 单题表单 ----------

  const patchForm = (patch: Partial<TemplateQuestionDraft>) => {
    setEditing((prev) => (prev ? { ...prev, form: { ...prev.form, ...patch } } : prev));
  };

  const saveForm = () => {
    if (!editing) return;
    const form = { ...editing.form };
    const next = editing.isNew
      ? [...drafts, form]
      : drafts.map((d) => (d.key === form.key ? form : d));
    const err = validateQuestionDrafts(withPreviewCodes(next));
    if (err) {
      setFormError(err);
      return;
    }
    setDrafts(next);
    setEditing(null);
    setFormError(null);
  };

  // ---------- 提交 / 重置 ----------

  const submit = async () => {
    setError(null);
    try {
      await onSubmit(drafts);
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  };

  const reset = () => {
    setDrafts(draftsFromSchema({ questions }));
    setError(null);
  };

  // ---------- 渲染 ----------

  if (editing) {
    const { form } = editing;
    const isChoice = CHOICE_QUESTION_TYPES.includes(form.question_type);
    return (
      <div>
        <h3 className="cc-card-title">
          {editing.isNew ? '新增自定义题' : `编辑题目：${form.question_code}`}
        </h3>
        <Input
          label="题干（title）"
          required
          value={form.title}
          onChange={(e) => patchForm({ title: e.target.value })}
        />
        <div className="cc-field">
          <label className="cc-label" htmlFor="admin-qtype">
            题型
          </label>
          <select
            id="admin-qtype"
            className="admin-select"
            value={form.question_type}
            disabled={!editing.isNew}
            onChange={(e) => {
              const type = e.target.value as TemplateQuestionDraft['question_type'];
              patchForm({
                question_type: type,
                options:
                  CHOICE_QUESTION_TYPES.includes(type) && form.options.length === 0
                    ? [{ value: '', label: '' }]
                    : form.options,
              });
            }}
          >
            {TEMPLATE_QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUESTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {editing.isNew ? null : (
            <p className="cc-hint">题型创建后不可修改（统计/导出口径稳定，PRD §8.3）。</p>
          )}
        </div>

        {isChoice ? (
          <div className="cc-field">
            <span className="cc-label">选项（value = 机器值，label = 显示文本）</span>
            {form.options.map((opt, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <input
                  className="cc-input"
                  placeholder="value"
                  aria-label={`选项 ${i + 1} 机器值`}
                  value={opt.value}
                  onChange={(e) =>
                    patchForm({
                      options: form.options.map((o, j) =>
                        j === i ? { ...o, value: e.target.value } : o,
                      ),
                    })
                  }
                />
                <input
                  className="cc-input"
                  placeholder="label"
                  aria-label={`选项 ${i + 1} 显示文本`}
                  value={opt.label}
                  onChange={(e) =>
                    patchForm({
                      options: form.options.map((o, j) =>
                        j === i ? { ...o, label: e.target.value } : o,
                      ),
                    })
                  }
                />
                <Button
                  variant="secondary"
                  onClick={() => patchForm({ options: form.options.filter((_, j) => j !== i) })}
                >
                  删除
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => patchForm({ options: [...form.options, { value: '', label: '' }] })}
              >
                添加选项
              </Button>
            </div>
          </div>
        ) : null}

        <div className="cc-field">
          <label className="cc-label">
            <input
              type="checkbox"
              checked={form.required}
              onChange={(e) => patchForm({ required: e.target.checked })}
            />{' '}
            必填
          </label>
          <label className="cc-label">
            <input
              type="checkbox"
              checked={form.is_sensitive}
              onChange={(e) => patchForm({ is_sensitive: e.target.checked })}
            />{' '}
            敏感题（普通导出按标记排除，FR-SUR-012）
          </label>
        </div>

        {formError ? (
          <p className="cc-error" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="admin-row-actions" style={{ marginTop: '0.75rem' }}>
          <Button onClick={saveForm}>保存题目</Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            返回列表
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {drafts.length === 0 ? (
        <p className="admin-muted">暂无题目，点击下方「新增自定义题」。</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {drafts.map((d, i) => (
            <li key={d.key} className="admin-question-item">
              <div>
                <span className="admin-muted">#{i + 1}</span>{' '}
                <code>{d.question_code || '（新题，保存时自动编号）'}</code>{' '}
                {d.title || '（未填题干）'}
              </div>
              <div className="admin-question-badges">
                <span className="admin-badge">{QUESTION_TYPE_LABELS[d.question_type]}</span>
                <span className="admin-badge">{SOURCE_TYPE_LABELS[sourceTypeOf(d)]}</span>
                {d.locked ? <span className="admin-badge admin-badge-danger">锁定</span> : null}
                {d.is_sensitive ? <span className="admin-badge admin-badge-warn">敏感</span> : null}
                {d.required ? <span className="admin-badge admin-badge-info">必填</span> : null}
              </div>
              <div className="admin-row-actions" style={{ marginTop: '0.25rem' }}>
                <Button
                  variant="secondary"
                  disabled={i === 0 || d.locked || drafts[i - 1].locked}
                  onClick={() => move(i, -1)}
                >
                  上移
                </Button>
                <Button
                  variant="secondary"
                  disabled={i === drafts.length - 1 || d.locked || drafts[i + 1].locked}
                  onClick={() => move(i, 1)}
                >
                  下移
                </Button>
                {d.locked ? (
                  <span className="admin-muted">只读</span>
                ) : (
                  <Button variant="secondary" onClick={() => openEdit(d)}>
                    编辑
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="admin-row-actions" style={{ marginTop: '0.5rem' }}>
        <Button variant="secondary" onClick={openNew}>
          新增自定义题
        </Button>
      </div>
      <p className="cc-hint">
        题目顺序即问卷顺序；锁定核心题只读且位置固定（不可跨过排序，FR-SUR-001），
        保存后自定义题按列表顺序写入 order_index。V1 无删除入口（FR-AUD-001）。
      </p>

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="admin-row-actions" style={{ marginTop: '0.75rem' }}>
        <Button loading={saving} onClick={() => void submit()}>
          保存修改
        </Button>
        <Button variant="secondary" disabled={saving} onClick={reset}>
          重置
        </Button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { normalizeApiError } from '../../../shared/api/http';
import { Button, Input } from '../../../shared/ui';
import { QUESTION_TYPE_LABELS } from '../lib/labels';
import {
  CHOICE_QUESTION_TYPES,
  TEMPLATE_QUESTION_TYPES,
  draftsFromSchema,
  emptyQuestionDraft,
  schemaFromDrafts,
  validateQuestionDrafts,
  validateSchemaJsonText,
  type TemplateQuestionDraft,
} from '../lib/templates';

/**
 * 可视化模板题目编辑器（FR-SUR-001/011、PRD §8.2/§8.3）。
 *
 * 替代裸 schema_json JSON 编辑：题目列表（新增/编辑/删除/上下移排序）+ 单题表单，
 * 保留「JSON 原文」模式作为逃生门（两种模式双向同步）。
 * 编辑对象永远是「下一版本草稿」：已发布版本不可变，提交后由后端端点建版本 +
 * 移动 current_version_id（事务 + 审计，PRD §11.3）。
 *
 * 规则：从已发布版本带入的题 question_code 与题型不可改（统计/导出口径跨版本稳定）；
 * 修改锁定核心题需显式确认（影响之后新建的所有问卷，FR-SUR-001）。
 */

export interface TemplateSchemaEditorProps {
  /** 预填内容（当前版本 schema_json；新建模板时传 null）。 */
  initialSchema: unknown;
  /** 外部提交中状态（禁用交互）。 */
  saving: boolean;
  /** 提交按钮文案（如「发布」「创建」）。 */
  submitLabel: string;
  /** 提交（参数为规范化后的 schema_json）；抛错时错误文案内联展示、不关闭编辑器。 */
  onSubmit: (schema: { questions: Record<string, unknown>[] }) => Promise<void>;
  onCancel: () => void;
}

/** 单题编辑中的表单状态。 */
interface EditingState {
  form: TemplateQuestionDraft;
  /** validation_json 的高级 JSON 原文（空 = 无校验定义）。 */
  validationText: string;
  isNew: boolean;
}

/** 判断锁定核心题是否被修改（题干/选项/必填/敏感任一变化）。 */
function lockedQuestionChanged(original: TemplateQuestionDraft, form: TemplateQuestionDraft): boolean {
  const pick = (d: TemplateQuestionDraft) =>
    JSON.stringify({
      title: d.title,
      options: d.options,
      required: d.required,
      is_sensitive: d.is_sensitive,
      locked: d.locked,
    });
  return original.locked && pick(original) !== pick(form);
}

export function TemplateSchemaEditor({
  initialSchema,
  saving,
  submitLabel,
  onSubmit,
  onCancel,
}: TemplateSchemaEditorProps) {
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [drafts, setDrafts] = useState<TemplateQuestionDraft[]>(() =>
    draftsFromSchema(initialSchema),
  );
  const [jsonText, setJsonText] = useState('');
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [lockedConfirmed, setLockedConfirmed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ---------- 列表操作 ----------

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= drafts.length) return;
    setDrafts((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const remove = (key: string) => {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  };

  const openEdit = (draft: TemplateQuestionDraft) => {
    setEditing({
      form: { ...draft, options: draft.options.map((o) => ({ ...o })) },
      validationText: draft.validation_json ? JSON.stringify(draft.validation_json, null, 2) : '',
      isNew: false,
    });
    setLockedConfirmed(false);
    setFormError(null);
  };

  const openNew = () => {
    setEditing({ form: emptyQuestionDraft(), validationText: '', isNew: true });
    setLockedConfirmed(false);
    setFormError(null);
  };

  // ---------- 单题表单 ----------

  const patchForm = (patch: Partial<TemplateQuestionDraft>) => {
    setEditing((prev) => (prev ? { ...prev, form: { ...prev.form, ...patch } } : prev));
  };

  const saveForm = () => {
    if (!editing) return;
    const form = { ...editing.form };

    // 高级校验定义（可选）：非空须为合法 JSON 对象
    const validationText = editing.validationText.trim();
    if (validationText) {
      try {
        const parsed: unknown = JSON.parse(validationText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFormError('高级校验定义必须是 JSON 对象');
          return;
        }
        form.validation_json = parsed as Record<string, unknown>;
      } catch {
        setFormError('高级校验定义 JSON 格式不合法');
        return;
      }
    } else {
      delete form.validation_json;
    }

    const next = editing.isNew
      ? [...drafts, form]
      : drafts.map((d) => (d.key === form.key ? form : d));
    const err = validateQuestionDrafts(next);
    if (err) {
      setFormError(err);
      return;
    }
    const original = drafts.find((d) => d.key === form.key);
    if (original && lockedQuestionChanged(original, form) && !lockedConfirmed) {
      setFormError('该题为锁定核心题，修改将影响之后新建的所有问卷，请勾选确认后再保存');
      return;
    }
    setDrafts(next);
    setEditing(null);
    setFormError(null);
  };

  // ---------- 模式切换 ----------

  const switchToJson = () => {
    setJsonText(JSON.stringify(schemaFromDrafts(drafts), null, 2));
    setError(null);
    setMode('json');
  };

  const switchToVisual = () => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      setDrafts(draftsFromSchema(parsed));
      setError(null);
      setMode('visual');
    } catch {
      setError('JSON 格式不合法，无法切换到可视化编辑');
    }
  };

  // ---------- 提交 ----------

  const submit = async () => {
    setError(null);
    try {
      if (mode === 'json') {
        const textErr = validateSchemaJsonText(jsonText);
        if (textErr) {
          setError(textErr);
          return;
        }
        const parsed = JSON.parse(jsonText) as { questions?: unknown[] };
        const parsedDrafts = draftsFromSchema(parsed);
        if (
          !Array.isArray(parsed.questions) ||
          parsed.questions.length !== parsedDrafts.length
        ) {
          setError('存在无法解析的题目（题型非法或结构不符），请检查 JSON');
          return;
        }
        const err = validateQuestionDrafts(parsedDrafts);
        if (err) {
          setError(err);
          return;
        }
        await onSubmit(parsed as { questions: Record<string, unknown>[] });
      } else {
        const err = validateQuestionDrafts(drafts);
        if (err) {
          setError(err);
          return;
        }
        await onSubmit(schemaFromDrafts(drafts));
      }
    } catch (err) {
      setError(normalizeApiError(err).message);
    }
  };

  // ---------- 渲染 ----------

  if (editing) {
    const { form } = editing;
    const isChoice = CHOICE_QUESTION_TYPES.includes(form.question_type);
    const original = drafts.find((d) => d.key === form.key);
    const showLockedConfirm = original !== undefined && lockedQuestionChanged(original, form);
    return (
      <div>
        <h3 className="cc-card-title">{editing.isNew ? '新增题目' : `编辑题目：${form.question_code}`}</h3>
        <Input
          label="题目代码（question_code）"
          value={form.question_code}
          disabled={form.fromPublished}
          hint={
            form.fromPublished
              ? '从已发布版本带入的题目代码不可修改（跨版本统计口径稳定，PRD §8.3）'
              : '稳定机器字段，仅字母/数字/下划线，同一问卷内唯一'
          }
          onChange={(e) => patchForm({ question_code: e.target.value })}
        />
        <Input
          label="题干（title）"
          required
          value={form.title}
          onChange={(e) => patchForm({ title: e.target.value })}
        />
        <div className="cc-field">
          <label className="cc-label" htmlFor="sa-qtype">
            题型
          </label>
          <select
            id="sa-qtype"
            className="sa-select"
            value={form.question_type}
            disabled={form.fromPublished}
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
          {form.fromPublished ? (
            <p className="cc-hint">从已发布版本带入的题目题型不可修改。</p>
          ) : null}
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
              checked={form.locked}
              onChange={(e) => patchForm({ locked: e.target.checked })}
            />{' '}
            锁定核心题（机构不可修改或删除，FR-SUR-001）
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

        <div className="cc-field">
          <label className="cc-label" htmlFor="sa-qvalidation">
            高级校验定义（validation_json，可选）
          </label>
          <textarea
            id="sa-qvalidation"
            className="sa-textarea"
            rows={3}
            placeholder='如 { "min": 1, "max": 5 }'
            value={editing.validationText}
            onChange={(e) => setEditing({ ...editing, validationText: e.target.value })}
          />
        </div>

        {showLockedConfirm ? (
          <div className="sa-confirm-warning" role="alert">
            <p>
              该题为锁定核心题，修改题干/选项/标记将影响之后新建的所有活动问卷（FR-SUR-001）。
            </p>
            <label className="cc-label">
              <input
                type="checkbox"
                checked={lockedConfirmed}
                onChange={(e) => setLockedConfirmed(e.target.checked)}
              />{' '}
              我确认修改此锁定核心题
            </label>
          </div>
        ) : null}

        {formError ? (
          <p className="cc-error" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="sa-actions" style={{ marginTop: '0.75rem' }}>
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
      {mode === 'visual' ? (
        <>
          {drafts.length === 0 ? (
            <p className="sa-muted">暂无题目，点击下方「新增题目」。</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {drafts.map((d, i) => (
                <li key={d.key} className="sa-question-item">
                  <div>
                    <span className="sa-muted">#{i + 1}</span> <code>{d.question_code || '（未填代码）'}</code>{' '}
                    {d.title || '（未填题干）'}
                  </div>
                  <div className="sa-actions" style={{ marginTop: '0.25rem' }}>
                    <span className="sa-badge">{QUESTION_TYPE_LABELS[d.question_type]}</span>
                    {d.locked ? <span className="sa-badge sa-badge-danger">锁定</span> : null}
                    {d.is_sensitive ? <span className="sa-badge sa-badge-warn">敏感</span> : null}
                    {d.required ? <span className="sa-badge sa-badge-info">必填</span> : null}
                  </div>
                  <div className="sa-actions" style={{ marginTop: '0.25rem' }}>
                    <Button variant="secondary" disabled={i === 0} onClick={() => move(i, -1)}>
                      上移
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={i === drafts.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      下移
                    </Button>
                    <Button variant="secondary" onClick={() => openEdit(d)}>
                      编辑
                    </Button>
                    <Button variant="danger" onClick={() => remove(d.key)}>
                      删除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="sa-actions" style={{ marginTop: '0.5rem' }}>
            <Button variant="secondary" onClick={openNew}>
              新增题目
            </Button>
          </div>
          <p className="cc-hint">
            题目顺序即问卷顺序；提交后自动生成 order_index。已发布版本不可变，新版本只影响之后新建的活动问卷（FR-SUR-011）。
          </p>
        </>
      ) : (
        <div className="cc-field">
          <label className="cc-label" htmlFor="sa-schema-json">
            题目定义 JSON（schema_json）
          </label>
          <textarea
            id="sa-schema-json"
            className="sa-textarea"
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          <p className="cc-hint">
            与可视化编辑双向同步；建议包含 questions 数组（question_code、question_type、title、
            locked、is_sensitive、required、options_json）。模板发布将写入审计日志（PRD §11.3）。
          </p>
        </div>
      )}

      {error ? (
        <p className="cc-error" role="alert">
          {error}
        </p>
      ) : null}

      <div
        className="sa-actions"
        style={{ marginTop: '0.75rem', justifyContent: 'space-between' }}
      >
        <Button
          variant="secondary"
          disabled={saving}
          onClick={mode === 'visual' ? switchToJson : switchToVisual}
        >
          {mode === 'visual' ? 'JSON 原文' : '可视化编辑'}
        </Button>
        <div className="sa-actions">
          <Button loading={saving} onClick={() => void submit()}>
            {submitLabel}
          </Button>
          <Button variant="secondary" disabled={saving} onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    </div>
  );
}

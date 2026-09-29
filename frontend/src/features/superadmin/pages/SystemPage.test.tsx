import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { clearAllSessions, stubApi, unstubApi } from '../../../test/mockApi';
import { SuperSystemPage } from './SystemPage';

beforeEach(clearAllSessions);
afterEach(unstubApi);

it('默认展示四份生效表单，历史模板须主动展开，报名表不可误发为问卷', async () => {
  const templates = [
    { id: 'cr', name: 'Chatter 报名表', kind: 'registration' },
    { id: 'lr', name: 'Listener 报名表', kind: 'registration' },
    { id: 'cp', name: 'Chatter 后测', kind: 'survey' },
    { id: 'lp', name: 'Listener 后测', kind: 'survey' },
    { id: 'old', name: '旧前测', kind: 'survey', status: 'disabled' },
  ].map((item) => ({ status: 'active', ...item, template_code: item.id.toUpperCase(), current_version_id: `${item.id}v1` }));
  const list = (items: unknown[]) => ({ body: { page: 1, perPage: 500, totalItems: items.length, totalPages: 1, items } });
  stubApi({
    'GET /api/cc/super/backup-status': { body: { last_backup: null, alert: false } },
    'GET /api/collections/survey_templates/records': list(templates),
    'GET /api/collections/survey_template_versions/records': list(templates.map((item) => ({
      id: item.current_version_id, template_id: item.id, version: 1, schema_json: { questions: [] },
    }))),
  });
  render(<MemoryRouter><SuperSystemPage /></MemoryRouter>);
  expect(await screen.findByText('Chatter 报名表')).toBeInTheDocument();
  expect(screen.getByText('Listener 报名表')).toBeInTheDocument();
  expect(screen.getByText('Chatter 后测')).toBeInTheDocument();
  expect(screen.getByText('Listener 后测')).toBeInTheDocument();
  expect(screen.queryByText('旧前测')).not.toBeInTheDocument();
  const row = screen.getByText('Chatter 报名表').closest('tr')!;
  expect(within(row).getByRole('button', { name: '发布新版本' })).toBeDisabled();
  expect(within(row).getByRole('button', { name: '预览' })).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '显示已停用的历史模板' }));
  expect(screen.getByText('旧前测')).toBeInTheDocument();
});

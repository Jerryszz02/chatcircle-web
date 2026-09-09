import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = (name) => readFileSync(new URL('../pb_hooks/' + name, import.meta.url), 'utf8');
const inline = (name) => {
  const text = source(name);
  const start = text.indexOf('  const exportV2FindAll = ');
  const end = text.indexOf('\n  };', text.indexOf('return { requiresSensitive:', start)) + '\n  };'.length;
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
};
test('preview and create keep the same pagination and sensitivity implementation', () => {
  assert.equal(inline('exports.pb.js'), inline('exports_v2.pb.js'));
});
for (const name of ['lib/exportv2.pb.js', 'exports.pb.js', 'exports_v2.pb.js']) {
  test(name + ' preserves 1001 definitions and aggregates the last sensitive one', () => {
    const definitions = Array.from({ length: 1001 }, (_, i) => ({
      id: 'definition-' + i,
      get: (key) => ({ organization_id: 'org', is_sensitive: i === 1000, field_code: 'history' })[key],
    }));
    let calls = 0;
    const app = { findRecordsByFilter(collection, filter, sort, limit, offset) {
      assert.equal(collection, 'registration_field_defs');
      assert.equal(sort, 'id');
      calls++;
      return definitions.slice(offset, offset + limit);
    } };
    const selection = { columns: { system: [], registration_field_codes: ['history'], survey_questions: [] } };
    const isLibrary = name.startsWith('lib/');
    const context = { $app: app, app, selection, EXPORT_V2_SENSITIVE_SYSTEM_COLUMNS: [], exportV2OrgInClause: () => "organization_id = 'org'" };
    const code = isLibrary ? source(name) : inline(name);
    const result = vm.runInNewContext(code + '\nexportV2AnalyzeSelection(' +
      (isLibrary ? 'app, ' : '') + 'selection, ["org"], []);', { ...context });
    assert.equal(calls, 3);
    assert.equal(result.fieldDefIdsByCode.history.length, 1001);
    assert.equal(result.requiresSensitive, true);
    assert.equal(result.fieldDefSensitiveByCode.history, true);
    definitions[1000].get = (key) => ({ organization_id: 'org', is_sensitive: false })[key];
    const ordinary = vm.runInNewContext(code + '\nexportV2AnalyzeSelection(' +
      (isLibrary ? 'app, ' : '') + 'selection, ["org"], []);', { ...context });
    assert.equal(ordinary.requiresSensitive, false);
  });
}

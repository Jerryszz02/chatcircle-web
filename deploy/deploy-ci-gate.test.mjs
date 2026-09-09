import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const script = workflow.match(/          script: \|\n([\s\S]*?)\n  deploy:/)[1]
  .split('\n').map((line) => line.replace(/^            /, '')).join('\n');
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('context', 'github', 'core', 'process', script);
const sha = 'a'.repeat(40);
const passing = { conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha };
async function check({ event = 'workflow_run', run = passing, runs = [passing], requested = sha } = {}) {
  const result = { failures: [], output: null, calls: [] };
  await execute({ eventName: event, payload: { workflow_run: run }, repo: { owner: 'example', repo: 'app' } },
    { rest: { actions: { async listWorkflowRuns(args) {
      result.calls.push(args);
      assert.equal(args.workflow_id, 'ci.yml');
      assert.equal(args.head_sha, sha);
      return { data: { workflow_runs: runs } };
    } } } },
    { setFailed: (text) => result.failures.push(text), setOutput: (key, value) => { result.output = value; }, info() {} },
    { env: { REQUESTED_SHA: requested } });
  return result;
}

test('successful main push CI forwards exactly its SHA', async () => {
  const result = await check();
  assert.equal(result.output, sha);
  assert.deepEqual(result.failures, []);
});
test('failed CI and PR CI never dispatch deployment', async () => {
  for (const run of [{ ...passing, conclusion: 'failure' }, { ...passing, event: 'pull_request' }]) {
    const result = await check({ run });
    assert.equal(result.output, null);
    assert.equal(result.calls.length, 0);
    assert.equal(result.failures.length, 1);
  }
});
test('manual dispatch requires successful CI for the exact main push SHA', async () => {
  assert.equal((await check({ event: 'workflow_dispatch' })).output, sha);
  for (const run of [{ ...passing, conclusion: 'failure' }, { ...passing, head_sha: 'b'.repeat(40) },
    { ...passing, head_branch: 'feature' }, { ...passing, event: 'pull_request' }]) {
    const result = await check({ event: 'workflow_dispatch', runs: [run] });
    assert.equal(result.output, null);
    assert.equal(result.failures.length, 1);
  }
});
test('manual input is data and invalid SHA fails before API use', async () => {
  const result = await check({ event: 'workflow_dispatch', requested: "'; throw new Error('injected') //" });
  assert.equal(result.output, null);
  assert.equal(result.calls.length, 0);
  assert.equal(result.failures.length, 1);
  assert.doesNotMatch(script, /\$\{\{ inputs\./);
  assert.match(workflow, /        env:\n          REQUESTED_SHA:/);
});
test('preflight and deploy use positional SHA and the same prebuilt image', () => {
  assert.equal((workflow.match(/target_sha="\$1"/g) || []).length, 2);
  assert.doesNotMatch(workflow, /git fetch[^\n]*\$DEPLOY_SHA/);
  assert.match(workflow, /git merge-base --is-ancestor "\$previous_sha" "\$target_sha"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$target_sha"/);
  assert.match(workflow, /docker compose up --no-build --pull never -d/);
  assert.ok(workflow.indexOf('docker compose exec -T backup') < workflow.indexOf('git merge --ff-only'));
});

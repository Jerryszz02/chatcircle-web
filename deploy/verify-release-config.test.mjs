import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasActiveAdminConsoleBlock,
  hasCandidateImagePreflightBuild,
} from './verify-release-config.mjs';

test('accepts an active admin-console deny handler', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    handle /_/* {
      respond 403
    }
  `), true);
});

test('rejects a deny handler that only appears in comments', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    # handle /_/* {
    #   respond 403
    # }
  `), false);
});

test('requires respond 403 inside the admin-console handler', () => {
  assert.equal(hasActiveAdminConsoleBlock(`
    handle /_/* {
      reverse_proxy app:8090
    }

    handle {
      respond 403
    }
  `), false);
});

test('accepts the active candidate-image preflight build command', () => {
  assert.equal(hasCandidateImagePreflightBuild(`
    docker compose config -q
    docker compose --project-name "$preflight_project" build
  `), true);
});

test('rejects comments and the later production up --build command', () => {
  assert.equal(hasCandidateImagePreflightBuild(`
    # docker compose --project-name "$preflight_project" build
    # Building candidate images...
    docker compose up --build -d
  `), false);
});

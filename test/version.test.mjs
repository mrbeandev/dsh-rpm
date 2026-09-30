import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, classifyVersion, SUPPORTED_DSH_RANGE, TESTED_DSH_VERSIONS } from '../index.mjs';

test('compareVersions orders cores and prereleases', () => {
  assert.equal(compareVersions('0.1.5-rc.2', '0.1.5-rc.3'), -1);
  assert.equal(compareVersions('0.1.5', '0.1.5-rc.3'), 1);
  assert.equal(compareVersions('0.2.0-rc.1', '0.2.0-rc.1'), 0);
  assert.equal(compareVersions('0.1.9', '0.2.0'), -1);
});

test('classifyVersion: tested releases are exact', () => {
  for (const v of TESTED_DSH_VERSIONS) assert.equal(classifyVersion(v), 'tested');
});

test('classifyVersion: untested in-range releases load with a warning', () => {
  assert.equal(classifyVersion('0.1.6-rc.1'), 'compatible');
  assert.equal(classifyVersion('0.2.1'), 'compatible');
});

test('classifyVersion: out-of-range releases are refused', () => {
  assert.equal(classifyVersion('0.1.4'), 'unsupported');
  assert.equal(classifyVersion('0.3.0'), 'unsupported');
  assert.equal(classifyVersion('0.3.0-alpha.1'), 'unsupported');
  assert.equal(classifyVersion(undefined), 'unknown');
});

test('supported range matches dsh-short-tool-ids v0.4.0', () => {
  assert.deepEqual(SUPPORTED_DSH_RANGE, { min: '0.1.5-rc.1', below: '0.3.0' });
});

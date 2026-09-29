/**
 * BuildTrack Video Factory - Phase 3A Scenario Fixtures
 *
 * Provides typed, canonical scenario examples for progress meetings,
 * commercial claims, and schedule-risk reviews.
 */

import { Scenario } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to resolve fixtures directory whether running in source or dist
function getFixturesDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../../../../tests/fixtures/scenarios'),
    path.resolve(__dirname, '../../../../tests/fixtures/scenarios'),
    path.resolve(process.cwd(), 'tests/fixtures/scenarios'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[2];
}

export function loadScenarioFixture(filename: string): Scenario {
  const dir = getFixturesDir();
  const filePath = path.join(dir, filename.endsWith('.json') ? filename : `${filename}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Scenario fixture not found at path: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content) as Scenario;
}

export const getProgressMeetingScenario = (): Scenario => loadScenarioFixture('progress-meeting.json');
export const getClaimVariationScenario = (): Scenario => loadScenarioFixture('claim-variation.json');
export const getScheduleRiskScenario = (): Scenario => loadScenarioFixture('schedule-risk.json');

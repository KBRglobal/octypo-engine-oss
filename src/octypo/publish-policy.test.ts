import { describe, it, expect } from 'vitest';
import { shouldAutoPublish, approvedStatus } from './publish-policy.js';

// AUTO_PUBLISH is the one safety switch a cautious customer relies on. It used to
// be evaluated in two places with two different literal lists, and the gatekeeper
// wrote "published" before the job handler could revert it. These tests exist so
// the decision stays in one place and keeps meaning what the customer thinks.
describe('publish policy', () => {
  it('defaults to auto-publishing when unset', () => {
    expect(shouldAutoPublish({} as NodeJS.ProcessEnv)).toBe(true);
    expect(approvedStatus({} as NodeJS.ProcessEnv)).toBe('published');
  });

  it.each(['false', 'FALSE', '0', 'no', 'off', ' off '])(
    'treats %j as "hold for review"',
    (value) => {
      const env = { AUTO_PUBLISH: value } as NodeJS.ProcessEnv;
      expect(shouldAutoPublish(env)).toBe(false);
      expect(approvedStatus(env)).toBe('in_review');
    },
  );

  it('never holds as "draft" — the scheduler auto-slots drafts', () => {
    // The regression this guards: a held article written as "draft" was picked
    // up by autoSlotDrafts on the next tick and published anyway, so the
    // AUTO_PUBLISH=false switch protected nothing.
    const env = { AUTO_PUBLISH: 'false' } as NodeJS.ProcessEnv;
    expect(approvedStatus(env)).not.toBe('draft');
  });

  it.each(['true', 'TRUE', '1', 'yes', 'anything-else'])(
    'treats %j as auto-publish',
    (value) => {
      const env = { AUTO_PUBLISH: value } as NodeJS.ProcessEnv;
      expect(shouldAutoPublish(env)).toBe(true);
      expect(approvedStatus(env)).toBe('published');
    },
  );

  it('never returns "published" while holding for review', () => {
    // The regression this guards: an approved article was written as published
    // and only afterwards reverted to draft, leaving it briefly live.
    const env = { AUTO_PUBLISH: 'false' } as NodeJS.ProcessEnv;
    expect(approvedStatus(env)).not.toBe('published');
  });
});

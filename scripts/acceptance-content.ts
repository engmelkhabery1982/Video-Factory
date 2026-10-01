/**
 * ACCEPTANCE CONTENT — fresh, unseen, fictional training examples.
 *
 * Shared by the acceptance driver (`scripts/final-product-acceptance.ts`) and
 * its regression tests, so the content shape the acceptance depends on is
 * itself guarded by a test.
 *
 * Nothing here is a fixture scenario and nothing is replayed from a previous
 * run: every sentence is the SOURCE AUTHORITY for a fictional example, and the
 * numbers a scenario may speak are declared explicitly.
 */

/**
 * Newly authored for this acceptance. A clearly fictional professional
 * training example: every statement below is the SOURCE AUTHORITY for this
 * fictional scenario, not a real industry statistic.
 */
export const ACCEPTANCE_VIDEO_ID = 'FinalAcceptance_RFI_Backlog';

export const ACCEPTANCE_INPUT = {
  videoId: ACCEPTANCE_VIDEO_ID,
  videoType: 'long',
  topic: 'Controlling an ageing RFI backlog before it becomes schedule delay',
  targetAudience: 'Package managers and document controllers',
  mainProblem: 'Ageing RFIs quietly turn into schedule delay',
  viewerPromise: 'A repeatable 48-hour control routine for the RFI register',
  hook: 'Twenty-four open RFIs, eight of them older than fourteen days.',
  script: [
    'This training example follows a fictional RFI register on a mid-size commercial fit-out.',
    'The register currently holds 24 open RFIs.',
    'Eight of those RFIs are older than 14 days.',
    'The control rule reviews the whole register every 48 hours.',
    'Any RFI still without a response after 7 days is escalated to the package manager.',
    'Three control actions stop the backlog from becoming schedule delay.',
    'First, age the register and flag every item past 14 days.',
    'Second, assign a single named owner to each open RFI.',
    'Third, escalate the aged items on a fixed 48-hour cycle.',
    'An ageing RFI only becomes delay when nobody owns the clock.',
    'Start your BuildTrack trial and put the register on a clock.',
  ].join('\n'),
  keyNumbers: ['24 open RFIs', '8 older than 14 days', '48 hours', '7 days', '3 control actions'],
  keyPoints: ['Age the register', 'Single named owner', 'Fixed escalation cycle'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — RFI Backlog Control, acceptance scenario'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

/** Deterministic, locally generated acceptance asset (never a fixture copy). */
export const ACCEPTANCE_ASSET = {
  /** The acceptance asset's own label/filename stem. NOT a binding logicalRef:
   *  the binding logicalRef is discovered from the generated Long plan. */
  label: 'rfi-ageing-summary',
  name: 'RFI Ageing Summary (acceptance)',
  kind: 'chart',
  source: 'Generated locally for Final Product Acceptance',
  license: 'Project-owned acceptance evidence',
  tags: ['acceptance-asset', 'acceptance'],
};

/** The exact set of source numbers the acceptance script is allowed to speak. */
export const SOURCE_NUMBERS = new Set(['24', '8', '14', '48', '7', '3']);

/**
 * SECOND fresh, unseen, fictional project (18/17G). Its only job is to prove
 * that production generation consumes project 1's PERSISTED production history
 * on a fresh run with no render at all.
 */
export const SECOND_ACCEPTANCE_VIDEO_ID = 'FinalAcceptance_Register_Handover';


export const SECOND_ACCEPTANCE_INPUT = {
  videoId: SECOND_ACCEPTANCE_VIDEO_ID,
  videoType: 'long',
  topic: 'Handing over an RFI register without losing ownership',
  targetAudience: 'Site managers taking over a live register',
  mainProblem: 'Register ownership blurs at handover',
  viewerPromise: 'A named-owner handover routine for the register',
  hook: 'Two owners for one register means no owner at all.',
  script: [
    'This training example follows a fictional register handover on a live fit-out.',
    'The handover pack contains 12 open items.',
    'Three named owners cover the whole register.',
    'The handover is signed off within 5 working days.',
    'One owner is named against every register line before the pack is signed.',
    'The escalation clock is handed over with the register, not reset.',
    'Start your BuildTrack trial and hand over a register with one owner.',
  ].join('\n'),
  keyNumbers: ['12 open items', '3 named owners', '5 working days'],
  keyPoints: ['Name one owner per register', 'Hand over the escalation clock', 'Sign the register handover'],
  productName: 'BuildTrack',
  productShots: [],
  cta: 'Start your BuildTrack trial',
  voiceoverFile: null,
  targetAudio: {},
  brollFiles: [],
  sourceReferences: ['Fictional training example — Register Handover, acceptance scenario'],
  outputLanguage: 'en',
  brandPreset: 'buildtrack',
  shortCount: 1,
};

/** The exact set of source numbers the SECOND acceptance project may speak. */
export const SECOND_SOURCE_NUMBERS = new Set(['12', '3', '5']);

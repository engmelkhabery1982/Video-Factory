import React from 'react';
import { useCurrentFrame } from 'remotion';
import type {
  RemotionBeatCompositionSpec,
  RemotionSceneCompositionSpec,
  SceneRenderCharacter,
} from '@buildtrack/core';
import { isDialogueEvidenceBeat } from '@buildtrack/core';
import { FONTS, LAYOUT, SHORTS_UNSAFE, type Theme } from '../brand/theme';

/**
 * Workstream C — Dialogue / Character Visual Production
 *
 * A real, reusable dialogue scene component. It renders a Phase 5C scene as a
 * professional conversation instead of collapsing it into a generic text card.
 *
 * Design constraints honoured here:
 * - The CURRENT LOCAL FRAME selects the active beat. Timing is never
 *   re-estimated: every interval comes from `localStartFrame`/`localEndFrame`,
 *   which Phase 5C derived from the authoritative Phase 4 reconciled timing.
 * - Faceless channel: characters are stylised professional presentations
 *   (initials silhouette + role plate), never generated photos. No network
 *   calls, no image generation.
 * - Shot semantics are visible and distinct: two_shot, close_up, medium,
 *   over_the_shoulder and wide each produce a different composition, and
 *   speakerFocus / focusCharacterId / framing steer it further.
 * - cameraMovement produces subtle deterministic movement only, derived from
 *   beat progress. No timing or narrative change.
 * - Portrait (Short) is a native layout, not a cropped Long: participants
 *   stack, everything stays inside LAYOUT.short.safe and clear of the platform
 *   risk zones, and the caption band stays free.
 *
 * The `data-dialogue-*` attributes are invisible diagnostic markers (same
 * pattern as the existing `data-buildtrack-resolved-media`). They carry no
 * styling and exist so the shot/focus/plane decisions are assertable.
 */

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

/** Stable small non-cryptographic hash — same id always yields the same tint. */
function stableHash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Deterministic on-brand tint per character so cast members stay distinct. */
function characterTint(character: SceneRenderCharacter, t: Theme): string {
  const palette = [t.c.primary, t.c.secondary, t.c.accent];
  return palette[stableHash(character.id) % palette.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** 0..1 progress through the beat, from the authoritative local frame range. */
function beatProgress(beat: RemotionBeatCompositionSpec, localFrame: number): number {
  const span = beat.localEndFrame - beat.localStartFrame;
  if (span <= 0) return 0;
  const p = (localFrame - beat.localStartFrame) / span;
  return Math.max(0, Math.min(1, p));
}

/**
 * Subtle deterministic camera movement. Pure visual offset — it never changes
 * when a beat starts or ends, so authoritative audio timing is untouched.
 */
export function cameraOffset(movement: string, progress: number): { x: number; y: number; scale: number } {
  const eased = progress;
  switch (movement) {
    case 'slow_push':
      return { x: 0, y: 0, scale: 1 + 0.028 * eased };
    case 'slow_pull':
      return { x: 0, y: 0, scale: 1.03 - 0.028 * eased };
    case 'pan_left':
      return { x: 14 - 28 * eased, y: 0, scale: 1 };
    case 'pan_right':
      return { x: -14 + 28 * eased, y: 0, scale: 1 };
    case 'subtle_drift':
      return { x: 0, y: -7 + 14 * eased, scale: 1 };
    case 'static':
    default:
      return { x: 0, y: 0, scale: 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Shot semantics                                                      */
/* ------------------------------------------------------------------ */

export type DialogueComposition =
  | 'two_shot'
  | 'close_up'
  | 'medium'
  | 'over_the_shoulder'
  | 'wide'
  | 'insert';

/** Visual plane a participant is drawn on. */
export type DialoguePlane = 'foreground' | 'background' | 'stage';

/** Which character the shot is about, and which one reacts. */
export interface DialogueFocus {
  /** Character the composition leads with. */
  primaryId: string | null;
  /** Character shown as secondary / reacting. */
  secondaryId: string | null;
}

/**
 * Resolves the visual focus for a beat.
 *
 * Precedence (documented, deterministic):
 *   1. `shot.focusCharacterId` when it resolves to a known participant.
 *   2. `speakerFocus === 'reacting_character'` → the reacting character.
 *   3. Otherwise the active speaker.
 *
 * The reacting character is only ever taken from `reactingCharacterId`; it is
 * never invented, and never taken from `activeSpeakerId`.
 */
export function resolveDialogueFocus(
  beat: RemotionBeatCompositionSpec,
  knownIds: Set<string>
): DialogueFocus {
  const active = beat.activeSpeakerId && knownIds.has(beat.activeSpeakerId) ? beat.activeSpeakerId : null;
  const reacting =
    beat.reactingCharacterId && knownIds.has(beat.reactingCharacterId) ? beat.reactingCharacterId : null;

  let primaryId: string | null = null;
  if (beat.shot.focusCharacterId && knownIds.has(beat.shot.focusCharacterId)) {
    primaryId = beat.shot.focusCharacterId;
  } else if (beat.shot.speakerFocus === 'reacting_character' && reacting) {
    primaryId = reacting;
  } else {
    primaryId = active;
  }

  // The secondary is whoever is left that is not the primary.
  let secondaryId: string | null = reacting && reacting !== primaryId ? reacting : null;
  if (!secondaryId && active && active !== primaryId) secondaryId = active;

  return { primaryId, secondaryId };
}

/** Maps an authoritative shotType onto a composition archetype. */
export function compositionForShot(shotType: string): DialogueComposition {
  switch (shotType) {
    case 'two_shot':
      return 'two_shot';
    case 'close_up':
      return 'close_up';
    case 'medium':
      return 'medium';
    case 'over_the_shoulder':
      return 'over_the_shoulder';
    case 'wide':
      return 'wide';
    default:
      // screen_insert / point_of_view / detail_macro and anything unknown are
      // treated as an evidence/insert moment with a participant strip.
      return 'insert';
  }
}

/**
 * Selects the beat that owns `localFrame`.
 *
 * Clamps rather than wrapping: a frame before the first beat resolves to the
 * first beat, a frame past the last resolves to the last. The component is
 * mounted inside a Sequence so only in-range frames occur in practice; this
 * just makes the out-of-range behaviour predictable instead of surprising.
 */
export function selectBeat(
  beats: RemotionBeatCompositionSpec[],
  localFrame: number,
): RemotionBeatCompositionSpec | null {
  if (!beats || beats.length === 0) return null;
  const inRange = beats.find((b) => localFrame >= b.localStartFrame && localFrame < b.localEndFrame);
  if (inRange) return inRange;
  return localFrame < beats[0].localStartFrame ? beats[0] : beats[beats.length - 1];
}

/** True when the beat is about shared evidence rather than a person. */
export function isEvidenceBeat(beat: RemotionBeatCompositionSpec): boolean {
  return isDialogueEvidenceBeat(beat);
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

const ROLE_GLYPH: Record<string, string> = {
  challenger: '▲',
  technical_authority: '◆',
  decision_maker: '■',
  mediator: '●',
};

function roleGlyph(narrativeFunction: string): string {
  return ROLE_GLYPH[narrativeFunction] ?? '●';
}

/** Intent / delivery chip — subtle, professional, never cartoonish. */
const IntentChip: React.FC<{ intent: string | null; delivery: string | null; accent: string }> = ({
  intent,
  delivery,
  accent,
}) => {
  if (!intent && !delivery) return null;
  const label = [intent, delivery].filter(Boolean).join(' · ').toUpperCase();
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        fontFamily: FONTS.body,
        fontWeight: 700,
        fontSize: 15,
        letterSpacing: 1.4,
        color: accent,
        border: `1px solid ${accent}55`,
        borderRadius: 999,
        padding: '5px 14px',
        background: 'rgba(8,18,32,0.55)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </div>
  );
};

/**
 * Faceless professional character presentation: initials silhouette, role
 * plate, name and narrative-function tag. No photography, no network.
 */
const CharacterPlate: React.FC<{
  character: SceneRenderCharacter;
  /** Visual weight: the character the composition leads with. */
  emphasis: 'lead' | 'support';
  /** Depth plane the plate is drawn on. */
  plane: DialoguePlane;
  scale: number;
  accent: string;
  t: Theme;
  size: 'lead' | 'support' | 'strip';
}> = ({ character, emphasis, plane, scale, accent, t, size }) => {
  const tint = characterTint(character, t);
  const isLead = emphasis === 'lead';
  const portrait = size === 'lead' ? 260 : size === 'support' ? 168 : 96;
  const nameSize = size === 'lead' ? 34 : size === 'support' ? 26 : 20;
  const roleSize = size === 'lead' ? 22 : size === 'support' ? 18 : 15;

  return (
    <div
      data-dialogue-speaker={character.id}
      data-dialogue-emphasis={emphasis}
      data-dialogue-plane={plane}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: size === 'strip' ? 8 : 14,
        transform: `scale(${scale})`,
        transformOrigin: 'center',
        opacity: plane === 'background' ? 0.55 : isLead ? 1 : 0.74,
        minWidth: 0,
      }}
    >
      {/* silhouette */}
      <div
        style={{
          position: 'relative',
          width: portrait,
          height: portrait,
          borderRadius: size === 'strip' ? 22 : 28,
          background: `linear-gradient(165deg, ${tint}2E 0%, rgba(8,18,32,0.92) 70%)`,
          border: isLead ? `4px solid ${accent}` : `2px solid ${tint}66`,
          boxShadow: isLead
            ? `0 0 0 6px ${accent}22, 0 18px 44px rgba(0,0,0,0.5)`
            : '0 10px 26px rgba(0,0,0,0.34)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {/* stylised head + shoulders silhouette */}
        <div
          style={{
            position: 'absolute',
            bottom: -portrait * 0.16,
            width: portrait * 0.52,
            height: portrait * 0.42,
            borderRadius: `${portrait}px ${portrait}px 0 0`,
            background: `${tint}${isLead ? 'CC' : '77'}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: portrait * 0.16,
            width: portrait * 0.3,
            height: portrait * 0.3,
            borderRadius: '50%',
            background: `${tint}${isLead ? 'E6' : '88'}`,
          }}
        />
        <span
          style={{
            position: 'relative',
            fontFamily: FONTS.heading,
            fontWeight: 800,
            fontSize: portrait * 0.3,
            color: '#FFFFFF',
            letterSpacing: 1,
            textShadow: '0 2px 10px rgba(0,0,0,0.85)',
          }}
        >
          {initialsOf(character.name)}
        </span>
        {/* role glyph badge */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            width: 34,
            height: 34,
            borderRadius: 10,
            background: 'rgba(8,18,32,0.86)',
            border: `1px solid ${tint}88`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONTS.body,
            fontSize: 16,
            color: tint,
          }}
        >
          {roleGlyph(character.narrativeFunction)}
        </div>
      </div>

      {/* name + role plate */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          maxWidth: size === 'strip' ? 260 : 420,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontFamily: FONTS.heading,
            fontWeight: 800,
            fontSize: nameSize,
            lineHeight: 1.12,
            color: isLead ? '#FFFFFF' : 'rgba(230,237,246,0.82)',
            textShadow: '0 2px 8px rgba(0,0,0,0.8)',
          }}
        >
          {character.name}
        </div>
        <div
          style={{
            fontFamily: FONTS.body,
            fontWeight: 600,
            fontSize: roleSize,
            lineHeight: 1.2,
            color: isLead ? accent : 'rgba(230,237,246,0.62)',
            letterSpacing: 0.3,
          }}
        >
          {character.role}
        </div>
        {size !== 'strip' ? (
          <div
            style={{
              fontFamily: FONTS.body,
              fontWeight: 600,
              fontSize: size === 'lead' ? 16 : 14,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              color: 'rgba(230,237,246,0.5)',
            }}
          >
            {character.narrativeFunction.replace(/_/g, ' ')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** Evidence / insert context panel — what the beat is actually about. */
const EvidencePanel: React.FC<{
  beat: RemotionBeatCompositionSpec;
  scene: RemotionSceneCompositionSpec;
  accent: string;
  t: Theme;
  portrait: boolean;
  mediaUrl?: string | null;
}> = ({ beat, scene, accent, t, portrait, mediaUrl }) => {
  const insert = scene.production?.screenInsert;
  const label = insert?.title ?? scene.onScreenInfo?.title ?? scene.title ?? 'Evidence';
  const detail = insert?.description ?? scene.onScreenInfo?.subtitle ?? null;
  const facts = beat.evidenceIds.length > 0 ? `${beat.evidenceIds.length} cited record(s)` : null;

  return (
    <div
      data-dialogue-evidence="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: portrait ? 20 : 24,
        borderRadius: t.radius,
        background: 'rgba(8,18,32,0.78)',
        border: `2px solid ${accent}55`,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: FONTS.body,
          fontWeight: 800,
          fontSize: portrait ? 20 : 18,
          letterSpacing: 1.6,
          textTransform: 'uppercase',
          color: accent,
        }}
      >
        Evidence in view
      </div>
      <div
        style={{
          fontFamily: FONTS.heading,
          fontWeight: 700,
          fontSize: portrait ? 34 : 28,
          color: '#FFFFFF',
          lineHeight: 1.2,
        }}
      >
        {label}
      </div>
      {detail ? (
        <div
          style={{
            fontFamily: FONTS.body,
            fontWeight: 500,
            fontSize: portrait ? 24 : 20,
            color: 'rgba(230,237,246,0.78)',
            lineHeight: 1.35,
          }}
        >
          {detail}
        </div>
      ) : null}
      {facts ? (
        <div
          style={{
            fontFamily: FONTS.numeric,
            fontWeight: 700,
            fontSize: portrait ? 22 : 18,
            color: 'rgba(230,237,246,0.66)',
          }}
        >
          {facts}
        </div>
      ) : null}
      {/* Phase 6A/6B asset compatibility: resolved media stays visible. */}
      {mediaUrl ? (
        <div
          data-buildtrack-resolved-media={mediaUrl}
          style={{
            marginTop: 4,
            borderRadius: Math.max(4, t.radius - 6),
            border: `1px solid ${accent}44`,
            minHeight: portrait ? 220 : 200,
            backgroundImage: `url(${mediaUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* DialogueScene                                                       */
/* ------------------------------------------------------------------ */

export interface DialogueSceneProps {
  scene: RemotionSceneCompositionSpec;
  t: Theme;
  format: 'long' | 'short';
  /** Resolved production media for this scene (Phase 6A mediaMap). */
  mediaUrl?: string | null;
  /** 0..1 position inside the scene (informational only; never re-timed). */
  progress?: number;
  debug?: boolean;
}

export const DialogueScene: React.FC<DialogueSceneProps> = ({
  scene,
  t,
  format,
  mediaUrl = null,
  debug = false,
}) => {
  // The component is mounted inside a Sequence, so useCurrentFrame() is LOCAL.
  const localFrame = useCurrentFrame();
  const portrait = format === 'short';

  const characters = scene.participants ?? [];
  const knownIds = new Set(characters.map((c) => c.id));
  const byId = new Map(characters.map((c) => [c.id, c]));

  // Authoritative beat selection from the current local frame. No re-estimation.
  const beat = selectBeat(scene.beats, localFrame);

  if (!beat) {
    // No beat at all — nothing honest to draw as dialogue.
    return <div style={{ position: 'absolute', inset: 0 }} />;
  }

  const focus = resolveDialogueFocus(beat, knownIds);
  const primary = focus.primaryId ? byId.get(focus.primaryId) ?? null : null;
  const secondary = focus.secondaryId ? byId.get(focus.secondaryId) ?? null : null;
  const activeSpeaker =
    beat.activeSpeakerId && knownIds.has(beat.activeSpeakerId) ? byId.get(beat.activeSpeakerId) ?? null : null;

  const evidence = isEvidenceBeat(beat);
  const composition = evidence ? 'insert' : compositionForShot(beat.shot.shotType);
  const cam = cameraOffset(beat.shot.cameraMovement, beatProgress(beat, localFrame));
  const accent = scene.visualTreatment.accent ?? t.c.accent;

  const safe = portrait ? LAYOUT.short.safe : LAYOUT.long.safe;
  // Portrait: keep clear of the top risk zone and the caption band at the bottom.
  const topInset = portrait ? Math.max(safe, SHORTS_UNSAFE.top.height + 24) : safe;
  const bottomInset = portrait ? Math.max(safe, 640) : safe;
  const sideInset = portrait ? safe : safe;

  const framingLeft = beat.shot.framing === 'rule_of_thirds_left';
  const framingRight = beat.shot.framing === 'rule_of_thirds_right';

  /* ---- plate factory --------------------------------------------- */

  const plate = (
    character: SceneRenderCharacter,
    isLead: boolean,
    plane: DialoguePlane,
    size: 'lead' | 'support' | 'strip',
    scale = 1,
  ) => (
    <CharacterPlate
      character={character}
      emphasis={isLead ? 'lead' : 'support'}
      plane={plane}
      scale={scale}
      accent={accent}
      t={t}
      size={size}
    />
  );

  let body: React.ReactNode;

  if (composition === 'insert') {
    // Evidence / shared display: the context leads, participants stay present
    // as a compact strip so the conversation is still legible.
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: portrait ? 28 : 36,
          minWidth: 0,
          width: '100%',
        }}
      >
        <EvidencePanel beat={beat} scene={scene} accent={accent} t={t} portrait={portrait} mediaUrl={mediaUrl} />
        <div
          style={{
            display: 'flex',
            flexDirection: portrait ? 'column' : 'row',
            justifyContent: 'center',
            alignItems: portrait ? 'center' : 'flex-end',
            gap: portrait ? 20 : 48,
          }}
        >
          {activeSpeaker ? plate(activeSpeaker, true, 'stage', 'strip') : null}
          {secondary && secondary.id !== activeSpeaker?.id ? plate(secondary, false, 'stage', 'strip', 0.82) : null}
        </div>
      </div>
    );
  } else if (composition === 'two_shot') {
    // Two characters visible, balanced framing.
    const left = framingLeft ? primary : framingRight ? secondary : primary;
    const right = framingLeft ? secondary : framingRight ? primary : secondary;
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: portrait ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: portrait ? 40 : 96,
          width: '100%',
          minWidth: 0,
        }}
      >
        {left ? plate(left, left.id === primary?.id, 'stage', portrait ? 'lead' : 'support', left.id === primary?.id ? 1 : 0.86) : null}
        {right ? plate(right, right.id === primary?.id, 'stage', portrait ? 'lead' : 'support', right.id === primary?.id ? 1 : 0.86) : null}
      </div>
    );
  } else if (composition === 'close_up') {
    // Active / focused character dominates the frame.
    body = (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          minWidth: 0,
        }}
      >
        {primary ? plate(primary, true, 'stage', 'lead', 1) : null}
        {secondary ? (
          <div style={{ position: 'absolute', right: portrait ? 0 : sideInset, bottom: portrait ? 0 : 24 }}>
            {plate(secondary, false, 'stage', 'strip', 0.78)}
          </div>
        ) : null}
      </div>
    );
  } else if (composition === 'over_the_shoulder') {
    // Foreground reacting / secondary participant with the focused speaker behind.
    const foreground = secondary ?? primary;
    const background = foreground && foreground.id === secondary?.id ? primary : secondary;
    body = (
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: portrait ? 'center' : framingLeft ? 'flex-start' : 'flex-end',
          width: '100%',
          minWidth: 0,
        }}
      >
        {background ? (
          <div style={{ transform: 'scale(0.9)' }}>{plate(background, background.id === primary?.id, 'background', 'support', 0.9)}</div>
        ) : null}
        {foreground ? (
          <div
            style={{
              position: 'absolute',
              bottom: portrait ? -40 : -70,
              left: portrait ? '50%' : framingLeft ? '62%' : '-6%',
              transform: portrait ? 'translateX(-50%)' : 'none',
              zIndex: 2,
            }}
          >
            {plate(foreground, foreground.id === primary?.id, 'foreground', 'lead', 1.04)}
          </div>
        ) : null}
      </div>
    );
  } else if (composition === 'wide') {
    // Both participants plus broader environment / context.
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: portrait ? 24 : 32,
          width: '100%',
          minWidth: 0,
          alignItems: 'center',
        }}
      >
        <div
          data-dialogue-context={scene.locationId ?? ''}
          style={{
            width: '100%',
            padding: portrait ? '18px 22px' : '20px 28px',
            borderRadius: t.radius,
            background: 'rgba(8,18,32,0.6)',
            border: `1px solid ${accent}33`,
            fontFamily: FONTS.body,
            fontWeight: 700,
            fontSize: portrait ? 22 : 20,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            color: 'rgba(230,237,246,0.72)',
            textAlign: 'center',
          }}
        >
          {scene.locationId ? scene.locationId.replace(/^loc-/, '').replace(/-/g, ' ') : 'Site context'}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: portrait ? 'column' : 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: portrait ? 32 : 80,
          }}
        >
          {primary ? plate(primary, true, 'stage', 'support', 0.92) : null}
          {secondary ? plate(secondary, false, 'stage', 'support', 0.78) : null}
        </div>
      </div>
    );
  } else {
    // medium: speaker prominent with secondary reaction context.
    body = (
      <div
        style={{
          display: 'flex',
          flexDirection: portrait ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: portrait ? 36 : 72,
          width: '100%',
          minWidth: 0,
        }}
      >
        {primary ? plate(primary, true, 'stage', 'lead', 1) : null}
        {secondary ? plate(secondary, false, 'stage', 'support', 0.8) : null}
      </div>
    );
  }

  /* ---- shell ------------------------------------------------------ */

  return (
    <div
      data-dialogue-scene="true"
      data-dialogue-composition={composition}
      data-dialogue-shot={beat.shot.shotType}
      data-dialogue-focus={beat.shot.speakerFocus}
      data-dialogue-beat={beat.id}
      data-dialogue-active-speaker={beat.activeSpeakerId ?? ''}
      data-dialogue-reacting={beat.reactingCharacterId ?? ''}
      data-dialogue-orientation={portrait ? 'portrait' : 'landscape'}
      data-dialogue-width={scene.width}
      data-dialogue-height={scene.height}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: `linear-gradient(${portrait ? '180deg' : '160deg'}, #0A1526 0%, ${t.c.surfaceDark} 100%)`,
      }}
    >
      {/* camera movement — subtle, deterministic, purely visual */}
      <div
        data-dialogue-camera={beat.shot.cameraMovement}
        style={{
          position: 'absolute',
          inset: -24,
          transform: `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.scale.toFixed(4)})`,
          willChange: 'transform',
        }}
      />
      <div
        data-dialogue-safe-top={topInset}
        data-dialogue-safe-bottom={bottomInset}
        data-dialogue-safe-side={sideInset}
        style={{
          position: 'absolute',
          inset: 0,
          paddingTop: topInset,
          paddingBottom: bottomInset,
          paddingLeft: sideInset,
          paddingRight: sideInset,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          gap: portrait ? 24 : 28,
          boxSizing: 'border-box',
        }}
      >
        <IntentChip intent={beat.intent} delivery={beat.delivery} accent={accent} />
        {body}
      </div>

      {debug ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            padding: '8px 16px',
            background: 'rgba(0,0,0,0.7)',
            color: '#FFF',
            fontFamily: 'monospace',
            fontSize: 12,
            zIndex: 100,
          }}
        >
          <div>
            DIALOGUE {scene.rendererKey} → {composition} | shot {beat.shot.shotType} | focus {beat.shot.speakerFocus}
          </div>
          <div>
            beat [{beat.localStartFrame},{beat.localEndFrame}) active={String(beat.activeSpeakerId)} reacting=
            {String(beat.reactingCharacterId)}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DialogueScene;

import React from 'react';
import { Banner, Field, Tag } from '../ui';
import type { EditorAssetRef, EditorCapabilities, EditorDocument } from '../../lib/editor-types';
import { documentDuration, opUpdate, round3, placedClipAt } from '../../lib/editor-model';
import { EngineState, NumberInput, Select, TextInput, kindLabel, seconds, type Stage } from './shared';

/** The subset of the existing asset library the editor needs (GET /api/assets). */
export interface LibraryAsset {
  id: string;
  name: string;
  kind: string;
  mimeType?: string;
  source: string;
  license: string;
  durationSec?: number;
  width?: number;
  height?: number;
  status?: string;
  blocked?: boolean;
}

/**
 * The material kind is taken from the measured MIME type first, so a logo SVG
 * is an image and never silently looks like audio; the library's own `kind` is
 * only a fallback because it can be a non-media bucket (logo, chart, icon...).
 */
export const toAssetRef = (asset: LibraryAsset): EditorAssetRef => ({
  id: asset.id,
  kind: asset.mimeType?.startsWith('video/')
    ? 'video'
    : asset.mimeType?.startsWith('image/')
      ? 'image'
      : asset.mimeType?.startsWith('audio/')
        ? 'audio'
        : asset.kind === 'video'
          ? 'video'
          : asset.kind === 'image'
            ? 'image'
            : 'audio',
  name: asset.name,
  mediaUrl: `/media/asset/${asset.id}`,
  durationSec: typeof asset.durationSec === 'number' ? asset.durationSec : null,
  source: asset.source ?? '',
  license: asset.license ?? '',
  sha256: null,
});

/**
 * The asset panel.
 *
 * A file in the library is NOT bound to a scene. Binding is an explicit action
 * that sets `sourceAssetId` on the selected clip, so the operator can always
 * tell "uploaded" from "used". Provenance is shown exactly as the library
 * records it: an empty source/licence is labelled as not recorded, never
 * silently promoted to owner-owned.
 */
export const EditorAssetPanel: React.FC<{
  document: EditorDocument;
  library: LibraryAsset[];
  libraryError: string | null;
  uploadBusy: boolean;
  selectedClipId: string | null;
  onUpload: (file: File) => void;
  onAssign: (asset: EditorAssetRef) => void;
  disabled: boolean;
}> = ({ document, library, libraryError, uploadBusy, selectedClipId, onUpload, onAssign, disabled }) => {
  const boundClips = (assetId: string) =>
    document.visualClips.filter((clip) => clip.sourceAssetId === assetId).map((clip) => clip.id);
  const selected = placedClipAt(document, selectedClipId);

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Assets</h3>
        <label className="btn sm" style={{ cursor: 'pointer' }}>
          {uploadBusy ? 'Uploading…' : '+ Upload a file'}
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            style={{ display: 'none' }}
            disabled={disabled || uploadBusy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </div>

      <p className="sub">
        {selected ? (
          <>
            Assigning attaches the file to the selected clip <b className="mono">{selected.clip.id}</b> (composition {selected.startSec.toFixed(2)}–{selected.endSec.toFixed(2)}s).
          </>
        ) : (
          <>Select a clip first — assigning a file to “nothing” would not be a binding.</>
        )}
      </p>

      {libraryError ? <Banner kind="warn">The asset library could not be read: {libraryError}</Banner> : null}

      <h4 className="small">Referenced by this editor document</h4>
      {!document.assets.length ? <div className="banner info">This document references no assets yet.</div> : null}
      {document.assets.map((asset) => (
        <div key={asset.id} className="asset-row">
          <div>
            <Tag kind="accent">{kindLabel(asset.kind)}</Tag> <span className="mono">{asset.name}</span>
            <div className="small">
              source: {asset.source.trim() ? asset.source : <em>not recorded</em>} · licence: {asset.license.trim() ? asset.license : <em>not recorded</em>} · source duration {asset.durationSec === null ? 'not measured' : seconds(asset.durationSec)}
            </div>
            <div className="small">
              {boundClips(asset.id).length ? <>bound to {boundClips(asset.id).join(', ')}</> : <>not bound to any clip</>}
            </div>
          </div>
          <button className="btn sm" disabled={disabled || !selectedClipId} onClick={() => onAssign(asset)}>
            Assign to selected clip
          </button>
        </div>
      ))}

      <h4 className="small mt">Asset library on this machine ({library.length})</h4>
      {!library.length ? (
        <div className="banner info">
          No uploaded assets yet. Uploads land in the library — they are not attached to a clip until you assign one.
        </div>
      ) : null}
      {library.map((asset) => {
        const ref = toAssetRef(asset);
        const inconsistent = !asset.source?.trim() || !asset.license?.trim();
        return (
          <div key={asset.id} className="asset-row">
            <div>
              <Tag kind="accent">{kindLabel(ref.kind)}</Tag> <span className="mono">{asset.name}</span>
              {inconsistent ? <Tag kind="warn">provenance not recorded</Tag> : null}
              {asset.blocked ? <Tag kind="bad">blocked</Tag> : null}
              <div className="small">
                source: {asset.source?.trim() ? asset.source : <em>not recorded</em>} · licence: {asset.license?.trim() ? asset.license : <em>not recorded</em>} · source duration{' '}
                {typeof asset.durationSec === 'number' ? seconds(asset.durationSec) : 'not measured'}
                {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
              </div>
              <div className="small">
                {boundClips(asset.id).length ? <>bound to {boundClips(asset.id).join(', ')}</> : <>in the library only — not bound to a scene</>}
              </div>
            </div>
            <button className="btn sm" disabled={disabled || !selectedClipId} onClick={() => onAssign(ref)}>
              Assign to selected clip
            </button>
          </div>
        );
      })}
    </div>
  );
};

/**
 * Narration.
 *
 * The approved recording is the authority. A visual change never regenerates
 * it: `visualClips` operations never touch `audioClips`. Changing an APPROVED
 * audio clip's timings stages `approved: false` in the same transaction, so an
 * approval can never silently survive the change that invalidates it.
 */
export const EditorNarrationPanel: React.FC<{
  document: EditorDocument;
  selectedAudioId: string | null;
  onSelectAudio: (id: string | null) => void;
  stage: Stage;
  disabled: boolean;
}> = ({ document, selectedAudioId, onSelectAudio, stage, disabled }) => {
  const audio = document.audioClips.find((clip) => clip.id === selectedAudioId) ?? document.audioClips[0] ?? null;
  const asset = audio ? document.assets.find((item) => item.id === audio.sourceAssetId) ?? null : null;

  const update = (changes: Record<string, unknown>) => {
    if (!audio) return;
    const invalidates = audio.approved && ('sourceInSec' in changes || 'sourceOutSec' in changes || 'startSec' in changes || 'gainDb' in changes || 'sourceAssetId' in changes);
    stage([opUpdate('audioClips', audio.id, invalidates ? { ...changes, approved: false } : changes)]);
  };

  return (
    <div className="card">
      <h3>Narration (approved audio)</h3>
      {!audio ? (
        <div className="banner info">This document has no narration track. Narrator audio is never invented here.</div>
      ) : (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <b className="mono">{audio.id}</b> · {asset?.name ?? 'unknown file'}
              <div className="small">
                {audio.approved ? <Tag kind="ok">approved</Tag> : <Tag kind="warn">approval invalidated / not approved</Tag>}{' '}
                {audio.locked ? <Tag kind="warn">locked</Tag> : null} speaker: {audio.speakerId ?? 'not set'}
              </div>
            </div>
            <div className="row">
              {document.audioClips.map((clip) => (
                <button key={clip.id} className={`btn sm ${clip.id === audio.id ? 'primary' : ''}`} onClick={() => onSelectAudio(clip.id)}>
                  {clip.id}
                </button>
              ))}
            </div>
          </div>
          <div className="grid2 mt">
            <NumberInput label="Start (composition)" value={audio.startSec} step={0.1} min={0} disabled={disabled || audio.locked} onCommit={(value) => update({ startSec: round3(Math.max(0, value)) })} />
            <NumberInput label="Source in" value={audio.sourceInSec} step={0.1} min={0} disabled={disabled || audio.locked} onCommit={(value) => update({ sourceInSec: round3(Math.max(0, value)) })} />
            <NumberInput label="Source out" value={audio.sourceOutSec} step={0.1} min={0} disabled={disabled || audio.locked} onCommit={(value) => update({ sourceOutSec: round3(Math.max(0, value)) })} />
            <NumberInput label="Gain" value={audio.gainDb} step={0.5} suffix="dB" disabled={disabled || audio.locked} onCommit={(value) => update({ gainDb: value })} />
          </div>
          <div className="row">
            <button className="btn sm" disabled={disabled} onClick={() => update({ locked: !audio.locked })}>
              {audio.locked ? 'Unlock narration' : 'Lock narration'}
            </button>
            <button className="btn sm" disabled={disabled || audio.locked} onClick={() => update({ approved: !audio.approved })}>
              {audio.approved ? 'Withdraw approval' : 'Mark reviewed and approved'}
            </button>
          </div>
          <p className="small" style={{ marginTop: 8 }}>
            Trimming, replacing or re-gaining an approved recording withdraws its approval in the same edit — an approval never survives the
            change that invalidates it. Nothing here synthesizes a new voice: an unavailable speech engine stays unavailable.
          </p>
        </>
      )}
    </div>
  );
};

/**
 * Project content profile, channel identity and engine capability.
 *
 * The channel identity is explicit: no automatic first-logo selection, and for
 * religious content the BuildTrack identity is refused by the server (`refusal`
 * is shown verbatim) instead of being silently substituted.
 */
export const EditorDocumentPanel: React.FC<{
  document: EditorDocument;
  capabilities: EditorCapabilities;
  brand: { id: string; name: string; logoAssetId: string | null } | null;
  brandIdentityBound: boolean | null;
  brandRefusal: string | null;
  brandError: string | null;
  stage: Stage;
  disabled: boolean;
}> = ({ document, capabilities, brand, brandIdentityBound, brandRefusal, brandError, stage, disabled }) => (
  <div className="card">
    <h3>Project content &amp; channel identity</h3>
    <div className="grid2">
      <Select
        label="Content profile"
        value={document.contentProfile}
        disabled={disabled}
        options={[
          { value: 'religious', label: 'religious — no product/CTA form, no invented identity' },
          { value: 'educational', label: 'educational — brand must be chosen' },
          { value: 'promotional', label: 'promotional — product/CTA structure applies' },
        ]}
        onCommit={(value) => stage([{ type: 'setDocument', changes: { contentProfile: value as EditorDocument['contentProfile'] } }])}
      />
      <Select
        label="Format"
        value={document.format}
        disabled={disabled}
        options={[
          { value: 'landscape', label: 'landscape 16:9' },
          { value: 'portrait', label: 'portrait 9:16' },
        ]}
        onCommit={(value) => stage([{ type: 'setDocument', changes: { format: value as EditorDocument['format'] } }])}
      />
    </div>
    <TextInput
      label="Channel identity (brand id) — empty means no identity is bound"
      value={document.channelBrandId ?? ''}
      placeholder="no channel identity bound"
      disabled={disabled}
      onCommit={(value) => stage([{ type: 'setDocument', changes: { channelBrandId: value.trim() ? value.trim() : null } }])}
    />
    <div className="small" style={{ lineHeight: 1.7 }}>
      {brandError ? <Banner kind="warn">Brand resolution could not be read: {brandError}</Banner> : null}
      {brand ? (
        <div>
          Resolved brand: <b>{brand.name}</b> <span className="mono">({brand.id})</span>{' '}
          {brandIdentityBound === false ? <Tag kind="warn">no identity asset bound</Tag> : <Tag kind="ok">identity bound</Tag>}
          {brandRefusal ? <div style={{ marginTop: 4 }}>{brandRefusal}</div> : null}
        </div>
      ) : null}
      <div style={{ marginTop: 4 }}>
        The editor never picks the first logo in the library. A logo renders only when the selected brand owns it; a visual system without
        a logo is not a channel identity.
      </div>
    </div>

    <h4 className="small mt">Engines (reported by the server, not assumed)</h4>
    <EngineState label="Alignment runtime" available={capabilities.alignment?.available === true} reason={capabilities.alignment?.reason ?? null} />
    <EngineState label="Server preview / render" available={capabilities.preview?.available === true} reason={capabilities.preview?.reason ?? null} />
    <EngineState label="Voice generation" available={capabilities.voiceGeneration?.available === true} reason={capabilities.voiceGeneration?.reason ?? null} />
    {(capabilities.voiceGeneration?.engines ?? []).map((engine) => (
      <EngineState key={engine.id} label={`voice engine: ${engine.id}`} available={engine.available} reason={engine.reason ?? null} />
    ))}
    {(capabilities.notes ?? []).map((note, index) => (
      <div key={index} className="small">
        {note}
      </div>
    ))}
    <div className="small mt">
      Document duration {documentDuration(document).toFixed(2)}s · schema v{document.schemaVersion} · target {document.targetId}
    </div>
    <Field label="Document identity">
      <div className="mono small">
        {document.projectId} · revision {document.revision}
      </div>
    </Field>
    {document.visualClips.some((clip) => clip.sourceAssetId === null) ? (
      <Banner kind="warn">
        {document.visualClips.filter((clip) => clip.sourceAssetId === null).length} clip(s) have no asset bound. A still is not footage, and an
        unbound clip is not a picture.
      </Banner>
    ) : null}
  </div>
);

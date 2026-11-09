import React from 'react';
import { Tag } from '../ui';
import type { EditorAssetRef, EditorOperation } from '../../lib/editor-types';
import type { ValidationFinding } from '../../lib/editor-model';

/** Result of staging operations: non-empty means the edit was refused. */
export type Stage = (operations: EditorOperation[]) => ValidationFinding[];

/**
 * A numeric field that stages an operation when the value is committed.
 * Typed numbers and the arrow keys are both first-class: nothing in this editor
 * requires a drag.
 */
export const NumberInput: React.FC<{
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  suffix?: string;
  onCommit: (value: number) => void;
}> = ({ label, value, step = 0.1, min, max, disabled, suffix, onCommit }) => (
  <div className="field" style={{ marginBottom: 8 }}>
    <label>
      {label}
      {suffix ? <span className="dim"> ({suffix})</span> : null}
    </label>
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (Number.isFinite(next)) onCommit(next);
      }}
    />
  </div>
);

export const TextInput: React.FC<{
  label: string;
  value: string;
  disabled?: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
}> = ({ label, value, disabled, placeholder, onCommit }) => (
  <div className="field" style={{ marginBottom: 8 }}>
    <label>{label}</label>
    <input value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onCommit(e.target.value)} />
  </div>
);

export const Select: React.FC<{
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onCommit: (value: string) => void;
}> = ({ label, value, options, disabled, onCommit }) => (
  <div className="field" style={{ marginBottom: 8 }}>
    <label>{label}</label>
    <select value={value} disabled={disabled} onChange={(e) => onCommit(e.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </div>
);

export const kindLabel = (kind: string): string => (kind === 'image' ? 'image (still)' : kind === 'video' ? 'video (plays)' : 'audio');

export const seconds = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}s`;

/**
 * Provenance is shown verbatim. Empty source/licence is reported as "not
 * recorded" — it is never upgraded to "owner-owned" for the operator.
 */
export const Provenance: React.FC<{ asset: EditorAssetRef | null; compact?: boolean }> = ({ asset, compact }) => {
  if (!asset) {
    return (
      <div className="small">
        <Tag kind="warn">not bound</Tag> no asset is attached to this clip yet
      </div>
    );
  }
  const missing = !asset.source.trim() || !asset.license.trim();
  return (
    <div className="small" style={{ lineHeight: 1.6 }}>
      <Tag kind="accent">{kindLabel(asset.kind)}</Tag>{' '}
      <span className="mono">{asset.name}</span>
      {!compact ? (
        <>
          <div>
            source: {asset.source.trim() ? asset.source : <em>not recorded</em>}
          </div>
          <div>
            licence: {asset.license.trim() ? asset.license : <em>not recorded</em>}
          </div>
          <div>
            source duration: {asset.durationSec === null ? 'not measured (still)' : seconds(asset.durationSec)}
            {asset.sha256 ? ` · sha256 ${asset.sha256.slice(0, 12)}…` : ' · no measured hash'}
          </div>
        </>
      ) : null}
      {missing ? (
        <div style={{ marginTop: 4 }}>
          <Tag kind="warn">provenance incomplete</Tag> the file is usable, but its source/licence is not recorded.
        </div>
      ) : null}
    </div>
  );
};

export const FindingsList: React.FC<{ findings: ValidationFinding[] }> = ({ findings }) => {
  if (!findings.length) return null;
  return (
    <div className="banner bad" role="alert">
      <b>These edits were refused and nothing was staged:</b>
      <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
        {findings.map((finding, index) => (
          <li key={`${finding.field}-${index}`}>
            <span className="mono">{finding.field}</span> — {finding.message}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const EngineState: React.FC<{ label: string; available: boolean; reason?: string | null }> = ({ label, available, reason }) => (
  <div className="small" style={{ padding: '3px 0' }}>
    <Tag kind={available ? 'ok' : 'warn'}>{available ? 'available' : 'unavailable'}</Tag> <b>{label}</b>
    {!available && reason ? <> — {reason}</> : null}
  </div>
);

import React from 'react';
import { Tag } from '../ui';
import { fixtureControls, setFixtureControl } from '../../lib/editor-fixture';

/**
 * Development-only controls, rendered ONLY when the fixture is explicitly
 * switched on (`?editorFixture=1` in a development build).
 *
 * These switches exist so the failure paths can be demonstrated honestly —
 * a failed save, a revision conflict, a missing alignment runtime — instead of
 * being described. They are never reachable in a production build, and they are
 * never used to turn a failure into a success.
 */
export const EditorDevBar: React.FC<{ revision: number; mediaUrls: string[]; onChanged: () => void }> = ({ revision, mediaUrls, onChanged }) => {
  const controls = fixtureControls();
  return (
    <div className="card" style={{ borderColor: '#5c4a14' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>
          <Tag kind="warn">DEVELOPMENT FIXTURE</Tag> {`/api/projects/:id/editor is served by the frontend, not by apps/api`}
        </h3>
        <span className="small">revision {revision}</span>
      </div>
      <p className="small">
        Arena is implementing the backend against the same contract. This mode is opt-in (`?editorFixture=1`, development builds only) and is
        never a fallback: with the flag off, a failing endpoint is reported as a failure.
      </p>
      <div className="row">
        <button
          className={`btn sm ${controls.failNextSave ? 'primary' : ''}`}
          onClick={() => {
            setFixtureControl('failNextSave', !controls.failNextSave);
            onChanged();
          }}
        >
          {controls.failNextSave ? 'the next save will fail (armed)' : 'arm a failed save'}
        </button>
        <button
          className="btn sm"
          onClick={() => {
            setFixtureControl('serverRevisionAhead', revision + 1);
            onChanged();
          }}
        >
          bump the server revision (force a conflict)
        </button>
        <button
          className={`btn sm ${controls.alignmentRuntime ? 'primary' : ''}`}
          onClick={() => {
            setFixtureControl('alignmentRuntime', !controls.alignmentRuntime);
            onChanged();
          }}
        >
          {controls.alignmentRuntime ? 'alignment runtime: present (pretend)' : 'pretend the alignment runtime exists'}
        </button>
        <button
          className={`btn sm ${controls.previewSubstituteUrl ? 'primary' : ''}`}
          onClick={() => {
            setFixtureControl('previewSubstituteUrl', controls.previewSubstituteUrl ? null : (mediaUrls[0] ?? null));
            onChanged();
          }}
          disabled={!mediaUrls.length}
          title="Explicitly substitute a real served asset URL for the server render. It is labelled as a substitute."
        >
          {controls.previewSubstituteUrl ? 'server render substitute: on' : 'substitute a URL for the server render'}
        </button>
        {controls.serverRevisionAhead !== null ? (
          <button
            className="btn sm ghost"
            onClick={() => {
              setFixtureControl('serverRevisionAhead', null);
              onChanged();
            }}
          >
            clear pending conflict
          </button>
        ) : null}
      </div>
      {controls.previewSubstituteUrl ? (
        <div className="small mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>
          substitute URL: {controls.previewSubstituteUrl}
        </div>
      ) : null}
    </div>
  );
};

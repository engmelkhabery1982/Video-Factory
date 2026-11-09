import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {renderToString} from 'react-dom/server';
import {beforeAll, afterAll, describe, expect, it, vi} from 'vitest';

const isolated = vi.hoisted(() => {
  const p = process.getBuiltinModule('node:path');
  const f = process.getBuiltinModule('node:fs');
  const root = p.join(process.cwd(), '.stills', 'test-isolation', 'editor-contract-integration');
  f.mkdirSync(root, {recursive:true});
  process.env.BUILDTRAKE_DATA = p.join(root, 'data');
  process.env.BUILDTRAKE_OUTPUT = p.join(root, 'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  delete process.env.VF_ALIGN_COMMAND;
  return {root};
});
import {buildStoryboard, emptyHistory, PROJECT_SCHEMA_VERSION} from '@buildtrack/core';
import {buildServerApp} from '../apps/api/src/server';
import {saveProject} from '../apps/api/src/services/store';
import {getEditor, commitOperations, normalizeEditorResponse} from '../apps/web/src/lib/editor-api';
import {documentFindings, operationFindings, opUpdate} from '../apps/web/src/lib/editor-model';
import {EditorAlignmentPanel} from '../apps/web/src/components/editor/EditorServerPanels';

let app: Awaited<ReturnType<typeof buildServerApp>>;
const projectId = 'Editor_Contract_Integration';
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  const input:any = {videoId:projectId,videoType:'long',topic:'Fixture',targetAudience:'Review',mainProblem:'Fixture',viewerPromise:'Fixture',hook:'Fixture',script:'الرَّحْمَنُ. الرَّحِيمُ.',keyNumbers:['1'],keyPoints:['Fixture'],productName:'Fixture',productShots:[],cta:'Fixture',voiceoverFile:null,targetAudio:{},brollFiles:[],sourceReferences:[],outputLanguage:'ar',brandPreset:'safety_first',shortCount:0};
  const built = buildStoryboard({input,history:emptyHistory(),audioDuration:30});
  const {historyEntry,...storyboard} = built;
  const now = new Date().toISOString();
  saveProject({schemaVersion:PROJECT_SCHEMA_VERSION,meta:{input,brand:built.brand,createdAt:now,updatedAt:now,status:'storyboarded'},storyboard,artifacts:[],qc:[]});
  const assetDir=path.join(isolated.root,'data','assets');
  fs.mkdirSync(assetDir,{recursive:true});
  fs.writeFileSync(path.join(assetDir,'index.json'),JSON.stringify([{id:'integration_image',name:'Fixture image',mimeType:'image/png',status:'active',blocked:false,source:'test fixture',license:'fixture',durationSec:null}]));
  app=await buildServerApp();
  const origin=await app.listen({host:'127.0.0.1',port:0});
  // Resolve relative URLs only. Responses come from the actual HTTP server.
  vi.stubGlobal('fetch',(url:any,init:any)=>originalFetch(new URL(String(url),origin),init));
});
afterAll(async()=> {vi.unstubAllGlobals(); await app?.close();});

describe('actual backend DTO consumed by the frontend',()=> {
  it('serves uploaded footage byte ranges over a real socket for source-offset playback', async () => {
    const assetDir = path.join(isolated.root, 'data', 'assets');
    const bytes = Buffer.from(Array.from({length: 128}, (_, i) => i));
    fs.writeFileSync(path.join(assetDir, 'range-fixture.mp4'), bytes);
    const indexPath = path.join(assetDir, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    index.push({id:'integration_range_video',path:'assets/range-fixture.mp4',mimeType:'video/mp4'});
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const full = await fetch('/media/asset/integration_range_video');
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('128');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    for (const [header, start, end] of [['bytes=10-19',10,19], ['bytes=120-',120,127], ['bytes=-8',120,127]] as const) {
      const response = await fetch('/media/asset/integration_range_video', {headers:{Range:header}});
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/128`);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(start,end+1));
    }
    for (const header of ['bytes=128-', 'bytes=10-3', 'bytes=0-1,4-5']) {
      const response = await fetch('/media/asset/integration_range_video', {headers:{Range:header}});
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */128');
      expect((await response.arrayBuffer()).byteLength).toBe(0);
    }
    expect((await fetch('/media/asset/unknown', {headers:{Range:'bytes=0-1'}})).status).toBe(404);
  });
  it('loads valid null-range placeholders without false validation errors',async()=> {
    const envelope=await getEditor(projectId,'long');
    expect(envelope.document.visualClips[0].sourceInSec).toBeNull();
    expect(documentFindings(envelope.document)).toEqual([]);
    expect(envelope.document.alignment.state).toBe('not_requested');
    expect(envelope.capabilities.voiceGeneration?.available).toBe(false);
    expect(()=>renderToString(React.createElement(EditorAlignmentPanel,{document:envelope.document,capabilities:envelope.capabilities,jobId:null,result:null,blocker:null,error:null,busy:false,reviewed:false,onReviewedChange:()=>{},onRequest:()=>{},onAccept:()=>{},disabled:false}))).not.toThrow();
  });
  it('binds a still through the frontend client with the server null-range semantics',async()=> {
    const envelope=await getEditor(projectId,'long');
    const op=opUpdate('visualClips',envelope.document.visualClips[0].id,{sourceAssetId:'integration_image',sourceInSec:null,sourceOutSec:null});
    expect(operationFindings(envelope.document,op)).toEqual([]);
    const saved=await commitOperations(projectId,'long',envelope.document.revision,[op]);
    expect(saved.document.visualClips[0].sourceAssetId).toBe('integration_image');
    expect(documentFindings(saved.document)).toEqual([]);
    const reopened=await getEditor(projectId,'long');
    expect(reopened.document.revision).toBe(saved.document.revision);
  });
  it('renders server proposal rows safely and preserves unavailable spans',async()=> {
    const envelope=await getEditor(projectId,'long');
    const result=normalizeEditorResponse({status:'proposed',proposalId:'fixture_proposal',rows:[{sceneId:'vc_lng_01',startSec:1.2,endSec:3.4},{sceneId:'unresolved',startSec:null,endSec:null}]});
    const html=renderToString(React.createElement(EditorAlignmentPanel,{document:envelope.document,capabilities:envelope.capabilities,jobId:'fixture_job',result,blocker:null,error:null,busy:false,reviewed:false,onReviewedChange:()=>{},onRequest:()=>{},onAccept:()=>{},disabled:false}));
    expect(html).toContain('1.20s');
    expect(html).toContain('3.40s');
    expect(html).toContain('unresolved span');
    expect(result.rows[1].proposedStartSec).toBeNull();
    expect(result.rows[1].unresolvedSpan).toBe(true);
  });
});

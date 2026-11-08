/** Actual HTTP/storage contracts, synthetic assets only; no engine or rendered-output claim. */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
const qa = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = process.getBuiltinModule('node:path') as typeof import('node:path');
  const os = process.getBuiltinModule('node:os') as typeof import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'vf-closeout06-http-'));
  process.env.BUILDTRAKE_DATA = path.join(root,'data');
  process.env.BUILDTRAKE_OUTPUT = path.join(root,'output');
  process.env.VF_PREVIEW_DISABLE = '1';
  return {root};
});
import { buildServerApp } from '../apps/api/src/server.js';
import { createDraft, getDraft, patchDraft } from '../apps/api/src/services/factory-service.js';
let app: Awaited<ReturnType<typeof buildServerApp>>;
beforeAll(async () => { app = await buildServerApp(); });
afterAll(async () => {
  await app?.close();
  if (path.basename(qa.root).startsWith('vf-closeout06-http-')) fs.rmSync(qa.root,{recursive:true,force:true});
});
function draft() {
  return createDraft({contentProfile:'educational',format:'landscape',inputs:{brief:'QA',script:'An owned synthetic line.',visualAssetIds:[],narrationMode:'none'}}).body;
}
for (const broken of ['{invalid JSON','null','{}']) {
  it(`reports corrupt draft through HTTP and preserves bytes: ${broken}`, async () => {
    const d = draft();
    const file = path.join(qa.root,'data','factory','drafts',d.draftId+'.json');
    fs.writeFileSync(file,broken);
    const result = await app.inject({method:'GET',url:`/api/factory/drafts/${d.draftId}`});
    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).code).toBe('FACTORY_DRAFT_CORRUPT');
    expect(result.body).not.toContain(qa.root);
    expect(fs.readFileSync(file,'utf8')).toBe(broken);
  });
}
it('refuses a real uploaded still on an authored recording row before Apply, without mutation', async () => {
  const d = draft();
  const env = getDraft(d.draftId);
  const treatment = env.treatments.find(t=>t.id===env.selectedTreatmentId)!;
  const patched = patchDraft(d.draftId,{expectedRevision:env.revision,selectedTreatmentId:env.selectedTreatmentId,
    scenes:treatment.scenes.map(s=>({...s,technique:'screen_recording',graphic:null}))});
  const scene = patched.treatments.find(t=>t.id===patched.selectedTreatmentId)!.scenes[0];
  const boundary = '----closeout06';
  const parts = Object.entries({name:'Owned QA pixel',kind:'screenshot',source:'Owned synthetic QA',license:'Owned QA'}).map(([k,v])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned.png"\r\nContent-Type: image/png\r\n\r\n`));
  parts.push(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64'),Buffer.from(`\r\n--${boundary}--\r\n`));
  const upload = await app.inject({method:'POST',url:'/api/assets',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat(parts)});
  expect(upload.statusCode,upload.body).toBe(200);
  const result = await app.inject({method:'POST',url:`/api/factory/drafts/${d.draftId}/bind-image`,payload:{expectedRevision:patched.revision,sceneId:scene.id,assetId:JSON.parse(upload.body).asset.id}});
  expect(result.statusCode,result.body).toBe(409);
  const after = getDraft(d.draftId);
  expect(after.revision).toBe(patched.revision);
  expect(after.status).toBe('blocked');
  expect(after.missing.some(m=>m.sceneId===scene.id && m.kind==='recording')).toBe(true);
});

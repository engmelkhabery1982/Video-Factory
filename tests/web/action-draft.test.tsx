// @vitest-environment happy-dom
import React from 'react';
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {GraphicActionsEditor} from '../../apps/web/src/components/graphic/GraphicEditors';
import {buildProcessGraphic} from '../../apps/web/src/lib/graphic-form';
import {proofNumeric,proofKinetic,proofActor} from '../fixtures/graphic-proof-specs';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined;let host:HTMLDivElement|undefined;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());host?.remove();root=undefined;host=undefined;});
const examples=[proofNumeric('landscape'),proofKinetic('landscape'),proofActor('landscape'),buildProcessGraphic({title:'',items:['Review','Save']},'landscape',7)];
for(const initial of examples)for(const field of ['from','to','start','end'] as const)it(`${initial.kind}/${field}: empty stays local, repair stages exact value, source unchanged`,async()=>{
 const source=JSON.stringify(initial);const changed=vi.fn();host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
 await act(async()=>root!.render(<GraphicActionsEditor graphic={initial} format="landscape" profile="educational" durationSec={7} label="draft" onChange={changed}/>));
 const input=()=>host!.querySelector<HTMLInputElement>(`[aria-label="draft action ${initial.actions[0].id} ${field}"]`)!;
 const type=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}));});
 await type('');expect(changed).not.toHaveBeenCalled();expect(input().value).toBe('');expect(host.textContent).toContain('Action edits are not applied yet');expect(JSON.stringify(initial)).toBe(source);
 const key=field==='start'?'startSec':field==='end'?'endSec':field;
 await type(String(initial.actions[0][key]));expect(changed).toHaveBeenCalledTimes(1);expect(changed.mock.calls[0][0]).toEqual(initial);expect(JSON.stringify(initial)).toBe(source);
});

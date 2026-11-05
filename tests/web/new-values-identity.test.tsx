// @vitest-environment happy-dom
import React, {act, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import type {EditorGraphic} from '@buildtrack/core/visual';
import {GraphicValuesForm} from '../../apps/web/src/components/graphic/GraphicEditors';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|null=null,host:HTMLDivElement|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());host?.remove();root=null;host=null;});
for(const technique of ['numeric_comparison','process_path'] as const){
  it(`${technique}: newly authored values retain IDs/actions on repeated Apply and a text-only edit`,async()=>{
    const changed=vi.fn();
    function Inspector(){const[g,setG]=useState<EditorGraphic|null>(null);return <GraphicValuesForm technique={technique} graphic={g} format="portrait" profile="educational" durationSec={3} label="identity-qa" onChange={v=>{changed(v);setG(v);}}/>;}
    host=document.createElement('div');document.body.append(host);root=createRoot(host);
    await act(async()=>root!.render(<Inspector/>));
    async function input(name:string,value:string){await act(async()=>{const f=host!.querySelector<HTMLInputElement>(`[aria-label="identity-qa ${name}"]`)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(f,value);f.dispatchEvent(new Event('input',{bubbles:true}));});}
    async function apply(){await act(async()=>host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-identity-qa"]')!.click());}
    if(technique==='numeric_comparison'){
      await input('scale maximum','100');
      for(const i of [1,2]){await input(`value ${i} label`,`Exact ${i}`);await input(`value ${i} number`,String(i*25));}
    }else{
      await input('step 1','Check');
      await act(async()=>[...host!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Add step')!.click());
      await input('step 2','Save');
    }
    await apply();expect(changed).toHaveBeenCalledTimes(1);
    const first=changed.mock.calls[0][0] as EditorGraphic;
    await apply();expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls[1][0]).toEqual(first);
    await input(technique==='numeric_comparison'?'value 1 label':'step 1','  مراجعة! Exact  ');
    await apply();expect(changed).toHaveBeenCalledTimes(3);
    const edited=changed.mock.calls[2][0] as EditorGraphic;
    expect(edited.objects.map(o=>o.id)).toEqual(first.objects.map(o=>o.id));
    expect(edited.actions).toEqual(first.actions);
    expect(edited.objects[0]).toEqual({...first.objects[0],label:'  مراجعة! Exact  '});
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });
}

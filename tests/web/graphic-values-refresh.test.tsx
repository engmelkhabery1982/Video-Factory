// @vitest-environment happy-dom
import React,{act}from'react';import{createRoot,type Root}from'react-dom/client';import{afterEach,expect,it,vi}from'vitest';
import type{EditorGraphic}from'@buildtrack/core/visual';
import{GraphicValuesForm}from'../../apps/web/src/components/graphic/GraphicEditors';
import{buildNumericGraphic,buildProcessGraphic,buildKineticGraphic}from'../../apps/web/src/lib/graphic-form';
(globalThis as{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement|null=null,root:Root|null=null;
afterEach(async()=>{if(root)await act(async()=>root!.unmount());host?.remove();root=null;host=null;});
for(const kind of['numeric_comparison','process_path','kinetic_text']as const){
  it(`${kind}: a replacement canonical graphic refreshes the same mounted inspector and Apply does not restore its old title`,async()=>{
    const initial:EditorGraphic=kind==='numeric_comparison'?buildNumericGraphic({title:'Old title',scaleMax:'100',rows:[{label:'Old A',value:'25',unit:''},{label:'B',value:'50',unit:''}]},'landscape',3):kind==='process_path'?buildProcessGraphic({title:'Old title',items:['Check','Save']},'landscape',3):buildKineticGraphic({title:'Old title',items:['Old phrase','Next']},'landscape',3);
    const changed=vi.fn();host=document.createElement('div');document.body.append(host);root=createRoot(host);
    const draw=(g:EditorGraphic)=><GraphicValuesForm key="same-clip-same-technique" label="refresh-qa" technique={kind} graphic={g} format="landscape" profile="educational" durationSec={3} onChange={changed}/>;
    await act(async()=>root!.render(draw(initial)));
    const replacement=structuredClone(initial);replacement.title='Externally restored title';
    await act(async()=>root!.render(draw(replacement)));
    expect(host!.querySelector<HTMLInputElement>('[aria-label="refresh-qa title"]')!.value).toBe(replacement.title);
    await act(async()=>host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-refresh-qa"]')!.click());
    expect(changed).toHaveBeenCalledOnce();expect(changed.mock.calls[0][0]).toEqual(replacement);
    changed.mockClear();
    await act(async()=>{
      const field=host!.querySelector<HTMLInputElement>('[aria-label="refresh-qa title"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,'  Local unsaved title!  ');
      field.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const actionOnly=structuredClone(replacement);actionOnly.actions[0].id+='-external';
    await act(async()=>root!.render(draw(actionOnly)));
    expect(host!.querySelector<HTMLInputElement>('[aria-label="refresh-qa title"]')!.value).toBe('  Local unsaved title!  ');
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    const concurrent=structuredClone(actionOnly);concurrent.title='Different current title';
    await act(async()=>root!.render(draw(concurrent)));
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('local input is kept');
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-refresh-qa"]')!.disabled).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await act(async()=>root!.render(draw(actionOnly))); // Undoing the external values change removes the conflict without erasing typing.
    expect(host!.querySelector('[role="alert"]')).toBeNull();
    expect(host!.querySelector<HTMLInputElement>('[aria-label="refresh-qa title"]')!.value).toBe('  Local unsaved title!  ');
    await act(async()=>root!.render(draw(concurrent)));
    await act(async()=>[...host!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Use current shot values')!.click());
    await act(async()=>host!.querySelector<HTMLButtonElement>('[data-testid="apply-values-refresh-qa"]')!.click());
    expect(changed).toHaveBeenCalledOnce();expect(changed.mock.calls[0][0]).toEqual(concurrent);
  });
}

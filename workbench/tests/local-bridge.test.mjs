import test from 'node:test';
import assert from 'node:assert/strict';
let serial = 0;
async function setup(t, { meta = '', hash = '', stored = '', blockedStorage = false } = {}) {
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  t.after(() => { for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key]=value; } });
  const values = new Map([['ui-quality-workbench.bridge-token', stored]]);
  globalThis.window = { location: {hash, pathname:'/',search:''}, history:{replaceState(...args){window.location.hash=args[2].split('#')[1] || '';}}, sessionStorage: {
    setItem(k,v){if(blockedStorage)throw new Error('blocked');values.set(k,v);}, getItem(k){if(blockedStorage)throw new Error('blocked');return values.get(k);}
  }};
  globalThis.document={querySelector:()=>meta ? {content:meta} : null};
  return import(`../src/lib/localBridge.js?case=${++serial}`);
}
test('fresh document token replaces stale fragment and storage tokens',async t=>{
  const bridge=await setup(t,{meta:'fresh',hash:'#token=old',stored:'older'});
  assert.equal(bridge.getBridgeToken(),'fresh');assert.equal(window.location.hash,'');
  globalThis.fetch=async (path,{headers})=>{assert.equal(headers.get('X-Workbench-Token'),'fresh');return Response.json({videoDownloader:{ready:true}});};
  assert.equal((await bridge.getLocalCapabilities()).videoDownloader.ready,true);
});
test('private storage still permits document-session API calls',async t=>{
  const bridge=await setup(t,{meta:'fresh',blockedStorage:true});assert.equal(bridge.getBridgeToken(),'fresh');
});
test('static page never attempts installation without a session',async t=>{
  const bridge=await setup(t);globalThis.fetch=()=>assert.fail('must not call fetch');
  assert.equal((await bridge.getLocalCapabilities()).bridge,false);
  await assert.rejects(bridge.installVideoDependencies(),/start.py/);
});
test('network, stale token and static preview return actionable errors',async t=>{
  const bridge=await setup(t,{meta:'valid'});
  globalThis.fetch=async()=>{throw new TypeError('network');};await assert.rejects(bridge.getVideoJobs(),/连接已断开/);
  globalThis.fetch=async()=>new Response('',{status:401});await assert.rejects(bridge.getVideoJobs(),/连接已过期/);
  globalThis.fetch=async()=>new Response('<html>',{headers:{'content-type':'text/html'}});await assert.rejects(bridge.getVideoJobs(),/静态网页/);
  globalThis.fetch=async()=>{throw new DOMException('cancelled','AbortError');};await assert.rejects(bridge.getVideoJobs(),{name:'AbortError'});
});
test('dependency install endpoint accepts no remote command or download URL',async t=>{
  const bridge=await setup(t,{meta:'session'});
  globalThis.fetch=async(path,options)=>{assert.equal(path,'/api/video/install');assert.equal(options.method,'POST');assert.equal(options.body,'{}');return Response.json({message:'started'},{status:202});};
  assert.equal((await bridge.installVideoDependencies()).message,'started');
});

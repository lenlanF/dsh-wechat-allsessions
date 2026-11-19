import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {apply} from '../lib/index.js';

const scratch=process.env.DSH_PLUGIN_TEST_TMP || tmpdir();
function context({settings,transport,controller,sessions=[]}={}){
 const registered=[],handlers=[],writes=[];
 const defaults={describe:()=>[{ns:'dsh-wechat-allsessions'}],mutate:async(ns,ops)=>{writes.push({ns,ops})},configure(){}};
 const services={settings:settings??defaults,webServer:{register:r=>{registered.push(r);return()=>{}}},credentials:{resolve:async()=>({value:'FAKE_TOKEN'}),set:async()=>{}},sessionController:controller??{prompt:async()=>({accepted:true})},sessions:{list:()=>sessions}};
 const ctx={fiber:{entry:{options:{id:'dsh-wechat-allsessions'}}},get:k=>services[k],on:(event,fn)=>{handlers.push({event,fn});return()=>{}},inject(){},effect(){},logger:{warn(){},info(){}}};
 return {ctx,registered,handlers,writes};
}
async function setup(t,options={}){
 const dir=await mkdtemp(join(scratch,'wechat-audit-'));
 t.after(()=>rm(dir,{force:true,recursive:true}));
 const configFile=join(dir,'accounts.json'),stateDir=join(dir,'states'),routeFile=join(dir,'routes.json');
 await writeFile(configFile,JSON.stringify({version:1,accounts:[{botId:'bot',ownerUserId:'owner',tokenRef:'fake',baseUrl:'https://ilinkai.weixin.qq.com/'}]}));
 if(options.initialOwnerSession) await writeFile(routeFile,JSON.stringify({version:1,users:{owner:{sessionId:options.initialOwnerSession,title:'Audit session',cwd:'E:/Temp',updatedAt:1}}}));
 const sendCalls=[];
 const transport=options.transport??{notifyStart:async()=>{},notifyStop:async()=>{},getUpdates:async()=>({msgs:[],get_updates_buf:''}),sendText:async a=>{sendCalls.push(a);return{sent:true}}};
 const host=context({controller:options.controller,sessions:options.sessions??(options.initialOwnerSession?[{id:options.initialOwnerSession,header:{title:'Audit session'}}]:[])});
 const handle=apply(host.ctx,{enabled:options.enabled??false,accountConfigPath:configFile,statePath:stateDir,routeStorePath:routeFile,defaultUserId:options.defaultUserId??'',broadcastAll:options.broadcastAll??false},{transport,autoStart:options.autoStart??false,emptyPollDelayMs:1});
 await handle.start();
 t.after(()=>handle.stop());
 return { ...host,handle,dir,configFile,stateDir,routeFile,sendCalls,transport };
}
const message=(from,text,id)=>({from_user_id:from,item_list:[{type:1,text_item:{text}}],message_id:id});

test('changing enabled persists the change before claiming saved',async t=>{
 const host=await setup(t);
 const route=host.registered.find(x=>x.path.endsWith('/config'));
 const req={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{origin:'http://localhost'},on(name,fn){if(name==='data')fn(Buffer.from('{"enabled":true}'));if(name==='end')queueMicrotask(fn);return this;}};
 const res={setHeader(){},end(s){this.body=JSON.parse(s)},statusCode:0};
 await route.handler(req,res);
 assert.equal(res.body.ok,true);
 assert.equal(res.body.restartRequired,true);
 assert.ok(host.writes.some(w=>w.ops.some(op=>op.path[0]==='enabled' && op.value===true)));
});

test('unknown WeChat user cannot list other sessions or bind arbitrary session',async t=>{
  const host=await setup(t,{enabled:true,initialOwnerSession:'owner-session'});
 await host.handle.handleInbound(message('owner','/session owner-session','m-owner'));
 await host.handle.handleInbound(message('stranger','/list','m-list'));
 await host.handle.handleInbound(message('stranger','/session owner-session','m-route'));
 assert.ok(!host.sendCalls.some(c=>c.toUserId==='stranger'&&c.text.includes('owner-session')));
 const data=JSON.parse(await readFile(host.routeFile,'utf8'));
 assert.equal(data.users.stranger,undefined);
});

test('bridge stop and restart must create a new non-aborted signal',async t=>{
 let starts=0;
 const transport={notifyStart:async({signal})=>{starts++;if(signal.aborted)throw Error('reused aborted signal')},notifyStop:async()=>{},sendText:async()=>({sent:true})};
 const host=await setup(t,{enabled:true,transport});
 await host.handle.stop();
 await host.handle.start();
 assert.equal(starts,2);
});

test('failed prompt keeps cursor and retries with stable id until DSH accepts',async t=>{
  const seenCursors=[], requestIds=[];
  let promptAttempts=0;
  const transport={
    notifyStart:async()=>{}, notifyStop:async()=>{},
    sendText:async()=>({sent:true}),
    getUpdates:async({getUpdatesBuf})=>{
      seenCursors.push(getUpdatesBuf);
      if (!getUpdatesBuf) return {
        msgs:[message('owner','execute after route','batch-msg-1')],
        get_updates_buf:'AFTER-ACCEPT',
      };
      return {msgs:[],get_updates_buf:getUpdatesBuf};
    },
  };
  const host=await setup(t,{
    enabled:true,autoStart:true,initialOwnerSession:'my-dsh-session',transport,
    controller:{prompt:async request=>{
      requestIds.push(request.requestId);
      promptAttempts++;
      if(promptAttempts===1)throw Error('DSH temporary reject');
      return {accepted:true};
    }},
  });
  for(let i=0;i<70 && promptAttempts<2;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(promptAttempts,2,'inbound must be retried after first failure');
  assert.equal(seenCursors[0],'');
  assert.equal(seenCursors[1],'','failed batch must re-fetch with original cursor');
  assert.equal(requestIds[0],requestIds[1],'redelivery must use stable idempotency key');
  const stateFile=join(host.stateDir,'bot','allsessions-state.json');
  let state={};
  for(let i=0;i<40;i++){
    try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
    if(state.getUpdatesBuf==='AFTER-ACCEPT')break;
    await new Promise(r=>setTimeout(r,20));
  }
  await host.handle.stop();
  assert.ok(state.seenMessageIds.includes('batch-msg-1'));
  assert.equal(state.getUpdatesBuf,'AFTER-ACCEPT');
});

test('successful disabled-mode account binding exposes no token and starts no poll',async t=>{
  let polls=0,starts=0;
  const transport={
    notifyStart:async()=>{starts++},notifyStop:async()=>{},
    getUpdates:async()=>{polls++;return{msgs:[],get_updates_buf:''}},
    pollLogin:async()=>({
      status:'confirmed',bot_token:'HIGHLY_PRIVATE_CREDENTIAL',
      ilink_bot_id:'new-wechat-account',ilink_user_id:'owner',
      baseurl:'https://ilinkai.weixin.qq.com/',
    }),
  };
  const host=await setup(t,{enabled:false,transport,autoStart:true});
  const route=host.registered.find(x=>x.path.endsWith('/login'));
  const req={method:'POST',socket:{remoteAddress:'127.0.0.1'},headers:{origin:'http://localhost'},
    on(event,fn){if(event==='data')fn(Buffer.from('{"qrcode":"scan-test"}'));if(event==='end')queueMicrotask(fn);return this;}};
  const res={setHeader(){},end(v){this.body=JSON.parse(v)},statusCode:0};
  await route.handler(req,res);
  assert.equal(res.body.ok,true);
  assert.equal(res.body.status.status,'confirmed');
  assert.doesNotMatch(JSON.stringify(res.body),/HIGHLY_PRIVATE_CREDENTIAL/);
  assert.equal(polls,0);
  assert.equal(starts,0);
});


test('saved enabled state loads from Settings even when loader passes an empty config',()=>{
  const settings={describe:()=>[{ns:'dsh-wechat-allsessions',value:{enabled:true,broadcastAll:true,defaultUserId:'owner'}}],mutate:async()=>{},configure(){}};
  const host=context({settings});
  const handle=apply(host.ctx,{}, {autoStart:false,transport:{}});
  assert.equal(handle.rules.enabled,true);
  assert.equal(handle.rules.broadcastAll,true);
  assert.equal(handle.rules.defaultUserId,'owner');
});

test('corrupted polling state fails closed instead of resetting the cursor',async t=>{
  const dir=await mkdtemp(join(scratch,'wechat-state-corrupt-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const configPath=join(dir,'account.json'),stateDir=join(dir,'state');
  await writeFile(configPath,JSON.stringify({accounts:[{botId:'bot',ownerUserId:'owner',tokenRef:'fake'}]}));
  await mkdir(join(stateDir,'bot'),{recursive:true});
  const file=join(stateDir,'bot','allsessions-state.json');
  await writeFile(file,'{INVALID_PERSISTED_STATE');
  const host=context();
  const handle=apply(host.ctx,{enabled:true,accountConfigPath:configPath,statePath:stateDir,
    routeStorePath:join(dir,'routes.json')},{autoStart:false,transport:{notifyStart:async()=>{}}});
  await assert.rejects(()=>handle.start(),SyntaxError);
  assert.equal(await readFile(file,'utf8'),'{INVALID_PERSISTED_STATE');
  await handle.stop();
});

test('malformed route storage fails closed instead of overwriting historical routes',async t=>{
  const {loadRouteStore}=await import('../lib/router.js');
  const dir=await mkdtemp(join(scratch,'wechat-routes-corrupt-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'routes.json');
  await writeFile(file,'{CORRUPTED_ROUTE_RECORD');
  await assert.rejects(()=>loadRouteStore(file),SyntaxError);
  assert.equal(await readFile(file,'utf8'),'{CORRUPTED_ROUTE_RECORD');
});

test('broadcastAll without an explicit recipient uses the bound WeChat owner',async t=>{
  const dir=await mkdtemp(join(scratch,'wechat-broadcast-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const configPath=join(dir,'account.json'),stateDir=join(dir,'state');
  await mkdir(join(stateDir,'bot'),{recursive:true});
  await writeFile(configPath,JSON.stringify({accounts:[{botId:'bot',ownerUserId:'owner',tokenRef:'fake'}]}));
  await writeFile(join(stateDir,'bot','allsessions-state.json'),JSON.stringify({
    getUpdatesBuf:'',contextTokens:{users:{owner:{token:'CONTEXT_FAKE'}}},seenMessageIds:[],
  }));
  const sent=[];
  const host=context();
  const handle=apply(host.ctx,{enabled:true,broadcastAll:true,accountConfigPath:configPath,statePath:stateDir,
    routeStorePath:join(dir,'routes.json')},{autoStart:false,
    transport:{notifyStart:async()=>{},sendText:async params=>{sent.push(params);return{sent:true}}}});
  await handle.start();
  const session={id:'session-123',header:{cwd:'E:/Temp'}};
  for(const event of [
    {type:'turn/start',data:{turn:1}},
    {type:'user/message',surfaceOp:'append',data:{turn:1,source:{kind:'user'}}},
    {type:'assistant/message',surfaceOp:'append',data:{turn:1,step:0,message:{content:[{type:'text',text:'Audit result'}]}}},
    {type:'turn/end',data:{turn:1,reason:'completed'}},
  ]) await handle.engine.enqueue(session,event);
  assert.equal(sent.length,1);
  assert.equal(sent[0].toUserId,'owner');
  await handle.stop();
});

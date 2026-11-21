// Synthetic current-journal evidence across assistant IPC and consultation MCP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ISOLATION_KEYS, startIsolatedApp, connectMcp } from '../isolated-app.mjs';
const { values } = parseArgs({ options: { app:{type:'string'}, out:{type:'string'}, label:{type:'string'} } });
assert(values.app && values.out && values.label); assert.equal(Number(process.versions.node.split('.')[0]),22);
const bundle=await realpath(resolve(values.app)), out=resolve(values.out), root=await realpath(await mkdtemp(join(tmpdir(),'paraself-journal-context-')));
await mkdir(out,{recursive:true});
const hash=text=>createHash('sha256').update(text).digest('hex');
let holdNext=false, releaseHeld;
const checks=[], calls=[], cleanup=[]; let app,mcp,socket,error=null,next=0; const pending=new Map();
const marker='RSI16_OLD_STANCE', revised='RSI16_NEW_STANCE', project='rsi16';
const check=(name,ok)=>{checks.push({name,ok:Boolean(ok)});console.log(`${ok?'ok':'FAIL'} ${name}`);};
const freePort=()=>new Promise((done,fail)=>{const s=createServer().once('error',fail).listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>done(port));});});
const stub=httpServer(async(req,res)=>{
 try {
 let text='';for await(const chunk of req){text+=chunk;if(text.length>300000){res.writeHead(413).end();return;}}
 if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
 const body=JSON.parse(text);calls.push(body.messages);
 if(holdNext){holdNext=false;await new Promise(done=>{releaseHeld=done;res.once('close',done);});if(res.destroyed)return;}
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({id:`stub-${calls.length}`,model:'fixture',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({action:'answer',answer:'合成回答。',citedIndexes:[]})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));
 } catch { res.writeHead(500).end(); }
});
await new Promise(done=>stub.listen(0,'127.0.0.1',done));
const api=(method,input)=>new Promise((done,fail)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);fail(new Error(`${method} timeout`));},15000);pending.set(id,response=>{clearTimeout(timer);if(response.error||response.result?.exceptionDetails)fail(new Error(`${method}: ${JSON.stringify(response.error??response.result.exceptionDetails)}`));else done(response.result.result.value);});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:`window.decision.${method}(${JSON.stringify(input)})`,returnByValue:true,awaitPromise:true}}));});
const call=async(name,input)=>{let timer;const r=await Promise.race([mcp.call(name,input),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${name} timeout`)),15000);})]).finally(()=>clearTimeout(timer));assert(!r.error&&!r.result?.isError,JSON.stringify(r));return r.result.structuredContent;};
try {
 const port=await freePort();app=await startIsolatedApp({root,executable:join(bundle,'Contents/MacOS/Paraself'),debugPort:port});assert.equal(app.child.pid,app.runtime.pid);
 for(const key of ISOLATION_KEYS)assert(resolve(app.env[key]).startsWith(root+sep));
 let page; const deadline=Date.now()+15000;
 while(!page&&Date.now()<deadline){const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();page=pages.find(p=>p.type==='page'&&decodeURIComponent(p.url).startsWith(`file://${bundle}/`));if(!page)await new Promise(done=>setTimeout(done,100));}assert(page?.webSocketDebuggerUrl);
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((done,fail)=>{socket.onopen=done;socket.onerror=fail;});socket.onmessage=e=>{const r=JSON.parse(e.data),cb=pending.get(r.id);if(cb){pending.delete(r.id);cb(r);}};
 mcp=await connectMcp({env:app.env,bridge:join(bundle,'Contents/Resources/bridge/paraself-bridge')});
 await api('setLocalCredentialsEnabled',true);
 const priority=Math.max(-1,...(await api('listModelProviderProfiles')).map(p=>p.priority))+1;
 await api('saveModelProviderProfile',{profile:{version:1,profileId:'lab-stub',kind:'openai-compatible',label:'隔离合成桩',enabled:true,priority,model:'fixture',timeoutMs:10000,baseUrl:`http://127.0.0.1:${stub.address().port}/v1`,apiProtocol:'chat-completions',credentialConfigured:false,proxy:{mode:'direct'},fallbackOnFailure:false},secret:'synthetic-not-a-real-key'});
 const created=await api('createProactiveRecord',{kind:'preference',sourceKind:'app_manual',sourceForm:'user_original',sensitivity:'private',tags:[],project,title:'合成回滚约定',content:`合成回滚先使用蓝色通道 ${marker}`,appliesWhen:'合成回滚',exceptions:'其它项目不适用'});
 assert(created.recordId);const id=created.recordId;
 const healthy=await api('createProactiveRecord',{kind:'preference',sourceKind:'app_manual',sourceForm:'user_original',sensitivity:'private',tags:[],project,title:'合成回滚参考',content:'合成回滚保留健康参考 RSI16_HEALTHY',appliesWhen:'合成回滚',exceptions:'其它项目不适用'});assert(healthy.recordId);
 const search=()=>api('searchAssistantSources',{query:'合成回滚',scope:'decisions'});
 const consultation=()=>call('consult_decision_principles',{question:'合成回滚采用哪条通道？',options:[{label:'蓝色通道'},{label:'绿色通道'}],project});
 const initial=await call('search_decision_context',{source:'preferences',recordId:id});
 const originalPath=resolve(app.env.PARASELF_VAULT_PATH,initial.context.results[0].sourceRef.relativePath);assert(originalPath.startsWith(resolve(app.env.PARASELF_VAULT_PATH)+sep));const originalNote=await readFile(originalPath,'utf8');
 const first=await search();const source=first.sources.find(s=>s.recordId===id);assert(source,'active preference must be visible before withdrawal');
 const consultBefore=await consultation();assert(JSON.stringify(consultBefore).includes(marker),'consultation must exercise the synthetic source');
 const model=async(messages,selectedSources)=>{const at=calls.length;const response=await api('runAssistantTurn',{messages,scope:'decisions',profileId:'lab-stub',...(selectedSources?{selectedSources}:{} )});return {response,prompts:JSON.stringify(calls.slice(at)),callCount:calls.length-at};};
 const user=[{role:'user',content:'请根据指定材料说明当前约定。'}];
 const active=await model(user,[source]);check('active selected material reaches the isolated model',active.prompts.includes(marker));
 await call('update_decision_journal_entry',{source:'preferences',recordId:id,action:'withdraw',expectedRevision:0,basis:'user_said',reason:'合成用户撤回'});
 const withdrawn=await search();check('assistant search excludes withdrawn preferences',!withdrawn.sources.some(s=>s.recordId===id));
 const checked=await api('checkAssistantSource',source);check('old citations no longer open withdrawn current evidence',checked.status==='unavailable'&&!checked.content.includes(marker));
 const selected=await model(user,[source]);check('withdrawn selected material is refused before model input',selected.response.status==='unavailable'&&!selected.prompts.includes(marker));
 const history=[{role:'user',content:'之前的约定是什么？'},{role:'assistant',content:'旧回答',citations:[source]},{role:'user',content:'现在还适用吗？'}];
 const followed=await model(history);check('follow-up does not reintroduce a withdrawn citation',followed.response.status==='answered'&&followed.callCount>0&&!followed.prompts.includes(marker));
 check('healthy consultation respects withdrawal',!JSON.stringify(await consultation()).includes(marker));
 const amendment=join(app.env.PARASELF_VAULT_PATH,'Decision Journal/decision-amendments',`${hash(`preferences:${id}`)}.md`);
 const original=await readFile(amendment,'utf8');
 for(const mode of ['file','directory']){
  const folder=dirname(amendment);
  if(mode==='file')await writeFile(amendment,'synthetic damaged metadata');
  else{await rename(folder,`${folder}-held`);await writeFile(folder,'synthetic unavailable directory');}
  try{
   const result=await consultation(),text=JSON.stringify(result);
   check(`${mode}: uncertain withdrawal metadata does not revive the old stance`,!text.includes(marker));
   check(`${mode}: consultation reports incomplete or unavailable signals`,/"signals(?:Incomplete|Unavailable)":true/u.test(text));
   const context=await call('search_decision_context',{source:'preferences',recordId:id});
   check(`${mode}: structured search also excludes unverifiable withdrawals`,!context.context.results.some(r=>r.id===id)&&context.context.coverage!=='complete');
   const assistant=await search();if(mode==='file')check('a damaged neighbor does not hide healthy preferences',assistant.sources.some(s=>s.recordId===healthy.recordId));check(`${mode}: assistant excludes unverifiable evidence and reports the gap`,!assistant.sources.some(s=>s.recordId===id)&&assistant.issues.length>0);
   const followed=await model(history);check(`${mode}: follow-up does not reuse unverifiable old excerpts`,followed.response.status==='answered'&&followed.callCount>0&&!followed.prompts.includes(marker));
  }finally{if(mode==='file')await writeFile(amendment,original);else{await rm(folder);await rename(`${folder}-held`,folder);}}
 }
 await call('update_decision_journal_entry',{source:'preferences',recordId:id,action:'restore',expectedRevision:1,basis:'user_said',reason:'合成恢复'});
 check('restoring the preference restores normal assistant retrieval',(await search()).sources.some(s=>s.recordId===id));
 holdNext=true;const running=model(user,[(await search()).sources.find(s=>s.recordId===id)]);void running.catch(()=>undefined);
 const raceDeadline=Date.now()+10000;while(!releaseHeld&&Date.now()<raceDeadline)await new Promise(done=>setTimeout(done,20));assert(releaseHeld,'model call must be in flight');
 await call('update_decision_journal_entry',{source:'preferences',recordId:id,action:'withdraw',expectedRevision:2,basis:'user_said',reason:'合成生成期间撤回'});
 releaseHeld();releaseHeld=undefined;const raced=await running;
 check('in-flight request used a source that was active when sent',raced.callCount>0&&raced.prompts.includes(marker));
 check('a withdrawal during generation invalidates the completed answer',raced.response.status==='unavailable'&&raced.response.message.includes('生成期间'));
 await call('update_decision_journal_entry',{source:'preferences',recordId:id,action:'restore',expectedRevision:3,basis:'user_said',reason:'合成恢复后继续验证'});
 const found=await call('search_decision_context',{source:'preferences',recordId:id});const contentHash=found.context.results[0].sourceRef.contentHash;
 await call('update_decision_journal_entry',{source:'preferences',recordId:id,action:'revise',expectedRevision:4,expectedContentHash:contentHash,fields:{summary:`合成回滚现在使用绿色通道 ${revised}`,appliesWhen:'仅合成验证阶段',caution:'生产未批准'},basis:'user_said',reason:'合成改写'});
 const current=await api('checkAssistantSource',source);check('assistant reads the effective rewrite and its qualifiers',current.content.includes(revised)&&current.content.includes('生产未批准')&&current.content.includes('改写'));
 const fresh=await api('searchAssistantSources',{query:'绿色通道',scope:'decisions'});check('search finds newly revised words before applying the result limit',fresh.sources.some(s=>s.recordId===id&&s.excerpt.includes(revised)));
 check('all reads and lifecycle changes preserve the original note',await readFile(originalPath,'utf8')===originalNote);
}catch(caught){error=caught instanceof Error?caught.stack:String(caught);}
finally{releaseHeld?.();socket?.close();mcp?.close();if(app){await app.stop().catch(e=>cleanup.push(String(e)));if(app.child.exitCode!==0||app.child.signalCode!==null)cleanup.push(`abnormal App exit: ${app.child.exitCode}/${app.child.signalCode}`);}await new Promise(done=>stub.close(done));}
await writeFile(join(out,'SUMMARY.json'),JSON.stringify({label:values.label,root,checks,calls,error,cleanup,appHash:hash(await readFile(join(bundle,'Contents/Resources/app.asar')))},null,2));
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} passed`);process.exitCode=error||cleanup.length||checks.some(c=>!c.ok)?1:0;

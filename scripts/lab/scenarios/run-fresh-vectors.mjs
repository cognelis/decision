// R1-IB scenario driver: reuse R1-BB assertions, but keep writes and reads in one App and all data under R1-IB.
import { mkdir, readFile, writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
const execute = promisify(execFile);
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { startIsolatedApp, connectMcp } from '../isolated-app.mjs';
import { expand, vaultFile, score, metrics } from '../context-run.mjs';
const {values}=parseArgs({options:{scenarios:{type:'string'},out:{type:'string'},app:{type:'string'},bridge:{type:'string'},root:{type:'string'},'local-models':{type:'boolean',default:false}}});
if(!values.scenarios || !values.out) throw new Error('--scenarios and --out required');
const raw=await readFile(values.scenarios);
const suite=JSON.parse(raw);
if(suite.version!==1 || suite.synthetic!==true) throw new Error('Expected synthetic scenario v1');
const out=resolve(values.out);
await mkdir(dirname(out),{recursive:true});await mkdir(out);
await writeFile(join(out,'scenarios.json'),raw);
const data=values.root?resolve(values.root):join(process.env.PARASELF_LAB_ROOT??join(tmpdir(),'decision-lab'),'fresh-vectors');await mkdir(data,{recursive:true});
const summary={started:new Date().toISOString(),scenarioSha256:createHash('sha256').update(raw).digest('hex'),localModels:values['local-models'],scenarios:[]};
const lifecycle=[];
const log=x=>appendFile(join(out,'requests.jsonl'),JSON.stringify({time:new Date().toISOString(),...x})+'\n');
try{
 for(const scenario of suite.scenarios){
  const root=await mkdtemp(join(data,values['local-models']?'on-':'off-'));
  const history={runtime:{repositoryPath:process.cwd()}},rows=[];
  let app,mcp;
  const life={scenario:scenario.id,root};lifecycle.push(life);
  const sample = async label => {
   const {stdout} = await execute('ps', ['-p', String(app.child.pid), '-o', 'pid=,%cpu=,rss=,time=']);
   const db = new DatabaseSync(join(app.env.PARASELF_USER_DATA, 'semantic-vectors.sqlite'), {readOnly:true});
   try { await appendFile(join(out, 'resources.jsonl'), JSON.stringify({time:new Date().toISOString(),label,pid:app.child.pid,ps:stdout.trim(),vectors:db.prepare('SELECT entity_type,entity_id,source_hash,updated_at FROM semantic_vectors').all()})+'\n'); }
   finally { db.close(); }
  };
  const waitSemanticReady = async phase => {
   const started=Date.now();let attempts=0,ready=false;
   do{
    const response=await mcp.call('search_decision_context',{query:'索引准备'});attempts++;
    ready=!JSON.stringify(response).includes('本机嵌入未在时限内完成');
    await log({scenario:scenario.id,step:'semantic-ready',phase,attempt:attempts,elapsedMs:Date.now()-started,response});
    if(!ready)await new Promise(r=>setTimeout(r,200));
   }while(!ready&&Date.now()-started<120000);
   if(!ready)throw new Error('Semantic search not in time within 120s');
   return Date.now()-started;
  };
  const call=async(step,phase,judged=true)=>{
   if(step.file){const file=expand(step.file,history);const target=vaultFile(app.env.PARASELF_VAULT_PATH,file.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,file.content);await log({scenario:scenario.id,step:step.id,file});return;}
   const args=expand(step.args??{},history);
   const expected=expand({...step.expect,...step.expectByMode?.[values['local-models']?'on':'off']},history);
   if(phase==='steps')await sample('before:'+step.id);
   if(step.remove){const removed=expand(step.remove,history);const removedAt=new Date().toISOString();await rm(vaultFile(app.env.PARASELF_VAULT_PATH,removed));await log({scenario:scenario.id,step:step.id,phase,removed,removedAt});if(phase==='steps')await sample('after:'+step.id);return {removed};}
   if(step.restart){const previous={pid:app.child.pid};mcp.close();await app.stop();previous.exitCode=app.child.exitCode;previous.signalCode=app.child.signalCode;life.restarts??=[];life.restarts.push(previous);app=await startIsolatedApp({root,executable:values.app,useLocalModels:values['local-models']});life.pid=app.child.pid;mcp=await connectMcp({env:app.env,bridge:values.bridge});const semanticReadyMs=values['local-models']?await waitSemanticReady('semantic-ready-restart'):null;await log({scenario:scenario.id,step:step.id,phase,restartedPid:life.pid,semanticReadyMs});if(phase==='steps')await sample('after:'+step.id);return {restarted:life.pid};}
   const start=Date.now();let attempt=0,result,response;
   do{
    response=await mcp.call(step.tool,args);attempt++;
    result=score(response,expected);
    await log({scenario:scenario.id,step:step.id,phase,attempt,elapsedMs:Date.now()-start,request:{jsonrpc:'2.0',id:response.id,method:'tools/call',params:{name:step.tool,arguments:args}},response});
    if(!judged || result.pass || !values['local-models'] || !step.eventuallyMs || Date.now()-start>=step.eventuallyMs)break;
    await new Promise(resolve=>setTimeout(resolve,200));
   }while(true);
   if(phase==='steps')await sample('after:'+step.id);
   history[step.id]=response.result?.structuredContent??response.result??response;
   if(judged)rows.push({id:step.id,tool:step.tool,phase,attempts:attempt,elapsedMs:Date.now()-start,...result});
   return response;
  };
  try{
   // Existing frozen fixtures are placed before startup, letting the product's normal startup sync index them.
   // The fresh fixture has no seed, so its writes and queries all run in the same process without a restart.
   const vault=join(root,'vault');await mkdir(vault,{recursive:true});
   for(const file of (scenario.beforeSeed?.length ? [] : scenario.seed?.files??[])){const target=vaultFile(vault,file.path);await mkdir(dirname(target),{recursive:true});await writeFile(target,file.content);}
   app=await startIsolatedApp({root,executable:values.app,useLocalModels:values['local-models']});life.pid=app.child.pid;
   mcp=await connectMcp({env:app.env,bridge:values.bridge});
   app.child.stderr.on('data',chunk=>{void appendFile(join(out,'app-stderr.log'),chunk);});
   if(values['local-models'])life.semanticReadyBeforeScenarioMs=await waitSemanticReady('semantic-ready-before-scenario');
   for(const step of scenario.beforeSeed??[])await call(step,'beforeSeed');
   if(scenario.beforeSeed?.length)for(const file of scenario.seed?.files??[])await call({id:'seed-file',file},'seed',false);
   for(const step of scenario.seed?.calls??[])await call(step,'seed');
   if(values['local-models'] && scenario.seed){
    // R1-BB's seed barrier is intentionally retained only for its original fixtures, never the new writes scenario.
    mcp.close();await app.stop();life.seedPid=life.pid;life.seedExitCode=app.child.exitCode;life.seedSignalCode=app.child.signalCode;
    app=await startIsolatedApp({root,executable:values.app,useLocalModels:true});life.pid=app.child.pid;mcp=await connectMcp({env:app.env,bridge:values.bridge});
    const expected=[];let offset=0;
    do{const r=await call({id:`catalog-${offset}`,tool:'search_decision_context',args:{query:'',limit:20,offset,includeOutOfScope:true}},'warmup',false);const c=r.result.structuredContent.context;expected.push(...c.results.map(x=>({id:x.id,type:{summarize:'summary',decisions:'decision',principles:'methodology'}[x.source]})));offset=c.nextOffset;}while(offset!==null);
    const deadline=Date.now()+120000;let ready=false;
    do{await call({id:'warm-consult',tool:'consult_decision_principles',args:{question:'索引准备：验证迁移可逆性',project:'lab'}},'warmup',false);await call({id:'warm-search',tool:'search_decision_context',args:{query:'索引准备'}},'warmup',false);const db=new DatabaseSync(join(app.env.PARASELF_USER_DATA,'semantic-vectors.sqlite'),{readOnly:true});try{const vectors=db.prepare('SELECT entity_id,entity_type,model,dimension FROM semantic_vectors').all();ready=expected.every(e=>vectors.some(v=>v.entity_id===e.id&&v.entity_type===e.type));await log({phase:'index-ready',ready,expected,vectors});}finally{db.close();}if(!ready)await new Promise(r=>setTimeout(r,200));}while(!ready&&Date.now()<deadline);
    if(!ready)throw new Error('Seed vectors not ready');
   }
   // As context-run: steps begin once a search's meaning comes in time. Begun at once, the first after a start (the model
   // hashed and loaded) was found by keyword alone, and fresh-recall failed on main and candidates alike (R9).
   if(values['local-models'])life.semanticReadyMs=await waitSemanticReady('semantic-ready-before-steps');
   for(const step of scenario.steps)await call(step,'steps');
   await sample('idle:start');await new Promise(r=>setTimeout(r,1000));await sample('idle:end');
  }finally{mcp?.close();if(app){await app.stop();life.exitCode=app.child.exitCode;life.signalCode=app.child.signalCode;life.closed=app.child.exitCode!==null||app.child.signalCode!==null;life.stop='isolated-app.stop: POST shutdown; fallback SIGTERM/SIGKILL';}summary.scenarios.push({id:scenario.id,root,rows,metrics:metrics(rows)});await writeFile(join(out,'lifecycle.json'),JSON.stringify(lifecycle,null,2));}
 }
}catch(error){summary.error=error.stack;process.exitCode=2;}
summary.finished=new Date().toISOString();summary.metrics=metrics(summary.scenarios.flatMap(s=>s.rows));await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({out,...summary.metrics,error:summary.error}));if(!summary.error&&summary.metrics.steps!==summary.metrics.passed)process.exitCode=1;

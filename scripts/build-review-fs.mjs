import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildReviewFs(root = fileURLToPath(new URL('../', import.meta.url))) {
  const output = join(root, 'dist/native'); await mkdir(output, {recursive:true});
  if (!['darwin','linux'].includes(process.platform)) return;
  const source = join(root,'apps/desktop/native/review-fs/review-fs.c'), target=join(output,'review-fs.node'), stamp=target+'.sha256';
  const fingerprint=createHash('sha256').update(await readFile(source)).update(process.platform+process.arch+'napi8').digest('hex');
  if(await readFile(stamp,'utf8').catch(()=>null)===fingerprint && await access(target).then(()=>true,()=>false))return;
  const include=process.env.PARASELF_NODE_HEADERS ?? join(dirname(process.execPath),'../include/node');
  await access(join(include,'node_api.h'));
  const temporary=target+'.'+process.pid+'.'+randomUUID();
  const flags=process.platform==='darwin'?['-bundle','-undefined','dynamic_lookup']:['-shared','-fPIC'];
  const built=spawnSync('cc',['-std=c11','-DNAPI_VERSION=8',...flags,'-I',include,source,'-o',temporary],{encoding:'utf8'});
  if(built.status!==0)throw new Error('Secure review filesystem build failed: '+built.stderr);
  await rename(temporary,target);await writeFile(stamp,fingerprint);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await buildReviewFs();

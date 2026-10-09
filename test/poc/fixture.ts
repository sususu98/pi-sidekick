// OFFLINE FEASIBILITY FIXTURE. Not a production extension; no remote models.
import { SessionManager, getPackageDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { RpcPeer } from "../../extensions/rpc.ts";
const root = process.env.FUSION_PROOF_ROOT!;
const extension = process.env.FUSION_PROOF_EXTENSION!;
const workerMode = process.env.FUSION_PROOF_WORKER === '1';
const KIND = 'fusion-proof-checkpoint';
const getText = (m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');

export default function (pi: ExtensionAPI) {
  pi.registerProvider('fusion-proof', {
    api: 'fusion-proof-api', baseUrl: 'http://127.0.0.1:1/never-used', apiKey: 'offline-fixture',
    models: ['lead', 'worker'].map(id => ({ id, name: `Offline ${id}`, reasoning: true, input: ['text'], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 100000, maxTokens: 4096 })),
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const output: any = {role:'assistant', content:[], api:model.api, provider:model.provider, model:model.id, timestamp:Date.now(), stopReason:'pending', usage:{input:20,output:10,cacheRead:0,cacheWrite:0,totalTokens:30,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
        try {
          if (options?.signal?.aborted) throw new Error('cancelled');
          const last = context.messages.at(-1);
          const users = context.messages.filter((m: any) => m.role === 'user');
          const task = getText(users.at(-1) ?? {content:''});
          let call: any;
          let text: string;
          if (last.role === 'user') {
            call = model.id === 'lead'
              ? {type:'toolCall',id:randomUUID(),name:'fusion_worker',arguments:{task}}
              : task.includes('SLOW') || task.includes('STEER_TEST')
                ? {type:'toolCall',id:randomUUID(),name:'fixture_wait',arguments:{milliseconds:task.includes('SLOW')?20000:500}}
                : {type:'toolCall',id:randomUUID(),name:'write',arguments:{path:join(root,'workspace','worker-output.txt'),content:`worker tasks=${users.length}`}};
            if (model.id === 'worker') {
              output.content.push({type:'text',text:'WORKER_PRIVATE_TRACE'});
              stream.push({type:'start',partial:output});
              stream.push({type:'text_start',contentIndex:0,partial:output});
              stream.push({type:'text_delta',contentIndex:0,delta:'WORKER_PRIVATE_TRACE',partial:output});
              stream.push({type:'text_end',contentIndex:0,content:'WORKER_PRIVATE_TRACE',partial:output});
            } else stream.push({type:'start',partial:output});
            const i = output.content.length;
            output.content.push(call);
            stream.push({type:'toolcall_start',contentIndex:i,partial:output});
            stream.push({type:'toolcall_end',contentIndex:i,toolCall:call,partial:output});
            output.stopReason = 'toolUse';
          } else {
            text = model.id === 'lead' ? 'LEAD_REVIEW: '+getText(last)
              : `WORKER_REPORT tasks=${users.length} remembered=${users.some((m: any) => getText(m).includes(process.env.FUSION_PROOF_SECRET!))} tool_result=${!last.isError}`;
            output.content.push({type:'text',text});
            stream.push({type:'start',partial:output});
            stream.push({type:'text_start',contentIndex:0,partial:output});
            stream.push({type:'text_delta',contentIndex:0,delta:text,partial:output});
            stream.push({type:'text_end',contentIndex:0,content:text,partial:output});
            output.stopReason = 'stop';
          }
          stream.push({type:'done',reason:output.stopReason,message:output}); stream.end();
        } catch(e) {
          output.stopReason = 'aborted'; output.errorMessage = String(e);
          stream.push({type:'error',reason:'aborted',error:output}); stream.end();
        }
      });
      return stream;
    },
  });

  if (workerMode) {
    pi.registerTool({name:'fixture_wait',label:'Offline cancellable wait',description:'Offline test of cancellable tools',parameters:Type.Object({milliseconds:Type.Number()}),
      async execute(_id,args,signal,onUpdate) {
        onUpdate?.({content:[{type:'text',text:'waiting'}],details:{}});
        await new Promise<void>((resolve,reject) => {
          const finish = () => {clearTimeout(timer); signal?.removeEventListener('abort',abort);};
          const abort = () => {finish();reject(new Error('worker tool cancelled'));};
          const timer = setTimeout(() => {finish();resolve();},args.milliseconds);
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted) abort();
        });
        return {content:[{type:'text',text:'finished'}],details:{}};
      },
    });
    return; // No recursive delegation in the worker.
  }

  let checkpoint: any;
  let worker: RpcPeer | undefined;
  let busy = false;
  pi.on('session_start', (_e,ctx) => {
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === KIND);
    checkpoint = entry?.type === 'custom' ? entry.data : undefined;
  });
  const stop = async () => {const w=worker; worker=undefined; if(w) {await w.clearQueue().catch(()=>{}); await w.abort().catch(()=>{}); await w.stop();}};
  pi.on('session_shutdown',stop);
  pi.registerCommand('fixture_restart',{description:'Offline proof: stop only worker process',handler:async()=>{if(busy)throw new Error('busy');await stop();}});
  pi.registerCommand('fixture_steer',{description:'Offline proof: correction while worker runs',handler:async()=>{if(!worker||!busy)throw new Error('worker not running');await worker.steer('CORRECTION_KEEP_SCOPE');}});
  pi.registerTool({
    name:'fusion_worker',label:'Fusion proof',description:'Delegate to a persistent worker session',exposure:'model-only',parameters:Type.Object({task:Type.String()}),
    async execute(_id,args,signal,onUpdate,ctx) {
      if(busy) throw new Error('worker busy'); busy=true;
      let unsubscribe: (()=>void)|undefined;
      let abortDone: Promise<void>|undefined;
      let cancel: (()=>void)|undefined;
      const save=async()=>{if(!worker)return;const state=await worker.getState(); const entries=await worker.getEntries();checkpoint={file:state.sessionFile,leaf:entries.leafId,owner:ctx.sessionManager.getSessionId()};pi.appendEntry(KIND,checkpoint);};
      try {
        signal?.throwIfAborted();
        if(!worker) {
          if(checkpoint?.file) {
            const manager=SessionManager.open(checkpoint.file);
            if(checkpoint.owner!==ctx.sessionManager.getSessionId() || manager.getLeafId()!==checkpoint.leaf) {
              const file=manager.createBranchedSession(checkpoint.leaf);
              if(!file)throw new Error('Cannot restore worker checkpoint');
              checkpoint={...checkpoint,file,owner:ctx.sessionManager.getSessionId()};
            }
          }
          worker=new RpcPeer({executable:process.execPath, runtimeArgs:['--preload',process.env.FUSION_PROOF_GUARD!],cliPath:join(getPackageDir(),'dist/bun/cli.js'),cwd:ctx.cwd,env:{FUSION_PROOF_WORKER:'1'},
            args:['--provider','fusion-proof','--model','worker','--no-extensions','-e',extension,'--no-skills','--no-themes','--no-prompt-templates','--no-approve','--thinking','high','--tools','read,bash,edit,write,fixture_wait','--session-dir',join(root,'worker-sessions'),...(checkpoint?.file?['--session',checkpoint.file]:[]) ]});
          await worker.start();
          await save();
        }
        const w=worker;
        cancel=()=>{abortDone=(async()=>{await w.clearQueue();await w.abort();})();abortDone.catch(()=>{});};
        signal?.addEventListener('abort',cancel,{once:true});
        if(signal?.aborted)cancel();
        let eventCount=0;
        unsubscribe=w.onEvent((e)=>{if(e.type==='tool_execution_start'||e.type==='tool_execution_end'||e.type==='message_update'){eventCount++;onUpdate?.({content:[{type:'text',text:`Worker event: ${e.type}`}],details:{eventCount}});}});
        const prompt = args.task==='FIRST' ? `Remember private token: ${process.env.FUSION_PROOF_SECRET}. Execute FIRST.` : args.task;
        await w.run(prompt,25000);
        if(abortDone)await abortDone;
        await save();
        signal?.throwIfAborted();
        const msgs=(await w.request({type:"get_messages"})).messages;const last=msgs.findLast((m:any)=>m.role==='assistant') as any;
        if(last?.stopReason==='error'||last?.stopReason==='aborted')throw new Error('Worker failed: '+last.errorMessage);
        return {content:[{type:'text',text:(await w.getLastAssistantText()).text??'No report'}],details:{...checkpoint,eventCount}};
      } finally {unsubscribe?.();if(cancel)signal?.removeEventListener('abort',cancel);if(abortDone)await abortDone.catch(()=>{});busy=false;}
    },
  });
}

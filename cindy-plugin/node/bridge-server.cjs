'use strict';
const http=require('node:http'),crypto=require('node:crypto');
const uuid=()=>crypto.randomUUID(),secret=()=>crypto.randomBytes(32).toString('base64url');
function same(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
const validId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s);
exports.createBridge=async function createBridge({notify,port=0,now=()=>Date.now(),pairTtlMs=300000}){
 const instance=uuid(),challenge=secret(),tokens=new Set(),operations=new Map(),requests=new Map();const pairs=new Map();let lastPair=0;
 function expirePairs(){for(const p of pairs.values())if(['awaiting-user','confirming'].includes(p.state)&&now()>=p.expiresAt){p.state='expired';p.finishedAt=now();}}
 function publicPair(p){return{id:p.id,code:p.code,state:p.state,createdAt:p.createdAt,expiresAt:p.expiresAt,finishedAt:p.finishedAt};}
 function json(res,status,value){if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}}
 function host(method,payload,timeout=12000){return new Promise((resolve,reject)=>{const id=uuid();const timer=setTimeout(()=>{operations.delete(id);reject(Error('Cindy 未及时响应'));},timeout);operations.set(id,{resolve,reject,timer});notify(method,{id,...payload});});}
 function auth(req){const value=req.headers.authorization;return typeof value==='string'?[...tokens].find(t=>same(value,'Bearer '+t)):undefined;}
 async function body(req){let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>36000)throw Error('输入过长');}return JSON.parse(raw||'{}');}
 function snapshot(r){return{id:r.id,state:r.state,target:r.target,label:r.label,answer:r.answer,error:r.error,acceptedAt:r.acceptedAt,finishedAt:r.finishedAt};}
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.headers.origin||req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='none'){json(res,403,{error:'拒绝网页跨域调用'});return;}
   if(req.headers.host!==`127.0.0.1:${server.address().port}`){json(res,403,{error:'无效本机地址'});return;}
   const u=new URL(req.url,'http://127.0.0.1');
   if(req.method==='POST'&&!String(req.headers['content-type']).startsWith('application/json')){json(res,415,{error:'仅接受 JSON'});return;}
   if(req.method==='GET'&&u.pathname==='/status'){json(res,200,{protocol:1,instance,kind:'cindy-meeting-partner-bridge'});return;}
   if(req.method==='POST'&&u.pathname==='/pair'){json(res,409,{error:'连接流程已更新，请更新 MeetCue；新版在 Cindy 内处理请求，不从外部弹确认'});return;}
   if(req.method==='POST'&&u.pathname==='/pair/register'){
    const input=await body(req);if(!same(input.challenge,challenge)){json(res,403,{error:'连接信息已失效'});return;}
    expirePairs();if([...pairs.values()].some(p=>['awaiting-user','confirming'].includes(p.state))){json(res,409,{error:'已有待处理连接请求，请到 Cindy 会议连接页处理，不要重复登记'});return;}
    if(now()-lastPair<5000){json(res,429,{error:'连接请求过于频繁'});return;}lastPair=now();
    for(const [id,p] of pairs)if(!['awaiting-user','confirming'].includes(p.state))pairs.delete(id);
    const p={id:uuid(),pollToken:secret(),code:crypto.randomBytes(4).toString('hex').toUpperCase(),state:'awaiting-user',createdAt:now(),expiresAt:now()+pairTtlMs};pairs.set(p.id,p);
    notify('pair-pending',publicPair(p));json(res,202,{...publicPair(p),pollToken:p.pollToken});return;
   }
   const pairMatch=u.pathname.match(/^\/pair\/([\w-]{1,100})$/);
   if(req.method==='GET'&&pairMatch){
    expirePairs();const p=pairs.get(pairMatch[1]);if(!p||!same(req.headers.authorization,'Bearer '+p.pollToken)){json(res,404,{error:'配对请求不存在'});return;}
    json(res,200,{...publicPair(p),...(p.state==='confirmed'?{token:p.token,instance}:{})});return;
   }
   const owner=auth(req);if(!owner){json(res,401,{error:'尚未连接 Cindy，请点击连接'});return;}
   if(req.method==='POST'&&u.pathname==='/disconnect'){tokens.delete(req.headers.authorization.slice(7));json(res,200,{ok:true});return;}
   if(req.method==='GET'&&u.pathname==='/targets'){json(res,200,await host('targets',{}));return;}
   if(req.method==='POST'&&u.pathname==='/ask'){
    const p=await body(req);
    if(!validId(p.requestKey)||typeof p.targetId!=='string'||p.targetId.length>220||typeof p.transcript!=='string'||!p.transcript.trim()||p.transcript.length>20000||typeof p.question!=='string'||p.question.length>2000)throw Error('问题或目标无效');
    const signature=crypto.createHash('sha256').update(JSON.stringify([p.targetId,p.transcript,p.question])).digest('hex');
    const old=requests.get(p.requestKey);
    if(old){if(old.owner!==owner){json(res,404,{error:'请求不存在'});return;}if(old.signature!==signature){json(res,409,{error:'同一请求内容已变化，未重复投递'});return;}json(res,200,snapshot(old));return;}
    const duplicate=[...requests.values()].find(r=>r.owner===owner&&r.signature===signature);
    if(duplicate){json(res,200,snapshot(duplicate));return;}
    if([...requests.values()].some(r=>!r.displayCancelled&&['sending','accepted','uncertain'].includes(r.state))){json(res,409,{error:'上一条请求尚未结束，请等待回复或取消显示'});return;}
    if(requests.size>=100){json(res,429,{error:'本次连接请求数已满，请重启插件后重新连接'});return;}
    const r={id:p.requestKey,owner,target:p.targetId,signature,state:'sending',createdAt:Date.now()};requests.set(r.id,r);json(res,202,snapshot(r));
    host('ask',{requestId:r.id,targetId:p.targetId,transcript:p.transcript,question:p.question},20000).then(result=>{if(!result.accepted||typeof result.taskId!=='string')throw Error('Cindy 未确认投递');r.state='accepted';r.sessionId=result.taskId;r.label=result.label;r.acceptedAt=Date.now();if(r.early){finish(r,r.early);delete r.early;}}).catch(e=>{r.state='uncertain';r.error='投递结果未确认，请先到 Cindy 核实，勿重复发送：'+e.message;});return;
   }
   const match=u.pathname.match(/^\/requests\/([\w-]{1,100})$/);
   if(req.method==='GET'&&match){const candidate=requests.get(match[1]),r=candidate?.owner===owner?candidate:undefined;json(res,r?200:404,r?snapshot(r):{error:'请求不存在'});return;}
   if(req.method==='POST'&&u.pathname==='/cancel'){
    const p=await body(req),r=requests.get(p.requestKey);if(!r||r.owner!==owner){json(res,404,{error:'请求不存在'});return;}
    // Cancellation never stops a partner's unrelated work. Retain its real receipt.
    try{await host('cancel',{requestId:r.id},10000);}catch{}
    r.displayCancelled=true;json(res,200,{ok:true,note:'已停止等待；已开始的伙伴工作可能继续，请在 Cindy 查看'});return;
   }
   json(res,404,{error:'接口不存在'});
  }catch(e){json(res,400,{error:e.message||'请求失败'});}
 });
 function finish(r,p){if(r.state==='completed')throw Error('答案已交付');if(r.sessionId!==p.sessionId)throw Error('答案来自其他会话，已拒绝');if(typeof p.answer!=='string'||!p.answer.trim()||p.answer.length>8000)throw Error('回答长度无效');r.answer=p.answer;r.state='completed';r.finishedAt=Date.now();return{delivered:true};}
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 return{
  info:{protocol:1,port:server.address().port,instance,challenge},
  resolve(p){const op=operations.get(p.id);if(!op)return{stale:true};operations.delete(p.id);clearTimeout(op.timer);if(p.ok)op.resolve(p.result);else op.reject(Error(p.error||'Cindy 操作失败'));return{ok:true};},
  deliver(p){const r=requests.get(p.requestId);if(!r)throw Error('请求不存在或已过期');if(!r.sessionId&&r.state==='sending'){r.early=p;return{pendingVerification:true};}return finish(r,p);},
  pairingStatus(){expirePairs();return{pairs:[...pairs.values()].map(publicPair)};},
  claimPair({id}){expirePairs();const p=pairs.get(id);if(!p||p.state!=='awaiting-user')throw Error('请求已处理、已过期或不存在，未再次弹确认');if(p.expiresAt-now()<100000){p.state='expired';p.finishedAt=now();throw Error('本请求剩余时间不足，已过期；没有弹确认');}p.state='confirming';p.confirmStartedAt=now();p.claim=secret();return{...publicPair(p),claim:p.claim};},
  completePair({id,claim,confirmed,reason}){expirePairs();const p=pairs.get(id);if(!p||p.state!=='confirming'||!same(p.claim,claim))throw Error('配对请求已失效，未创建连接凭据');p.finishedAt=now();p.state=confirmed===true?'confirmed':'not-approved';p.reason=reason||null;if(confirmed===true){p.token=secret();tokens.add(p.token);}delete p.claim;return publicPair(p);},
  status(){expirePairs();return{running:true,protocol:1,requests:requests.size,pairPending:[...pairs.values()].some(p=>['awaiting-user','confirming'].includes(p.state)),hostOperations:operations.size,pairing:[...pairs.values()].map(publicPair)};},
  async close(){for(const op of operations.values()){clearTimeout(op.timer);op.reject(Error('桥接已关闭'));}operations.clear();tokens.clear();server.closeAllConnections();await new Promise(r=>server.close(r));}
 };
};

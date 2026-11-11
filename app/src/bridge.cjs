'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {app,safeStorage}=require('electron');
function latency(startedAt,submittedAt,acceptedAt,finishedAt,receivedAt){const v=t=>Number.isFinite(t)&&t>=startedAt&&t<=receivedAt;return{submitToAcceptedMs:v(acceptedAt)?acceptedAt-submittedAt:null,partnerMs:v(acceptedAt)&&v(finishedAt)?finishedAt-acceptedAt:null,totalMs:receivedAt-startedAt};}
let connection,pairRegistration;
const saved=()=>path.join(app.getPath('userData'),'cindy-bridge-connection.bin');
function discovery(){const dir=path.join(os.tmpdir(),'cindy-meeting-partner-bridge-'+process.getuid()),file=path.join(dir,'discovery.json');const ds=fs.lstatSync(dir),s=fs.lstatSync(file);if(ds.isSymbolicLink()||s.isSymbolicLink()||ds.uid!==process.getuid()||s.uid!==process.getuid()||s.size>4096)throw Error('本机桥接信息无效');const d=JSON.parse(fs.readFileSync(file,'utf8'));if(d.protocol!==1||!Number.isInteger(d.port)||d.port<1024||d.port>65535||typeof d.instance!=='string'||typeof d.challenge!=='string')throw Error('桥接版本或地址无效');return d;}
function request(d,method,route,data,token,timeout=10000){return new Promise((resolve,reject)=>{
 const bytes=data===undefined?undefined:Buffer.from(JSON.stringify(data));
 const req=http.request({host:'127.0.0.1',port:d.port,path:route,method,headers:{...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(token?{Authorization:'Bearer '+token}:{})}},res=>{let raw='';res.on('data',c=>{raw+=c;if(Buffer.byteLength(raw)>100000){req.destroy(Error('桥接响应过大'));}});res.on('end',()=>{try{const result=JSON.parse(raw);if(res.statusCode<200||res.statusCode>=300)throw Error(result.error||'Cindy 桥接请求失败');resolve(result);}catch(e){reject(e);}});});
 req.setTimeout(timeout,()=>req.destroy(Error('Cindy 桥接连接超时')));req.on('error',e=>reject(Error(e.code==='ECONNREFUSED'?'Cindy 桥接未运行，请确认插件已启用':e.message)));if(bytes)req.write(bytes);req.end();
 });}
async function current(){let d;try{d=discovery();}catch{throw Error('未找到 Cindy 桥接，请先启用「会议伙伴桥接」插件');}if(!connection){try{if(!safeStorage.isEncryptionAvailable())throw Error('安全存储不可用');connection=JSON.parse(safeStorage.decryptString(fs.readFileSync(saved())));}catch{throw Error('尚未连接 Cindy，请点击连接');}}
 if(connection.instance!==d.instance)throw Error('Cindy 桥接已重启，请重新连接');const r=await request(d,'GET','/status');if(r.instance!==d.instance)throw Error('Cindy 桥接身份已变化');return{d,token:connection.token};}
function pairPublic(p){return{pending:['awaiting-user','confirming'].includes(p.state),pairId:p.id,code:p.code,state:p.state,expiresAt:p.expiresAt};}
exports.connect=async()=>{
 if(pairRegistration)return await exports.pairStatus();
 if(!safeStorage.isEncryptionAvailable())throw Error('系统安全存储不可用，未保存连接凭据');
 let d;try{d=discovery();}catch{throw Error('未找到 Cindy 桥接，请先启用「会议伙伴桥接」插件');}
 const info=await request(d,'GET','/status');if(info.instance!==d.instance||info.kind!=='cindy-meeting-partner-bridge')throw Error('桥接身份不匹配');
 const p=await request(d,'POST','/pair/register',{challenge:d.challenge});
 pairRegistration={...p,discovery:d};return pairPublic(p);
};
exports.pairStatus=async()=>{
 if(!pairRegistration)return{pending:false,state:'none'};
 const p=pairRegistration,d=p.discovery;
 const r=await request(d,'GET','/pair/'+encodeURIComponent(p.id),undefined,p.pollToken);
 if(r.state==='confirmed'){
  if(typeof r.token!=='string'||r.instance!==d.instance)throw Error('配对回执无效');
  connection={instance:d.instance,token:r.token};fs.writeFileSync(saved(),safeStorage.encryptString(JSON.stringify(connection)),{mode:0o600});pairRegistration=null;return{connected:true,state:'confirmed'};
 }
 if(['expired','not-approved'].includes(r.state))pairRegistration=null;
 return pairPublic(r);
};
exports.targets=async()=>{const{d,token}=await current();return await request(d,'GET','/targets',undefined,token,15000);};
exports.status=async()=>{if(pairRegistration)return{connected:false,...pairPublic(pairRegistration)};try{await current();return{connected:true};}catch(e){return{connected:false,message:e.message};}};
exports.ask=async({id,targetId,transcript,question,signal,onState})=>{
 const began=Date.now();const {d,token}=await current();if(signal?.aborted)throw Error('已取消发送');
 const submittedAt=Date.now();const initial=await request(d,'POST','/ask',{requestKey:id,targetId,transcript,question},token,12000);let r=initial,last;const receiptId=initial.id||id;
 while(true){
  if(signal?.aborted){await request(d,'POST','/cancel',{requestKey:receiptId},token,12000).catch(()=>{});throw Error('已停止等待；伙伴已开始的工作可能继续，请在 Cindy 查看');}
  if(r.state!==last){last=r.state;onState?.(r);}
  if(r.state==='completed'){const receivedAt=Date.now();return{answer:r.answer,label:r.label,ms:receivedAt-began,timing:latency(began,submittedAt,r.acceptedAt,r.finishedAt,receivedAt)};}
  if(r.state==='uncertain')throw Error(r.error||'投递结果未确认，请在 Cindy 核实，勿重复发送');
  if(Date.now()-began>120000)throw Error('伙伴尚未在 120 秒内回复；请在 Cindy 查看，未自动重复发送');
  await new Promise(resolve=>setTimeout(resolve,500));r=await request(d,'GET','/requests/'+encodeURIComponent(receiptId),undefined,token,12000);
 }
};

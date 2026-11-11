'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),readline=require('node:readline');
const {createBridge}=require('./bridge-server.cjs');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');let bridge;
const started=createBridge({notify:(method,params)=>send({jsonrpc:'2.0',method:'bridge:'+method,params})}).then(b=>{
 bridge=b;const dir=path.join(os.tmpdir(),'cindy-meeting-partner-bridge-'+process.getuid());
 try{const stat=fs.lstatSync(dir);if(stat.isSymbolicLink()||!stat.isDirectory()||stat.uid!==process.getuid())throw Error('本机连接目录不安全');}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(dir,{mode:0o700});}
 fs.chmodSync(dir,0o700);const discovery=path.join(dir,'discovery.json');if(fs.existsSync(discovery)&&fs.lstatSync(discovery).isSymbolicLink())throw Error('连接文件不能是链接');
 fs.writeFileSync(discovery,JSON.stringify(b.info),{mode:0o600});return b;
});
readline.createInterface({input:process.stdin}).on('line',async line=>{let r;try{r=JSON.parse(line);await started;let result;
 if(r.method==='start'||r.method==='status')result=bridge.status();
 else if(r.method==='host-result')result=bridge.resolve(r.params);
 else if(r.method==='pairing-status')result=bridge.pairingStatus();
 else if(r.method==='claim-pair')result=bridge.claimPair(r.params);
 else if(r.method==='complete-pair')result=bridge.completePair(r.params);
 else if(r.method==='deliver')result=bridge.deliver(r.params);
 else throw Error('未知操作');
 send({jsonrpc:'2.0',id:r.id,result});
}catch(e){send({jsonrpc:'2.0',id:r?.id??null,error:{code:-32000,message:e.message}});}});
let closing=false;async function close(){if(closing)return;closing=true;try{await bridge?.close();}finally{process.exit(0);}}
process.stdin.on('end',close);process.on('SIGTERM',close);process.on('SIGINT',close);started.catch(e=>{console.error(e.message);process.exit(1);});

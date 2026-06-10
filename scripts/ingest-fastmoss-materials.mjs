import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const XLSX = require(path.join(root,'node_modules/xlsx'));
const db = require(path.join(root,'packages/db/dist/index.js'));
const { createStorageClient } = require(path.join(root,'packages/storage/dist/index.js'));

const BASE='/Users/kaigeliang/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_pb55dzfod7w222_2899/temp/drag';
const wb=XLSX.readFile(BASE+'/fastmoss_tiktok_us_all_product_ranking_20260531.xlsx');
const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''})
  .filter(r=>String(r['商品图片']||'').startsWith('http')).slice(0,100);
console.log('待入库商品:', rows.length);
const storage=createStorageClient();
let ok=0,fail=0;
for(const r of rows){
  try{
    const imgUrl=String(r['商品图片']);
    const pid='fastmoss_'+String(r['商品ID']||Math.random().toString(36).slice(2,10));
    const matId='mat_fm_'+String(r['商品ID']||Date.now());
    const res=await fetch(imgUrl,{signal:AbortSignal.timeout(15000)});
    if(!res.ok){fail++;process.stdout.write('x');continue;}
    const buf=Buffer.from(await res.arrayBuffer());
    const stored=await storage.putObject({key:'materials/'+matId+'.jpg',body:buf,contentType:'image/jpeg'});
    await db.upsertMaterial({id:matId,productId:pid,name:String(r['商品名称']||'').slice(0,120),type:'image',sourceUrl:imgUrl,sourceObjectKey:stored.key,sourceDeclaration:'FastMoss TikTok US 商品榜单 2026-05-31；公开商品图，仅作渲染参考',uploadedAt:new Date()});
    ok++;process.stdout.write('.');
  }catch(e){fail++;process.stdout.write('x');}
}
console.log(`\n完成: 成功${ok} 失败${fail}`);

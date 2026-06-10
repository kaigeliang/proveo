// 从 download-queue + 已下载视频，生成 qwenvl 候选列表
import fs from 'node:fs';
const queue=JSON.parse(fs.readFileSync('tmp/kalodata-test/download-queue.json','utf8'));
const OUT='tmp/tiktok-videos';
const downloaded=new Map(fs.readdirSync(OUT).filter(f=>f.endsWith('.mp4')).map(f=>[f.split('.')[0],f]));
const candidates=[];
for(const item of queue){
  const vid=item.tiktokUrl.split('/video/')[1]?.split('?')[0]||'';
  const file=downloaded.get(vid);
  if(!file)continue;
  candidates.push({
    id:item.id, file:OUT+'/'+file, size:fs.statSync(OUT+'/'+file).size,
    durationSeconds:item.durationSeconds, productTitle:item.productTitle,
    category:item.category, bucket:item.bucket||(item.source==='fastmoss'?'fastmoss_top':'organic'),
    source:item.source,
  });
}
fs.writeFileSync('tmp/kalodata-test/qwenvl-url-candidates.json',JSON.stringify(candidates,null,2));
const bySource={};candidates.forEach(c=>bySource[c.source]=(bySource[c.source]||0)+1);
console.log('候选总数:', candidates.length, '| 来源:', JSON.stringify(bySource));
console.log('总大小:', (candidates.reduce((s,c)=>s+c.size,0)/1024/1024).toFixed(0)+'MB');

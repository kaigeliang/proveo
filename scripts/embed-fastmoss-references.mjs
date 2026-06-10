import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = require(path.join(root,'packages/db/dist/index.js'));
const { embedText } = require(path.join(root,'apps/api/dist/apps/api/src/lib/clip.js'));

async function main(){
  const refs = await db.getPrisma().referenceVideo.findMany({ where:{ id:{ startsWith:'fastmoss' } } });
  console.log('fastmoss reference:', refs.length);
  const Q=process.env.QDRANT_URL||'http://127.0.0.1:6333';
  await fetch(Q+'/collections/aigc_reference_vectors',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({vectors:{size:1024,distance:'Cosine'}})});
  let ok=0;
  const points=[];
  for(const r of refs){
    const br=r.breakdownReport||{};
    const cf=br.creativeFeature||{};
    const truth=br.qwenTruthSlice||{};
    const shots=[...(cf.shotStructure||[]),...(truth.shotStructure||[])];
    const text=[br.productTitle,br.category,br.description,...shots,...(cf.sellingPoints||[])].filter(Boolean).join(' ');
    if(!text.trim())continue;
    const vec = await embedText(text);
    if(!vec||vec.length!==1024)continue;
    const metadata={category:br.category||'',source:'fastmoss',productTitle:br.productTitle||''};
    await db.upsertEmbeddingVector({
      ownerType:'reference', ownerId:r.id, embeddingModel:db.REFERENCE_TEXT_EMBEDDING_MODEL,
      dims:1024, vector:vec, metadata,
    });
    points.push({id:10000+ok,vector:vec,payload:{ownerType:'reference',ownerId:r.id,embeddingModel:db.REFERENCE_TEXT_EMBEDDING_MODEL,...metadata}});
    ok++; if(ok%20===0)process.stdout.write(ok+' ');
  }
  // 写 qdrant
  for(let i=0;i<points.length;i+=100){
    await fetch(Q+'/collections/aigc_reference_vectors/points?wait=true',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({points:points.slice(i,i+100)})});
  }
  const info=await(await fetch(Q+'/collections/aigc_reference_vectors')).json();
  console.log('\n写入:',ok,'| qdrant 总点数:',info.result?.points_count);
}
main().catch(e=>{console.error(e);process.exit(1)});

import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { createDemo } from './model.ts';
const demo=await createDemo();
try{
 const claimed=await demo.action('claim',{request_id:'accept',expected_version:1});
 const replay=await demo.action('claim',{request_id:'accept',expected_version:1});
 assert.deepEqual(replay,claimed);
 await demo.action('progress',{request_id:'progress',expected_version:2});
 const waiting=await demo.action('wait',{request_id:'review',expected_version:2});
 assert.equal(waiting.task.status,'waiting');
 await assert.rejects(demo.action('stale',{request_id:'stale',expected_version:1}), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'VERSION_CONFLICT');
 const done=await demo.action('complete',{request_id:'complete',expected_version:3,summary:'キーボード操作・重複送信・古いversionの拒否を確認した（合成デモ）。'});
 assert.equal(done.task.status,'done');assert.equal(done.events.length,4);
 mkdirSync('output',{recursive:true});writeFileSync('output/scenario.json',JSON.stringify(done,null,2)+'\n');
 console.log('PASS: 受諾 → 進捗 → レビュー待ち → 根拠付き完了。重複送信・競合拒否も確認。');
}finally{demo.close();}

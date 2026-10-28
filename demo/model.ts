import { SQLiteD1 } from '../tests/v1-d1-helper.ts';
import { Repository } from '../src/v1/storage/d1/index.ts';
import { TaskService, DomainError } from '../src/v1/tasks/index.ts';

export async function createDemo() {
 const db=new SQLiteD1(true);
 const service=new TaskService(new Repository(db),{agentWorkEnabled:true});
 const actor={kind:'oauth_client' as const,id:'demo-owner',client_id:'demo-agent'};
 const owner='demo-owner';
 const task=await service.create(owner,actor,{request_id:'seed',task:{title:'公開デモのキーボード操作を検証する',executor_kind:'agent',assigned_agent:'demo-agent',project_key:'Portfolio',priority:'high',notes:'操作手順と確認結果を記録し、人が完了根拠を追えるようにする。'}});
 const state=async()=>({task:await service.get(owner,{id:task.id}),progress:(await service.listProgress(owner,{id:task.id})).items,events:db.sqlite.prepare('SELECT type,task_version,actor,created_at FROM v1_task_events ORDER BY rowid').all()});
 async function action(name:string,input:{request_id:string;expected_version:number;summary?:string}){
  const base={id:task.id,request_id:input.request_id,expected_version:input.expected_version};
  if(name==='claim')await service.claim(owner,actor,{...base,assigned_agent:'demo-agent'});
  else if(name==='progress')await service.logProgress(owner,actor,{id:task.id,request_id:input.request_id,summary:input.summary||'Tabで移動し、Enterで詳細を開けることを確認。'});
  else if(name==='wait')await service.setWaiting(owner,actor,{...base,waiting_kind:'human',waiting_on_ref:'demo-reviewer',blocker_summary:'検証結果のレビュー待ち',next_check_by:'demo-agent',next_check_at:'2035-04-10T09:00:00Z'});
  else if(name==='complete')await service.complete(owner,actor,{...base,evidence:{kind:'test',summary:input.summary||''}});
  else if(name==='stale')await service.update(owner,actor,{...base,expected_version:1,patch:{title:'この更新は拒否されるはず'}});
  else throw new DomainError('VALIDATION_FAILED','Unknown demo action');
  return state();
 }
 return {db,state,action,close:()=>db.sqlite.close()};
}

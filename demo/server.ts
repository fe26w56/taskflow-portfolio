import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createDemo } from './model.ts';
import { DomainError } from '../src/v1/tasks/index.ts';
let demo=await createDemo();
const page=readFileSync(new URL('./index.html',import.meta.url));
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 try{
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method==='GET'&&req.url==='/state'){res.end(JSON.stringify(await demo.state()));return;}
  if(req.method!=='POST'||req.url!=='/action'){res.writeHead(404);res.end('{}');return;}
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){res.writeHead(403);res.end('{}');return;}
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192){res.writeHead(413);res.end('{}');return;}}
  const {action,...input}=JSON.parse(raw);
  if(action==='reset'){demo.close();demo=await createDemo();res.end(JSON.stringify(await demo.state()));return;}
  res.end(JSON.stringify(await demo.action(action,input)));
 }catch(e){res.writeHead(e instanceof DomainError?409:400);res.end(JSON.stringify({error:e instanceof DomainError?e.code:'INVALID_REQUEST',message:e instanceof Error?e.message:'Invalid request'}));}
});
server.listen(4174,'127.0.0.1',()=>console.log('TaskFlow demo: http://127.0.0.1:4174'));

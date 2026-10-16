import {mkdtempSync,mkdirSync,copyFileSync,existsSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {withTerminalSmoke,SmokeSetupError} from "./terminal-smoke-fixture.ts";
import {createPendingInputCheck} from "./pending-input-regression.ts";
import {workspaceClose} from "../server/herdr/client.ts";
const evidence=process.env.CHECK_BROWSER_EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
try { await withTerminalSmoke(async({browser,origin})=>{
  const root=mkdtempSync("/tmp/pending-input-smoke-"),workspaces:string[]=[];
  const context=await browser.newContext({viewport:{width:1280,height:800}});await context.addInitScript(()=>localStorage.setItem("herdr-web-ui:settings",JSON.stringify({language:"en"})));
  const page=await context.newPage();const pending=createPendingInputCheck(page,evidence);
  await page.routeWebSocket(/\/ws(?:\?|$)/,socket=>{const upstream=socket.connectToServer();upstream.onMessage(raw=>{if(!pending.forwardSnapshot(socket,raw))socket.send(raw);});});
  try {await page.goto(origin);await page.locator(".conn-live").waitFor();await pending.run(root,workspaces);}
  finally {pending.release();if(evidence){if(existsSync(join(root,"pending-input.jsonl")))copyFileSync(join(root,"pending-input.jsonl"),join(evidence,"focused-pty.jsonl"));writeFileSync(join(evidence,"focused-dom.html"),await page.content());await page.screenshot({path:join(evidence,"focused.png")});}try{await context.close();}finally{try{await Promise.all(workspaces.map(id=>workspaceClose(id)));}finally{rmSync(root,{recursive:true,force:true});}}}
}); } catch(error) {console.error(error);process.exitCode=error instanceof SmokeSetupError?2:1;}

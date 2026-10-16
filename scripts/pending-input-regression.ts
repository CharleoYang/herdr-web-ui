import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, WebSocket, WebSocketRoute } from "playwright-core";
import { herdrRpc, workspaceCreate } from "../server/herdr/client.ts";
type Message = { type: string; pane_id?: string; text?: string; delivery?: string; id?: number; ok?: boolean; pending?: { text: string; state: string; request_id: number } };
type Frame = { at: number; socket: number; phase: string; direction: string; message: Message };
type Target = { pane: string; socket: number; text: string };
const NO_SEND_WAIT_MS = 400;
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
// User intent opens this window, not reconnect: no user message exists during terminal initialization.
// Unknown input to this pane is fail-closed; unrelated panes are allowed unless they carry this message.
function assertSnapshot(frames: readonly Frame[], target: Target, released: boolean): void {
  const sent = frames.filter(({direction,message:m}) => direction === "sent" && (m.type === "input" || m.type === "submit") && (m.pane_id === target.pane || m.text?.includes(target.text)));
  assert.equal(sent.length, released ? 1 : 0, "exactly one user submission, only after capability release");
  if (!released) return;
  const frame = sent[0]!; const message = frame.message;
  assert.equal(frame.phase, "released", "no early legacy input or submit");
  assert.equal(frame.socket, target.socket, "current socket owns the submission");
  assert.equal(message.type, "submit", "queueing never uses legacy input");
  assert.equal(message.pane_id, target.pane); assert.equal(message.text, target.text); assert.equal(message.delivery, "queue");
  const accepted = frames.filter(f => f.direction === "received" && f.socket === target.socket && f.message.type === "submit-result" && f.message.id === message.id);
  assert.equal(accepted.length, 1, "one authoritative bridge result");
  const ack = accepted[0]!.message;
  assert.equal(ack.pane_id, target.pane); assert.equal(ack.ok, true);
  assert.equal(ack.pending?.text, target.text); assert.equal(ack.pending?.state, "queued"); assert.equal(ack.pending?.request_id, message.id);
}
function counterexamples(frames: readonly Frame[], target: Target): void {
  const index = frames.findIndex(f => f.direction === "sent" && f.message.type === "submit" && f.message.text === target.text);
  assert.ok(index >= 0); const original = frames[index]!;
  const replace = (patch: Partial<Frame>, message: Partial<Message> = {}) => frames.map((f,i) => i === index ? {...f,...patch,message:{...f.message,...message}} : f);
  const bad: Array<[string, readonly Frame[]]> = [
    ["early legacy input",replace({phase:"intent"},{type:"input",text:target.text+"\r"})],
    ["early submit",replace({phase:"intent"})],
    ["duplicate",[...frames,original]], ["missing",frames.filter((_,i)=>i!==index)],
    ["wrong socket",replace({socket:target.socket+1})], ["wrong pane",replace({},{pane_id:"foreign-pane"})],
    ["wrong text",replace({},{text:"a different user message"})], ["immediate delivery",replace({},{delivery:"immediate"})],
    ["missing acknowledgement",frames.filter(f=>!(f.direction==="received"&&f.message.type==="submit-result"))],
    ["rejected acknowledgement",frames.map(f=>f.message.type==="submit-result"?{...f,message:{...f.message,ok:false}}:f)],
  ];
  for (const [label, mutant] of bad) { assert.throws(()=>assertSnapshot(mutant,target,true),undefined,label); console.log("PASS negative "+label); }
  assertSnapshot([...frames,{...original,message:{type:"input",pane_id:"unrelated-pane",text:"unrelated terminal data"}}],target,true);
  console.log("PASS unrelated consumer input does not reject the target message");
}
/** Owns the pending scene and its transport observation; both browser runners use this implementation. */
export function createPendingInputCheck(page: Page, evidenceDirectory?: string) {
  const frames: Frame[] = [], sockets: WebSocket[] = [], routes: WebSocketRoute[] = [];
  const inputs: Array<{type:"input"|"submit";pane_id:string;text:string;delivery?:"immediate"|"queue";stop?:true}> = [];
  const pendingActions: Array<{pane_id:string;pending_id:string;action:string}> = [];
  const inputStates = new Map<string,{ready:boolean;at:number;socket:WebSocket}>();
  let phase="setup",holdSnapshot=false,releaseSnapshot:(()=>void)|null=null;
  const record=(direction:string,socket:number,message:Message)=>{ const frame={at:Date.now(),phase,direction,socket,message}; frames.push(frame); if(evidenceDirectory) appendFileSync(join(evidenceDirectory,"focused-frames.jsonl"),JSON.stringify(frame)+"\n"); };
  const pendingReady=(pane:string)=>until(()=>{const s=inputStates.get(pane);return s?.ready===true&&s.socket===sockets.at(-1)&&!s.socket.isClosed()&&Date.now()-s.at>=500;},"stable pending attachment of "+pane);
  page.on("websocket",socket=>{sockets.push(socket);const generation=sockets.length;
    socket.on("framereceived",({payload})=>{const m=JSON.parse(String(payload));record("received",generation,m);if(m.type==="input-ready")inputStates.set(m.pane_id,{ready:m.ready!==false,at:Date.now(),socket});});
    socket.on("framesent",({payload})=>{const m=JSON.parse(String(payload));record("sent",generation,m);if(m.type==="input"||m.type==="submit")inputs.push(m);if(m.type==="pending-action")pendingActions.push(m);if(m.type==="attach"||m.type==="detach")inputStates.set(m.pane_id,{ready:false,at:Date.now(),socket});});
  });
  return {
    forwardSnapshot(socket:WebSocketRoute,raw:string|Buffer):boolean {
      if(!routes.includes(socket))routes.push(socket);const message=JSON.parse(String(raw));record("upstream",routes.indexOf(socket)+1,message);
      if(!holdSnapshot||message.type!=="snapshot")return false;
      holdSnapshot=false;releaseSnapshot=()=>{phase="released";record("release",routes.indexOf(socket)+1,message);socket.send(raw);releaseSnapshot=null;};return true;
    },
    async run(root:string,workspaces:string[]) {
      const routed=routes;
      const composer=page.getByRole("textbox",{name:"Message",exact:true});
  // The pending protocol has a real foreground agent and an owned byte recorder: merely
  // reporting an idle shell as working would not prove that server-side queueing happened.
  const pendingCwd = join(root, "pending"); mkdirSync(pendingCwd);
  const pendingWorkspace = await workspaceCreate({ cwd: pendingCwd, label: "herdr-web-ui-test-browser-pending" });
  workspaces.push(pendingWorkspace.workspace.workspace_id);
  const pendingPane = pendingWorkspace.root_pane.pane_id;
  const pendingProgram = join(root, "claude"); copyFileSync(process.execPath, pendingProgram); chmodSync(pendingProgram, 0o755);
  const pendingLog = join(root, "pending-input.jsonl");
  const pendingScreen = join(root, "pending-screen.txt"); writeFileSync(pendingScreen, "");
  const pendingScript = join(root, "pending-agent.cjs");
  writeFileSync(pendingScript, `const fs=require("node:fs");const log=process.argv[2],screen=process.argv[3];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(log,""));process.stdin.on("data",c=>{if(c.includes(3))process.exit(0);fs.appendFileSync(log,JSON.stringify(c.toString("utf8"))+"\\n");});let shown="";setInterval(()=>{const next=fs.readFileSync(screen,"utf8");if(next!==shown){shown=next;process.stdout.write("\\x1b[2J\\x1b[H"+next);}},20);`);
  await herdrRpc("pane.send_text", { pane_id: pendingPane, text: `'${pendingProgram}' '${pendingScript}' '${pendingLog}' '${pendingScreen}'\n` });
  await until(() => existsSync(pendingLog), "pending byte recorder started");
  const pendingBytes = () => readFileSync(pendingLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  const reportPending = (state: string) => herdrRpc("pane.report_agent", { pane_id: pendingPane, source: "manual", agent: "claude", state });
  await reportPending("working");
  await page.locator(`.pane-select[title^="${pendingPane} —"]`).click();
  await page.getByRole("group", { name: "Pane view", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await until(async () => await page.locator(".composer-agent-label").innerText() === "Claude", "foreground agent identity reached the composer");
  await pendingReady(pendingPane);
  const pendingRows = page.locator(".pending-messages .pending-message");
  const queuedTexts = ["first pending browser message", "# second pending message", "# third pending message"];
  for (const [index, text] of queuedTexts.entries()) {
    await composer.fill(text);
    assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0, "typing replaces Stop with Send");
    assert.equal(await page.getByRole("button", { name: "Queue message", exact: true }).count(), 0, "there is no separate Queue control");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await pendingRows.count() === index + 1 && await composer.inputValue() === "", "server accepted pending input");
    assert.equal(inputs.at(-1)?.pane_id, pendingPane);
    assert.equal(inputs.at(-1)?.delivery, "queue");
  }
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts);
  assert.equal(pendingBytes(), "", "accepted pending messages have not reached the pty");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 1, "empty working composer returns to Stop");
  assert.equal(await page.locator(".composer-action").count(), 1, "one primary action");
  const actionsBeforeTextClick = pendingActions.length;
  await pendingRows.locator(".pending-message-bubble").first().click();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingActions.length, actionsBeforeTextClick, "pending message text is selectable, not a send action");
  assert.equal(pendingBytes(), "");
  await reportPending("blocked"); await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), "", "blocked status never advances pending input");
  assert.equal(await pendingRows.count(), 3);
  await reportPending("working"); await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingRows.first().getByRole("button", { name: /^Send now:/ }).press("Enter");
  await until(async () => await pendingRows.count() === 2 && pendingBytes().endsWith("\r"), "explicit Send now delivered one item");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`);
  assert.equal(pendingActions.at(-1)?.pane_id, pendingPane);
  assert.equal(await pendingRows.first().getByRole("button", { name: /^Send now:/ }).evaluate((button) => button === document.activeElement), true, "a removed keyboard action hands focus to the next pending action");
  // a draft puts Send where Stop was: Escape in the box is still Stop, once a completion is put away, and keeps the draft
  await composer.fill("/he");
  await composer.press("Escape");
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`, "the first Escape on a command being completed only puts the completion away");
  await composer.fill("a draft while the agent works");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0);
  await composer.press("Escape");
  await until(() => pendingBytes() === `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "Escape with a draft stops the working agent");
  assert.deepEqual(inputs.at(-1), { type: "input", pane_id: pendingPane, text: "\u001b", stop: true }, "the composer's Stop goes out as a Stop");
  assert.equal(await composer.inputValue(), "a draft while the agent works", "Escape leaves the draft in the box");
  await composer.fill("");
  // a follow-up sent between a reconnect and its snapshot is the new connection's own row, not an unconfirmed copy
  phase = "reconnect";
  const socketsBeforeReconnect = sockets.length;
  holdSnapshot = true;
  await routed.at(-1)!.close();
  await until(() => releaseSnapshot !== null, "the reconnect's snapshot was held back");
  // the server can send its snapshot before the page has even sent its attach: the pane is
  // ready only once the new connection says so, not by the closed one's last word
  await until(() => sockets.length > socketsBeforeReconnect, "the page opened its new connection");
  await pendingReady(pendingPane);
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "the lost connection's rows are no longer its own");
  const target = {pane: pendingPane, socket: sockets.length, text: "sent before the snapshot"};
  const windowStart = frames.length; const bytesBeforeIntent = pendingBytes(); phase = "intent";
  const intentAt = Date.now();
  await composer.fill(target.text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.ok(Date.now()-intentAt < 2000, "release within the existing snapshot grace");
  assertSnapshot(frames.slice(windowStart), target, false);
  assert.equal(pendingBytes(), bytesBeforeIntent, "no premature PTY delivery");
  releaseSnapshot!();
  await until(async () => await page.locator('.pending-message[data-state="queued"]').count() === 1, "the message sent before the snapshot is a live pending row");
  await until(() => frames.some(f => f.direction === "received" && f.socket === target.socket && f.message.type === "submit-result" && f.message.pending?.text === target.text), "bridge accepted the exact queued follow-up");
  const actualWindow = frames.slice(windowStart);
  assertSnapshot(actualWindow, target, true);
  assert.equal(pendingBytes(), bytesBeforeIntent, "a queued acceptance never reaches the PTY");
  counterexamples(actualWindow,target);
  assert.equal(await page.locator(".composer-note").count(), 0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await until(async () => await pendingRows.count() === 2, "the live row was discarded on the bridge");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`);
  await page.reload(); await page.locator(".conn-live").waitFor();
  await until(async () => await pendingRows.count() === 2, "saved pending copies restored");
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts.slice(1));
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "reload removes connection proof");
  assert.equal(await page.locator(".pending-message-send").count(), 0, "unknown delivery cannot be resent");
  await reportPending("idle"); await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS);
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "reload and readiness never replay saved pending input");
  for (let left = 2; left > 0; left--) { await page.getByRole("button", { name: "Discard saved copy", exact: true }).first().click(); await until(async () => await pendingRows.count() === left - 1, "discard saved copy"); }
  console.log("PASS Send queues server-owned input, explicit Send now delivers once, and reload/readiness never replay uncertain copies");
      return {pendingPane,pendingRows,pendingBytes,reportPending,pendingScreen};
    },
    release() { releaseSnapshot?.(); },
  };
}

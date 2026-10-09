import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlDecoder, RpcPeer } from "../extensions/rpc.ts";

test("strict JSONL preserves split UTF-8, CRLF and Unicode line separators", () => {
  const values: unknown[] = []; const decoder = new JsonlDecoder(v => values.push(v));
  const wire = Buffer.from(JSON.stringify({ text: "中文\u2028next\u2029喵" }) + "\r\n");
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  decoder.finish(); expect(values).toEqual([{ text: "中文\u2028next\u2029喵" }]);
  expect(() => new JsonlDecoder(() => {}).push(Buffer.from("broken\n"))).toThrow();
  const incomplete = new JsonlDecoder(() => {}); incomplete.push(Buffer.from('{"x":'));
  expect(() => incomplete.finish()).toThrow();
  expect(() => new JsonlDecoder(() => {}, 4).push(Buffer.from("12345"))).toThrow();
});

test("missing Bun executable rejects and cleans up, rather than waiting forever for exit", async () => {
  const peer = new RpcPeer({ executable: "/does/not/exist/pi-sidekick-bun", cliPath: "unused", cwd: tmpdir(), args: [] });
  const result = await Promise.race([peer.start().then(() => "started", error => String(error)), new Promise<string>(resolve => setTimeout(() => resolve("hung"), 500))]);
  expect(result).not.toBe("hung"); expect(result).toContain("RPC process failed"); await peer.stop();
  await expect(peer.start()).rejects.toThrow("single-use");
});

test("RPC handled/rejected/early-exit/invalid stream/timeout do not hang run waiters", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sidekick-rpc-"));
  const script = join(root, "fake.ts");
  await writeFile(script, `let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const c=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');if(c.type==='get_state')send({type:'response',id:c.id,command:c.type,success:true,data:{sessionId:'test',isStreaming:false}});else if(c.message==='EXIT')process.exit(7);else if(c.message==='MALFORMED')process.stdout.write('not json\\n');else if(c.message==='HANG'){}else send({type:'response',id:c.id,command:c.type,success:c.message!=='REJECT',data:{disposition:'handled'},error:'rejected prompt'});}});process.stdin.on('end',()=>process.exit(0));`);
  try {
    for (const message of ["HANDLED", "REJECT", "EXIT", "MALFORMED", "HANG"]) {
      const peer = new RpcPeer({ executable: process.execPath, cliPath: script, cwd: root, args: [], requestTimeoutMs: 300 });
      try { await peer.start(); await expect(peer.run(message, 400)).rejects.toThrow(); }
      finally { const pid = peer.pid!; await peer.stop(); expect(() => process.kill(pid, 0)).toThrow(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);

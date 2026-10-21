import assert from "node:assert/strict";
import { test } from "node:test";

import { Lanes } from "../src/lanes.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("Lane：同聊天串行——进行中的第二次调用不排队、直接返回未开工", async () => {
  const lanes = new Lanes();
  const gate = deferred<void>();
  const first = lanes.run("oc_1", async () => {
    await gate.promise;
    return "first";
  });
  assert.equal(lanes.isBusy("oc_1"), true);

  const second = await lanes.run("oc_1", async () => "second");
  assert.deepEqual(second, { started: false });

  gate.resolve();
  assert.deepEqual(await first, { started: true, value: "first" });
  assert.equal(lanes.isBusy("oc_1"), false);
});

test("Lane：跨聊天互不阻塞", async () => {
  const lanes = new Lanes();
  const gateA = deferred<void>();
  const order: string[] = [];

  const a = lanes.run("oc_a", async () => {
    await gateA.promise;
    order.push("a");
  });
  const b = await lanes.run("oc_b", async () => {
    order.push("b");
  });
  assert.deepEqual(b, { started: true, value: undefined });
  gateA.resolve();
  await a;
  assert.deepEqual(order, ["b", "a"]);
  assert.deepEqual(lanes.busyChats, []);
});

test("Lane：任务抛错也会释放 Lane", async () => {
  const lanes = new Lanes();
  await assert.rejects(() =>
    lanes.run("oc_1", async () => {
      throw new Error("boom");
    }),
  );
  assert.equal(lanes.isBusy("oc_1"), false);
  const retry = await lanes.run("oc_1", async () => "ok");
  assert.deepEqual(retry, { started: true, value: "ok" });
});

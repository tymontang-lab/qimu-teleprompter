import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the QIMU application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /QIMU Teleprompter/);
  assert.match(html, /极简提词录像/);
  assert.match(html, /进入提词模式/);
  assert.match(html, /manifest\.json/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("ships the local-first PWA resources", async () => {
  const [manifestText, serviceWorker, page] = await Promise.all([
    readFile(new URL("public/manifest.json", root), "utf8"),
    readFile(new URL("public/service-worker.js", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.name, "QIMU Teleprompter");
  assert.equal(manifest.short_name, "QIMU");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait-primary");
  assert.match(serviceWorker, /qimu-v1/);
  assert.match(page, /getUserMedia/);
  assert.match(page, /MediaRecorder/);
  assert.match(page, /recorder\.start\(1000\)/);
  assert.match(page, /3, 2, 1/);
  assert.match(page, /不会出现在最终录像中/);
});

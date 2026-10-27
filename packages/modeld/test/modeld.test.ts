import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-modeld-"));
process.env.STATE_DIR = dir;
process.env.PHOSPHORUS_INI_FILE = join(dir, "phosphorus.ini");
const url = "https://huggingface.co/org/repo/blob/main/q4.gguf";
writeFileSync(process.env.PHOSPHORUS_INI_FILE, `[model]\nurl = ${url}\nctx = 8192.7\nslots = 2.9\nhost = true\ngpu = false\n`);
const { deviceRe, gpuLostRe, modelLink, readConfig } = await import("@phosphorus/modeld");
// util's ini file is fixed on its first import, another test's in a whole run
const iniTaken = readConfig().raw === url;

// torus's llama-server, 2026-10-26: Vulkan's device lost, then every decode failing
test("gpu lost", () => {
  for (const l of [
    "E srv  update_slots: decode() failed: vk::CommandBuffer::end: ErrorDeviceLost",
    "E srv    send_error: task id = 6, error: decode() failed: vk::CommandBuffer::end: ErrorUnknown",
  ])
    expect(gpuLostRe.test(l)).toBe(true);
  for (const l of [
    "E srv  update_slots: decode() failed: Invalid input batch.",
    "W srv  llama_server: security: no API key is set and CORS allows all origins",
    "ggml_vulkan: Found 1 Vulkan devices:",
  ])
    expect(gpuLostRe.test(l)).toBe(false);
});

test("model link", () => {
  expect(modelLink("https://huggingface.co/org/repo/blob/main/q4.gguf")).toEqual({ url: "https://huggingface.co/org/repo/resolve/main/q4.gguf", file: "q4.gguf" });
  expect(modelLink("https://x.example/m/a%20b.gguf?download=1")).toEqual({ url: "https://x.example/m/a%20b.gguf?download=1", file: "a b.gguf" });
  for (const raw of ["http://x.example/a.gguf", "https://x.example/a.safetensors", "https://x.example/", "not a url", ""]) expect(modelLink(raw)).toBeUndefined();
});

test("devices", () => {
  const out = "Available devices:\n  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15600 MiB free)\n  Vulkan1: Intel UHD (1024 MiB, 900 MiB free)\n";
  expect([...out.matchAll(deviceRe)].map((m) => [m[1], m[3]])).toEqual([
    ["Vulkan0", "15600"],
    ["Vulkan1", "900"],
  ]);
});

// ctx truncated, slots floored, the blob page taken as its file
test.skipIf(!iniTaken)("config", () => {
  expect(readConfig()).toEqual({
    raw: url,
    url: "https://huggingface.co/org/repo/resolve/main/q4.gguf",
    file: "q4.gguf",
    ctx: 8192,
    slots: 2,
    host: true,
    gpu: false,
  });
});

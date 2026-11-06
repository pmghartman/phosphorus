import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNvidia, nvidiaGpus } from "@phosphorus/util";

const tmp = mkdtempSync(join(tmpdir(), "stats-"));
process.env.STATE_DIR = tmp;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const data = (f: string) => readFileSync(join(import.meta.dir, "testdata", f), "utf8");
const linux = await import("../src/linux.ts");
const darwin = await import("../src/darwin.ts");
const win32 = await import("../src/win32.ts");
const stats = await import("@phosphorus/stats");

// --- linux: /proc --------------------------------------------------------------

test("linux cpu times", () => {
  const cpu = linux.cpuTimes(data("proc/stat"));
  const lines = data("proc/stat")
    .split("\n")
    .filter((l) => l.startsWith("cpu"));
  expect(cpu.length).toBe(lines.length);
  const f = lines[0]!.trim().split(/\s+/).slice(1).map(Number);
  expect(cpu[0]).toEqual({ idle: f[3]! + f[4]!, total: f.slice(0, 8).reduce((a, b) => a + b, 0) });
  for (const c of cpu) expect(c.idle).toBeLessThanOrEqual(c.total);
  expect(linux.cpuTimes("")).toEqual([]);
  // intr lines stop the scan
  expect(linux.cpuTimes("cpu  1 2 3 4 5 6 7 8 9 10\nintr 5\ncpu0 1 1 1 1 1 1 1 1")).toEqual([{ idle: 9, total: 36 }]);
});

test("linux meminfo", () => {
  const m = linux.memInfo(data("proc/meminfo"));
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(data("proc/meminfo"))![1]) * 1024;
  expect(m).toEqual({
    total: kb("MemTotal"),
    used: kb("MemTotal") - kb("MemAvailable"),
    avail: kb("MemAvailable"),
    cached: kb("Cached") + kb("Buffers"),
    swapTotal: kb("SwapTotal"),
    swapUsed: kb("SwapTotal") - kb("SwapFree"),
  });
  // MemFree stands in for MemAvailable on an old kernel
  expect(linux.memInfo("MemTotal:  100 kB\nMemFree:  40 kB\n").avail).toBe(40 * 1024);
});

test("linux net dev", () => {
  const n = linux.netBytes(data("proc/net-dev"));
  expect(n.bytes.lo).toBeUndefined();
  expect(n.order.length).toBeGreaterThan(0);
  for (const name of n.order) expect(n.bytes[name]!.rx).toBeGreaterThanOrEqual(0);
  const sample =
    "Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n" +
    "    lo: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0\n  eth0: 100 2 0 0 0 0 0 0 200 3 0 0 0 0 0 0\ndocker0: 5 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0\n";
  expect(linux.netBytes(sample)).toEqual({ bytes: { eth0: { rx: 100, tx: 200 } }, order: ["eth0"] });
});

test("linux diskstats", () => {
  const [r, w] = linux.diskBytes(data("proc/diskstats"));
  expect(r).toBeGreaterThanOrEqual(0);
  expect(w).toBeGreaterThanOrEqual(0);
  // whole disks only, sectors of 512: partitions and loops don't double count
  const s =
    " 259 0 nvme0n1 10 0 1000 0 20 0 2000 0 0 0 0\n 259 1 nvme0n1p1 10 0 1000 0 20 0 2000 0 0 0 0\n" +
    " 7 0 loop0 1 0 8 0 1 0 8 0 0 0 0\n 8 0 sda 1 0 16 0 1 0 32 0 0 0 0\n";
  expect(linux.diskBytes(s)).toEqual([(1000 + 16) * 512, (2000 + 32) * 512]);
});

test("linux mountinfo", () => {
  const ms = linux.diskMounts(data("proc/mountinfo"));
  for (const m of ms) expect(m.dir.startsWith("/")).toBe(true);
  const s =
    "23 28 0:22 / /proc rw,relatime - proc proc rw\n" +
    "36 28 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n" +
    "40 28 8:2 / /mnt/my\\040disk rw - xfs /dev/sda2 rw\n" +
    "41 28 0:40 / /run/user/1000 rw - tmpfs tmpfs rw\n" +
    "42 28 0:50 /sub /data rw shared:5 - btrfs /dev/sdb rw\n";
  expect(linux.diskMounts(s)).toEqual([
    { dir: "/", dev: "8:1" },
    { dir: "/mnt/my disk", dev: "8:2" },
    { dir: "/data", dev: "0:50" },
  ]);
});

test.skipIf(process.platform !== "linux")("linux disk sums real filesystems", () => {
  const d = linux.disk();
  expect(d.count).toBeGreaterThan(0);
  expect(d.total).toBeGreaterThan(d.used);
  // the same device mounted twice counts once
  const one = linux.disk([
    { dir: "/", dev: "x" },
    { dir: "/", dev: "y" },
  ]);
  expect(one.count).toBe(1);
});

test("linux load, uptime, cpu model, amd clock", () => {
  expect(linux.loadAvg("0.52 0.58 0.59 1/1086 12345\n")).toEqual([0.52, 0.58, 0.59]);
  expect(linux.loadAvg("")).toEqual([null, null, null]);
  expect(linux.uptimeSecs("12345.67 98765.43\n")).toBe(12345.67);
  expect(linux.uptimeSecs("")).toBe(0);
  expect(linux.cpuModel("processor\t: 0\nmodel name\t: AMD Ryzen 9 5950X 16-Core Processor\n")).toBe(
    "AMD Ryzen 9 5950X 16-Core Processor",
  );
  expect(linux.amdClock(data("amd-sclk.txt"))).toEqual([1000, 2200]);
  expect(linux.amdClock("")).toEqual([null, null]);
});

// --- NVML ---------------------------------------------------------------------

// whatever gpus this machine has, none where there's no nvidia driver
test("nvidia gpus through NVML", () => {
  const g = nvidiaGpus();
  expect(hasNvidia()).toBe(g.length > 0);
  for (const x of g) {
    expect(x.name).toBe(x.name.toLowerCase());
    expect(x.memTotal).toBeGreaterThan(0);
    expect(x.memUsed).toBeLessThanOrEqual(x.memTotal);
    for (const v of [x.temp, x.mhz, x.mhzMax]) expect(v === null || v > 0).toBe(true);
  }
});

// --- darwin: commands -------------------------------------------------------

test("darwin memory", () => {
  const page = 16384;
  const m = darwin.memInfo(data("darwin/vm_stat.txt"), data("darwin/swapusage.txt"), 17179869184);
  expect(m).toEqual({
    total: 17179869184,
    avail: (31250 + 250000) * page,
    used: 17179869184 - (31250 + 250000) * page,
    cached: 250000 * page,
    swapTotal: 3072 * (1 << 20),
    swapUsed: 1536.5 * (1 << 20),
  });
  expect(darwin.memInfo("", "", 100)).toEqual({
    total: 100,
    used: 100,
    avail: 0,
    cached: 0,
    swapTotal: 0,
    swapUsed: 0,
  });
});

test("darwin netstat links", () => {
  const n = darwin.netBytes(data("darwin/netstat.txt"));
  // loopback, awdl and anpi left out, idle links too, each interface once
  expect(n.order).toEqual(["en0", "en5", "utun3"]);
  expect(n.bytes.en0).toEqual({ rx: 1876543210, tx: 234567890 });
  expect(n.bytes.utun3).toEqual({ rx: 87654321, tx: 12345678 });
});

test("darwin disk bytes and volumes", () => {
  expect(darwin.diskBytes(data("darwin/ioreg-disk.txt"))).toEqual([58467723776 + 1000, 34567891456 + 2000]);
  const d = darwin.disk(data("darwin/df.txt"));
  // the APFS container once (its volumes share total:free) with / and Data's used, the two other volumes
  expect(d.count).toBe(3);
  expect(d.total).toBe((971350180 + 1953125000 + 3906250000) * 1024);
  expect(d.used).toBe((10485760 + 520000000 + 976562500 + 1953125000) * 1024);
});

test("darwin boot time", () => {
  expect(darwin.bootTime(data("darwin/boottime.txt"))).toBe("1729000000");
});

// --- windows: powershell json -------------------------------------------------

test("windows poll", () => {
  const p = win32.parsePoll(JSON.parse(data("win32/poll.json")), 34359738368, 17179869184);
  expect(p.mem).toEqual({
    total: 34359738368,
    used: 17179869184,
    avail: 17179869184,
    cached: 734003200 + 4294967296,
    swapTotal: 4096 * (1 << 20),
    swapUsed: 512 * (1 << 20),
  });
  // vEthernet and an idle adapter left out
  expect(p.net).toEqual({
    bytes: { Ethernet: { rx: 123456789012, tx: 9876543210 }, "Bluetooth Network Connection": { rx: 4096, tx: 1024 } },
    order: ["Ethernet", "Bluetooth Network Connection"],
  });
  expect(p.io).toEqual([1000000250, 500000125]);
  // two volumes with the same total:free taken as one
  expect(p.disk).toEqual({
    total: 1023737835520 + 2000396746752,
    used: 1023737835520 - 512000000000 + 2000396746752 - 1000000000000,
    count: 2,
  });
  // a lone adapter comes back bare from ConvertTo-Json
  expect(win32.parsePoll({ net: { name: "Ethernet", rx: 1, tx: 2 } }, 10, 5).net.order).toEqual(["Ethernet"]);
  expect(win32.parsePoll(undefined, 10, 5).mem).toEqual({
    total: 10,
    used: 5,
    avail: 5,
    cached: 0,
    swapTotal: 0,
    swapUsed: 0,
  });
});

test("windows gpus", () => {
  const j = JSON.parse(data("win32/gpu.json"));
  // the stale entry, the APU and the software adapter dropped; no load before a second read
  const [g, eng] = win32.parseGpus(j);
  const card = { mhz: null, mhzMax: null, temp: null };
  expect(g).toEqual([
    {
      name: "nvidia geforce rtx 3080",
      util: null,
      memUsed: 3221225472,
      memTotal: 10737418240,
      ...card,
      vendor: "nvidia",
    },
    { name: "amd radeon rx 6600 xt", util: null, memUsed: 67108864, memTotal: 8589934592, ...card, vendor: "amd" },
  ]);
  // a second later: the busiest engine summed over processes, 30% and 10% on the 3d one
  const add = (u: string, by: number) => String(BigInt(u) + BigInt(by));
  const later = {
    ...j,
    engines: j.engines.map((e: any) => ({
      ...e,
      t: add(e.t, 10_000_000),
      u: add(
        e.u,
        e.n.startsWith("pid_1234")
          ? 3_000_000
          : e.n.startsWith("pid_5678_luid_0x00000000_0x0000CB9B_phys_0_eng_0")
            ? 1_000_000
            : e.n.includes("eng_3")
              ? 500_000
              : 0,
      ),
    })),
  };
  const [g2] = win32.parseGpus(later, eng);
  expect(g2.map((x) => [x.name, x.util])).toEqual([
    ["nvidia geforce rtx 3080", 40],
    ["amd radeon rx 6600 xt", 0],
  ]);
  // none listed by the classes: every vendor-known dedicated one, the newest of a name
  const [none] = win32.parseGpus({ adapters: j.adapters });
  expect(none.map((a) => [a.name, a.util, a.memUsed])).toEqual([
    ["nvidia geforce rtx 3080", null, null],
    ["amd radeon rx 6600 xt", null, null],
  ]);
  expect(win32.parseGpus(undefined)[0]).toEqual([]);
});

test("windows discrete", () => {
  expect(win32.discrete("amd", "AMD Radeon(TM) Graphics", 8195)).toBe(false);
  expect(win32.discrete("amd", "AMD Radeon 780M Graphics", 8195)).toBe(false);
  expect(win32.discrete("amd", "AMD Radeon RX 7900 XTX", 8195)).toBe(true);
  expect(win32.discrete("amd", "AMD Radeon(TM) Graphics", 0x10)).toBe(true);
  expect(win32.discrete("intel", "Intel(R) Arc(TM) Graphics", 8195)).toBe(false);
  expect(win32.discrete("intel", "Intel(R) Arc(TM) 140V GPU", 8195)).toBe(false);
  expect(win32.discrete("intel", "Intel(R) Arc(TM) B580 Graphics", 8195)).toBe(true);
  expect(win32.discrete("intel", "Intel(R) Iris(R) Xe Graphics", 8195)).toBe(false);
  expect(win32.discrete("nvidia", "NVIDIA GeForce RTX 4060 Laptop GPU", 0x20)).toBe(false);
  expect(win32.discrete("nvidia", "NVIDIA GeForce RTX 4060 Laptop GPU", 0x10)).toBe(true);
});

// --- the sampler ----------------------------------------------------------------

test.skipIf(process.platform !== "linux")(
  "init writes the day's baseline and samples flow while listened to",
  async () => {
    stats.hooks.self = () => ({ host: "box", platform: "linux", version: "t" });
    await stats.init();
    const nd = JSON.parse(readFileSync(join(tmp, "data", "net-day.json"), "utf8"));
    expect(Object.keys(nd)).toEqual(["boot", "last", "cpu", "buckets"]);
    expect(nd.boot).toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    expect(nd.buckets).toEqual([]);
    // a second init on the file: one bucket of what moved since
    await stats.init();
    expect(JSON.parse(readFileSync(join(tmp, "data", "net-day.json"), "utf8")).buckets.length).toBe(1);

    const got: any[] = [];
    const off = stats.listen((t) => got.push(JSON.parse(t)));
    for (let i = 0; i < 40 && got.length < 2; i++) await Bun.sleep(100);
    off();
    expect(got.length).toBeGreaterThanOrEqual(2);
    const s = got[0];
    expect(s.host).toBe("box");
    expect(typeof s.at).toBe("number");
    expect(s.cpu.cores.length).toBeGreaterThan(0);
    expect(typeof s.cpu.total).toBe("number");
    expect(s.cpu.load.length).toBe(3);
    expect(Object.keys(s.mem).sort()).toEqual(["avail", "cached", "swapTotal", "swapUsed", "total", "used"]);
    expect(Array.isArray(s.net)).toBe(true);
    expect(Object.keys(s.netDay).sort()).toEqual(["rx", "since", "tx"]);
    expect(s.netDay.since).toBeGreaterThan(0);
    expect(s.io).toEqual({ r: expect.any(Number), w: expect.any(Number) });
    expect(s.disk.count).toBeGreaterThan(0);
    expect(Array.isArray(s.gpus)).toBe(true);
    expect(s.uptime).toBeGreaterThan(0);
    expect(Array.isArray(s.parts)).toBe(true);
    expect(s.own).toMatchObject({ cpu: expect.any(Number), mem: expect.any(Number), pids: expect.any(Number) });
    expect(s.procs.count).toBeGreaterThan(0);
    expect(s.procs.top.length).toBeLessThanOrEqual(25);
    expect(s.procs.top[0]).toMatchObject({
      pid: expect.any(Number),
      name: expect.any(String),
      cpu: expect.any(Number),
      mem: expect.any(Number),
    });
    // the second sample, two seconds on, has per-process cpu figures and sorted rows
    const top = got[1].procs.top;
    for (let i = 1; i < top.length; i++)
      expect(top[i - 1].cpu > top[i].cpu || (top[i - 1].cpu === top[i].cpu && top[i - 1].mem >= top[i].mem)).toBe(true);
  },
);

test("day trend", () => {
  const H = 3600 * 1000;
  const M = 5 * 60 * 1000;
  const at = 100 * H + 12 * 60 * 1000;
  // a bucket every 5 minutes for a day and a bit: 10 bytes in and 1 out each, cpu i%,
  // disk and gpu unread in the oldest, as a file from before they were kept
  const b: [number, number, number, number | null, number | null, (number | null)?, (number | null)?][] = [];
  for (let i = 0; i < 300; i++) {
    const end = at - (299 - i) * M;
    b.push(i < 150 ? [end, 10, 1, i % 12, 50] : [end, 10, 1, i % 12, 50, 40, i % 2 ? null : 20]);
  }
  const t = stats.trendOf(b, at);
  // the last hour still filling: it ends at the next mark
  expect(t.at).toBe(101 * H);
  expect(t.step).toBe(H);
  expect(t.rx.length).toBe(24);
  // net the day ending at each hour: 288 buckets once a whole day is kept
  expect(t.rx.at(-2)).toBe(2880);
  expect(t.tx.at(-2)).toBe(288);
  // the oldest hour's day only as far back as the first bucket, 33 of them
  expect(t.rx[0]).toBe(330);
  // the filling hour's day: up to now, 279 buckets
  expect(t.rx.at(-1)).toBe(2790);
  // each hour its own: cpu 0 to 11 over it, averaged and its highest bucket
  expect(t.cpu.at(-2)).toBe(5.5);
  expect(t.cpuPeak.at(-2)).toBe(11);
  expect(t.mem.every((v) => v === 50)).toBe(true);
  expect(t.disk[0]).toBe(null);
  expect(t.disk.at(-1)).toBe(40);
  // a gpu unread in some buckets averaged over the ones it was read in
  expect(t.gpu.at(-2)).toBe(20);
  expect(t.gpuPeak[0]).toBe(null);
  // two buckets: the hours before them null
  const short = stats.trendOf(b.slice(-2), at);
  expect(short.rx.at(-1)).toBe(20);
  expect(short.cpu.slice(0, -1).every((v) => v === null)).toBe(true);
  expect(short.rx.slice(0, -1).every((v) => v === null)).toBe(true);
  expect(short.since).toBe(b.at(-2)![0] - M);
});

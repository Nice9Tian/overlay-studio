/**
 * 进程树小工具,给 smoke-*.mjs 共用。
 *
 * 为什么不用 tasklist 按映像名筛:机器上本来就有别的 node.exe(比如 Adobe Creative Cloud
 * 自带的那个)和一堆用户自己的 chrome.exe,连跑验收的这个脚本自己也是 node.exe。
 * 按名字数进程会把它们全算成「本次启动的残留」,得到假的失败结论。
 * 唯一靠得住的口径是父子关系:只认主程序 exe 的后代进程。
 */
import { execFileSync } from "node:child_process";

/** 全机进程表 → [{pid, ppid, name}] */
export function procList() {
  let out;
  try {
    out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.match(/^"(\d+)","(\d+)","(.*)"$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] });
  }
  return rows;
}

/** 按映像名找进程(不看父子) */
export function findByName(name, list = procList()) {
  const lower = name.toLowerCase();
  return list.filter((p) => p.name.toLowerCase() === lower);
}

/** roots 的所有后代(不含 roots 自己),广度优先 */
export function descendants(roots, list = procList()) {
  const byParent = new Map();
  for (const p of list) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const seen = new Set(roots);
  const queue = [...roots];
  const out = [];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/** pid 还活着吗 */
export function alive(pid, list = procList()) {
  return list.some((p) => p.pid === pid);
}

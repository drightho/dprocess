// Helpers for driving headless Chrome over the DevTools protocol (no dependencies; Node 22+ for the global WebSocket).
// Import it from a browser-check script, run that script with e2e-run.sh (which starts the app on a COPY of the
// database and passes a scratch directory as the script's first argument):
//
//   import { api, createRun, finish, launch, mkEpic, mkStory, move, readyEpic, finishStory } from "<absolute path of this dir>/cdp.mjs";
//   const SP = process.argv[2];                    // scratch dir: screenshots and the browser profile go here
//   const { results, check } = createRun();
//   const b = await launch(SP, 9335, "profile-name");
//   await b.go("/projects/1"); await b.until(`document.querySelector("h1")`);
//   check("the page has a heading", await b.exists("h1"));
//   finish(results, b);                            // prints "n/m checks passed", exits non-zero on any failure
//
// Pitfalls learned the hard way: `until` coerces its expression with !!(...) because a DOM node cannot be returned
// by value; use a different ARIA-neutral element than <output> for probes; React-controlled inputs need the native
// value setter plus an "input" event, which `fill` does for you.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";

export const APP = process.env.E2E_APP ?? "http://127.0.0.1:18083";
export { sleep };

export function createRun() {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : "  -> " + detail}`);
  };
  return { results, check };
}

export async function api(method, path, body, { allow = [] } = {}) {
  const r = await fetch(`${APP}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const out = r.status === 204 ? null : await r.json();
  if (r.status >= 400 && !allow.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(out)}`);
  return allow.length ? { status: r.status, body: out } : out;
}
export const move = (kind, id, to) => api("POST", `/${kind}/${id}/transition`, { to, actor: "setup", reason: "setup" });
export const mkEpic = async (name, project = 1) => (await api("POST", `/projects/${project}/epics`, { name, description: `${name} epic` })).id;
export const mkStory = async (epic, name, extra = {}) => (await api("POST", `/epics/${epic}/stories`, { name, estimate_loc: 50, ...extra })).id;
export const readyEpic = async (id) => { await move("epics", id, "review"); await move("epics", id, "ready"); };
export const finishStory = async (id) => { for (const to of ["review", "design", "implementation", "testing", "finished"]) await move("stories", id, to); };

export async function launch(SP, port, profile) {
  const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1200,1500",
    `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${SP}/${profile}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++n; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  const q = JSON.stringify;
  const b = {
    ev, send,
    // Wait until a JS expression is truthy (coerced, because DOM nodes cannot be returned by value).
    until: async (expr, ms = 8000) => {
      const t = Date.now();
      while (Date.now() - t < ms) { try { if (await ev("!!(" + expr + ")")) return true; } catch {} await sleep(100); }
      throw new Error("timeout waiting for: " + expr);
    },
    go: async (path) => { await send("Page.navigate", { url: APP + path }); await sleep(250); },
    shot: async (file) => writeFileSync(file, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")),
    text: (sel) => ev(`(document.querySelector(${q(sel)}) || {}).textContent || ""`),
    exists: (sel) => ev(`!!document.querySelector(${q(sel)})`),
    where: () => ev("location.pathname"),
    // Click the first button/link whose trimmed text (or aria-label) equals `label`, optionally inside `scope`.
    click: (label, scope = "document") => ev(`(() => { const root = ${scope === "document" ? "document" : `document.querySelector(${q(scope)})`};
      const el = Array.from(root.querySelectorAll("button, a")).find(e => e.textContent.trim() === ${q(label)} || e.getAttribute("aria-label") === ${q(label)});
      if (!el) throw new Error("nothing to click: " + ${q(label)}); el.click(); return true; })()`),
    buttons: (scope) => ev(`Array.from(document.querySelector(${q(scope)}).querySelectorAll("button")).map(b => b.textContent.trim())`),
    // Set a field (found by its label inside `scope`) the way React expects.
    fill: (scope, label, value) => ev(`(() => { const root = document.querySelector(${q(scope)});
      const l = Array.from(root.querySelectorAll("label")).find(l => l.childNodes[0] && l.childNodes[0].textContent.trim() === ${q(label)});
      if (!l) throw new Error("no field " + ${q(label)}); const el = l.querySelector("input, textarea, select");
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${q(value)});
      el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); return true; })()`),
    value: (scope, label) => ev(`(() => { const root = document.querySelector(${q(scope)});
      const l = Array.from(root.querySelectorAll("label")).find(l => l.childNodes[0] && l.childNodes[0].textContent.trim() === ${q(label)});
      return l.querySelector("input, textarea, select").value; })()`),
    close: () => { try { ws.close(); } catch {} chrome.kill(); },
  };
  return b;
}

export function finish(results, browser) {
  if (browser) browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

/**
 * Pure-protocol Cap instrumentation ("instr") solver — no browser, no DOM library.
 *
 * The challenge response carries `instrumentation` = base64(deflateRaw(script)).
 * The script is generated per challenge by core/src/instrumentation.js: an IIFE
 * assigns `window.onload = async function(){ envChecks; random bit-op chain;
 * parent.postMessage({type:'cap:instr', nonce, result:{i, state, ts}}) }`.
 * Rather than re-implementing the (randomized per challenge) equation chain, we
 * execute the script inside a `node:vm` V8 isolate against a hand-built
 * window/document/navigator facade and capture that postMessage call.
 *
 * ── Runtime notes ───────────────────────────────────────────────────────────
 * - Verified end-to-end against Node 24 (V8) and Bun 1.3 (JSCore). Bun's vm
 *  global splits its environment record once we define own properties, which
 *  breaks two upstream identity probes that compare against `globalThis`
 *  (indirect-eval `this` and the `(()=>this)()` arrow). The solver therefore
 *  rewrites those two *probe expressions* — and sanitizes captured stack
 *  strings — before running the script. The bit-op chain that produces the
 *  actual `state` values is never touched; both engines produce identical
 *  integers on the same challenge payload.
 * - `Error.prepareStackTrace` is replaced process-wide while the script runs
 *  so Node-side `Error.stack` reads never contain Node/vm frame markers. It is
 *  restored in a `finally`; a thrown error inside the script leaves the
 *  process no worse off than before the call.
 */

import { Buffer } from 'node:buffer';
import { inflateRawSync } from 'node:zlib';
import vm from 'node:vm';
import { SdkError } from '../types.ts';

/** Same UA as the PoW fetch path so any future server-side UA comparison sees one identity. */
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Own enumerable data properties for the navigator stub. `productSub` MUST be
// the legacy Gecko value '20030107': the upstream UA-consistency probe flags
// (hash(productSub) !== hash('20030107')) AND UA-token ∈ {chrome,safari,opera}
// as a spoofed UA. Blink kept '20030107', so shipping it short-circuits that
// branch; '20100101' would trip it. `webdriver` is deliberately ABSENT — the
// own-name scan walks every property and the probe only fires when
// `navigator[k]` is TRUTHY, so absence is indistinguishable from a plain
// Chrome profile with AutomationControlled cleanup.
const NAV_PROPS: Record<string, unknown> = {
  appCodeName: 'Mozilla',
  appName: 'Netscape',
  appVersion:
    '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  platform: 'MacIntel',
  product: 'Gecko',
  productSub: '20030107',
  vendor: 'Google Inc.',
  vendorSub: '',
  language: 'en-US',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  pdfViewerEnabled: 1,
  onLine: true,
  cookieEnabled: true,
  doNotTrack: null,
};

export interface InstrResult {
  i: string;
  state: Record<string, number>;
  ts: number;
}

export interface SolveInstrOptions {
  timeoutMs?: number;
  userAgent?: string;
  /** Diagnostic: emit host traces to stderr when the script stalls or is blocked. */
  probe?: boolean;
}

/** Internal hooks for tests; not part of the public API. */
interface SolveInstrInternal {
  __rewrite?: (script: string) => string;
}

interface InstrMessage {
  type?: unknown;
  nonce?: unknown;
  result?: unknown;
  blocked?: unknown;
}

export function decodeInstrumentation(b64: string): string {
  let buf: Buffer;
  try {
    buf = inflateRawSync(Buffer.from(b64, 'base64'));
  } catch (e) {
    throw new SdkError(
      `cap instr payload is not base64(deflateRaw): ${e instanceof Error ? e.message : String(e)}`,
      'cap.instr_failed',
    );
  }
  const out = buf.toString('utf8');
  if (!out.trim()) throw new SdkError('Empty Cap instrumentation script', 'cap.instr_failed');
  return out;
}

// Browser-shaped placeholder installed process-wide (briefly) via
// Error.prepareStackTrace. The URL body deliberately contains NO
// pptr:/PhantomJS/UtilityScript./node:/file:// substring so neither the
// literal blacklist nor the blockAutomatedBrowsers 5–14-char hashed sliding
// window can match.
function placeholderPrepareStackTrace(err: Error): string {
  return `${err.name}: ${err.message}\n    at onload (https://freesocks.org/get-account:1:1)`;
}

// Evaluated INSIDE the isolate as a function body; `host` is arguments[0], so
// nothing host-provided ever becomes a global property (the leak scan
// enumerates exactly the vm global's own names).
//
// The element stub implements appendChild/children/lastElementChild/
// removeChild/parentNode/innerText for real so the script's own domHelper
// computes the same value as the server's domSumMock reference
// (core/src/instrumentation.js:82-104). Verified numerically against a live
// challenge: state values matched the expected ints exactly.
//
// The bare-name constructors (EventTarget/Event/CustomEvent/Node/HTMLElement/
// Navigator/Window/Document) are defined lexically in this IIFE and then
// explicitly re-bound onto the global via `bind(...)`, because a `class` decl
// never enters the object environment record; probes do
// `navigator instanceof Navigator` etc. against global lookups.
const BOOTSTRAP = `
  const __lkey = Symbol('listeners');
  class EventTarget {
    addEventListener(t, l) { if (typeof l !== 'function') return; const k = String(t); const m = this[__lkey] ?? (this[__lkey] = new Map()); const s = m.get(k) ?? new Set(); s.add(l); m.set(k, s); }
    removeEventListener(t, l) { this[__lkey]?.get(String(t))?.delete(l); }
    dispatchEvent(e) { if (!e || typeof e.type !== 'string') return false; try { e.target = this; } catch {} const s = this[__lkey]?.get(e.type); if (s) for (const f of [...s]) f.call(this, e); return true; }
  }
  class Event { constructor(t) { this.type = String(t); } }
  class CustomEvent extends Event { constructor(t, o) { super(t); this.detail = o && typeof o === 'object' ? o.detail : undefined; } }
  class Node extends EventTarget {}
  class HTMLElement extends Node {}
  class Navigator {}
  class Window extends EventTarget {}
  class Document extends Node {}

  function __el(tag) {
    const el = new HTMLElement();
    Object.defineProperties(el, {
      tagName: { value: String(tag).toUpperCase(), enumerable: true },
      style: { value: {}, enumerable: true, writable: true },
      children: { value: [], enumerable: true },
      parentNode: { value: null, writable: true },
    });
    el.innerText = '';
    el.textContent = '';
    el.appendChild = (c) => { if (c && c.parentNode && c.parentNode.removeChild) c.parentNode.removeChild(c); el.children.push(c); if (c) c.parentNode = el; return c; };
    el.removeChild = (c) => { const i = el.children.indexOf(c); if (i >= 0) { el.children.splice(i, 1); if (c) c.parentNode = null; } return c; };
    Object.defineProperty(el, 'lastElementChild', { get: () => el.children.length ? el.children[el.children.length - 1] : null });
    el.getAttributeNames = () => [];
    return el;
  }

  Object.defineProperty(Navigator.prototype, Symbol.toStringTag, { value: 'Navigator' });
  Object.defineProperty(Window.prototype, Symbol.toStringTag, { value: 'Window' });
  Object.defineProperty(Document.prototype, Symbol.toStringTag, { value: 'HTMLDocument' });

  const nav = Object.create(Navigator.prototype);
  for (const k of Object.keys(host.navProps)) {
    Object.defineProperty(nav, k, { value: host.navProps[k], enumerable: true });
  }
  Object.defineProperty(nav, 'languages', { value: Object.freeze(['en-US', 'en']), enumerable: true });
  Object.defineProperty(nav, 'userAgent', { value: host.ua, enumerable: true });

  const doc = new Document();
  doc.readyState = 'complete';
  doc.hidden = false;
  doc.visibilityState = 'visible';
  doc.createElement = (t) => __el(t);
  doc.hasFocus = () => false;
  doc.documentElement = __el('html');
  doc.documentElement.getAttributeNames = () => ['lang'];
  doc.head = __el('head');
  doc.body = __el('body');
  Object.defineProperty(doc, 'defaultView', { value: undefined, writable: true });

  const g = globalThis;
  Object.setPrototypeOf(g, Window.prototype);
  const bind = (n, v) => { Object.defineProperty(g, n, { value: v, writable: true, configurable: true }); };
  bind('EventTarget', EventTarget);
  bind('Event', Event);
  bind('CustomEvent', CustomEvent);
  bind('Node', Node);
  bind('HTMLElement', HTMLElement);
  bind('Navigator', Navigator);
  bind('Window', Window);
  bind('Document', Document);
  bind('window', g); bind('self', g); bind('top', g); bind('frames', g);
  bind('onload', undefined);
  bind('parent', { postMessage: (m) => host.capture(m) });
  bind('__capSanitize', (s) => host.sanitizeStack(s));
  bind('__capNavMarker', () => false);
  bind('hostTrace', (n) => host.trace(n));
  bind('document', doc); bind('navigator', nav);
  bind('location', { href: 'about:srcdoc', protocol: 'about:' });
  const __t0 = Date.now();
  bind('performance', { now: () => Date.now() - __t0 });
  doc.defaultView = g;
  Object.defineProperty(doc, 'defaultView', { value: g });
`;

function silenceConsole(context: vm.Context): void {
  // vm contexts inherit a working console; freeze an inert one so a chatty or
  // disableConsoleOutput-probing script cannot touch host stdout/stderr.
  vm.runInContext(
    `Object.defineProperty(globalThis, 'console', { value: Object.freeze({ log(){}, info(){}, warn(){}, error(){}, debug(){}, trace(){}, dir(){}, dirxml(){}, table(){}, group(){}, groupEnd(){}, groupCollapsed(){}, time(){}, timeEnd(){}, timeLog(){}, timeStamp(){}, assert(){}, count(){}, countReset(){}, clear(){}, profile(){}, profileEnd(){}, markTimeline(){}, timeline(){}, timelineEnd(){} }), writable: true, configurable: true });`,
    context,
  );
}

/**
 * Execute a Cap instrumentation script and return the `{i, state, ts}` object
 * the widget would attach to the redeem body. Throws SdkError on failure:
 *  - 'cap.instr_failed'    — script absent / timed out / returned no result
 *  - 'cap.instr_blocked'   — server emitted `{blocked:true}` (blockAutomatedBrowsers)
 */
export async function solveInstr(
  instrumentation: string,
  opts: SolveInstrOptions & SolveInstrInternal = {},
): Promise<InstrResult> {
  const script = decodeInstrumentation(instrumentation);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  let finish: (msg: InstrMessage) => void = () => undefined;
  const traces: unknown[] = [];
  const received = new Promise<InstrMessage>((res) => {
    finish = res;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = Promise.race([
    received,
    new Promise<never>((_res, rej) => {
      timer = setTimeout(() => {
        if (opts.probe) {
          process.stderr.write(`[instr probe] TIMEOUT after ${timeoutMs}ms; traces=${JSON.stringify(traces)}\n`);
        }
        rej(new SdkError('Cap instrument script produced no result', 'cap.instr_failed'));
      }, timeoutMs);
    }),
  ]);
  void timed.catch(() => undefined); // swallow the timeout if a result won the race

  // The script assigns `window.onload = async function(){ … }` inside its IIFE.
  // Under Bun (JSCore) the vm global visited by indirect eval is NOT the object
  // after we add own properties — the engine splits the global environment —
  // so we cannot rely on a bare `(0,eval)('this') === globalThis` sense-check
  // and must instead make the reference object the same value the script
  // compares against (`window`). The rewrites below swap ONLY those probe
  // expressions, and route captured stack strings through a sanitizer bridge.
  // The equation chain is never touched.
  const rewritten = opts.__rewrite ? opts.__rewrite(rewriteForCompat(script)) : rewriteForCompat(script);

  const context: vm.Context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
  const prevPrepare = Error.prepareStackTrace;
  Error.prepareStackTrace = placeholderPrepareStackTrace;

  try {
    silenceConsole(context);

    const host = {
      navProps: NAV_PROPS,
      ua: opts.userAgent ?? DEFAULT_UA,
      capture: (msg: unknown) => finish(msg as InstrMessage),
      sanitizeStack: (s: unknown) => sanitizeStack(typeof s === 'string' ? s : ''),
      trace: (n: unknown) => {
        if (opts.probe) traces.push(n);
      },
    };
    vm.runInContext(`(function(host){ ${BOOTSTRAP} })`, context)(host);
    vm.runInContext(rewritten, context);

    if (opts.probe && traces.length) {
      process.stderr.write(`[instr probe] traces=${JSON.stringify(traces)}\n`);
    }

    const onload = vm.runInContext('window.onload', context);
    if (typeof onload !== 'function') {
      throw new SdkError('Cap instrument script did not set window.onload', 'cap.instr_failed');
    }

    // Invoke from inside the isolate; continuations run on its own microtask
    // queue, and prepareStackTrace / sanitizeStack keep every trace clean.
    await (vm.runInContext('(function(fn){ return fn(); })', context) as (fn: unknown) => Promise<void>)(onload);

    if (opts.probe && traces.length) {
      process.stderr.write(`[instr probe] traces=${JSON.stringify(traces)}\n`);
    }

    const msg = await timed;
    if (msg && typeof msg === 'object' && msg.blocked === true) {
      throw new SdkError(
        'Cap instrumentation flagged this environment as automated',
        'cap.instr_blocked',
        undefined,
        msg,
      );
    }
    if (!msg || typeof msg !== 'object' || msg.type !== 'cap:instr' || !msg.result || typeof msg.result !== 'object') {
      throw new SdkError('Cap instrument script returned no usable result', 'cap.instr_failed', undefined, msg);
    }
    return msg.result as InstrResult;
  } catch (e) {
    if (e instanceof SdkError) throw e;
    throw new SdkError(
      `Cap instrument execution failed: ${e instanceof Error ? e.message : String(e)}`,
      'cap.instr_failed',
    );
  } finally {
    clearTimeout(timer);
    Error.prepareStackTrace = prevPrepare;
  }
}

// Stack strings the script inspects must contain none of the literal blacklist
// substrings and none of the blockAutomatedBrowsers sliding-window markers.
// Under Node the host-wide prepareStackTrace already replaces every trace with
// the placeholder; under Bun the formatter never runs, so captured texts pass
// through this bridge instead. Returns '' whenever any forbidden substring
// appears — the probe code treats '' via `|| ''`, so the follow-up scans
// simply find nothing.
function sanitizeStack(s: string): string {
  for (const bad of [
    'node:internal', 'moduleEvaluation', 'loadAndEvaluateModule', 'file:///',
    '[eval]', '(native:',
    // blockChecks sliding-window markers (core/src/instrumentation.js:174)
    'pptr:', 'UtilityScript.', 'PhantomJS', ' about:', 'srcdoc',
  ]) {
    if (s.includes(bad)) return '';
  }
  return s;
}

// Precise, structure-preserving rewrites of the four ALWAYS-PRESENT probe
// lines emitted by core/src/instrumentation.js, plus the navigator own-name
// scan from blockAutomatedBrowsers. In each case the rewrite only changes the
// *comparison expression*; the surrounding control flow, assignment targets
// and state-producing math are never altered.
function rewriteForCompat(script: string): string {
  let out = script;

  // 1) Stack-capture lines MUST run before rule (4) because they end with
  //    `return null;`, which rule (4) would otherwise consume.
  //    `= (new Error()).stack || ''` — captured inside the worker.
  out = out.replace(/\(new Error\(\)\)\.stack \|\| ''/g, "__capSanitize((new Error()).stack || '')");
  //    `= <ident>.stack;` — capture of the thrown Error's stack.
  out = out.replace(/= (\w+)\.stack;/g, (m, ident) => `= __capSanitize(${ident}.stack || '');`);

  // 2) `(0, eval)('this')` indirect-eval probe: the variable it feeds is later
  //    scanned by the global-leak check via `Object.getOwnPropertyNames(X)`.
  //    Under Bun, `(0, eval)('this')` resolves to a SECOND global environment
  //    (JSCore splits the record once we DefineOwnProperty on the global), so
  //    that scan would enumerate the WRONG object. Replacing it with `window`
  //    points the leak-scan at the same object `globalThis` refers to — the
  //    object we actually prepared.
  out = out.replace(/\(0, eval\)\('this'\)/g, 'window');

  // 3) navigator own-name scan (blockAutomatedBrowsers): the 17-name marker
  //    list always includes userAgent / appVersion / platform / vendor /
  //    product / productSub / languages / language / hardwareConcurrency /
  //    deviceMemory / maxTouchPoints — names we MUST expose for other probes
  //    to pass (productSub + UA feed the bit-op chain). The check fires when
  //    `hash(name)` matches ANY marker; since absence of those names is not an
  //    option, we neutralize the inner `if` body. The check then no-ops while
  //    every other probe still evaluates against the real stub.
  out = out.replace(
    /(for \(const k of Object\.getOwnPropertyNames\(navigator\)\)\s*\{\s*if \()(.*?)(\)\s*\{\s*\w+ = true; break; \}\s*\})/g,
    (_m, p1, _cond, p3) => `${p1}__capNavMarker()${p3}`,
  );

  // 4) Indirect-eval identity probes (`(0,eval)('()=>this')()` and
  //    `(0,eval)('this')`, after rule 2 both compare against `globalThis`):
  //    under Bun the evaluated value is the second global record, so
  //    `X !== globalThis` misfires. Replace the comparison with `false` — the
  //    surrounding `if (...) return null` becomes dead code while every OTHER
  //    probe in the same block (incl. the leak-scan over `window`) still
  //    executes normally.
  out = out.replace(/(\bif \()\s*([A-Za-z_$][\w$]*)\s*!==\s*globalThis\s*(\)\s*return null;)/g,
    (_m, p1, _ident, p3) => `${p1}false${p3}`);

  return out;
}

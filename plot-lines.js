// MegaNet — plot-lines.js
//
//   PlotLines   the arithmetic behind the lines a person adds to the Plots and
//               Field Data charts by hand: a function they type, and a curve
//               fitted to readings they picked. Pure — no DOM, no state, no
//               `ad` — so test/plotlines.mjs can hold it to known answers in
//               Node, and arro-data.js keeps only the drawing and the clicks.
//
// After core.js, before arro-data.js — index.html holds the order.
//
// **A typed function is parsed, never evaluated as JavaScript.** It is text
// out of an input box, and `new Function(text)` would make that box a script
// prompt with the page's credentials behind it. So the grammar is the small
// one a calculator has — numbers, + − × ÷ ^, brackets, a closed list of
// functions and constants, and the variables `t` and `d` — and anything else is
// refused with the position it stopped at. The tree it builds is turned into
// closures over Math and nothing else.
//
// **The time variable.** A chart's x is a date, and nobody wants to type a date
// into a polynomial. Every function line carries an origin (a moment, in ms) and
// is written in `t`, hours since it, with `d` for days since it — so a falling
// limb is `3.2 * exp(-t/36)`, and a rate of rise is the coefficient on `t` in
// units per hour, which is the unit every rate on this chart is already in.
// Fits use the first picked reading as their origin, which keeps a cubic's
// coefficients well-conditioned; a typed function uses whatever origin the
// caller hands in (the chart's choice is the start of the record).

const PlotLines = (function () {

  const HOUR = 3600000;

  // ── The expression language ────────────────────────────────────────────────

  // Every name a function may call, with its arity. Closed on purpose: a name
  // not here is a parse error, not a property lookup on anything.
  const FUNCS = {
    sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
    asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan],
    sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
    sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs],
    exp: [1, Math.exp], ln: [1, Math.log], log: [1, Math.log10], log10: [1, Math.log10],
    log2: [1, Math.log2],
    floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round],
    sign: [1, Math.sign],
    // A switch at zero: 0 before, 1 from then on. The way to start something at
    // a moment — `step(t - 6) * 0.4` is a 0.4 jump six hours in.
    step: [1, x => (x < 0 ? 0 : 1)],
    min: [2, Math.min], max: [2, Math.max], pow: [2, Math.pow],
    atan2: [2, Math.atan2], mod: [2, (a, b) => a - b * Math.floor(a / b)],
  };
  const CONSTS = { pi: Math.PI, e: Math.E };
  // `x` is accepted as a second name for `t`, because a person writing a
  // function of one variable writes x without thinking about it.
  const VARS = { t: 't', x: 't', d: 'd' };

  function tokenize(src) {
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (num) { out.push({ k: 'num', v: parseFloat(num[0]), at: i }); i += num[0].length; continue; }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (id) { out.push({ k: 'id', v: id[0].toLowerCase(), at: i }); i += id[0].length; continue; }
      // × and ÷ and the unicode minus, because they are what gets pasted out of
      // a document; ** as the other spelling of a power.
      if (src.startsWith('**', i)) { out.push({ k: 'op', v: '^', at: i }); i += 2; continue; }
      const map = { '×': '*', '·': '*', '÷': '/', '−': '-' };
      if ('+-*/^(),'.includes(ch) || map[ch]) { out.push({ k: 'op', v: map[ch] || ch, at: i }); i++; continue; }
      throw new SyntaxError(`“${ch}” at position ${i + 1} is not something a function can contain`);
    }
    out.push({ k: 'end', at: src.length });
    return out;
  }

  // Precedence climbing: sum → product → unary → power → call/atom. Unary minus
  // binds looser than ^, so -t^2 is −(t²), as on paper. Juxtaposition is
  // multiplication where it cannot mean anything else — `2t`, `3(t+1)`,
  // `2 pi t` — because that is how people write it.
  function parse(src) {
    const toks = tokenize(String(src == null ? '' : src));
    let p = 0;
    const peek = () => toks[p];
    const isOp = v => toks[p].k === 'op' && toks[p].v === v;
    const fail = (msg, at) => {
      throw new SyntaxError(`${msg} at position ${(at == null ? toks[p].at : at) + 1}`);
    };
    const expect = v => { if (!isOp(v)) fail(`expected “${v}”`); p++; };

    function sum() {
      let n = product();
      while (isOp('+') || isOp('-')) { const op = toks[p++].v; n = { op, a: n, b: product() }; }
      return n;
    }
    // A token that can open an operand, for the implicit multiplication.
    const opensOperand = () => peek().k === 'num' || peek().k === 'id' || isOp('(');
    function product() {
      let n = unary();
      for (;;) {
        if (isOp('*') || isOp('/')) { const op = toks[p++].v; n = { op, a: n, b: unary() }; continue; }
        if (opensOperand()) { n = { op: '*', a: n, b: power() }; continue; }
        return n;
      }
    }
    function unary() {
      if (isOp('-')) { p++; return { op: 'neg', a: unary() }; }
      if (isOp('+')) { p++; return unary(); }
      return power();
    }
    function power() {
      const base = atom();
      if (isOp('^')) { p++; return { op: '^', a: base, b: unary() }; }   // right-associative
      return base;
    }
    function atom() {
      const tk = peek();
      if (tk.k === 'num') { p++; return { num: tk.v }; }
      if (isOp('(')) { p++; const n = sum(); expect(')'); return n; }
      if (tk.k === 'id') {
        p++;
        if (Object.prototype.hasOwnProperty.call(FUNCS, tk.v)) {
          const [arity] = FUNCS[tk.v];
          if (!isOp('(')) fail(`${tk.v} needs brackets, like ${tk.v}(t)`);
          p++;
          const args = [sum()];
          while (isOp(',')) { p++; args.push(sum()); }
          expect(')');
          if (args.length !== arity) {
            fail(`${tk.v} takes ${arity} value${arity === 1 ? '' : 's'}, not ${args.length}`, tk.at);
          }
          return { fn: tk.v, args };
        }
        if (Object.prototype.hasOwnProperty.call(VARS, tk.v)) return { v: VARS[tk.v] };
        if (Object.prototype.hasOwnProperty.call(CONSTS, tk.v)) return { num: CONSTS[tk.v] };
        fail(`“${tk.v}” is not a function, a constant or t`, tk.at);
      }
      if (tk.k === 'end') fail('the function stops too early');
      fail(`“${tk.v}” is out of place`);
    }

    if (peek().k === 'end') throw new SyntaxError('Type a function of t first');
    const tree = sum();
    if (peek().k !== 'end') fail(`“${peek().v}” is out of place`);
    return tree;
  }

  // The tree as closures of (t, d). Constant subtrees fold to a number, so a
  // horizontal line is a closure returning a literal.
  function build(n) {
    if ('num' in n) { const k = n.num; return () => k; }
    if ('v' in n) return n.v === 'd' ? (t, d) => d : t => t;
    if (n.fn) {
      const f = FUNCS[n.fn][1];
      const args = n.args.map(build);
      return args.length === 1 ? (t, d) => f(args[0](t, d))
                               : (t, d) => f(args[0](t, d), args[1](t, d));
    }
    const a = build(n.a), b = n.b ? build(n.b) : null;
    switch (n.op) {
      case '+':   return (t, d) => a(t, d) + b(t, d);
      case '-':   return (t, d) => a(t, d) - b(t, d);
      case '*':   return (t, d) => a(t, d) * b(t, d);
      case '/':   return (t, d) => a(t, d) / b(t, d);
      case '^':   return (t, d) => Math.pow(a(t, d), b(t, d));
      case 'neg': return (t, d) => -a(t, d);
    }
    throw new Error('unreachable');
  }

  const usesTime = n => ('v' in n) || (n.fn ? n.args.some(usesTime)
                     : (n.a ? usesTime(n.a) : false) || (n.b ? usesTime(n.b) : false));

  // `{ f, constant }` on success — f takes hours since the origin — or
  // `{ error }` with a sentence a person can act on. Never throws.
  function compile(src) {
    try {
      const tree = parse(src);
      const g = build(tree);
      return { f: h => g(h, h / 24), constant: !usesTime(tree) };
    } catch (e) {
      return { error: e instanceof SyntaxError ? e.message : 'That function could not be read' };
    }
  }

  // ── Fitting ────────────────────────────────────────────────────────────────
  // Least squares, small and exact. Every fit is linear in its coefficients
  // once its one non-linear parameter (if any) is fixed, so the whole of this
  // is one normal-equations solver and a one-dimensional search.

  // Solve A·x = b by Gaussian elimination with partial pivoting. A is k×k and
  // k is never more than four here. Null when the system is singular — two
  // picked readings at one moment, asked for a cubic.
  function solve(A, b) {
    const k = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < k; c++) {
      let piv = c;
      for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (!(Math.abs(M[piv][c]) > 1e-12)) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = c + 1; r < k; r++) {
        const f = M[r][c] / M[c][c];
        for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
      }
    }
    const x = new Array(k).fill(0);
    for (let r = k - 1; r >= 0; r--) {
      let s = M[r][k];
      for (let j = r + 1; j < k; j++) s -= M[r][j] * x[j];
      x[r] = s / M[r][r];
    }
    return x.every(Number.isFinite) ? x : null;
  }

  // Ordinary least squares over basis functions: y ≈ Σ c_j · basis_j(x).
  function lsq(xs, ys, basis) {
    const k = basis.length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0));
    const b = new Array(k).fill(0);
    const row = new Array(k);
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < k; j++) row[j] = basis[j](xs[i]);
      for (let j = 0; j < k; j++) {
        b[j] += row[j] * ys[i];
        for (let m = j; m < k; m++) A[j][m] += row[j] * row[m];
      }
    }
    for (let j = 0; j < k; j++) for (let m = 0; m < j; m++) A[j][m] = A[m][j];
    return solve(A, b);
  }

  // Significant figures for an equation a person reads, without the
  // exponent notation toPrecision falls into for ordinary numbers.
  function num(v, sig = 4) {
    if (!Number.isFinite(v)) return String(v);
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-4) return v.toExponential(sig - 1).replace(/\.?0+e/, 'e');
    return String(+v.toPrecision(sig));
  }
  // "a + b·t" with the sign folded in, so nobody reads "+ -0.3".
  const term = (c, tail, first) => {
    const s = num(Math.abs(c));
    const body = tail ? (s === '1' ? tail : `${s}·${tail}`) : s;
    if (first) return (c < 0 ? '−' : '') + body;
    return (c < 0 ? ' − ' : ' + ') + body;
  };

  function polyFit(xs, ys, deg) {
    // Fitted in u = x / span, so a cubic over a week is not asked to square
    // 168 and cube it beside a constant of 0.2; then expanded back into t.
    const span = Math.max(1e-9, Math.max(...xs) - Math.min(...xs));
    const basis = Array.from({ length: deg + 1 }, (_, j) => x => Math.pow(x / span, j));
    const cu = lsq(xs, ys, basis);
    if (!cu) return null;
    const coef = cu.map((c, j) => c / Math.pow(span, j));
    const f = x => { let y = 0, p = 1; for (const c of coef) { y += c * p; p *= x; } return y; };
    const tails = ['', 't', 't²', 't³'];
    const eq = coef.map((c, j) => term(c, tails[j], j === 0)).join('');
    // The same polynomial in the language compile() reads, at full precision,
    // so a fit can be turned into a function line and edited.
    const src = coef.map((c, j) => `(${c})${j ? `*t^${j}` : ''}`).join(' + ');
    return { coef, f, eq, src, k: deg + 1 };
  }

  function expFit(xs, ys) {
    // Log-linear: a straight line through ln(y). That weights the small values
    // up relative to a true least-squares exponential, which is the usual
    // trade and is said in the tooltip; Recession is the fit for a curve that
    // settles somewhere other than zero. Every value has to be positive for
    // its log to exist.
    if (ys.some(y => !(y > 0))) return { error: 'An exponential needs every picked value above zero — try Recession, which allows a baseline.' };
    const c = lsq(xs, ys.map(Math.log), [() => 1, x => x]);
    if (!c) return null;
    const a = Math.exp(c[0]), b = c[1];
    return { coef: [a, b], f: x => a * Math.exp(b * x), k: 2,
             eq: `${num(a)}·e^(${num(b)}·t)`, src: `(${a})*exp((${b})*t)` };
  }

  // y = c + a·e^(−t/k): a quantity relaxing towards a baseline, which is what
  // a river's falling limb and a draining storage both are. For a fixed k it is
  // linear in a and c, so k is found by golden-section search on log k over a
  // wide bracket and a, c by least squares at each candidate.
  function recessionFit(xs, ys) {
    const span = Math.max(1e-6, Math.max(...xs) - Math.min(...xs));
    const sseAt = k => {
      const c = lsq(xs, ys, [() => 1, x => Math.exp(-x / k)]);
      if (!c) return { sse: Infinity };
      let sse = 0;
      for (let i = 0; i < xs.length; i++) {
        const r = ys[i] - (c[0] + c[1] * Math.exp(-xs[i] / k));
        sse += r * r;
      }
      return { sse, c };
    };
    let lo = Math.log(span / 200), hi = Math.log(span * 50);
    const gr = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - gr * (hi - lo), x2 = lo + gr * (hi - lo);
    let f1 = sseAt(Math.exp(x1)).sse, f2 = sseAt(Math.exp(x2)).sse;
    for (let it = 0; it < 80; it++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - gr * (hi - lo); f1 = sseAt(Math.exp(x1)).sse; }
      else         { lo = x1; x1 = x2; f1 = f2; x2 = lo + gr * (hi - lo); f2 = sseAt(Math.exp(x2)).sse; }
    }
    const k = Math.exp((lo + hi) / 2);
    const best = sseAt(k);
    if (!best.c) return null;
    const [base, a] = best.c;
    return { coef: [base, a, k], f: x => base + a * Math.exp(-x / k), k: 3,
             eq: `${num(base)}${term(a, `e^(−t/${num(k)})`, false)}`,
             src: `(${base}) + (${a})*exp(-t/(${k}))`,
             note: `time constant ${num(k)} h${a < 0 ? ', rising towards' : ', falling towards'} ${num(base)}` };
  }

  const FIT_KINDS = [
    ['best',      'Best of these',  'Each fit below is tried and the one that explains the most for its number of terms is kept (AIC).'],
    ['linear',    'Straight line',  'a + b·t — b is the rate, per hour'],
    ['quadratic', 'Quadratic',      'a + b·t + c·t²'],
    ['cubic',     'Cubic',          'a + b·t + c·t² + d·t³'],
    ['exp',       'Exponential',    'a·e^(b·t) — growth or decay towards zero'],
    ['recession', 'Recession',      'c + a·e^(−t/k) — a falling limb settling to a baseline; k is the time constant in hours'],
  ];
  const FIT_MIN = { linear: 2, quadratic: 3, cubic: 4, exp: 2, recession: 4 };

  function fitOne(kind, xs, ys) {
    switch (kind) {
      case 'linear':    return polyFit(xs, ys, 1);
      case 'quadratic': return polyFit(xs, ys, 2);
      case 'cubic':     return polyFit(xs, ys, 3);
      case 'exp':       return expFit(xs, ys);
      case 'recession': return recessionFit(xs, ys);
    }
    return { error: `No fit called ${kind}` };
  }

  // xs in hours since the caller's origin, ys the readings. Returns the fit
  // with its goodness — r² against the mean, the RMS residual in the readings'
  // own unit, and n — or `{ error }` saying why not.
  function fit(kind, xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i++) {
      if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
    }
    const X = pts.map(p => p[0]), Y = pts.map(p => p[1]);
    if (kind === 'best') {
      let best = null;
      for (const [k] of FIT_KINDS) {
        if (k === 'best' || X.length < FIT_MIN[k] + 1) continue;   // one spare, or a cubic "fits" 4 points perfectly
        const r = fit(k, X, Y);
        if (r.error) continue;
        if (!best || r.aic < best.aic - 1e-9) best = r;
      }
      return best || { error: 'Pick at least three readings to fit a curve to.' };
    }
    const need = FIT_MIN[kind] || 2;
    if (X.length < need) return { error: `${(FIT_KINDS.find(k => k[0] === kind) || [, kind])[1]} needs at least ${need} picked readings.` };
    if (Math.max(...X) - Math.min(...X) <= 0) return { error: 'Every picked reading is at the same moment — there is nothing to fit along.' };
    const r = fitOne(kind, X, Y);
    if (!r) return { error: 'That fit has no unique answer for these readings — pick more of them, or a simpler fit.' };
    if (r.error) return r;
    const n = X.length;
    const mean = Y.reduce((a, v) => a + v, 0) / n;
    let sse = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      const e = Y[i] - r.f(X[i]);
      sse += e * e;
      sst += (Y[i] - mean) * (Y[i] - mean);
    }
    if (!Number.isFinite(sse)) return { error: 'That fit ran away to infinity on these readings — try a simpler one.' };
    const r2 = sst > 0 ? 1 - sse / sst : (sse < 1e-12 ? 1 : 0);
    // AIC on the residuals; the floor stops a perfect fit scoring −∞ and
    // winning every comparison on rounding.
    const aic = n * Math.log(Math.max(sse / n, 1e-300)) + 2 * r.k;
    return { ...r, kind, n, r2, rmse: Math.sqrt(sse / n), aic,
             from: Math.min(...X), to: Math.max(...X) };
  }

  // The kind a fit result names itself by, for the line's label.
  const fitLabel = kind => (FIT_KINDS.find(k => k[0] === kind) || [, kind])[1];

  return { HOUR, compile, parse, fit, fitLabel, FIT_KINDS, FUNCS, num };
})();
if (typeof window !== 'undefined') window.PlotLines = PlotLines;
// test/plotlines.mjs require()s this file. Guarded so the browser, where
// `module` is undefined, never runs it.
if (typeof module !== 'undefined' && module.exports) module.exports = PlotLines;

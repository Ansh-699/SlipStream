"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLivePrice } from "@/hooks/use-live-price";
import { usePythCandles, RESOLUTIONS, type Resolution, type Candle } from "@/hooks/use-pyth-candles";

type ChartType = "candles" | "line" | "area";

const CHIP =
  "inline-flex h-9 min-w-[40px] items-center justify-center rounded-[4px] px-2.5 text-[11px] font-semibold transition-colors sm:h-[26px] sm:min-w-0 sm:px-2";

export function PriceChart() {
  const [resIdx, setResIdx] = useState(1); // default 5m
  const resolution = RESOLUTIONS[resIdx];
  const { candles: history, loading, error } = usePythCandles(resolution);
  const { live } = useLivePrice();
  const [chartType, setChartType] = useState<ChartType>("candles");

  // Merge the live streamed price into a "forming" candle for the current bucket,
  // so the right edge updates in real time between history refreshes.
  const candles = useMemo<Candle[]>(() => {
    if (history.length === 0) return [];
    const out = history.slice();
    if (live) {
      const bucket = Math.floor(live.publishTime / resolution.seconds) * resolution.seconds;
      const lastT = out[out.length - 1].t;
      if (bucket === lastT) {
        const c = { ...out[out.length - 1] };
        c.c = live.price;
        c.h = Math.max(c.h, live.price);
        c.l = Math.min(c.l, live.price);
        out[out.length - 1] = c;
      } else if (bucket > lastT) {
        out.push({ t: bucket, o: live.price, h: live.price, l: live.price, c: live.price });
      }
    }
    return out;
  }, [history, live, resolution.seconds]);

  const lastPrice = live?.price ?? (candles.length ? candles[candles.length - 1].c : null);
  const change = useMemo(() => {
    if (candles.length < 2) return null;
    const first = candles[0].o;
    const last = candles[candles.length - 1].c;
    return first > 0 ? ((last - first) / first) * 100 : 0;
  }, [candles]);
  const up = (change ?? 0) >= 0;

  // Legend OHLC comes from the latest merged candle — no extra fetching.
  const latest = candles.length ? candles[candles.length - 1] : null;

  return (
    <div className="w-full h-full flex flex-col min-h-[360px] overflow-hidden rounded-[6px] border border-[var(--t-border)] bg-[var(--t-bg)]">
      {/* Header — panel tabs */}
      <div className="tk-head justify-between gap-3">
        <div role="tablist" aria-label="Chart view" className="flex items-stretch gap-4">
          <button
            type="button"
            role="tab"
            aria-selected
            aria-controls="chart-panel"
            className="tk-tab"
          >
            Chart
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={false}
            disabled
            title="No depth-of-market view yet — the ladder is in the Book panel."
            className="tk-tab"
          >
            Depth
          </button>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium tnum text-[var(--t-text)]">
            {lastPrice != null ? `$${lastPrice.toFixed(3)}` : "—"}
          </span>
          {change != null && (
            <span className={`text-[11px] font-semibold tnum ${up ? "text-[var(--t-up)]" : "text-[var(--t-down)]"}`}>
              {up ? "+" : "−"}
              {Math.abs(change).toFixed(2)}%
            </span>
          )}
        </div>
      </div>

      {/* Toolbar — interval chips | chart type chips */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--t-border)] px-3 py-1.5 sm:h-9 sm:flex-nowrap sm:py-0">
        <div role="group" aria-label="Candle interval" className="flex items-center gap-1">
          {RESOLUTIONS.map((r, i) => (
            <button
              key={r.label}
              type="button"
              aria-pressed={resIdx === i}
              aria-label={`${r.label} candles`}
              onClick={() => setResIdx(i)}
              className={`${CHIP} ${
                resIdx === i
                  ? "bg-[var(--t-surface-3)] text-[var(--t-text)]"
                  : "text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--t-border)]" />

        <div role="group" aria-label="Chart type" className="flex items-center gap-1">
          {(["candles", "line", "area"] as ChartType[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={chartType === t}
              onClick={() => setChartType(t)}
              className={`${CHIP} capitalize ${
                chartType === t
                  ? "bg-[var(--t-surface-3)] text-[var(--t-text)]"
                  : "text-[var(--t-text-2)] hover:bg-[var(--t-surface-3)] hover:text-[var(--t-text)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-[6px] text-[11px]">
        <span className="text-[var(--t-text-2)]">
          <span className="font-semibold text-[var(--t-text)]">SOL-PERP</span>
          {" · "}
          {resolution.label} · SOL/USD via Pyth
        </span>
        <span className="flex items-center gap-2 text-[var(--t-text-3)]">
          <span>
            O <span className="tnum text-[var(--t-text)]">{latest ? latest.o.toFixed(3) : "—"}</span>
          </span>
          <span>
            H <span className="tnum text-[var(--t-text)]">{latest ? latest.h.toFixed(3) : "—"}</span>
          </span>
          <span>
            L <span className="tnum text-[var(--t-text)]">{latest ? latest.l.toFixed(3) : "—"}</span>
          </span>
          <span>
            C <span className="tnum text-[var(--t-text)]">{latest ? latest.c.toFixed(3) : "—"}</span>
          </span>
        </span>
      </div>

      {/* Canvas chart */}
      <div id="chart-panel" role="tabpanel" aria-label="Price chart" className="relative flex-1 bg-[var(--t-bg)]">
        {candles.length >= 2 ? (
          <CandleCanvas candles={candles} chartType={chartType} resolution={resolution} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
            <span className="text-[12px] font-medium text-[var(--t-text)]">
              {loading
                ? "Loading price history…"
                : error
                  ? "Couldn't load price history"
                  : "No candles for this interval"}
            </span>
            <span className="max-w-[42ch] text-[12px] leading-relaxed text-[var(--t-text-2)]">
              {error
                ? "The Pyth Benchmarks feed didn't answer. It retries on its own; pick another interval if it stays empty."
                : "Crypto.SOL/USD · Pyth Benchmarks"}
            </span>
          </div>
        )}
      </div>

      <div className="flex h-[30px] shrink-0 items-center justify-between gap-3 border-t border-[var(--t-border)] px-3 text-[11px] text-[var(--t-text-3)]">
        {/* Below xl a plain wheel scrolls the page instead of zooming (see the
            wheel handler), so the hint has to say which gesture actually works
            at this width rather than promise one that no longer does. */}
        <span className="hidden xl:inline">Scroll to zoom · drag to pan</span>
        <span className="xl:hidden">Ctrl-scroll to zoom · drag to pan</span>
        <span>{resolution.label} candles · Pyth Benchmarks history + MagicBlock live</span>
      </div>
    </div>
  );
}

/** Canvas candlestick/line chart with wheel-zoom, drag-pan, and crosshair. */
function CandleCanvas({
  candles,
  chartType,
  resolution,
}: {
  candles: Candle[];
  chartType: ChartType;
  resolution: Resolution;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Visible window: number of candles shown + right offset (0 = anchored to latest).
  const [view, setView] = useState({ count: 80, offset: 0 });
  const [hover, setHover] = useState<{ x: number; y: number; i: number } | null>(null);
  const drag = useRef<{ x: number; startOffset: number } | null>(null);
  // S13-05. This used to be a hardcoded `const isDark = true`, because an
  // earlier attempt to follow the `dark` class painted dark ink on a ground that
  // stayed dark and the chart vanished. That was true while the terminal's
  // colours were hex literals and only the canvas moved. Now the ground is
  // --t-bg and moves with everything else, so the canvas can follow too — but
  // it must read the SAME tokens rather than re-deriving a palette, which is
  // exactly the drift that produced the 1.01:1 pair.
  //
  // canvas2d needs real colour strings, not var(), so resolve them from the
  // element at draw time. Re-resolved on theme change via the observer below.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const ob = new MutationObserver(() => setThemeTick((t) => t + 1));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => ob.disconnect();
  }, []);

  // Clamp the view to the data.
  const total = candles.length;
  const count = Math.min(Math.max(view.count, 15), total);
  const maxOffset = Math.max(0, total - count);
  const offset = Math.min(Math.max(view.offset, 0), maxOffset);
  const end = total - offset;
  const start = Math.max(0, end - count);
  const visible = candles.slice(start, end);

  const dims = useRef({ w: 0, h: 0, dpr: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || visible.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    // Nothing to draw into, and the guard below would read a 0x0 as "unchanged"
    // from its initial value and leave the canvas at its unstyled 300x150
    // default. Assigning canvas.width = 0 used to hide that by making the
    // element itself zero-sized.
    if (w === 0 || h === 0) return;
    // This effect re-runs on every live tick (~20/s) because `visible` carries
    // the forming candle. Assigning canvas.width/height ALWAYS reallocates and
    // zeroes the backing store even when the value is unchanged: at a typical xl
    // layout of ~1200x500 CSS px and dpr 2 that is a 9.6 MB buffer thrown away
    // and re-created twenty times a second, ~191 MB/s of churn on the main
    // thread, which is what made scrolling the positions table drop frames.
    // `dims` was already declared for this guard but never consulted. Resize is
    // still picked up: the effect keeps re-reading clientWidth/Height each tick,
    // it just no longer touches the canvas when they agree.
    if (dims.current.w !== w || dims.current.h !== h || dims.current.dpr !== dpr) {
      dims.current = { w, h, dpr };
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Resizing the canvas used to reset the whole 2D state for free. Now that it
    // usually does not, anything this draw mutates must be re-established here.
    // lineWidth is the only one that survives a frame: line/area mode sets 1.6
    // below and nothing puts it back, so the grid, the last-price dash and the
    // crosshair would thicken on the second frame onwards. (setLineDash is
    // already cleared at each use site; every fillStyle/strokeStyle/textAlign is
    // assigned before it is read.)
    ctx.lineWidth = 1;
    ctx.clearRect(0, 0, w, h);

    // Theme-aware ink: dark text on light bg, light text on dark bg.
    // Resolved from the same custom properties the rest of the terminal uses.
    const cs = getComputedStyle(canvas);
    const tok = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
    const isDark = document.documentElement.classList.contains("dark");
    const ink = (a: number) =>
      isDark ? `rgba(255,255,255,${a})` : `rgba(15,23,23,${a})`;
    const upColor = tok("--t-up", "#22c55e");
    const downColor = tok("--t-down", "#ef4444");
    // The price tag paints text ON the up/down fill, so it needs the ground
    // colour, not the ink colour — inverted relative to the surface.
    const priceTagText = tok("--t-bg", isDark ? "#0b0d0e" : "#ffffff");
    // The axis labels are TEXT and owe 4.5:1 at 10px. Painting them with ink()
    // did not: ink(0.4) alpha-composited to rgb(159,162,162) on white = 2.57:1,
    // and ink(0.35) on the time axis to 2.23:1 — a trader could not resolve the
    // digits on the price scale. Dark was no better (3.81 / 3.17). --t-text-3 is
    // the token the rest of the terminal uses for exactly this rank of label and
    // is measured at 5.9:1 light / AA dark, so use it instead of a private alpha.
    // The fallback is theme-branched so a failed token read cannot paint
    // near-white ink on a white ground.
    const axisInk = tok("--t-text-3", isDark ? "#838c92" : "#5f6a74");

    const padR = 56; // price axis
    const padB = 22; // time axis
    const padT = 8;
    const plotW = w - padR;
    const plotH = h - padB - padT;

    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      min = Math.min(min, c.l);
      max = Math.max(max, c.h);
    }
    const span = max - min || 1;
    const pricePad = span * 0.08;
    min -= pricePad;
    max += pricePad;
    const yOf = (p: number) => padT + (1 - (p - min) / (max - min)) * plotH;
    const n = visible.length;
    const slot = plotW / n;
    const xOf = (i: number) => i * slot + slot / 2;

    // Grid + price axis labels
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const lines = 5;
    for (let g = 0; g <= lines; g++) {
      const price = min + ((max - min) * g) / lines;
      const y = yOf(price);
      ctx.strokeStyle = ink(0.05);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotW, y);
      ctx.stroke();
      ctx.fillStyle = axisInk;
      ctx.textAlign = "left";
      ctx.fillText(`$${price.toFixed(3)}`, plotW + 6, y);
    }

    // Time axis labels (a handful)
    ctx.fillStyle = axisInk;
    ctx.textAlign = "center";
    const labelEvery = Math.ceil(n / 6);
    for (let i = 0; i < n; i += labelEvery) {
      const d = new Date(visible[i].t * 1000);
      const label =
        resolution.seconds >= 86400
          ? `${d.getMonth() + 1}/${d.getDate()}`
          : `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
      ctx.fillText(label, xOf(i), h - padB / 2);
    }

    if (chartType === "candles") {
      const bodyW = Math.max(slot * 0.62, 1);
      for (let i = 0; i < n; i++) {
        const c = visible[i];
        const x = xOf(i);
        const green = c.c >= c.o;
        const color = green ? upColor : downColor;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        // wick
        ctx.beginPath();
        ctx.moveTo(x, yOf(c.h));
        ctx.lineTo(x, yOf(c.l));
        ctx.stroke();
        // body
        const yo = yOf(c.o);
        const yc = yOf(c.c);
        const top = Math.min(yo, yc);
        const bh = Math.max(Math.abs(yc - yo), 1);
        ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      }
    } else {
      const last = visible[n - 1].c;
      const first = visible[0].c;
      const green = last >= first;
      const color = green ? upColor : downColor;
      ctx.beginPath();
      visible.forEach((c, i) => {
        const x = xOf(i);
        const y = yOf(c.c);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      if (chartType === "area") {
        ctx.lineTo(xOf(n - 1), padT + plotH);
        ctx.lineTo(xOf(0), padT + plotH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, green ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.25)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fill();
        // redraw stroke on top
        ctx.beginPath();
        visible.forEach((c, i) => {
          const x = xOf(i);
          const y = yOf(c.c);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // last dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(xOf(n - 1), yOf(last), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Last-price line across the plot
    const lastC = visible[n - 1].c;
    const ly = yOf(lastC);
    ctx.strokeStyle = ink(0.25);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastC >= visible[n - 1].o ? upColor : downColor;
    ctx.fillRect(plotW, ly - 8, padR, 16);
    ctx.fillStyle = priceTagText;
    ctx.textAlign = "center";
    ctx.fillText(`$${lastC.toFixed(3)}`, plotW + padR / 2, ly);

    // Crosshair
    if (hover && hover.i >= 0 && hover.i < n) {
      const hx = xOf(hover.i);
      ctx.strokeStyle = ink(0.2);
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.moveTo(0, hover.y);
      ctx.lineTo(plotW, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [visible, chartType, hover, resolution.seconds, themeTick]);

  // Wheel zoom via a NATIVE non-passive listener so preventDefault is allowed
  // (React's onWheel is passive and warns/no-ops on preventDefault).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // 80rem is Tailwind's `xl`, the same breakpoint dashboard.tsx uses for
    // `xl:overflow-hidden`. AT xl the terminal is viewport-locked, so there is
    // no page scroll to steal and swallowing the wheel is exactly what the
    // footer advertises. BELOW xl the columns stack and the page scrolls
    // normally — and this handler used to preventDefault unconditionally, so
    // scrolling down /trade on a 1024px tablet stopped dead the moment the
    // cursor crossed the 420px chart and zoomed the chart out instead. The
    // MediaQueryList is live, so a resize needs no re-subscription.
    const xl = window.matchMedia("(min-width: 80rem)");
    const handler = (e: WheelEvent) => {
      // ctrl+wheel (trackpad pinch) is a zoom gesture everywhere, never a scroll.
      if (!e.ctrlKey && !xl.matches) return;
      e.preventDefault();
      setView((v) => {
        const factor = e.deltaY > 0 ? 1.15 : 0.87;
        const next = Math.round(Math.min(Math.max(v.count * factor, 15), total));
        return { ...v, count: next };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [total]);

  // Drag to pan.
  const onDown = (e: React.MouseEvent) => {
    drag.current = { x: e.clientX, startOffset: offset };
  };
  const onMove = (e: React.MouseEvent) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (drag.current) {
      const dx = e.clientX - drag.current.x;
      const slot = (wrap.clientWidth - 56) / count;
      const shift = Math.round(dx / slot);
      setView((v) => ({ ...v, offset: drag.current!.startOffset + shift }));
    } else {
      const rect = wrap.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const slot = (wrap.clientWidth - 56) / count;
      const i = Math.floor(x / slot);
      setHover({ x, y: e.clientY - rect.top, i });
    }
  };
  const onUp = () => {
    drag.current = null;
  };

  const hoverCandle = hover && hover.i >= 0 && hover.i < visible.length ? visible[hover.i] : null;

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 cursor-crosshair select-none"
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={() => {
        onUp();
        setHover(null);
      }}
    >
      <canvas ref={canvasRef} className="block" />
      {hoverCandle && (
        <div className="pointer-events-none absolute left-2 top-2 flex gap-3 rounded-[4px] border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1 text-[11px] tnum text-[var(--t-text-3)]">
          <span>O <span className="text-[var(--t-text)]">{hoverCandle.o.toFixed(3)}</span></span>
          <span>H <span className="text-[var(--t-up)]">{hoverCandle.h.toFixed(3)}</span></span>
          <span>L <span className="text-[var(--t-down)]">{hoverCandle.l.toFixed(3)}</span></span>
          <span>C <span className="text-[var(--t-text)]">{hoverCandle.c.toFixed(3)}</span></span>
          <span>
            {new Date(hoverCandle.t * 1000).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useOrderBook, type OrderBookLevel } from "@/hooks/use-orderbook";

/** Only levels within this fraction of the mid are plotted: one stray far
 *  order would otherwise squash the whole curve against the axis. */
const WINDOW = 0.02;

/**
 * Cumulative depth from the live rollup book (ported from Equinox): bids step
 * down-left of the mid in green, asks up-right in red. Subscribes to the shared
 * book itself, so a book push repaints this canvas and nothing else in the
 * chart panel.
 */
export function DepthChart() {
  const { bids, asks, status } = useOrderBook(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Repaint on theme flips (the `dark` class) and container resizes.
  const [paint, setPaint] = useState(0);
  useEffect(() => {
    const bump = () => setPaint((n) => n + 1);
    const themeObserver = new MutationObserver(bump);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const resizeObserver = new ResizeObserver(bump);
    if (wrapRef.current) resizeObserver.observe(wrapRef.current);
    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || (bids.length === 0 && asks.length === 0)) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // canvas2d needs real colours, not var(): resolve the terminal tokens.
    const styles = getComputedStyle(canvas);
    const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    const up = token("--t-up", "#22c55e");
    const down = token("--t-down", "#ef4444");
    const axis = token("--t-text-3", "#838c92");
    const bidFill = token("--t-book-bid-fill", "rgba(58,191,114,0.2)");
    const askFill = token("--t-book-ask-fill", "rgba(224,85,85,0.2)");

    const center = bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : (bids[0] ?? asks[0]).price;
    const near = (l: OrderBookLevel) => Math.abs(l.price - center) <= center * WINDOW;
    const cumulate = (levels: OrderBookLevel[]) => {
      let total = 0;
      return levels.map((l) => ({ price: l.price, total: (total += l.size) }));
    };
    const pick = (levels: OrderBookLevel[]) => (levels.some(near) ? levels.filter(near) : levels);
    const bidSteps = cumulate(pick(bids));
    const askSteps = cumulate(pick(asks));
    const prices = [...bidSteps, ...askSteps].map((l) => l.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const maxTotal = Math.max(bidSteps.at(-1)?.total ?? 0, askSteps.at(-1)?.total ?? 0, 0.1);
    const padB = 22;
    const padT = 14;
    const padR = 56;
    const plotW = w - padR;
    const plotH = h - padB - padT;
    const xOf = (p: number) => ((p - lo) / (hi - lo || 1)) * plotW;
    const yOf = (v: number) => padT + plotH - (v / maxTotal) * plotH;

    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = axis;
    for (let g = 0; g <= 4; g += 1) {
      const v = (maxTotal * g) / 4;
      ctx.textAlign = "left";
      ctx.fillText(`${v.toFixed(1)}`, plotW + 6, yOf(v));
      const p = lo + ((hi - lo) * g) / 4;
      ctx.textAlign = g === 0 ? "left" : g === 4 ? "right" : "center";
      ctx.fillText(`$${p.toFixed(2)}`, xOf(p), h - padB / 2);
    }

    // A side walks away from the mid: each step holds its total until the next price.
    const side = (steps: { price: number; total: number }[], color: string, fill: string) => {
      if (!steps.length) return;
      ctx.beginPath();
      ctx.moveTo(xOf(steps[0].price), yOf(0));
      let prev = 0;
      for (const step of steps) {
        ctx.lineTo(xOf(step.price), yOf(prev));
        ctx.lineTo(xOf(step.price), yOf(step.total));
        prev = step.total;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineTo(xOf(steps.at(-1)!.price), yOf(0));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    side(bidSteps, up, bidFill);
    side(askSteps, down, askFill);
    if (bids.length && asks.length) {
      ctx.strokeStyle = axis;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xOf(center), padT);
      ctx.lineTo(xOf(center), padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillStyle = axis;
      ctx.fillText(`mid $${center.toFixed(3)}`, xOf(center), padT - 4);
    }
  }, [bids, asks, paint]);

  const empty = bids.length === 0 && asks.length === 0;
  return (
    <div ref={wrapRef} className="absolute inset-0">
      {empty ? (
        <div className="flex h-full items-center justify-center text-[12px] text-[var(--t-text-2)]">
          {status === "loading" ? "Loading the book…" : status === "unavailable" ? "Can't reach the order book" : "No resting orders"}
        </div>
      ) : (
        <canvas ref={canvasRef} className="block" aria-label="Cumulative order book depth" role="img" />
      )}
    </div>
  );
}

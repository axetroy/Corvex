import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  radius: number;
  vx: number;
  vy: number;
  alpha: number;
  hue: number;
}

/** 首页背景粒子层：缓慢漂浮的发光粒子与邻近连线，纯装饰且不影响交互。 */
export function LandingParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let running = true;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const target = Math.min(96, Math.max(40, Math.floor((width * height) / 11_000)));
      particles = Array.from({ length: target }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 1.2 + Math.random() * 2.4,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.18 - Math.random() * 0.5,
        alpha: 0.35 + Math.random() * 0.55,
        hue: Math.random() > 0.45 ? 212 : 268,
      }));
      // resize 会清空画布，立即补画一帧，静态模式下也不会出现空白。
      draw();
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      for (const particle of particles) {
        particle.x += particle.vx;
        particle.y += particle.vy;
        if (particle.y < -10) {
          particle.y = height + 10;
          particle.x = Math.random() * width;
        }
        if (particle.x < -10) particle.x = width + 10;
        if (particle.x > width + 10) particle.x = -10;
      }

      // 邻近粒子之间画出微弱连线，形成神经网络般的空间感。
      context.lineWidth = 0.5;
      for (let i = 0; i < particles.length; i += 1) {
        for (let j = i + 1; j < particles.length; j += 1) {
          const a = particles[i]!;
          const b = particles[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > 24_000) continue;
          const strength = 1 - Math.sqrt(distanceSquared) / 155;
          context.strokeStyle = `rgba(126, 158, 255, ${Math.max(0, strength) * 0.22})`;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }
      }

      for (const particle of particles) {
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = `hsla(${particle.hue}, 100%, 76%, ${particle.alpha})`;
        context.shadowColor = `hsla(${particle.hue}, 100%, 70%, 1)`;
        context.shadowBlur = 16;
        context.fill();
      }
      context.shadowBlur = 0;
    };

    const tick = () => {
      if (!running || document.hidden) return;
      draw();
      frame = window.requestAnimationFrame(tick);
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        window.cancelAnimationFrame(frame);
      } else if (!reduced) {
        running = true;
        tick();
      }
    };

    resize();
    if (reduced) draw();
    else tick();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      running = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas className="landing-canvas" ref={canvasRef} aria-hidden="true" />;
}

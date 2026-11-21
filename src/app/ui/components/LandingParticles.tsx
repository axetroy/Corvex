import { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  radius: number;
  vx: number;
  vy: number;
  alpha: number;
  hue: number;
  phase: number;
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
    // 即使系统开启了减少动画，也保留缓慢的粒子漂浮，只降低速度与闪烁幅度。
    const speed = reduced ? 0.35 : 1;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;

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
        phase: Math.random() * Math.PI * 2,
      }));
      // resize 会清空画布，立即补画一帧，避免首屏出现空白。
      draw();
    };

    const draw = (now = performance.now()) => {
      context.clearRect(0, 0, width, height);
      for (const particle of particles) {
        particle.x += (particle.vx + Math.sin(now / 2400 + particle.phase) * 0.18) * speed;
        particle.y += particle.vy * speed;
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
        const pulse = 0.78 + 0.22 * Math.sin(now / 900 + particle.phase);
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = `hsla(${particle.hue}, 100%, 76%, ${particle.alpha * pulse})`;
        context.shadowColor = `hsla(${particle.hue}, 100%, 70%, 1)`;
        context.shadowBlur = 16;
        context.fill();
      }
      context.shadowBlur = 0;
    };

    // 用定时器驱动而不是 requestAnimationFrame：未获得焦点的标签页里 rAF 会被浏览器
    // 严重节流，看起来就像粒子静止不动。
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      draw();
    }, 40);

    resize();
    window.addEventListener("resize", resize);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas className="landing-canvas" ref={canvasRef} aria-hidden="true" />;
}

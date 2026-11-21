import { useEffect, useRef, type CSSProperties } from "react";
import { LandingParticles } from "./LandingParticles.js";
import type { Copy, Locale } from "../i18n.js";
import { LanguageIcon } from "./icons.js";
import "./LandingPage.css";

interface Props {
  copy: Copy;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}

/** 公开首页：蓝色到紫色的科技风格，滚动时逐步显现。 */
export function LandingPage({ copy, locale, onLocaleChange }: Props) {
  const features = [
    { title: copy.feature1Title, desc: copy.feature1Desc, icon: "◎" },
    { title: copy.feature2Title, desc: copy.feature2Desc, icon: "◇" },
    { title: copy.feature3Title, desc: copy.feature3Desc, icon: "✦" },
    { title: copy.feature4Title, desc: copy.feature4Desc, icon: "⚙" },
    { title: copy.feature5Title, desc: copy.feature5Desc, icon: "⬡" },
    { title: copy.feature6Title, desc: copy.feature6Desc, icon: "⌘" },
  ];
  const steps = [
    { title: copy.step1Title, desc: copy.step1Desc },
    { title: copy.step2Title, desc: copy.step2Desc },
    { title: copy.step3Title, desc: copy.step3Desc },
  ];
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const reveals = [...container.querySelectorAll<HTMLElement>("[data-reveal]")];
    // 用滚动位置直接切换类名：进入视口入场，离开时移除类名由 CSS 反向播放出场。
    // 不依赖 IntersectionObserver，避免未聚焦的预览标签页里回调被节流。
    const updateReveals = () => {
      const viewportHeight = window.innerHeight || 800;
      for (const element of reveals) {
        const rect = element.getBoundingClientRect();
        const visible = rect.top < viewportHeight * 0.85 && rect.bottom > viewportHeight * 0.1;
        element.classList.toggle("visible", visible);
      }
    };
    window.addEventListener("scroll", updateReveals, { passive: true });
    window.addEventListener("resize", updateReveals);
    updateReveals();

    // 数字直接显示；模块的入场/出场完全由滚动动画负责。
    for (const element of container.querySelectorAll<HTMLElement>("[data-count]")) {
      element.textContent = element.dataset.count ?? "0";
    }

    return () => {
      window.removeEventListener("scroll", updateReveals);
      window.removeEventListener("resize", updateReveals);
    };
  }, []);

  return (
    <div className="landing" ref={root}>
      <div className="landing-bg" aria-hidden="true">
        <div className="landing-grid" />
        <div className="landing-beam landing-beam-a" />
        <div className="landing-beam landing-beam-b" />
        <div className="landing-scanlines" />
        <LandingParticles />
      </div>
      <div className="landing-orb landing-orb-a" aria-hidden="true" />
      <div className="landing-orb landing-orb-b" aria-hidden="true" />
      <nav className="landing-nav landing-wrap">
        <a className="landing-logo" href="/">
          <span className="landing-logo-mark">C</span>
          <span>Corvex</span>
        </a>
        <div className="landing-nav-actions">
          <button
            type="button"
            className="landing-lang"
            aria-label={copy.languageLabel}
            onClick={() => onLocaleChange(locale === "zh-CN" ? "en" : "zh-CN")}
          >
            <LanguageIcon />
            <span>{locale === "zh-CN" ? "EN" : "中文"}</span>
          </button>
          <a className="landing-btn landing-btn-primary" href="/ops">{copy.landingLogin}</a>
        </div>
      </nav>

      <header className="landing-hero landing-wrap">
        <div className="landing-hero-grid">
          <div>
            <span className="landing-badge" data-reveal><i aria-hidden="true" />{copy.landingBadge}</span>
            <h1 data-reveal style={{ "--delay": "80ms" } as CSSProperties}>
              {copy.landingTitle1}
              <br />
              <span className="landing-gradient">{copy.landingTitle2}</span>
            </h1>
            <p className="landing-lead" data-reveal style={{ "--delay": "160ms" } as CSSProperties}>{copy.landingLead}</p>
            <div className="landing-hero-actions" data-reveal style={{ "--delay": "240ms" } as CSSProperties}>
              <a className="landing-btn landing-btn-primary" href="/ops">{copy.landingLogin}</a>
              <a className="landing-btn landing-btn-ghost" href="#features">{copy.landingExplore}</a>
            </div>
          </div>
          <div className="landing-demo" data-reveal style={{ "--delay": "200ms" } as CSSProperties}>
            <div className="landing-demo-top"><i /><i /><i /></div>
            <div className="landing-demo-line">
              <span className="landing-demo-avatar">U</span>
              <span className="landing-bubble landing-bubble-user">{copy.landingDemoQuestion}</span>
            </div>
            <div className="landing-demo-line">
              <span className="landing-demo-avatar landing-demo-avatar-c">C</span>
              <span className="landing-bubble landing-bubble-ai">
                {copy.landingDemoAnswer}
                <span className="landing-typing"><i /><i /><i /></span>
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="landing-section landing-wrap" id="features">
        <div className="landing-section-head" data-reveal>
          <span className="landing-eyebrow">CAPABILITIES</span>
          <h2>{copy.landingFeaturesTitle}</h2>
          <p>{copy.landingFeaturesLead}</p>
        </div>
        <div className="landing-cards">
          {features.map((feature, index) => (
            <div className="landing-feature" data-reveal style={{ "--delay": `${index * 80}ms` } as CSSProperties} key={feature.title}>
              <span className="landing-feature-icon" aria-hidden="true">{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-wrap">
        <div className="landing-section-head" data-reveal>
          <span className="landing-eyebrow">HOW IT WORKS</span>
          <h2>{copy.landingStepsTitle}</h2>
        </div>
        <div className="landing-steps">
          {steps.map((step, index) => (
            <div className="landing-step" data-reveal style={{ "--delay": `${index * 90}ms` } as CSSProperties} key={step.title}>
              <span>0{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section landing-wrap">
        <div className="landing-stats" data-reveal>
          {[
            { value: "3", label: copy.landingStat1 },
            { value: "5", label: copy.landingStat2 },
            { value: "30", label: copy.landingStat3 },
            { value: "100", label: copy.landingStat4 },
          ].map((stat) => (
            <div className="landing-stat" key={stat.label}>
              <b data-count={stat.value}>0</b>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-cta landing-wrap" data-reveal>
        <h2 className="landing-gradient">{copy.ctaTitle}</h2>
        <p>{copy.ctaLead}</p>
        <a className="landing-btn landing-btn-primary" href="/ops">{copy.ctaButton}</a>
      </section>
      <footer className="landing-footer landing-wrap">
        <span>Corvex · GitLab Code Agent</span>
        <span>{copy.landingBadge}</span>
      </footer>
    </div>
  );
}

import type { ReactNode } from "react";
import { LayerCard } from "@cloudflare/kumo";

export function AuthLayout({
  title,
  description,
  notice,
  secondaryAction,
  footer,
  children,
}: {
  title: string;
  description?: ReactNode;
  notice?: ReactNode;
  secondaryAction?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="auth-layout">
      <LayerCard
        render={<section aria-labelledby="auth-title" />}
        className="auth-layout-card"
      >
        <div className="auth-layout-summary">
          <div className="auth-layout-brand">bifurcation</div>
          <div className="auth-layout-introduction">
            <h1 id="auth-title">{title}</h1>
            {notice}
            {description && <p className="subtle">{description}</p>}
          </div>
          {secondaryAction && (
            <div className="auth-layout-alternative">{secondaryAction}</div>
          )}
          {footer && <footer className="subtle">{footer}</footer>}
        </div>
        <div className="auth-layout-content">{children}</div>
      </LayerCard>
    </main>
  );
}

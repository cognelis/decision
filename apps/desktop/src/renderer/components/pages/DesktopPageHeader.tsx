import type { ReactNode } from "react";

interface DesktopPageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  meta?: ReactNode;
  metaLabel?: string;
}

export const DesktopPageHeader = ({
  eyebrow,
  title,
  description,
  meta,
  metaLabel,
}: DesktopPageHeaderProps) => (
  <header className="desktop-view-header drag-region">
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    {meta === undefined || metaLabel === undefined ? null : (
      <div className="desktop-view-meta">
        <strong>{meta}</strong>
        <span>{metaLabel}</span>
      </div>
    )}
  </header>
);

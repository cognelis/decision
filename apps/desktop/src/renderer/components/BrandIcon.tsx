import brandIconUrl from "../../../assets/decision-mark.svg?url";

interface BrandIconProps {
  className?: string;
  decorative?: boolean;
}

export const BrandIcon = ({
  className,
  decorative = true,
}: BrandIconProps) => (
  <img
    className={className}
    src={brandIconUrl}
    {...(decorative
      ? { alt: "", "aria-hidden": true }
      : { alt: "Decision" })}
  />
);

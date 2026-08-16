type OmniRouteLogoProps = {
  size?: number;
  className?: string;
};

export default function OmniRouteLogo({ size = 20, className = "" }: OmniRouteLogoProps) {
  return <img src="/bp-batam-logo.png" width={Math.round(size * 2.44)} height={size} alt="BP Batam" className={`max-w-full object-contain ${className}`} />;
}

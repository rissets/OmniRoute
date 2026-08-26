type OmniRouteLogoProps = {
  size?: number;
  className?: string;
};

export default function OmniRouteLogo({ size = 20, className = "" }: OmniRouteLogoProps) {
  return (
    <img
      src="/hellodigi-mark.png"
      width={size}
      height={size}
      alt="HelloDigi"
      className={`max-w-full object-contain ${className}`}
    />
  );
}

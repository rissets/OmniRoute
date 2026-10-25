"use client";
import Image from "next/image";
import { cn } from "@/shared/utils/cn";
export default function OmniRouteLogo({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      unoptimized
      src="/brand/bp-batam-emblem.svg"
      alt="BP Batam"
      width={size}
      height={size}
      className={cn("object-contain", className)}
      style={{ width: size, height: size }}
    />
  );
}
export function OmniRouteLockup({
  name,
  logoSrc,
  className,
}: {
  name?: string | null;
  logoSrc?: string | null;
  className?: string;
}) {
  const custom = Boolean(
    logoSrc && name && !logoSrc.startsWith("/brand/bp-batam") && !/omnirout|keak/i.test(name)
  );
  if (custom)
    return (
      <span
        role="img"
        aria-label={name!}
        className={cn("inline-flex items-center gap-2", className)}
      >
        <Image
          unoptimized
          width={24}
          height={24}
          src={logoSrc!}
          alt=""
          className="size-6 object-contain"
        />
        <span>{name}</span>
      </span>
    );
  return (
    <span role="img" aria-label="BP Batam AI Gateway" className={cn("bp-brand-lockup", className)}>
      <Image
        unoptimized
        src={logoSrc || "/brand/bp-batam-logo.png"}
        alt="BP Batam — Badan Pengusahaan Batam"
        loading="eager"
        width={190}
        height={47}
      />
    </span>
  );
}

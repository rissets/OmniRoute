import type { KeakProduct, ProductSwitcherItem } from "@omniroute/ui-kit/keak-brand";

/** Destinations for the kit ProductSwitcher (spec §3.7). Owned by OmniRoute, not the kit. */
export const KEAK_PRODUCT_LINKS: ProductSwitcherItem[] = [
  { product: "optimize", href: "https://bpbatam.go.id" },
  { product: "inference", href: "https://bpbatam.go.id" },
  { product: "omniroute", href: "https://bpbatam.go.id" },
];

export const KEAK_ACTIVE_PRODUCT: KeakProduct = "omniroute";

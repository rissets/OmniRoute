import type { HTMLAttributes, ReactNode, SVGProps } from "react";
import { cn } from "./lib/utils";
export { KEAK_MARK_PATH, KEAK_WORDMARK_PATH, KEAK_WORDMARK_VIEWBOX } from "./keak-brand-vectors";
export interface KeakMarkProps extends SVGProps<SVGSVGElement>{label?:string;}
export function KeakMark({label="BP Batam",className,...props}:KeakMarkProps){return <svg viewBox="0 0 310 310" role="img" aria-label={label} className={className} {...props}><image href="/brand/bp-batam-emblem.svg" width="310" height="310"/></svg>;}
export interface KeakLogoProps extends HTMLAttributes<HTMLSpanElement>{label?:string;showMark?:boolean;}
export function KeakLogo({label="BP Batam",showMark,className,...props}:KeakLogoProps){return <span role="img" aria-label={label} className={cn("bp-brand-lockup",className)} {...props}><img src="/brand/bp-batam-logo.png" alt="BP Batam" width={190} height={47}/></span>;}
export type KeakProduct="optimize"|"inference"|"omniroute";
export const keakProductNames:Record<KeakProduct,string>={optimize:"Layanan AI",inference:"Model AI",omniroute:"AI Gateway"};
export interface ProductIconProps extends SVGProps<SVGSVGElement>{product:KeakProduct;label?:string;variant?:"badge"|"glyph";}
export function ProductIcon({product,label="BP Batam",variant,className,...props}:ProductIconProps){return <KeakMark label={label} className={cn("ci-keak-product-icon",className)} {...props}/>;}
export interface ProductLockupProps extends HTMLAttributes<HTMLSpanElement>{product:KeakProduct;showMark?:boolean;showIcon?:boolean;}
export function ProductLockup({product,showMark,showIcon,className,...props}:ProductLockupProps){return <KeakLogo className={className} {...props}/>;}
export interface ProductSwitcherItem{product:KeakProduct;href:string;description?:string;}
export interface ProductSwitcherProps extends HTMLAttributes<HTMLElement>{items:ProductSwitcherItem[];activeProduct?:KeakProduct;}
export function ProductSwitcher({items,activeProduct,className,...props}:ProductSwitcherProps){return <nav aria-label="BP Batam" className={className} {...props}><a href="/dashboard/help">BP Batam AI Gateway</a></nav>;}
export interface EditorialSectionProps extends HTMLAttributes<HTMLElement>{index:string;label:string;children?:ReactNode;}
export function EditorialSection({index,label,children,className,...props}:EditorialSectionProps){return <section className={cn("ci-editorial-section",className)} {...props}><div className="ci-editorial-label"><span>{index}</span><span>{label}</span></div>{children}</section>;}
export interface EditorialCardProps extends HTMLAttributes<HTMLElement>{eyebrow:string;title:string;description?:string;href:string;linkLabel?:string;}
export function EditorialCard({eyebrow,title,description,href,linkLabel="Selengkapnya",className,...props}:EditorialCardProps){return <article className={cn("ci-editorial-card",className)} {...props}><span className="ci-editorial-card-eyebrow">{eyebrow}</span><h3>{title}</h3>{description&&<p>{description}</p>}<a href={href}>{linkLabel}</a></article>;}

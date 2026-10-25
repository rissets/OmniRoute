/**
 * /dashboard/chaos/page.tsx — Chaos Mode Configuration
 */
import { getTranslations } from "next-intl/server";
import ChaosConfigPageClient from "./ChaosConfigPageClient";

export async function generateMetadata() {
  const t = await getTranslations("chaosConfig");
  return { title: `${t("pageTitle")} — BP Batam AI Gateway` };
}

export default function Page() {
  return <ChaosConfigPageClient />;
}

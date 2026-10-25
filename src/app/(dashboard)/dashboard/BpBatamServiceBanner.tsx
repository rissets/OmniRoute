import Link from "next/link";
export default function BpBatamServiceBanner() {
  return (
    <section className="bp-service-banner" aria-label="BP Batam AI Gateway">
      <div>
        <span className="bp-eyebrow">BP BATAM · LAYANAN AI TERPADU</span>
        <h2 className="ci-heading">Satu gerbang untuk kebutuhan AI Anda</h2>
        <p>
          Kelola provider, akses model, pantau penggunaan, dan hubungkan aplikasi melalui API yang
          terpusat.
        </p>
      </div>
      <Link href="/dashboard/help" className="ci-button ci-button--secondary">
        Panduan layanan
      </Link>
    </section>
  );
}

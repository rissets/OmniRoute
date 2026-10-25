import Link from "next/link";
import { OmniRouteLockup } from "@/shared/components/OmniRouteLogo";
export default function LandingPage() {
  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <header className="flex items-center justify-between">
        <OmniRouteLockup />
        <Link href="/login" className="ci-button ci-button--primary">
          Masuk
        </Link>
      </header>
      <section className="py-20 max-w-3xl">
        <p className="bp-eyebrow">BP BATAM AI GATEWAY</p>
        <h1 className="text-4xl md:text-5xl font-bold mt-5 leading-tight">
          Akses AI yang terpusat, terkelola, dan terukur.
        </h1>
        <p className="text-lg text-text-muted mt-6 leading-relaxed">
          Hubungkan provider dan aplikasi, kelola akses model, serta pantau penggunaan melalui satu
          gateway.
        </p>
        <div className="flex gap-4 mt-8">
          <Link href="/dashboard" className="ci-button ci-button--primary">
            Buka dashboard
          </Link>
          <Link href="/docs" className="ci-button ci-button--secondary">
            Dokumentasi
          </Link>
        </div>
      </section>
      <footer className="py-8 border-t border-border flex flex-wrap gap-6 text-sm">
        <a href="https://bpbatam.go.id">BP Batam</a>
        <a href="mailto:humas@bpbatam.go.id">Kontak</a>
        <Link href="/dashboard/help">Bantuan & publikasi</Link>
      </footer>
    </main>
  );
}

import Link from "next/link";
export const metadata = { title: "Bantuan & Kontak | BP Batam AI Gateway" };
export default function HelpPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="bp-eyebrow">BP BATAM AI GATEWAY</p>
        <h1 className="text-3xl font-bold mt-2">Bantuan & kontak</h1>
        <p className="text-text-muted mt-3">
          Panduan operator, dukungan, dan informasi resmi BP Batam.
        </p>
      </header>
      <div className="bp-help-grid">
        <section>
          <h2>Mulai menggunakan layanan</h2>
          <ol className="list-decimal ps-5 space-y-2">
            <li>
              Hubungkan kredensial provider pada <Link href="/dashboard/providers">Provider</Link>.
            </li>
            <li>
              Kelola model dan routing pada <Link href="/dashboard/models">Model & Combo</Link>.
            </li>
            <li>
              Buat kunci akses pada <Link href="/dashboard/api-manager">API Keys</Link>.
            </li>
            <li>
              Salin URL API pada <Link href="/dashboard/endpoint">Endpoints</Link>, lalu uji di{" "}
              <Link href="/dashboard/playground">Playground</Link>.
            </li>
          </ol>
        </section>
        <section>
          <h2>Kontak BP Batam</h2>
          <p>
            Pertanyaan mengenai profil kelembagaan dan informasi publik dapat disampaikan melalui
            kanal resmi BP Batam.
          </p>
          <p className="mt-4">
            <a href="mailto:humas@bpbatam.go.id">humas@bpbatam.go.id</a>
          </p>
          <p className="mt-2">
            <a href="https://bpbatam.go.id" target="_blank" rel="noopener noreferrer">
              Situs resmi BP Batam
            </a>
          </p>
          <p className="mt-4 text-sm">
            Untuk kendala akses atau kredensial pada instalasi lokal, hubungi administrator yang
            mengelola gateway ini.
          </p>
        </section>
        <section>
          <h2>Dokumentasi & integrasi</h2>
          <p>
            Gunakan API kompatibel OpenAI, endpoint Responses, protokol MCP/A2A, serta layanan audio
            dan gambar sesuai provider yang tersedia.
          </p>
          <div className="flex flex-wrap gap-4 mt-4">
            <Link href="/docs">Dokumentasi</Link>
            <Link href="/dashboard/mcp">MCP</Link>
            <Link href="/dashboard/a2a">A2A</Link>
            <Link href="/dashboard/usage">Penggunaan</Link>
          </div>
        </section>
        <section>
          <h2>Berita & publikasi</h2>
          <p>
            Ikuti informasi, pengumuman, berita kegiatan, dan publikasi terbaru melalui situs resmi
            BP Batam.
          </p>
          <p className="mt-4">
            <a href="https://bpbatam.go.id" target="_blank" rel="noopener noreferrer">
              Buka informasi BP Batam
            </a>
          </p>
        </section>
      </div>
    </div>
  );
}

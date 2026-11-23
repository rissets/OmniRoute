"use client";

import { useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";

type Pool = {
  ceiling: string;
  issued: string;
  remaining: string;
  consumed: string;
  reserved: string;
  accounts: { id: string; kind: string; balance: string; reserved: string }[];
};
const number = (value: string) => Number(value).toLocaleString("id-ID");
export default function BpBatamPool() {
  const [pool, setPool] = useState<Pool | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState("");
  const [addition, setAddition] = useState("");
  const [success, setSuccess] = useState("");
  async function load() {
    setError("");
    try {
      const r = await fetch("/api/bpbatam-pool");
      if (!r.ok) throw new Error("Akses owner OmniRoute diperlukan untuk membaca pool.");
      const value = await r.json();
      setPool(value);
      setTotal(value.ceiling);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pool tidak dapat dibaca.");
    }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/bpbatam-pool")
      .then(async (response) => {
        if (!response.ok) throw new Error("Akses owner OmniRoute diperlukan untuk membaca pool.");
        return (await response.json()) as Pool;
      })
      .then((value) => {
        if (!active) return;
        setPool(value);
        setTotal(value.ceiling);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Pool tidak dapat dibaca.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function update(mode: "set-total" | "add") {
    const tokens = Number(mode === "add" ? addition : total);
    if (!pool || !Number.isSafeInteger(tokens) || tokens <= 0) {
      setError("Masukkan jumlah token bulat yang lebih besar dari nol.");
      return;
    }
    if (mode === "set-total" && tokens < Number(pool.issued)) {
      setError("Total pool tidak boleh di bawah jumlah token yang sudah diterbitkan.");
      return;
    }
    setSuccess("");
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/bpbatam-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: crypto.randomUUID(),
          mode,
          tokens,
          expected_issued: Number(pool.issued),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).code ?? "Pool gagal ditetapkan");
      const value = await r.json();
      setPool(value);
      setTotal(value.ceiling);
      setAddition("");
      setSuccess("Pool token berhasil diperbarui.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pool gagal ditetapkan");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Pool Token BP Batam</h1>
        <p>
          Saldo permanen organisasi. Alokasi departemen dan pengguna dikelola melalui control panel.
        </p>
      </header>
      {error && (
        <div role="alert">
          {error} <Button onClick={() => void load()}>Coba lagi</Button>
        </div>
      )}
      {!pool && !error && <p role="status">Memuat pool token…</p>}
      {pool && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            {[
              ["Batas penerbitan", pool.ceiling],
              ["Telah diterbitkan", pool.issued],
              ["Saldo tersisa", pool.remaining],
              ["Pemakaian", pool.consumed],
            ].map(([label, value]) => (
              <Card key={label} title={label}>
                <p className="text-2xl font-semibold">{number(value)}</p>
                <p>token</p>
              </Card>
            ))}
          </div>
          <Card title="Kelola pool token">
            <p className="mb-4">
              Pool bersifat permanen dan dapat ditambah. Jumlah yang sudah diterbitkan tidak dapat
              ditarik melalui pengurangan total. Reservasi aktif: {number(pool.reserved)} token.
            </p>
            {success && (
              <p role="status" className="mb-3">
                {success}
              </p>
            )}
            <form
              className="mb-6 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void update("set-total");
              }}
            >
              <label htmlFor="pool-total">Total pool token</label>
              <input
                id="pool-total"
                type="number"
                min={pool.issued}
                step="1"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                className="rounded-lg border border-border bg-transparent px-3 py-2"
                required
                disabled={busy}
              />
              <p className="text-sm">
                Menetapkan total penerbitan kumulatif. Selisih di atas token yang sudah terbit
                ditambahkan ke saldo organisasi.
              </p>
              <Button type="submit" disabled={busy}>
                {busy ? "Menyimpan…" : "Simpan total pool"}
              </Button>
            </form>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void update("add");
              }}
            >
              <label htmlFor="pool-add">Tambahkan token ke pool</label>
              <input
                id="pool-add"
                type="number"
                min="1"
                step="1"
                value={addition}
                onChange={(e) => setAddition(e.target.value)}
                className="rounded-lg border border-border bg-transparent px-3 py-2"
                required
                disabled={busy}
              />
              <p className="text-sm">
                Penambahan dicatat di jurnal OmniRoute dan tidak mengubah limit atau alokasi
                pengguna secara otomatis.
              </p>
              <Button type="submit" disabled={busy || !addition}>
                {busy ? "Menambahkan…" : "Tambah token"}
              </Button>
            </form>
          </Card>
          <Card title="Distribusi saldo">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th>Akun</th>
                    <th>Jenis</th>
                    <th>Saldo</th>
                    <th>Reservasi</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.accounts.map((a) => (
                    <tr key={a.id}>
                      <td className="break-all py-2">{a.id}</td>
                      <td>{a.kind}</td>
                      <td>{number(a.balance)}</td>
                      <td>{number(a.reserved)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </main>
  );
}

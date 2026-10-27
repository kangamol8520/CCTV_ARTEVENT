import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import { Button, Field, Input } from "../components/ui";

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await login(username, password); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form onSubmit={submit} className="w-80 space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <div className="text-lg font-semibold">CCTV Platform</div>
        <Field label="ชื่อผู้ใช้"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></Field>
        <Field label="รหัสผ่าน"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {error && <div className="text-sm text-red-400">{error}</div>}
        <Button type="submit" disabled={busy} className="w-full justify-center">เข้าสู่ระบบ</Button>
      </form>
    </div>
  );
}

import { IconShieldLock } from "@tabler/icons-react";
import { KioskPane } from "./components/KioskPane";
import { PhonePane } from "./components/PhonePane";
import { AttackerPane } from "./components/AttackerPane";
import { EventLog } from "./components/EventLog";

export function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-[1360px] flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <IconShieldLock size={22} strokeWidth={1.8} className="text-accent" aria-hidden />
            <h1 className="text-xl font-semibold tracking-tight">L0 Admission Control</h1>
          </div>
          <p className="mt-1 text-sm text-dim">
            Rotating QR check-in — <span className="text-fg">presence is a credential</span>. Filters the
            internet out before L1–L5 ever run.
          </p>
        </div>
        <div className="flex gap-2 font-mono text-[10px] uppercase tracking-wider text-mute">
          <span className="rounded-md border border-line px-2 py-1">offline · zero credentials</span>
          <span className="rounded-md border border-line px-2 py-1">CS7980 · WP B/C</span>
        </div>
      </header>

      <main className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <KioskPane className="lg:col-span-3" />
        <PhonePane className="lg:col-span-4" />
        <AttackerPane className="lg:col-span-5" />
      </main>

      <EventLog />
    </div>
  );
}

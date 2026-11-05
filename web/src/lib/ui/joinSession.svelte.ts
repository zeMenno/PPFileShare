import { JoinRoom, type JoinSnapshot, type RoomLink } from '../engine/join';
import { memorySink } from '../engine/sinks';

const NAME_KEY = 'pp-name';

export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

/** Reactive wrapper around JoinRoom shared by the file and watch views. */
export class JoinSession {
  room = $state.raw<JoinRoom | null>(null);
  snap = $state.raw<JoinSnapshot | null>(null);
  openError = $state('');
  opening = $state(false);
  password = $state('');
  askPassword = $state(false);
  wrongPassword = $state(false);

  constructor(readonly link: RoomLink) {}

  start() {
    if (this.link.needsPassword) this.askPassword = true;
    else this.connect();
  }

  async connect() {
    if (this.opening) return;
    this.opening = true;
    this.openError = '';
    this.wrongPassword = false;
    try {
      const r = await JoinRoom.open(this.link, this.link.needsPassword ? this.password : undefined, savedName() || undefined);
      r.on('change', (s) => {
        this.snap = s;
        if (s.status === 'wrong-key' && this.link.needsPassword) {
          this.wrongPassword = true;
          this.askPassword = true;
          r.close();
          this.room = null;
        }
      });
      this.room = r;
      this.snap = r.snapshot();
      this.askPassword = false;
      if (import.meta.env.DEV) (window as any).__ppJoin = Object.assign(r, { memorySink });
    } catch (e) {
      this.openError = (e as Error).message || 'Could not open this link.';
    } finally {
      this.opening = false;
    }
  }

  close() {
    this.room?.close();
  }

  /** True once there's something to show beyond a status screen. */
  ready(hasContent: boolean): boolean {
    const s = this.snap;
    if (this.askPassword || this.openError || !s) return false;
    if (s.status === 'connecting' || s.status === 'waiting' || s.status === 'linking') return false;
    if ((s.status === 'failed' || s.status === 'closed' || s.status === 'denied' || s.status === 'wrong-key') && !hasContent) return false;
    return true;
  }
}
